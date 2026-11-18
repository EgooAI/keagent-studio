package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/mail"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf16"
)

const douyinSchema = `
CREATE TABLE IF NOT EXISTS keagent_douyin_account (
 id text PRIMARY KEY, owner_id text NOT NULL, device_id text NOT NULL, payload jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS keagent_douyin_account_owner ON keagent_douyin_account(owner_id,device_id);
CREATE TABLE IF NOT EXISTS keagent_douyin_publish (
 id text PRIMARY KEY, owner_id text NOT NULL, device_id text NOT NULL, artifact_id text NOT NULL,
 handoff_id text NOT NULL REFERENCES keagent_artifact_handoff(id), request_key text NOT NULL,
 fingerprint text NOT NULL, state text NOT NULL, payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), heartbeat_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,request_key));
CREATE INDEX IF NOT EXISTS keagent_douyin_publish_owner ON keagent_douyin_publish(owner_id,created_at DESC);
CREATE INDEX IF NOT EXISTS keagent_douyin_publish_artifact ON keagent_douyin_publish(owner_id,artifact_id,created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS keagent_douyin_health (
 id integer PRIMARY KEY CHECK(id=1), failures integer NOT NULL DEFAULT 0, window_at timestamptz,
 incident boolean NOT NULL DEFAULT false);
INSERT INTO keagent_douyin_health(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS keagent_douyin_observation (record_id text PRIMARY KEY, state text NOT NULL);
CREATE TABLE IF NOT EXISTS keagent_douyin_mail (
 id text PRIMARY KEY, kind text NOT NULL, record_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 next_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz, attempts integer NOT NULL DEFAULT 0);
`

type douyinInput struct {
	RequestKey  string   `json:"requestKey"`
	HandoffID   string   `json:"handoffId"`
	AccountID   string   `json:"accountId"`
	Title       string   `json:"title"`
	Description string   `json:"description"`
	Hashtags    []string `json:"hashtags"`
	CoverRef    string   `json:"coverRef,omitempty"`
	Batch       bool     `json:"batch,omitempty"`
	ScheduledAt int64    `json:"scheduledAt,omitempty"`
}
type douyinLog struct {
	Step       string `json:"step"`
	Status     string `json:"status"`
	Timestamp  string `json:"timestamp"`
	DurationMS int64  `json:"durationMs,omitempty"`
	ErrorCode  string `json:"errorCode,omitempty"`
}
type douyinRecord struct {
	douyinInput
	ID           string      `json:"id"`
	OwnerID      string      `json:"ownerId"`
	DeviceID     string      `json:"deviceId"`
	ArtifactID   string      `json:"artifactId"`
	State        string      `json:"state"`
	Progress     int         `json:"progress"`
	CreatedAt    string      `json:"createdAt"`
	UpdatedAt    string      `json:"updatedAt"`
	ExternalID   string      `json:"externalId,omitempty"`
	URL          string      `json:"url,omitempty"`
	ResultSource string      `json:"resultSource,omitempty"`
	ErrorCode    string      `json:"errorCode,omitempty"`
	Logs         []douyinLog `json:"logs"`
}

