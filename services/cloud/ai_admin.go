package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"maps"
	"net/http"
	"net/url"
	"strings"
	"time"
)

func aiPublicValues(spec aiSpec, values aiValues) (object, object) {
	fields, secrets := object{}, object{}
	for _, field := range spec.Fields {
		value := values[field.Key]
		switch field.Kind {
		case "secret":
			secrets[field.Key] = value != ""
		case "toggle":
			fields[field.Key] = value == "true"
		case "url":
			fields[field.Key] = publicAIURL(value)
		default:
			fields[field.Key] = value
		}
	}
	return fields, secrets
}

func (s *server) aiOverview(ctx context.Context) (object, error) {
	ctx, err := s.activeAI(ctx)
	if err != nil {
		return nil, err
	}
	services := aiServicesFor(ctx)
	_, keyErr := aiCipher()
	result := make([]object, 0, len(aiSpecs))
	for i, spec := range aiSpecs {
		h, err := readAIHead(ctx, s.db, spec.Group, false)
		if err != nil {
			return nil, err
		}
		current := aiSnapshotFrom(ctx)
		// Do not describe a different configuration if an activation raced this read.
		if h.Active != current.versions[spec.Group] {
			return nil, fail(409, "配置已更新，请刷新后查看")
		}
		fields, secrets := aiPublicValues(spec, current.values)
		var candidate any
		if h.Candidate > 0 {
			values, e := readAIValues(ctx, s.db, spec.Group, h.Candidate)
			cf, cs := aiPublicValues(spec, values)
			missing, issues := aiConfigIssues(spec, values)
			if e != nil {
				issues = []string{"候选配置无法解密"}
			}
			latest, err := s.latestAIProbe(ctx, spec.ID, h.Candidate)
			if err != nil {
				return nil, err
			}
			candidate = object{"version": h.Candidate, "fields": cf, "secrets": cs, "missing": missing, "issues": issues, "test": latest}
		}
		activeTest, err := s.latestAIProbe(ctx, spec.ID, h.Active)
		if err != nil {
			return nil, err
		}
		canActivate := false
		if h.Candidate > 0 && keyErr == nil && !current.locked[spec.Group] {
			canActivate, err = s.aiActivationReady(ctx, s.db, spec.Group, h)
			if err != nil {
				return nil, err
			}
		}
		result = append(result, object{"summary": services[i], "fields": spec.Fields, "group": spec.Group,
			"revision": h.Revision, "active": object{"version": h.Active, "source": map[bool]string{true: "managed", false: "environment"}[h.Active > 0], "fields": fields, "secrets": secrets, "activatedAt": h.ActivatedAt, "test": activeTest, "locked": current.locked[spec.Group]},
			"candidate": candidate, "previous": h.Previous, "canActivate": canActivate})
	}
	voices, err := s.publicVoices(ctx, false)
	if err != nil {
		return nil, err
	}
	options := make([]object, 0, len(voices))
	for _, voice := range voices {
		options = append(options, object{"id": voice.ID, "name": voice.Name})
	}
	return object{"services": services, "management": result, "writable": keyErr == nil, "voices": options,
		"configured": services[0].State == "configured", "model": services[0].Model, "baseURL": services[0].Endpoint, "checkedAt": now(), "note": "凭证由服务端管理，本接口仅返回是否已设置。"}, nil
}
func (s *server) manageAI(r *http.Request, a actor, action string, body []byte) (any, error) {
	ctx := r.Context()
	if r.Method == http.MethodGet && action == "ai-config" {
		return s.aiOverview(ctx)
	}
	if r.Method == http.MethodGet && action == "ai-config/test" {
		return s.aiProbeByID(ctx, r.URL.Query().Get("id"))
	}
	if r.Method != http.MethodPost {
		return nil, fail(405, "方法不支持")
	}
	var input object
	if json.Unmarshal(body, &input) != nil {
		return nil, fail(400, "配置请求无效")
	}
	spec, ok := specFor(str(input["service"]))
	if !ok {
		return nil, fail(422, "未知 AI 服务")
	}
	if _, err := aiCipher(); err != nil {
		return nil, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `INSERT INTO keagent_ai_head(service_group) VALUES($1) ON CONFLICT DO NOTHING`, spec.Group); err != nil {
		return nil, err
	}
	h, err := readAIHead(ctx, tx, spec.Group, true)
	if err != nil {
		return nil, err
	}
	if action == "ai-config/test" {
		run, err := s.enqueueAIProbe(ctx, tx, a, spec, h, input)
		if err != nil {
			return nil, err
		}
		return run, tx.Commit()
	}
	if revision, ok := input["revision"].(float64); !ok || revision != float64(h.Revision) {
		return nil, fail(409, "配置已被修改，请刷新后重试")
	}
	version := h.Revision + 1
	switch action {
	case "ai-config/save", "ai-config/rollback":
		var values aiValues
		if action == "ai-config/rollback" {
			if h.Previous == nil {
				return nil, fail(409, "没有可恢复的上一个版本")
			}
			values, err = readAIValues(ctx, tx, spec.Group, *h.Previous)
		} else {
			base := h.Candidate
			if base == 0 {
				base = h.Active
			}
			if base == 0 {
				values = environmentAI(spec.Group)
			} else {
				values, err = readAIValues(ctx, tx, spec.Group, base)
			}
			if err == nil {
				err = patchAIValues(spec, values, obj(input["fields"]))
			}
		}
		if err != nil {
			return nil, err
		}
		sealed, err := sealAI(aiVersionLabel(spec.Group, version), values)
		if err != nil {
			return nil, err
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO keagent_ai_version(service_group,version,encrypted,actor_id) VALUES($1,$2,$3,$4)`, spec.Group, version, sealed, a.UserID); err != nil {
			return nil, err
		}
		if _, err = tx.ExecContext(ctx, `UPDATE keagent_ai_head SET revision=$2,candidate=$2 WHERE service_group=$1`, spec.Group, version); err != nil {
			return nil, err
		}
	case "ai-config/activate":
		if h.Candidate == 0 || number(input["version"]) != float64(h.Candidate) {
			return nil, fail(409, "候选版本已变化，请刷新")
		}
		ready, err := s.aiActivationReady(ctx, tx, spec.Group, h)
		if err != nil {
			return nil, err
		}
		if !ready {
			return nil, fail(409, "候选版本缺少最近24小时内通过的必要测试")
		}
		if h.Active == 0 {
			baseline := environmentAI(spec.Group)
			sealed, err := sealAI(aiVersionLabel(spec.Group, 0), baseline)
			if err != nil {
				return nil, err
			}
			if _, err = tx.ExecContext(ctx, `INSERT INTO keagent_ai_version(service_group,version,encrypted,actor_id) VALUES($1,0,$2,$3) ON CONFLICT DO NOTHING`, spec.Group, sealed, a.UserID); err != nil {
				return nil, err
			}
			if spec.Group == "avatar" {
				if _, err = tx.ExecContext(ctx, `UPDATE keagent_user_avatar SET payload=payload||jsonb_build_object('bucket',$1::text,'region',$2::text) WHERE COALESCE(payload->>'bucket','')=''`, baseline["VOLC_TOS_BUCKET"], baseline["VOLC_TOS_REGION"]); err != nil {
					return nil, err
				}
			}
		}
		version = h.Candidate
		if _, err = tx.ExecContext(ctx, `UPDATE keagent_ai_head SET revision=revision+1,previous=active,active=candidate,candidate=0,activated_at=now() WHERE service_group=$1`, spec.Group); err != nil {
			return nil, err
		}
	default:
		return nil, fail(404, "AI 配置操作不存在")
	}
	if err = aiAudit(ctx, tx, a.UserID, spec.ID, strings.TrimPrefix(action, "ai-config/"), version, ""); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return object{"version": version}, nil
}

func patchAIValues(spec aiSpec, values aiValues, patch object) error {
	if len(patch) == 0 {
		return fail(422, "没有可保存的配置字段")
	}
	old := maps.Clone(values)
	for key, raw := range patch {
		var field aiField
		for _, allowed := range spec.Fields {
			if allowed.Key == key {
				field = allowed
				break
			}
		}
		if field.Key == "" {
			return fail(422, "包含不支持的配置字段")
		}
		if field.Kind == "toggle" {
			value, ok := raw.(bool)
			if !ok {
				return fail(422, "开关配置无效")
			}
			values[key] = map[bool]string{true: "true", false: "false"}[value]
			continue
		}
		value, ok := raw.(string)
		value = strings.TrimSpace(value)
		if !ok || len(value) > 2048 || strings.ContainsAny(value, "\x00\r\n") {
			return fail(422, "配置字段格式无效")
		}
		if field.Kind != "secret" || value != "" {
			values[key] = value
		}
	}
	for urlKey, secretKey := range map[string]string{"AI_BASE_URL": "AI_API_KEY", "DASHSCOPE_BASE_URL": "DASHSCOPE_API_KEY"} {
		if values[urlKey] != old[urlKey] {
			previous, _ := url.Parse(old[urlKey])
			next, _ := url.Parse(values[urlKey])
			if next == nil || previous == nil || !strings.EqualFold(next.Host, previous.Host) {
				if strings.TrimSpace(str(patch[secretKey])) == "" {
					return fail(422, "更换服务域名时请重新填写 API Key")
				}
			}
		}
	}
	_, issues := aiConfigIssues(spec, values)
	if len(issues) > 0 {
		return fail(422, issues[0])
	}
	return nil
}
func (s *server) aiActivationReady(ctx context.Context, db aiRowReader, group string, h aiHead) (bool, error) {
	values, err := readAIValues(ctx, db, group, h.Candidate)
	if err != nil {
		return false, nil
	}
	for _, spec := range aiSpecs {
		if spec.Group != group || spec.ID == "voice-clone" && values["VOLC_VOICE_CLONE_ENABLED"] != "true" {
			continue
		}
		missing, issues := aiConfigIssues(spec, values)
		if len(missing)+len(issues) > 0 {
			return false, nil
		}
		var status string
		var finished sql.NullTime
		err = db.QueryRowContext(ctx, `SELECT status,finished_at FROM keagent_ai_probe WHERE service=$1 AND version=$2 AND mode IN ('sample','training') ORDER BY created_at DESC LIMIT 1`, spec.ID, h.Candidate).Scan(&status, &finished)
		if errors.Is(err, sql.ErrNoRows) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		if status != "passed" || !finished.Valid || time.Since(finished.Time) > 24*time.Hour {
			return false, nil
		}
	}
	return true, nil
}
