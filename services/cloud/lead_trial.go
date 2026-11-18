package main

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"time"
)

const leadTrialSetting = "lead_trial"
const leadTrialDay = `(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date`
const defaultLeadAnalysisLimit = 200
const defaultLeadDraftLimit = 50

type leadTrialLimits struct {
	AnalysisLimit int `json:"analysisLimit"`
	DraftLimit    int `json:"draftLimit"`
}

type leadTrialBalance struct {
	Limit     int `json:"limit"`
	Used      int `json:"used"`
	Remaining int `json:"remaining"`
}

type leadTrial struct {
	Analysis leadTrialBalance `json:"analysis"`
	Draft    leadTrialBalance `json:"draft"`
	ResetsAt time.Time        `json:"resetsAt"`
}

// A trial unit is a request to the model. Model errors still occupy a unit,
// while rejected authorization and requests above quota never reach the model.
type leadTrialOperation string

const (
	leadTrialAnalysis leadTrialOperation = "analysis"
	leadTrialDraft    leadTrialOperation = "draft"
)

func (op leadTrialOperation) providerOperation() string { return "lead_" + string(op) }

func leadTrialExceeded(op leadTrialOperation) error {
	if op == leadTrialDraft {
		return exchangeFail(429, "LEAD_TRIAL_EXHAUSTED", "今日 AI 私信草稿试用额度已用完，次日北京时间零点恢复。你仍可手动填写草稿。")
	}
	return exchangeFail(429, "LEAD_TRIAL_EXHAUSTED", "今日 AI 评论分析试用额度不足，请减少分析条数或在次日北京时间零点后重试。")
}

func (s *server) leadTrialStatus(ctx context.Context, q rowQuerier, ownerID string) (leadTrial, error) {
	var trial leadTrial
	err := q.QueryRowContext(ctx, `SELECT
COALESCE((SELECT (payload->>'analysisLimit')::int FROM keagent_setting WHERE id=$2),$3),
COALESCE((SELECT (payload->>'draftLimit')::int FROM keagent_setting WHERE id=$2),$4),
COALESCE(MAX(used) FILTER (WHERE operation='analysis'),0),
COALESCE(MAX(used) FILTER (WHERE operation='draft'),0),
((`+leadTrialDay+` + 1)::timestamp AT TIME ZONE 'Asia/Shanghai')
FROM keagent_lead_trial_usage WHERE owner_id=$1 AND usage_day=`+leadTrialDay,
		ownerID, leadTrialSetting, defaultLeadAnalysisLimit, defaultLeadDraftLimit).Scan(
		&trial.Analysis.Limit, &trial.Draft.Limit, &trial.Analysis.Used, &trial.Draft.Used, &trial.ResetsAt)
	trial.Analysis.Remaining = max(0, trial.Analysis.Limit-trial.Analysis.Used)
	trial.Draft.Remaining = max(0, trial.Draft.Limit-trial.Draft.Used)
	return trial, err
}

func (s *server) consumeLeadTrial(ctx context.Context, ownerID string, op leadTrialOperation) error {
	return consumeLeadTrial(ctx, s.db, ownerID, op)
}

func consumeLeadTrial(ctx context.Context, q rowQuerier, ownerID string, op leadTrialOperation) error {
	key, fallback := "analysisLimit", defaultLeadAnalysisLimit
	if op == leadTrialDraft {
		key, fallback = "draftLimit", defaultLeadDraftLimit
	}
	var used int
	err := q.QueryRowContext(ctx, `WITH policy AS (
 SELECT COALESCE((SELECT (payload->>$4)::int FROM keagent_setting WHERE id=$3),$5) AS quota
)
INSERT INTO keagent_lead_trial_usage(owner_id,usage_day,operation,used)
SELECT $1,`+leadTrialDay+`,$2,1 FROM policy WHERE quota>0
ON CONFLICT(owner_id,usage_day,operation) DO UPDATE SET used=keagent_lead_trial_usage.used+1
WHERE keagent_lead_trial_usage.used < (SELECT quota FROM policy)
RETURNING used`, ownerID, op, leadTrialSetting, key, fallback).Scan(&used)
	if errors.Is(err, sql.ErrNoRows) {
		return leadTrialExceeded(op)
	}
	return err
}