var douyinWord = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}$`)
var douyinStep = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)
var douyinPostID = regexp.MustCompile(`^[0-9]{5,30}$`)

func validateDouyinInput(v douyinInput) error {
	caption := strings.TrimSpace(v.Description)
	if v.Hashtags == nil || len(v.Hashtags) > 30 {
		return exchangeFail(422, "INVALID_INPUT", "话题过多")
	}
	for _, tag := range v.Hashtags {
		clean := strings.TrimPrefix(tag, "#")
		if clean == "" || len(utf16.Encode([]rune(clean))) > 100 || strings.ContainsAny(clean, "# \t\r\n\x00") {
			return exchangeFail(422, "INVALID_INPUT", "话题格式无效")
		}
		for _, r := range clean {
			if unicode.IsSpace(r) || r < 32 {
				return exchangeFail(422, "INVALID_INPUT", "话题格式无效")
			}
		}
		if caption != "" {
			caption += " "
		}
		caption += "#" + clean
	}
	if !exchangeKey.MatchString(v.RequestKey) || !exchangeID.MatchString(v.HandoffID) || !exchangeID.MatchString(v.AccountID) || strings.TrimSpace(v.Title) == "" || len(utf16.Encode([]rune(v.Title))) > 30 || len(utf16.Encode([]rune(caption))) > 1000 || (v.CoverRef != "" && !exchangeID.MatchString(v.CoverRef)) {
		return exchangeFail(422, "INVALID_INPUT", "发布参数无效；标题最多30字符，正文与话题合计最多1000字符")
	}
	if v.ScheduledAt != 0 && (v.Batch || v.ScheduledAt < 0 || v.ScheduledAt%60 != 0) {
		return exchangeFail(422, "INVALID_SCHEDULE", "定时发布须选择有效的单条预约时间")
	}
	for _, r := range v.Title + v.Description + strings.Join(v.Hashtags, "") {
		if r < 32 && r != '\n' && r != '\r' && r != '\t' {
			return exchangeFail(422, "INVALID_INPUT", "文案包含无效字符")
		}
	}
	return nil
}
func validDouyinResult(externalID, link string) bool {
	return douyinPostID.MatchString(externalID) && link == "https://www.douyin.com/video/"+externalID
}
func validDouyinLogs(logs []douyinLog) bool {
	if logs == nil || len(logs) > 128 {
		return false
	}
	for _, entry := range logs {
		_, err := time.Parse(time.RFC3339Nano, entry.Timestamp)
		if !douyinStep.MatchString(entry.Step) || err != nil || entry.DurationMS < 0 || entry.DurationMS > 86400000 || (entry.Status != "started" && entry.Status != "completed" && entry.Status != "failed") || (entry.ErrorCode != "" && !douyinWord.MatchString(entry.ErrorCode)) {
			return false
		}
	}
	return true
}
func readDouyinRecord(ctx context.Context, q exchangeReader, owner, recordID string, lock bool) (douyinRecord, error) {
	var v douyinRecord
	var raw []byte
	query := `SELECT payload FROM keagent_douyin_publish WHERE owner_id=$1 AND id=$2`
	if lock {
		query += ` FOR UPDATE`
	}
	err := q.QueryRowContext(ctx, query, owner, recordID).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return v, exchangeFail(404, "NOT_FOUND", "发布记录不存在")
	}
	if err != nil {
		return v, err
	}
	err = json.Unmarshal(raw, &v)
	return v, err
}
func writeDouyinRecord(ctx context.Context, tx *sql.Tx, v douyinRecord) error {
	raw, _ := json.Marshal(v)
	_, err := tx.ExecContext(ctx, `UPDATE keagent_douyin_publish SET payload=$3,state=$4,heartbeat_at=now() WHERE owner_id=$1 AND id=$2`, v.OwnerID, v.ID, raw, v.State)
	return err
}
func (s *server) douyin(ctx context.Context, a actor, operation string, body []byte) (any, error) {
	if operation == "accounts/list" {
		rr, err := s.db.QueryContext(ctx, `SELECT payload FROM keagent_douyin_account WHERE owner_id=$1 AND NOT(payload ? 'unboundAt') ORDER BY id`, a.UserID)
		if err != nil {
			return nil, err
		}
		defer rr.Close()
		items := []object{}
		for rr.Next() {
			var raw []byte
			var v object
			if err = rr.Scan(&raw); err != nil {
				return nil, err
			}
			if err = json.Unmarshal(raw, &v); err != nil {
				return nil, err
			}
			if v["platform"] == nil {
				v["platform"] = "douyin"
			}
			items = append(items, v)
		}
		return object{"items": items}, rr.Err()
	}
	if operation == "workspace" {
		return s.publishWorkspace(ctx, a, body)
	}
	if operation == "records/list" {
		var in struct {
			ArtifactID string `json:"artifactId"`
			Limit      int    `json:"limit"`
			Offset     int    `json:"offset"`
		}
		if err := decodeExchange(body, &in); err != nil {
			return nil, err
		}
		if in.Limit == 0 {
			in.Limit = 20
		}
		if in.Limit < 1 || in.Limit > 100 || in.Offset < 0 {
			return nil, exchangeFail(422, "INVALID_INPUT", "分页参数无效")
		}
		where := ` WHERE owner_id=$1 AND ($2='' OR artifact_id=$2)`
		var total int
		if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM keagent_douyin_publish`+where, a.UserID, in.ArtifactID).Scan(&total); err != nil {
			return nil, err
		}
		rr, err := s.db.QueryContext(ctx, `SELECT payload FROM keagent_douyin_publish`+where+` ORDER BY created_at DESC,id DESC LIMIT $3 OFFSET $4`, a.UserID, in.ArtifactID, in.Limit, in.Offset)
		if err != nil {
			return nil, err
		}
		defer rr.Close()
		items := []douyinRecord{}
		for rr.Next() {
			var raw []byte
			var v douyinRecord
			if err = rr.Scan(&raw); err != nil {
				return nil, err
			}
			if err = json.Unmarshal(raw, &v); err != nil {
				return nil, err
			}
			items = append(items, v)
		}
		return object{"items": items, "total": total, "limit": in.Limit, "offset": in.Offset}, rr.Err()
	}
	if operation == "records/get" {
		var in struct {
			ID string `json:"id"`
		}
		if err := decodeExchange(body, &in); err != nil {
			return nil, err
		}
		return readDouyinRecord(ctx, s.db, a.UserID, in.ID, false)
	}
	if err := requireExchangeDevice(a); err != nil {
		return nil, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var result any
	switch operation {
	case "accounts/bind", "accounts/update", "accounts/unbind":
		if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "douyin:"+a.DeviceID); err != nil {
			return nil, err
		}
		var in struct {
			ID             string `json:"id"`
			Name           string `json:"name"`
			Platform       string `json:"platform,omitempty"`
			SavedProfile   bool   `json:"savedProfile,omitempty"`
			PlatformUserID string `json:"platformUserId,omitempty"`
			LoginStatus    string `json:"loginStatus"`
		}
		if err = decodeExchange(body, &in); err != nil {
			return nil, err
		}
		if (in.Platform != "" && in.Platform != "douyin" && in.Platform != "xhs") || !exchangeID.MatchString(in.ID) || len([]rune(in.Name)) > 100 || len(in.PlatformUserID) > 150 {
			return nil, exchangeFail(422, "INVALID_INPUT", "账号参数无效")
		}
		if !strings.Contains(",logged_in,logged_out,expired,verification_required,risk_controlled,profile_unavailable,unknown,", ","+in.LoginStatus+",") {
			return nil, exchangeFail(422, "INVALID_INPUT", "登录状态无效")
		}
		var raw []byte
		var account object
		err = tx.QueryRowContext(ctx, `SELECT payload FROM keagent_douyin_account WHERE id=$1 AND owner_id=$2 AND device_id=$3 FOR UPDATE`, in.ID, a.UserID, a.DeviceID).Scan(&raw)
		if errors.Is(err, sql.ErrNoRows) && operation == "accounts/bind" {
			platform := in.Platform
			if platform == "" {
				platform = "douyin"
			}
			account = object{"id": in.ID, "deviceId": a.DeviceID, "platform": platform}
			err = nil
		} else if errors.Is(err, sql.ErrNoRows) {
			return nil, exchangeFail(404, "NOT_FOUND", "账号不存在或不属于当前设备")
		} else if err == nil {
			err = json.Unmarshal(raw, &account)
		}
		if err != nil {
			return nil, err
		}
		if account["platform"] == nil {
			account["platform"] = "douyin"
		}
		if in.Platform != "" && in.Platform != account["platform"] {
			return nil, exchangeFail(409, "ACCOUNT_CHANGED", "已绑定的账号不能切换平台")
		}
		if account["unboundAt"] != nil {
			return nil, exchangeFail(409, "ACCOUNT_UNAVAILABLE", "账号已解绑")
		}
		if operation == "accounts/unbind" {
			var busy bool
			err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM keagent_douyin_publish WHERE owner_id=$1 AND payload->>'accountId'=$2 AND state IN('running','submitting','unknown'))`, a.UserID, in.ID).Scan(&busy)
			if err != nil {
				return nil, err
			}
			if busy {
				return nil, exchangeFail(409, "ACCOUNT_BUSY", "请先完成发布或核对未知结果")
			}
			account["unboundAt"] = now()
		} else {
			if in.SavedProfile {
				if operation != "accounts/update" || in.PlatformUserID == "" || in.LoginStatus != "logged_in" {
					return nil, exchangeFail(422, "INVALID_INPUT", "请先确认平台账号身份")
				}
				// The device advisory lock above serializes concurrent profile saves.
				var duplicate bool
				if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM keagent_douyin_account WHERE owner_id=$1 AND device_id=$2 AND id<>$3 AND NOT(payload ? 'unboundAt') AND COALESCE(payload->>'platform','douyin')=$4 AND payload->>'platformUserId'=$5 AND payload->>'savedProfile'='true')`, a.UserID, a.DeviceID, in.ID, account["platform"], in.PlatformUserID).Scan(&duplicate); err != nil {
					return nil, err
				}
				if duplicate {
					return nil, exchangeFail(409, "ACCOUNT_ALREADY_BOUND", "本机已保存这个平台账号，请直接使用已有账号")
				}
				account["savedProfile"] = true
			}
			account["name"] = in.Name
			account["loginStatus"] = in.LoginStatus
			account["lastCheckedAt"] = now()
			if in.PlatformUserID != "" {
				if prior := str(account["platformUserId"]); prior != "" && prior != in.PlatformUserID {
					return nil, exchangeFail(409, "ACCOUNT_CHANGED", "该浏览器资料已绑定其他平台账号，请新增账号")
				}
				account["platformUserId"] = in.PlatformUserID
			}
		}
		raw, _ = json.Marshal(account)
		var accountWrite sql.Result
		accountWrite, err = tx.ExecContext(ctx, `INSERT INTO keagent_douyin_account(id,owner_id,device_id,payload) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload WHERE keagent_douyin_account.owner_id=EXCLUDED.owner_id AND keagent_douyin_account.device_id=EXCLUDED.device_id`, in.ID, a.UserID, a.DeviceID, raw)
		if err == nil {
			rows, e := accountWrite.RowsAffected()
			if e != nil {
				return nil, e
			}
			if rows != 1 {
				return nil, exchangeFail(404, "NOT_FOUND", "账号引用不可用")
			}
		}
		result = account
	case "records/create":
		var in douyinInput
		if err = decodeExchange(body, &in); err != nil {
			return nil, err
		}
		if err = validateDouyinInput(in); err != nil {
			return nil, err
		}
		_, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "douyin:"+a.DeviceID)
		if err != nil {
			return nil, err
		}
		var priorRaw []byte
		var fingerprint string
		err = tx.QueryRowContext(ctx, `SELECT payload,fingerprint FROM keagent_douyin_publish WHERE owner_id=$1 AND request_key=$2`, a.UserID, in.RequestKey).Scan(&priorRaw, &fingerprint)
		if err == nil {
			if fingerprint != exchangeFingerprint(in) {
				return nil, exchangeFail(409, "IDEMPOTENCY_CONFLICT", "请求键已绑定另一发布操作")
			}
			var prior douyinRecord
			if err = json.Unmarshal(priorRaw, &prior); err != nil {
				return nil, err
			}
			if prior.DeviceID != a.DeviceID {
				return nil, exchangeFail(409, "WRONG_DEVICE", "发布记录属于另一设备")
			}
			return object{"record": prior, "created": false}, nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		if in.ScheduledAt != 0 {
			offset := in.ScheduledAt - time.Now().Unix()
			if offset < 2*3600 || offset > 14*86400 {
				return nil, exchangeFail(422, "INVALID_SCHEDULE", "预约时间须在 2 小时至 14 天内")
			}
		}
		var busy bool
		if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM keagent_douyin_publish WHERE owner_id=$1 AND device_id=$2 AND state IN('running','submitting'))`, a.UserID, a.DeviceID).Scan(&busy); err != nil {
			return nil, err
		}
		if busy {
			return nil, exchangeFail(409, "DEVICE_BUSY", "当前设备已有发布正在执行")
		}
		var handoffRaw []byte
		err = tx.QueryRowContext(ctx, `SELECT payload FROM keagent_artifact_handoff WHERE id=$1 AND owner_id=$2`, in.HandoffID, a.UserID).Scan(&handoffRaw)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, exchangeFail(404, "NOT_FOUND", "交接不存在")
		}
		if err != nil {
			return nil, err
		}
		var handoff artifactHandoff
		if err = json.Unmarshal(handoffRaw, &handoff); err != nil {
			return nil, err
		}
		if handoff.DeviceID != a.DeviceID {
			return nil, exchangeFail(409, "WRONG_DEVICE", "交接属于另一设备")
		}
		lock := " FOR SHARE"
		if in.Batch {
			lock = " FOR UPDATE"
		}
		current, e := readExchangeArtifact(ctx, tx, a.UserID, handoff.Artifact.ID, lock)
		if e != nil {
			return nil, e
		}
		if current.Review.State != "approved" || current.Review.Revision != handoff.Artifact.Review.Revision {
			return nil, exchangeFail(409, "REVISION_CONFLICT", "请重新接收已验收成片")
		}
		if _, e = readArtifactAssets(ctx, tx, a, current.Assets, true); e != nil {
			return nil, e
		}
		var accountOK bool
		if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM keagent_douyin_account WHERE id=$1 AND owner_id=$2 AND device_id=$3 AND NOT(payload ? 'unboundAt') AND COALESCE(payload->>'platform','douyin')='douyin' AND payload->>'loginStatus'='logged_in')`, in.AccountID, a.UserID, a.DeviceID).Scan(&accountOK); err != nil {
			return nil, err
		}
		if !accountOK {
			return nil, exchangeFail(409, "ACCOUNT_UNAVAILABLE", "请先登录并保存抖音账号")
		}
		if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM keagent_douyin_publish WHERE owner_id=$1 AND artifact_id=$2 AND payload->>'accountId'=$3 AND state='unknown')`, a.UserID, current.ID, in.AccountID).Scan(&busy); err != nil {
			return nil, err
		}
		if busy {
			return nil, exchangeFail(409, "OUTCOME_UNRESOLVED", "请先核对该成片在此账号的上次发布结果")
		}
		if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM keagent_douyin_publish
			WHERE owner_id=$1 AND artifact_id=$2 AND payload->>'accountId'=$3 AND state='accepted'
			AND (payload ? 'scheduledAt' OR $4))`, a.UserID, current.ID, in.AccountID, in.ScheduledAt != 0).Scan(&busy); err != nil {
			return nil, err
		}
		if busy {
			return nil, exchangeFail(409, "ARTIFACT_ALREADY_SUBMITTED", "该成片已提交到此抖音账号")
		}
		if in.Batch {
			var state string
			err = tx.QueryRowContext(ctx, `SELECT state FROM keagent_douyin_publish WHERE owner_id=$1 AND artifact_id=$2
				AND state IN('running','submitting','accepted','unknown')
				ORDER BY (state='unknown') DESC,created_at DESC,id DESC LIMIT 1`, a.UserID, current.ID).Scan(&state)
			if err == nil {
				if state == "unknown" {
					return nil, exchangeFail(409, "OUTCOME_UNRESOLVED", "请先核对该成片的上次发布结果")
				}
				return nil, exchangeFail(409, "ARTIFACT_ALREADY_SUBMITTED", "该成片已有发布提交或正在执行")
			}
			if !errors.Is(err, sql.ErrNoRows) {
				return nil, err
			}
		}
		v := douyinRecord{douyinInput: in, ID: id(), OwnerID: a.UserID, DeviceID: a.DeviceID, ArtifactID: current.ID, State: "running", CreatedAt: now(), UpdatedAt: now(), Logs: []douyinLog{}}
		raw, _ := json.Marshal(v)
		_, err = tx.ExecContext(ctx, `INSERT INTO keagent_douyin_publish(id,owner_id,device_id,artifact_id,handoff_id,request_key,fingerprint,state,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, v.ID, a.UserID, a.DeviceID, v.ArtifactID, in.HandoffID, in.RequestKey, exchangeFingerprint(in), v.State, raw)
		result = object{"record": v, "created": true}
	case "records/report":
		var in douyinRecord
		if err = decodeExchange(body, &in); err != nil {
			return nil, err
		}
		v, e := readDouyinRecord(ctx, tx, a.UserID, in.ID, true)
		if e != nil {
			return nil, e
		}
		if v.DeviceID != a.DeviceID {
			return nil, exchangeFail(409, "WRONG_DEVICE", "发布属于另一设备")
		}
		if exchangeFingerprint(in.douyinInput) != exchangeFingerprint(v.douyinInput) || !validDouyinLogs(in.Logs) || in.Progress < 0 || in.Progress > 100 || (in.ErrorCode != "" && !douyinWord.MatchString(in.ErrorCode)) {
			return nil, exchangeFail(422, "INVALID_INPUT", "发布回报无效")
		}
		if !douyinTransition(v, in) {
			return nil, exchangeFail(409, "STATE_CONFLICT", "发布状态已改变，请刷新")
		}
		if v.ResultSource == "manual" {
			return v, nil
		}
		v.State = in.State
		v.Progress = in.Progress
		v.ErrorCode = in.ErrorCode
		v.ExternalID = in.ExternalID
		v.URL = in.URL
		v.Logs = in.Logs
		v.ResultSource = in.ResultSource
		v.UpdatedAt = now()
		if err = writeDouyinRecord(ctx, tx, v); err != nil {
			return nil, err
		}
		if err = observeDouyin(ctx, tx, v); err != nil {
			return nil, err
		}
		result = v
	case "records/heartbeat":
		var in struct {
			ID string `json:"id"`
		}
		if err = decodeExchange(body, &in); err != nil {
			return nil, err
		}
		v, e := readDouyinRecord(ctx, tx, a.UserID, in.ID, true)
		if e != nil {
			return nil, e
		}
		if v.DeviceID != a.DeviceID {
			return nil, exchangeFail(409, "WRONG_DEVICE", "发布属于另一设备")
		}
		if v.State == "running" || v.State == "submitting" {
			_, err = tx.ExecContext(ctx, `UPDATE keagent_douyin_publish SET heartbeat_at=now() WHERE id=$1`, v.ID)
		}
		result = v
	case "records/reconcile":
		var in struct {
			ID        string `json:"id"`
			Published bool   `json:"published"`
			URL       string `json:"url"`
		}
		if err = decodeExchange(body, &in); err != nil {
			return nil, err
		}
		v, e := readDouyinRecord(ctx, tx, a.UserID, in.ID, true)
		if e != nil {
			return nil, e
		}
		if v.DeviceID != a.DeviceID {
			return nil, exchangeFail(409, "WRONG_DEVICE", "请在原设备核对")
		}
		if v.ResultSource == "manual" {
			if (in.Published && v.State == "accepted" && in.URL == v.URL) ||
				(!in.Published && in.URL == "" && (v.ErrorCode == "USER_CONFIRMED_NOT_PUBLISHED" || v.ErrorCode == "USER_CONFIRMED_SCHEDULE_CANCELED")) {
				return v, nil
			}
			return nil, exchangeFail(409, "STATE_CONFLICT", "人工核对结论已保存，不能改写")
		}
		scheduledConfirmation := v.State == "accepted" && v.ScheduledAt != 0
		if v.State != "unknown" && !scheduledConfirmation {
			return nil, exchangeFail(409, "STATE_CONFLICT", "只允许核对结果未知的发布")
		}
		v.ResultSource = "manual"
		v.UpdatedAt = now()
		if in.Published {
			priorExternalID := v.ExternalID
			u, e := url.Parse(in.URL)
			if e != nil {
				return nil, exchangeFail(422, "INVALID_INPUT", "作品链接无效")
			}
			v.ExternalID = strings.TrimPrefix(u.Path, "/video/")
			v.URL = in.URL
			if !validDouyinResult(v.ExternalID, v.URL) {
				return nil, exchangeFail(422, "INVALID_INPUT", "请输入抖音作品的完整视频链接")
			}
			if scheduledConfirmation && v.ExternalID != priorExternalID {
				return nil, exchangeFail(422, "INVALID_INPUT", "作品链接与预约回执不一致")
			}
			v.State = "accepted"
			v.Progress = 100
			v.ErrorCode = ""
		} else if scheduledConfirmation {
			v.State = "canceled"
			v.ExternalID, v.URL = "", ""
			v.ErrorCode = "USER_CONFIRMED_SCHEDULE_CANCELED"
		} else {
			v.State = "failed"
			v.ErrorCode = "USER_CONFIRMED_NOT_PUBLISHED"
		}
		if err = writeDouyinRecord(ctx, tx, v); err != nil {
			return nil, err
		}
		result = v
	default:
		return nil, fail(404, "抖音接口不存在")
	}
	if err != nil {
		return nil, err
	}
	if operation != "records/heartbeat" {
		_, err = tx.ExecContext(ctx, `INSERT INTO keagent_audit(id,actor_id,action,target_id,metadata) VALUES($1,$2,$3,$4,$5)`, id(), a.UserID, "douyin."+strings.ReplaceAll(operation, "/", "."), a.DeviceID, []byte(`{}`))
		if err != nil {
			return nil, err
		}
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return result, nil
}
func douyinTransition(prior, next douyinRecord) bool {
	if next.State == "accepted" && (!validDouyinResult(next.ExternalID, next.URL) || next.ResultSource != "platform") {
		return false
	}
	if next.State != "accepted" && (next.ExternalID != "" || next.URL != "" || next.ResultSource != "") {
		return false
	}
	if prior.ResultSource == "manual" {
		return false
	}
	switch prior.State {
	case "running":
		return next.State == "running" || next.State == "submitting" || next.State == "failed" || next.State == "canceled"
	case "submitting":
		return next.State == "submitting" || next.State == "accepted" || next.State == "unknown" || (next.State == "failed" && next.ErrorCode == "PLATFORM_REJECTED")
	case "unknown":
		return next.State == "unknown" || next.State == "accepted"
	case "failed":
		if prior.ErrorCode == "INTERRUPTED" {
			return next.State == "accepted" || next.State == "failed" || next.State == "canceled"
		}
	}
	return prior.State == next.State && prior.ExternalID == next.ExternalID && prior.ErrorCode == next.ErrorCode
}

func observeDouyin(ctx context.Context, tx *sql.Tx, v douyinRecord) error {
	if v.ResultSource == "manual" || (v.State != "accepted" && !(v.State == "failed" && v.ErrorCode == "EXECUTION_FAILED")) {
		return nil
	}
	var previous string
	err := tx.QueryRowContext(ctx, `SELECT state FROM keagent_douyin_observation WHERE record_id=$1`, v.ID).Scan(&previous)
	if err == nil {
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO keagent_douyin_observation(record_id,state) VALUES($1,$2)`, v.ID, v.State)
	if err != nil {
		return err
	}
	var count int
	var started sql.NullTime
	var incident bool
	if err = tx.QueryRowContext(ctx, `SELECT failures,window_at,incident FROM keagent_douyin_health WHERE id=1 FOR UPDATE`).Scan(&count, &started, &incident); err != nil {
		return err
	}
	kind := ""
	if v.State == "accepted" {
		if incident {
			kind = "recovery"
		}
		count = 0
		started = sql.NullTime{}
		incident = false
	} else {
		if !started.Valid || time.Since(started.Time) > 24*time.Hour {
			count = 0
			started = sql.NullTime{Time: time.Now(), Valid: true}
		}
		count++
		if count >= 3 && !incident {
			incident = true
			kind = "failure"
		}
	}
	_, err = tx.ExecContext(ctx, `UPDATE keagent_douyin_health SET failures=$1,window_at=$2,incident=$3 WHERE id=1`, count, started, incident)
	if err != nil {
		return err
	}
	if kind != "" {
		_, err = tx.ExecContext(ctx, `INSERT INTO keagent_douyin_mail(id,kind,record_id) VALUES($1,$2,$3)`, id(), kind, v.ID)
	}
	return err
}

