package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const defaultLeadCriteria = "判断评论者是否有明确的购房、租房、卖房、出租或看房需求。有明确需求且可以合理回应时 qualified=true；不要根据昵称、头像、地区或身份特征推测。"
const customLeadCriteriaVersion = "v2"

func leadCriteriaVersion(criteria string) string {
	switch strings.TrimSpace(criteria) {
	case "", defaultLeadCriteria:
		return "v1"
	default:
		return customLeadCriteriaVersion
	}
}

type leadSettings struct {
	Criteria            string     `json:"criteria"`
	DefaultCriteria     string     `json:"defaultCriteria"`
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
	case "lead/consent/save":
		return s.saveLeadConsent(ctx, a, body, true)
	case "creatorhub/consent/save":
		return s.creatorHubConsentSave(ctx, a, body)
	case "creatorhub/consent/get", "lead/consent/get":
		return s.creatorHubConsentGet(ctx, a, body)
	case "creatorhub/consent/revoke", "lead/consent/revoke":
		return s.creatorHubConsentRevoke(ctx, a, body)
	default:
		return nil, collectionMissing()
	}
}

func (s *server) leadSettingsGet(ctx context.Context, a actor) (leadSettings, error) {
	out := leadSettings{Criteria: defaultLeadCriteria, DefaultCriteria: defaultLeadCriteria,
		CriteriaVersion: "v1", MaxComments: 200,
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
	if strings.TrimSpace(row.Criteria) == "" {
		row.Criteria = defaultLeadCriteria
	}
	row.CriteriaVersion = leadCriteriaVersion(row.Criteria)
	row.CriteriaHash = criteriaHash(row.CriteriaVersion, row.Criteria)
	row.DefaultCriteria = defaultLeadCriteria
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
		(in.CreatorHubAccountID != "" && !validCreatorHubAccountID(in.CreatorHubAccountID)) {
		return leadSettings{}, invalid
	}
	criteria := strings.TrimSpace(in.Criteria)
	if criteria == "" {
		criteria = defaultLeadCriteria
	}
	version := leadCriteriaVersion(criteria)
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

var creatorHubAccountIDPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,64}$`)

func validCreatorHubAccountID(value string) bool {
	return creatorHubAccountIDPattern.MatchString(value) && !strings.ContainsRune(value, 0)
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

func (s *server) creatorHubConsentSave(ctx context.Context, a actor, body []byte) (any, error) {
	return s.saveLeadConsent(ctx, a, body, false)
}

var xhsWorkID = regexp.MustCompile(`^xhs-[0-9a-f]{24}$`)

func validLeadWork(id string) bool { return douyinPostID.MatchString(id) || xhsWorkID.MatchString(id) }

func (s *server) saveLeadConsent(ctx context.Context, a actor, body []byte, desktop bool) (any, error) {
	var in struct {
		AccountID           string    `json:"accountId"`
		WorkID              string    `json:"workId"`
		Label               string    `json:"label"`
		RetentionDays       int       `json:"retentionDays"`
		ExpiresAt           time.Time `json:"expiresAt"`
		BaseURL             string    `json:"baseUrl"`
		CreatorHubAccountID string    `json:"creatorhubAccountId"`
	}
	if decodeExchange(body, &in) != nil || !exchangeID.MatchString(in.AccountID) ||
		!validLeadWork(in.WorkID) || !validExchangeText(in.Label, 100) ||
		in.RetentionDays < 1 || in.RetentionDays > 90 ||
		(!desktop && (!loopbackBaseURL(in.BaseURL) || !validCreatorHubAccountID(in.CreatorHubAccountID) || !douyinPostID.MatchString(in.WorkID))) ||
		(desktop && (in.BaseURL != "" || in.CreatorHubAccountID != "")) ||
		in.ExpiresAt.Before(time.Now()) || in.ExpiresAt.After(time.Now().AddDate(1, 0, 0)) {
		return nil, collectionInvalid()
	}
	if desktop {
		want := "douyin"
		if xhsWorkID.MatchString(in.WorkID) {
			want = "xhs"
		}
		var platform string
		err := s.db.QueryRowContext(ctx, `SELECT COALESCE(payload->>'platform','douyin') FROM keagent_douyin_account
			WHERE owner_id=$1 AND device_id=$2 AND id=$3 AND NOT(payload ? 'unboundAt')`, a.UserID, a.DeviceID, in.AccountID).Scan(&platform)
		if errors.Is(err, sql.ErrNoRows) || (err == nil && platform != want) {
			return nil, collectionMissing()
		}
		if err != nil {
			return nil, err
		}
	}
	providerCtx, err := s.activeAI(ctx)
	if err != nil {
		return nil, err
	}
	service := aiServicesFor(providerCtx)[0]
	if !desktop && (service.State != "configured" || service.Endpoint == "") {
		return nil, exchangeFail(503, "COMMENT_AI_UNAVAILABLE", "请先在服务设置中配置文案模型")
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO keagent_comment_consents(
		owner_id,device_id,account_id,work_id,label,purposes,expires_at,retention_days,
		base_url,creatorhub_account_id,ai_endpoint,revoked)
		VALUES($1,$2,$3,$4,$5,'{"analyzeWithAI":true,"manualContact":true}'::jsonb,$6,$7,$8,$9,$10,false)
		ON CONFLICT(owner_id,device_id,account_id,work_id) DO UPDATE SET
		label=excluded.label,purposes=excluded.purposes,expires_at=excluded.expires_at,
		retention_days=excluded.retention_days,base_url=excluded.base_url,
		creatorhub_account_id=excluded.creatorhub_account_id,ai_endpoint=excluded.ai_endpoint,
		revoked=false,consented_at=now()`,
		a.UserID, a.DeviceID, in.AccountID, in.WorkID, in.Label, in.ExpiresAt,
		in.RetentionDays, in.BaseURL, in.CreatorHubAccountID, service.Endpoint)
	if err != nil {
		return nil, err
	}
	return s.creatorHubConsentGet(ctx, a, mustJSON(object{"accountId": in.AccountID, "workId": in.WorkID}))
}