// The old one-comment interface can ask for an analysis and a draft in the
// same provider request. At the draft limit it still supports analysis alone.
func (s *server) allowLegacyLeadDraft(ctx context.Context, ownerID string, manualContact bool) (bool, error) {
	if !manualContact {
		return false, s.consumeLeadTrial(ctx, ownerID, leadTrialAnalysis)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	if err = consumeLeadTrial(ctx, tx, ownerID, leadTrialAnalysis); err != nil {
		return false, err
	}
	err = consumeLeadTrial(ctx, tx, ownerID, leadTrialDraft)
	if err != nil {
		var quota exchangeFault
		if !errors.As(err, &quota) || quota.code != "LEAD_TRIAL_EXHAUSTED" {
			return false, err
		}
	}
	return err == nil, tx.Commit()
}

func (s *server) checkLeadAnalysisTrial(ctx context.Context, q rowQuerier, ownerID string, minimum int) error {
	trial, err := s.leadTrialStatus(ctx, q, ownerID)
	if err != nil {
		return err
	}
	if trial.Analysis.Remaining < minimum {
		return leadTrialExceeded(leadTrialAnalysis)
	}
	return nil
}

func (s *server) adminLeadTrial(r *http.Request, a actor, body []byte) (any, error) {
	ctx := r.Context()
	if r.Method == http.MethodGet {
		var limits leadTrialLimits
		var analyzed, drafted, accounts int64
		err := s.db.QueryRowContext(ctx, `SELECT
COALESCE((SELECT (payload->>'analysisLimit')::int FROM keagent_setting WHERE id=$1),$2),
COALESCE((SELECT (payload->>'draftLimit')::int FROM keagent_setting WHERE id=$1),$3),
COALESCE(SUM(used) FILTER (WHERE operation='analysis'),0),
COALESCE(SUM(used) FILTER (WHERE operation='draft'),0),COUNT(DISTINCT owner_id)
FROM keagent_lead_trial_usage WHERE usage_day=`+leadTrialDay,
			leadTrialSetting, defaultLeadAnalysisLimit, defaultLeadDraftLimit).
			Scan(&limits.AnalysisLimit, &limits.DraftLimit, &analyzed, &drafted, &accounts)
		return object{"limits": limits, "today": object{"analysis": analyzed, "drafts": drafted, "accounts": accounts}}, err
	}
	if r.Method != http.MethodPost {
		return nil, fail(405, "此方法不受支持")
	}
	var in struct {
		AnalysisLimit *int `json:"analysisLimit"`
		DraftLimit    *int `json:"draftLimit"`
	}
	if decodeExchange(body, &in) != nil || in.AnalysisLimit == nil || in.DraftLimit == nil ||
		*in.AnalysisLimit < 0 || *in.AnalysisLimit > 10000 || *in.DraftLimit < 0 || *in.DraftLimit > 10000 {
		return nil, fail(422, "每日试用额度须为 0–10000 的整数")
	}
	limits := leadTrialLimits{AnalysisLimit: *in.AnalysisLimit, DraftLimit: *in.DraftLimit}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `INSERT INTO keagent_setting(id,payload) VALUES($1,$2)
ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload`, leadTrialSetting, mustJSON(limits)); err != nil {
		return nil, err
	}
	if err = writeCreditAudit(ctx, tx, a.UserID, "credit.lead_trial.update", leadTrialSetting,
		object{"analysisLimit": limits.AnalysisLimit, "draftLimit": limits.DraftLimit}); err != nil {
		return nil, err
	}
	return object{"limits": limits}, tx.Commit()
}