func (s *server) sweepDouyin(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `UPDATE keagent_douyin_publish SET state=CASE WHEN state='submitting' THEN 'unknown' ELSE 'failed' END,
 payload=payload || jsonb_build_object('state',CASE WHEN state='submitting' THEN 'unknown' ELSE 'failed' END,'errorCode',CASE WHEN state='submitting' THEN 'PUBLISH_OUTCOME_UNKNOWN' ELSE 'INTERRUPTED' END,'updatedAt',$1::text)
 WHERE state IN('running','submitting') AND heartbeat_at < now()-interval '90 seconds'`, now())
	return err
}

func (s *server) adminDouyin(r *http.Request, a actor, body []byte) (any, error) {
	ctx := r.Context()
	op := strings.TrimPrefix(r.URL.Path, "/v1/admin/douyin/")
	if op == "settings" {
		if r.Method == "POST" {
			var in struct {
				OperationsEmail string `json:"operationsEmail"`
			}
			if err := decodeExchange(body, &in); err != nil {
				return nil, err
			}
			in.OperationsEmail = strings.TrimSpace(in.OperationsEmail)
			if in.OperationsEmail != "" {
				email, err := mail.ParseAddress(in.OperationsEmail)
				if err != nil || email.Address != in.OperationsEmail || len(in.OperationsEmail) > 254 {
					return nil, exchangeFail(422, "INVALID_INPUT", "运维邮箱无效")
				}
			}
			raw, _ := json.Marshal(in)
			tx, err := s.db.BeginTx(ctx, nil)
			if err != nil {
				return nil, err
			}
			defer tx.Rollback()
			if _, err = tx.ExecContext(ctx, `INSERT INTO keagent_setting(id,payload) VALUES('douyin-alerts',$1) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload`, raw); err != nil {
				return nil, err
			}
			if _, err = tx.ExecContext(ctx, `INSERT INTO keagent_audit(id,actor_id,action,target_id) VALUES($1,$2,'douyin.alerts.update','douyin-alerts')`, id(), a.UserID); err != nil {
				return nil, err
			}
			if err = tx.Commit(); err != nil {
				return nil, err
			}
		} else if r.Method != "GET" {
			return nil, fail(405, "方法不支持")
		}
		var raw []byte
		err := s.db.QueryRowContext(ctx, `SELECT payload FROM keagent_setting WHERE id='douyin-alerts'`).Scan(&raw)
		settings := object{"operationsEmail": "", "smtpConfigured": douyinSMTPConfigured()}
		if err == nil {
			var v object
			if err = json.Unmarshal(raw, &v); err != nil {
				return nil, err
			}
			settings["operationsEmail"] = v["operationsEmail"]
		} else if !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		return settings, nil
	}
	if r.Method != "GET" {
		return nil, fail(405, "管理发布记录只读")
	}
	if op == "health" {
		var failures int
		var incident bool
		if err := s.db.QueryRowContext(ctx, `SELECT failures,incident FROM keagent_douyin_health WHERE id=1`).Scan(&failures, &incident); err != nil {
			return nil, err
		}
		var pending int
		if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM keagent_douyin_mail WHERE sent_at IS NULL`).Scan(&pending); err != nil {
			return nil, err
		}
		return object{"failures": failures, "incident": incident, "pendingEmails": pending}, nil
	}
	if op == "detail" {
		var raw []byte
		err := s.db.QueryRowContext(ctx, `SELECT payload FROM keagent_douyin_publish WHERE id=$1`, r.URL.Query().Get("id")).Scan(&raw)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, exchangeFail(404, "NOT_FOUND", "记录不存在")
		}
		if err != nil {
			return nil, err
		}
		var v douyinRecord
		if err = json.Unmarshal(raw, &v); err != nil {
			return nil, err
		}
		return douyinAdminProjection(v, true), nil
	}
	if op != "records" && op != "summary" {
		return nil, fail(404, "抖音管理接口不存在")
	}
	query := r.URL.Query()
	limit := 20
	offset := 0
	var err error
	if query.Get("limit") != "" {
		limit, err = strconv.Atoi(query.Get("limit"))
		if err != nil {
			return nil, exchangeFail(422, "INVALID_INPUT", "分页无效")
		}
	}
	if query.Get("offset") != "" {
		offset, err = strconv.Atoi(query.Get("offset"))
		if err != nil {
			return nil, exchangeFail(422, "INVALID_INPUT", "分页无效")
		}
	}
	if limit < 1 || limit > 100 || offset < 0 {
		return nil, exchangeFail(422, "INVALID_INPUT", "分页无效")
	}
	from, to := query.Get("from"), query.Get("to")
	for _, v := range []string{from, to} {
		if v != "" {
			if _, err = time.Parse(time.RFC3339, v); err != nil {
				return nil, exchangeFail(422, "INVALID_INPUT", "时间范围无效")
			}
		}
	}
	where := ` WHERE ($1='' OR owner_id=$1) AND ($2='' OR device_id=$2) AND ($3='' OR state=$3) AND ($4='' OR payload->>'errorCode'=$4) AND ($5='' OR created_at>=NULLIF($5,'')::timestamptz) AND ($6='' OR created_at<=NULLIF($6,'')::timestamptz)`
	args := []any{query.Get("ownerId"), query.Get("deviceId"), query.Get("state"), query.Get("errorCode"), from, to}
	if op == "summary" {
		rr, e := s.db.QueryContext(ctx, `SELECT state,count(*) FROM keagent_douyin_publish`+where+` GROUP BY state`, args...)
		if e != nil {
			return nil, e
		}
		defer rr.Close()
		states := object{}
		total := 0
		for rr.Next() {
			var state string
			var count int
			if e = rr.Scan(&state, &count); e != nil {
				return nil, e
			}
			states[state] = count
			total += count
		}
		return object{"total": total, "states": states}, rr.Err()
	}
	var total int
	if err = s.db.QueryRowContext(ctx, `SELECT count(*) FROM keagent_douyin_publish`+where, args...).Scan(&total); err != nil {
		return nil, err
	}
	args = append(args, limit, offset)
	rr, err := s.db.QueryContext(ctx, `SELECT payload FROM keagent_douyin_publish`+where+` ORDER BY created_at DESC,id DESC LIMIT $7 OFFSET $8`, args...)
	if err != nil {
		return nil, err
	}
	defer rr.Close()
	items := []object{}
	for rr.Next() {
		var raw []byte
		var v douyinRecord
		if err = rr.Scan(&raw); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(raw, &v); err != nil {
			return nil, err
		}
		items = append(items, douyinAdminProjection(v, false))
	}
	return object{"items": items, "total": total, "limit": limit, "offset": offset}, rr.Err()
}
func douyinAdminProjection(v douyinRecord, detail bool) object {
	result := object{"id": v.ID, "ownerId": v.OwnerID, "deviceId": v.DeviceID, "artifactId": v.ArtifactID, "handoffId": v.HandoffID, "accountId": v.AccountID, "state": v.State, "progress": v.Progress, "createdAt": v.CreatedAt, "updatedAt": v.UpdatedAt, "errorCode": v.ErrorCode, "externalId": v.ExternalID, "url": v.URL, "resultSource": v.ResultSource}
	if detail {
		result["logs"] = v.Logs
	}
	return result
}
