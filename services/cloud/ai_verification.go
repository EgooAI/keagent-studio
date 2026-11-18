package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"strings"
)

func aiVerificationHash(input object) string {
	// Bind an idempotent request to its exact inputs without storing an
	// unkeyed digest of user-supplied credentials.
	key, _ := base64.StdEncoding.DecodeString(strings.TrimSpace(os.Getenv("AI_CONFIG_ENCRYPTION_KEY")))
	mac := hmac.New(sha256.New, key)
	raw, _ := json.Marshal(input)
	_, _ = mac.Write([]byte("ai-verify-enable:"))
	_, _ = mac.Write(raw)
	return hex.EncodeToString(mac.Sum(nil))
}

func (s *server) latestAIVerification(ctx context.Context, group string) (object, error) {
	probe, err := scanAIProbe(s.db.QueryRowContext(ctx, "SELECT "+aiProbeReadColumns+` FROM keagent_ai_probe
		WHERE service_group=$1 AND result ? 'activationRevision'
		ORDER BY created_at DESC,id DESC LIMIT 1`, group))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return probe.public(), nil
}

func (s *server) enqueueAIVerification(ctx context.Context, tx *sql.Tx, a actor, spec aiSpec, h aiHead, input object) (object, error) {
	requestID := str(input["requestId"])
	if len(requestID) < 16 || !resourceID.MatchString(requestID) {
		return nil, fail(422, "验证请求标识无效")
	}
	if input["confirmed"] != true {
		return nil, fail(422, "请先确认真实测试")
	}
	useSaved := input["useSaved"] == true
	fields := obj(input["fields"])
	if (useSaved && input["fields"] != nil) || (!useSaved && len(fields) == 0) {
		return nil, fail(422, "请选择已保存的配置或填写需要更新的字段")
	}
	hash := aiVerificationHash(input)
	existing, err := scanAIProbe(tx.QueryRowContext(ctx, "SELECT "+aiProbeReadColumns+" FROM keagent_ai_probe WHERE id=$1", requestID))
	if err == nil {
		if existing.Group != spec.Group || existing.Hash != hash || existing.Actor != a.UserID || existing.Progress.ActivationRevision == nil {
			return nil, fail(409, "请求标识已使用")
		}
		return existing.public(), nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if revision, ok := input["revision"].(float64); !ok || revision != float64(h.Revision) {
		return nil, fail(409, "配置已被修改，请刷新后重试")
	}
	var running bool
	err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM keagent_ai_probe
		WHERE service_group=$1 AND status IN ('queued','running'))`, spec.Group).Scan(&running)
	if err != nil {
		return nil, err
	}
	if running {
		return nil, fail(409, "已有该服务的测试正在处理")
	}

	base := h.Active
	if useSaved {
		if h.Candidate == 0 {
			return nil, fail(409, "已保存的配置已变化，请刷新后重试")
		}
		base = h.Candidate
	}
	values, err := readAIValues(ctx, tx, spec.Group, base)
	if err != nil {
		return nil, err
	}
	if !useSaved {
		editSpec := spec
		if spec.Group == speechAIGroup {
			editSpec, _ = specFor("voice-clone")
		}
		if _, err = patchAIValues(editSpec, values, fields); err != nil {
			return nil, err
		}
	}
	mode := "sample"
	if spec.Group == speechAIGroup {
		spec, _ = specFor("tts")
		if values["DASHSCOPE_VOICE_CLONE_ENABLED"] == "true" {
			spec, _ = specFor("voice-clone")
			mode = "training"
		}
	}
	missing, issues := aiConfigIssues(spec, values)
	if len(issues) != 0 {
		return nil, fail(422, issues[0])
	}
	if len(missing) != 0 {
		return nil, fail(422, "缺少配置："+strings.Join(missing, "、"))
	}
	sample := obj(input["sample"])
	if err = validateAIProbeInput(spec.ID, mode, sample); err != nil {
		return nil, err
	}
	var encryptedSample []byte
	if spec.ID != "beike-cli" {
		encryptedSample, err = sealAI("ai-probe:"+requestID, sample)
		if err != nil {
			return nil, err
		}
	}

	// Reserve an immutable version without changing the active or legacy
	// candidate pointers. A later configuration change supersedes this check.
	version := h.Revision + 1
	sealed, err := sealAI(aiVersionLabel(spec.Group, version), values)
	if err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO keagent_ai_version(service_group,version,encrypted,actor_id)
		VALUES($1,$2,$3,$4)`, spec.Group, version, sealed, a.UserID); err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE keagent_ai_head SET revision=$2 WHERE service_group=$1`, spec.Group, version); err != nil {
		return nil, err
	}
	probe, err := scanAIProbe(tx.QueryRowContext(ctx, `INSERT INTO keagent_ai_probe
		(id,service_group,service,version,mode,status,encrypted_input,actor_id,request_hash,result)
		VALUES($1,$2,$3,$4,$5,'queued',$6,$7,$8,jsonb_build_object('activationRevision',$4::bigint))
		ON CONFLICT DO NOTHING RETURNING `+aiProbeColumns,
		requestID, spec.Group, spec.ID, version, mode, encryptedSample, a.UserID, hash))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fail(409, "请求标识已使用或已有测试正在处理")
	}
	if err != nil {
		return nil, err
	}
	if err = aiAudit(ctx, tx, a.UserID, spec.ID, "verify-enable", version, "queued"); err != nil {
		return nil, err
	}
	return probe.public(), nil
}

func activateAIVersion(ctx context.Context, tx *sql.Tx, aID, group string, h aiHead, version int64) error {
	if h.Active == 0 {
		sealed, err := sealAI(aiVersionLabel(group, 0), environmentAI(group))
		if err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO keagent_ai_version(service_group,version,encrypted,actor_id)
			VALUES($1,0,$2,$3) ON CONFLICT DO NOTHING`, group, sealed, aID); err != nil {
			return err
		}
	}
	_, err := tx.ExecContext(ctx, `UPDATE keagent_ai_head SET revision=revision+1,active=$2,candidate=0,activated_at=now()
		WHERE service_group=$1`, group, version)
	return err
}

func (s *server) completeAIVerification(ctx context.Context, tx *sql.Tx, p *aiProbe, h aiHead, status string) (string, error) {
	if status == "passed" {
		// Check the same activation gate used by the legacy workflow, against
		// the staged version and its successful probe in this transaction.
		h.Candidate = p.Version
		activation, err := s.checkAIActivation(ctx, tx, p.Group, h)
		if err != nil {
			return "", err
		}
		if activation.ready {
			if err = activateAIVersion(ctx, tx, p.Actor, p.Group, h, p.Version); err != nil {
				return "", err
			}
			return status, aiAudit(ctx, tx, p.Actor, p.Service, "activate", p.Version, "verified")
		}
		status = p.finish(fail(422, "验证结果不符合启用条件，请重试"))
		if _, err = tx.ExecContext(ctx, `UPDATE keagent_ai_probe SET status=$2,result=$3 WHERE id=$1`, p.ID, status, p.progressJSON()); err != nil {
			return "", err
		}
	}
	_, err := tx.ExecContext(ctx, `DELETE FROM keagent_ai_version WHERE service_group=$1 AND version=$2`, p.Group, p.Version)
	return status, err
}
