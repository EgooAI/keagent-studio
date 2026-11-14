package main

import (
	"context"
	"database/sql"
	"errors"
	"net/url"
	"strings"
	"time"
)

const defaultLeadCriteria = "判断评论者是否有明确的购房、租房、卖房、出租或看房需求。有明确需求且可以合理回应时 qualified=true；不要根据昵称、头像、地区或身份特征推测。"

type leadSettings struct {
	Criteria            string     `json:"criteria"`
	CriteriaVersion     string     `json:"criteriaVersion"`
	CriteriaHash        string     `json:"criteriaHash"`
	MaxComments         int        `json:"maxComments"`
	Concurrency         int        `json:"concurrency"`
	CreatorHubBaseURL   string     `json:"creatorhubBaseUrl"`
	CreatorHubAccountID string     `json:"creatorhubAccountId"`
	UpdatedAt           *time.Time `json:"updatedAt,omitempty"`
}

func criteriaHash(version, criteria string) string {
	return exchangeFingerprint([]string{"lead-criteria", version, strings.TrimSpace(criteria)})
}

func (s *server) leadConfig(ctx context.Context, a actor, op string, body []byte) (any, error) {
	switch op {
	case "lead/settings/get":
		return s.leadSettingsGet(ctx, a)
	case "lead/settings/save":
		return s.leadSettingsSave(ctx, a, body)
	default:
		return nil, collectionMissing()
	}
}

func (s *server) leadSettingsGet(ctx context.Context, a actor) (leadSettings, error) {
	out := leadSettings{Criteria: defaultLeadCriteria, CriteriaVersion: "v1", MaxComments: 200,
		Concurrency: 2, CreatorHubBaseURL: "http://127.0.0.1:8000"}
	var row leadSettings
	var updated time.Time
	err := s.db.QueryRowContext(ctx, `SELECT criteria,criteria_version,max_comments,concurrency,
		creatorhub_base_url,creatorhub_account_id,updated_at FROM keagent_lead_settings
		WHERE owner_id=$1 AND device_id=$2`, a.UserID, a.DeviceID).Scan(
		&row.Criteria, &row.CriteriaVersion, &row.MaxComments, &row.Concurrency,
		&row.CreatorHubBaseURL, &row.CreatorHubAccountID, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		out.CriteriaHash = criteriaHash(out.CriteriaVersion, out.Criteria)
		return out, nil
	}
	if err != nil {
		return leadSettings{}, err
	}
	row.CriteriaHash = criteriaHash(row.CriteriaVersion, row.Criteria)
	utc := updated.UTC()
	row.UpdatedAt = &utc
	return row, nil
}

func (s *server) leadSettingsSave(ctx context.Context, a actor, body []byte) (leadSettings, error) {
	var in struct {
		Criteria            string `json:"criteria"`
		MaxComments         int    `json:"maxComments"`
		Concurrency         int    `json:"concurrency"`
		CreatorHubBaseURL   string `json:"creatorhubBaseUrl"`
		CreatorHubAccountID string `json:"creatorhubAccountId"`
	}
	invalid := exchangeFail(422, "INVALID_INPUT", "获客设置参数无效")
	if decodeExchange(body, &in) != nil {
		return leadSettings{}, invalid
	}
	in.CreatorHubAccountID = strings.TrimSpace(in.CreatorHubAccountID)
	if len([]rune(in.Criteria)) > 8000 || strings.ContainsRune(in.Criteria, 0) ||
		in.MaxComments < 1 || in.MaxComments > 500 || in.Concurrency < 1 || in.Concurrency > 4 ||
		!loopbackBaseURL(in.CreatorHubBaseURL) ||
		(in.CreatorHubAccountID != "" && !validExchangeText(in.CreatorHubAccountID, 64)) {
		return leadSettings{}, invalid
	}
	criteria := strings.TrimSpace(in.Criteria)
	if criteria == "" {
		criteria = defaultLeadCriteria
	}
	version := "v1"
	_, err := s.db.ExecContext(ctx, `INSERT INTO keagent_lead_settings(
		owner_id,device_id,criteria,criteria_version,max_comments,concurrency,
		creatorhub_base_url,creatorhub_account_id,updated_at)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,now())
		ON CONFLICT(owner_id,device_id) DO UPDATE SET criteria=excluded.criteria,
		criteria_version=excluded.criteria_version,max_comments=excluded.max_comments,
		concurrency=excluded.concurrency,creatorhub_base_url=excluded.creatorhub_base_url,
		creatorhub_account_id=excluded.creatorhub_account_id,updated_at=now()`,
		a.UserID, a.DeviceID, criteria, version, in.MaxComments, in.Concurrency,
		in.CreatorHubBaseURL, in.CreatorHubAccountID)
	if err != nil {
		return leadSettings{}, err
	}
	return s.leadSettingsGet(ctx, a)
}

func loopbackBaseURL(raw string) bool {
	if raw == "" || strings.ContainsAny(raw, "?#@") {
		return false
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "http" || u.Port() == "" {
		return false
	}
	switch u.Hostname() {
	case "127.0.0.1", "localhost", "::1":
		return u.Path == "" || u.Path == "/"
	default:
		return false
	}
}