func (s *server) creatorHubConsentGet(ctx context.Context, a actor, body []byte) (any, error) {
	var in struct {
		AccountID string `json:"accountId"`
		WorkID    string `json:"workId"`
	}
	if decodeExchange(body, &in) != nil || !exchangeID.MatchString(in.AccountID) || !validLeadWork(in.WorkID) {
		return nil, collectionInvalid()
	}
	var label, baseURL, creatorHubAccountID, aiEndpoint string
	var purposes []byte
	var expires time.Time
	var retention int
	var revoked bool
	err := s.db.QueryRowContext(ctx, `SELECT label,purposes,expires_at,retention_days,base_url,
		creatorhub_account_id,ai_endpoint,revoked FROM keagent_comment_consents
		WHERE owner_id=$1 AND device_id=$2 AND account_id=$3 AND work_id=$4`,
		a.UserID, a.DeviceID, in.AccountID, in.WorkID).Scan(
		&label, &purposes, &expires, &retention, &baseURL, &creatorHubAccountID, &aiEndpoint, &revoked)
	if errors.Is(err, sql.ErrNoRows) {
		return object{"state": "unconfigured"}, nil
	}
	if err != nil {
		return nil, err
	}
	state := "active"
	if revoked {
		state = "revoked"
	} else if !expires.After(time.Now()) {
		state = "expired"
	}
	return object{"state": state, "label": label, "purposes": json.RawMessage(purposes),
		"expiresAt": expires.UTC(), "retentionDays": retention, "baseUrl": baseURL,
		"creatorhubAccountId": creatorHubAccountID, "aiEndpoint": aiEndpoint}, nil
}

func (s *server) creatorHubConsentRevoke(ctx context.Context, a actor, body []byte) (any, error) {
	var in struct {
		AccountID string `json:"accountId"`
		WorkID    string `json:"workId"`
	}
	if decodeExchange(body, &in) != nil || !exchangeID.MatchString(in.AccountID) || !validLeadWork(in.WorkID) {
		return nil, collectionInvalid()
	}
	if _, err := s.db.ExecContext(ctx, `UPDATE keagent_comment_consents SET revoked=true
		WHERE owner_id=$1 AND device_id=$2 AND account_id=$3 AND work_id=$4`,
		a.UserID, a.DeviceID, in.AccountID, in.WorkID); err != nil {
		return nil, err
	}
	return object{"ok": true}, nil
}

func loadCreatorHubConsent(ctx context.Context, tx *sql.Tx, a actor, scope commentScope) (*commentGrant, error) {
	var label, baseURL, creatorHubAccountID, aiEndpoint string
	var purposes []byte
	var expires time.Time
	var retention int
	var revoked bool
	err := tx.QueryRowContext(ctx, `SELECT label,purposes,expires_at,retention_days,base_url,
		creatorhub_account_id,ai_endpoint,revoked FROM keagent_comment_consents
		WHERE owner_id=$1 AND device_id=$2 AND account_id=$3 AND work_id=$4 FOR SHARE`,
		a.UserID, a.DeviceID, scope.AccountID, scope.WorkID).Scan(
		&label, &purposes, &expires, &retention, &baseURL, &creatorHubAccountID, &aiEndpoint, &revoked)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return consentGrant(a, scope, label, baseURL, creatorHubAccountID, aiEndpoint, purposes, expires, retention, revoked), nil
}

func consentGrant(a actor, scope commentScope, label, baseURL, creatorHubAccountID, aiEndpoint string, purposes []byte, expires time.Time, retention int, revoked bool) *commentGrant {
	var grant struct {
		AnalyzeWithAI bool `json:"analyzeWithAI"`
		ManualContact bool `json:"manualContact"`
	}
	// Malformed purposes deny both uses.
	_ = json.Unmarshal(purposes, &grant)
	// Expiry refreshes must not rotate the source policy key; identity and purposes only.
	kind, ref := "creatorhub", "creatorhub:"+creatorHubAccountID
	if baseURL == "" && creatorHubAccountID == "" {
		kind, ref = "electron", "electron:"+scope.AccountID
	}
	stableKey := exchangeFingerprint([]any{
		kind + "-consent", a.UserID, a.DeviceID, scope.AccountID, scope.WorkID,
		ref, grant.AnalyzeWithAI, grant.ManualContact,
	})
	return &commentGrant{
		OwnerID: a.UserID, DeviceID: a.DeviceID, AccountID: scope.AccountID,
		WorkID: scope.WorkID, Ref: ref, Label: label,
		Kind: kind, ExpiresAt: expires, RetentionDays: retention,
		Fields: append([]string{}, allowedCommentFields...), AnalyzeWithAI: grant.AnalyzeWithAI,
		ManualContact: grant.ManualContact, AIEndpoint: aiEndpoint, Revoked: revoked,
		PolicyKey: stableKey,
	}
}
