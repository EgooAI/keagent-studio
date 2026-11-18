package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

type aiProbeStep struct {
	Name  string `json:"name"`
	State string `json:"state"`
}
type aiProbeProgress struct {
	Steps                   []aiProbeStep `json:"steps"`
	Message                 string        `json:"message,omitempty"`
	Category                string        `json:"category,omitempty"`
	Task                    string        `json:"task,omitempty"`
	SpeechConfigFingerprint string        `json:"speechConfigFingerprint,omitempty"`
	ActivationRevision      *int64        `json:"activationRevision,omitempty"`
}
type aiProbe struct {
	ID, Group, Service, Mode, Status, Actor, Hash, Worker string
	Version                                               int64
	Created                                               time.Time
	Finished                                              *time.Time
	Progress                                              aiProbeProgress
	Input                                                 []byte
}

const aiProbeMetadata = "id,service_group,service,version,mode,status,actor_id,request_hash,worker,created_at,finished_at,result"
const aiProbeColumns = aiProbeMetadata + ",encrypted_input"
const aiProbeReadColumns = aiProbeMetadata + ",NULL::bytea"

func scanAIProbe(row interface{ Scan(...any) error }) (aiProbe, error) {
	var p aiProbe
	var raw []byte
	err := row.Scan(&p.ID, &p.Group, &p.Service, &p.Version, &p.Mode, &p.Status, &p.Actor, &p.Hash, &p.Worker, &p.Created, &p.Finished, &raw, &p.Input)
	if err == nil {
		err = json.Unmarshal(raw, &p.Progress)
	}
	return p, err
}
func (p aiProbe) public() object {
	steps := p.Progress.Steps
	if steps == nil {
		steps = []aiProbeStep{}
	}
	for i := range steps {
		if steps[i].State == "running" && p.Status != "running" && p.Status != "queued" {
			steps[i].State = p.Status
		}
	}
	return object{"id": p.ID, "service": p.Service, "version": p.Version, "mode": p.Mode, "status": p.Status, "createdAt": p.Created,
		"finishedAt": p.Finished, "steps": steps, "message": p.Progress.Message, "category": p.Progress.Category}
}
func (s *server) latestAIProbe(ctx context.Context, service string, version int64) (object, error) {
	spec, ok := specFor(service)
	if !ok {
		return nil, nil
	}
	p, err := scanAIProbe(s.db.QueryRowContext(ctx, "SELECT "+aiProbeReadColumns+" FROM keagent_ai_probe WHERE service_group=$1 AND service=$2 AND version=$3 ORDER BY created_at DESC,id DESC LIMIT 1", spec.Group, service, version))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return p.public(), nil
}
func (s *server) aiProbeByID(ctx context.Context, id string) (object, error) {
	p, err := scanAIProbe(s.db.QueryRowContext(ctx, "SELECT "+aiProbeReadColumns+" FROM keagent_ai_probe WHERE id=$1", id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fail(404, "测试记录不存在")
	}
	if err != nil {
		return nil, err
	}
	return p.public(), nil
}
func (s *server) enqueueAIProbe(ctx context.Context, tx *sql.Tx, a actor, spec aiSpec, h aiHead, input object) (object, error) {
	requestID, mode := str(input["requestId"]), str(input["mode"])
	if len(requestID) < 16 || !resourceID.MatchString(requestID) ||
		(mode != "connection" && mode != "sample" && (mode != "training" || spec.ID != "voice-clone")) {
		return nil, fail(422, "测试请求标识或类型无效")
	}
	if mode != "connection" && input["confirmed"] != true {
		return nil, fail(422, "请先确认真实测试")
	}
	version, ok := input["version"].(float64)
	if !ok {
		return nil, fail(422, "请选择测试配置")
	}
	payload := obj(input["sample"])
	if mode == "connection" {
		payload = nil
	}
	raw, _ := json.Marshal(object{"service": spec.ID, "mode": mode, "version": version, "sample": payload})
	hash := digestBytes(raw)
	existing, err := scanAIProbe(tx.QueryRowContext(ctx, "SELECT "+aiProbeReadColumns+" FROM keagent_ai_probe WHERE id=$1", requestID))
	if err == nil {
		if existing.Group != spec.Group || existing.Hash != hash || existing.Actor != a.UserID {
			return nil, fail(409, "请求标识已使用")
		}
		return existing.public(), nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if version != float64(h.Active) && (h.Candidate == 0 || version != float64(h.Candidate)) {
		return nil, fail(409, "测试配置已变化，请刷新后重试")
	}
	if err = validateAIProbeInput(spec.ID, mode, payload); err != nil {
		return nil, err
	}
	var ciphertext []byte
	if mode != "connection" && spec.ID != "beike-cli" {
		ciphertext, err = sealAI("ai-probe:"+requestID, payload)
		if err != nil {
			return nil, err
		}
	}
	p, err := scanAIProbe(tx.QueryRowContext(ctx, `INSERT INTO keagent_ai_probe(id,service_group,service,version,mode,status,encrypted_input,actor_id,request_hash)
		VALUES($1,$2,$3,$4,$5,'queued',$6,$7,$8) ON CONFLICT DO NOTHING RETURNING `+aiProbeColumns,
		requestID, spec.Group, spec.ID, int64(version), mode, ciphertext, a.UserID, hash))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fail(409, "已有该服务的测试正在处理")
	}
	if err != nil {
		return nil, err
	}
	if err = aiAudit(ctx, tx, a.UserID, spec.ID, "test", p.Version, mode); err != nil {
		return nil, err
	}
	return p.public(), nil
}

func (s *server) claimAIProbe(ctx context.Context) (aiProbe, error) {
	return scanAIProbe(s.db.QueryRowContext(ctx, `UPDATE keagent_ai_probe SET status='running',worker=$1,lease_until=now()+interval '90 seconds'
	WHERE id=(SELECT id FROM keagent_ai_probe WHERE status='queued' OR (status='running' AND lease_until<now() AND COALESCE(result->>'task','')<>'')
	ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING `+aiProbeColumns, id()))
}
func (s *server) runAIProbes(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	maintenance := time.NewTicker(15 * time.Second)
	defer maintenance.Stop()
	var workers sync.WaitGroup
	slots := make(chan struct{}, 3)
	defer workers.Wait()
	for {
		select {
		case <-ctx.Done():
			return
		case <-maintenance.C:
			// An interrupted request without a vendor task ID must not be submitted again.
			_, _ = s.db.ExecContext(ctx, `WITH abandoned AS (UPDATE keagent_ai_probe SET status='unknown',finished_at=now(),encrypted_input=NULL,
				result=result||'{"message":"提交结果未知，请在供应商控制台核对","category":"unknown"}'
				WHERE status='running' AND lease_until<now() AND COALESCE(result->>'task','')=''
				RETURNING id,actor_id,service_group,service,version,result),
				discarded AS (DELETE FROM keagent_ai_version v USING abandoned a
					WHERE v.service_group=a.service_group AND v.version=a.version AND a.result ? 'activationRevision')
				INSERT INTO keagent_audit(id,actor_id,action,target_id,metadata)
				SELECT md5(id||':ai-abandoned'),actor_id,'ai.test.result',service,jsonb_build_object('service',service,'version',version,'result','unknown') FROM abandoned ON CONFLICT DO NOTHING`)
		case <-ticker.C:
			select {
			case slots <- struct{}{}:
				p, err := s.claimAIProbe(ctx)
				if err != nil {
					<-slots
					continue
				}
				workers.Add(1)
				go func() { defer workers.Done(); defer func() { <-slots }(); s.executeAIProbe(ctx, p) }()
			default:
			}
		}
	}
}
func (s *server) saveAIProgress(ctx context.Context, p *aiProbe) error {
	result, err := s.db.ExecContext(ctx, `UPDATE keagent_ai_probe SET result=$3,lease_until=now()+interval '90 seconds' WHERE id=$1 AND worker=$2 AND status='running'`, p.ID, p.Worker, p.progressJSON())
	if err != nil {
		return err
	}
	if n, _ := result.RowsAffected(); n != 1 {
		return fail(409, "测试执行权已变更")
	}
	return nil
}
func (s *server) aiStep(ctx context.Context, p *aiProbe, name string) error {
	steps := p.Progress.Steps
	if len(steps) > 0 {
		last := &steps[len(steps)-1]
		if last.Name == name {
			return s.saveAIProgress(ctx, p)
		}
		last.State = "passed"
	}
	p.Progress.Steps = append(steps, aiProbeStep{name, "running"})
	return s.saveAIProgress(ctx, p)
}
func (s *server) executeAIProbe(parent context.Context, p aiProbe) {
	ctx, cancel := context.WithDeadline(parent, p.Created.Add(15*time.Minute))
	defer cancel()
	err := s.performAIProbe(ctx, &p)
	finish, finishCancel := context.WithTimeout(context.WithoutCancel(parent), 10*time.Second)
	defer finishCancel()
	tx, dbErr := s.db.BeginTx(finish, nil)
	if dbErr != nil {
		return
	}
	defer tx.Rollback()
	verification := p.Progress.ActivationRevision
	var head aiHead
	if verification != nil {
		// Mutations take the group head lock before touching the probe.
		head, dbErr = readAIHead(finish, tx, p.Group, true)
		if dbErr != nil {
			return
		}
		if err == nil && head.Revision != *verification {
			err = fail(409, "验证期间配置已变化，请刷新后重试")
		}
	}
	status := p.finish(err)
	result, dbErr := tx.ExecContext(finish, `UPDATE keagent_ai_probe SET status=$3,result=$4,finished_at=now(),encrypted_input=NULL WHERE id=$1 AND worker=$2 AND status='running'`, p.ID, p.Worker, status, p.progressJSON())
	if dbErr != nil {
		return
	}
	if n, _ := result.RowsAffected(); n != 1 {
		return
	}
	if verification != nil {
		status, dbErr = s.completeAIVerification(finish, tx, &p, head, status)
		if dbErr != nil {
			return
		}
	}
	if aiAudit(finish, tx, p.Actor, p.Service, "test.result", p.Version, status) == nil {
		_ = tx.Commit()
	}
}

func (p *aiProbe) finish(err error) string {
	status := "passed"
	if err != nil {
		status, p.Progress.Category, p.Progress.Message = aiProbeFailure(p.Service, err)
	}
	if n := len(p.Progress.Steps); n > 0 {
		p.Progress.Steps[n-1].State = status
	}
	return status
}

func (p *aiProbe) progressJSON() []byte {
	raw, _ := json.Marshal(p.Progress)
	return raw
}
func aiProbeFailure(service string, err error) (status, category, message string) {
	var upstream providerHTTPError
	if service == "opening" && errors.As(err, &upstream) {
		category := "validation"
		switch upstream.httpStatus {
		case http.StatusUnauthorized, http.StatusForbidden:
			category = "authentication"
		case http.StatusPaymentRequired, http.StatusTooManyRequests:
			category = "quota"
		}
		return "failed", category, upstream.Error()
	}
	if (service == "tts" || service == "voice-clone") && errors.As(err, &upstream) {
		label := "百炼配音"
		if service == "voice-clone" {
			label = "百炼声音复刻"
		}
		category, message = "validation", label+"请求失败"
		switch upstream.httpStatus {
		case http.StatusUnauthorized:
			category, message = "authentication", label+"鉴权失败，请核对百炼 API Key 和业务空间 ID"
		case http.StatusForbidden:
			category, message = "permission", "百炼拒绝请求，请检查业务空间、模型和音色权限"
		case http.StatusPaymentRequired, http.StatusTooManyRequests:
			category, message = "quota", label+"请求限流或额度不足，请在百炼控制台核对"
		}
		details := fmt.Sprintf("HTTP %d", upstream.httpStatus)
		switch upstream.name {
		case "InvalidApiKey", "AccessDenied", "InvalidParameter", "ModelNotFound", "WorkspaceNotFound", "Throttling", "Throttling.RateQuota", "Throttling.AllocationQuota":
			details += "，百炼错误码 " + upstream.name
		}
		if upstream.logID != "" {
			details += "，百炼请求 ID " + upstream.logID
		}
		return "failed", category, message + "（" + details + "）"
	}
	raw := err.Error()
	switch {
	case strings.Contains(raw, "401"):
		return "failed", "authentication", "供应商鉴权失败，请检查凭证"
	case strings.Contains(raw, "403"):
		return "failed", "permission", "供应商拒绝访问，请检查模型、音色或存储桶权限"
	case strings.Contains(raw, "429"), strings.Contains(raw, "402"), strings.Contains(raw, "quota"):
		return "failed", "quota", "请求限流或额度不足，请在供应商控制台核对"
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, context.Canceled), strings.Contains(raw, "结果未知"):
		return "unknown", "timeout", "测试结果未知，请在供应商控制台核对"
	}
	var known fault
	if errors.As(err, &known) && known.status != http.StatusInternalServerError {
		return "failed", "validation", known.message
	}
	return "failed", "internal", "测试未完成，请重试或联系部署人员"
}
