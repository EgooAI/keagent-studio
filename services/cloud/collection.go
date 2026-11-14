package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5/pgconn"
)

// Each cloud workspace is keyed by its authenticated owner. Profile paths never enter this schema.
const collectionSchema = `
CREATE TABLE IF NOT EXISTS keagent_collection_targets (
 id text PRIMARY KEY, owner_id text NOT NULL, device_id text NOT NULL,
 seq bigserial UNIQUE NOT NULL, request_key text NOT NULL, fingerprint text NOT NULL, payload jsonb NOT NULL,
 UNIQUE(owner_id,device_id,id), UNIQUE(owner_id,device_id,request_key));
CREATE UNIQUE INDEX IF NOT EXISTS keagent_collection_target_active ON keagent_collection_targets
 (owner_id,device_id,(payload->>'accountId'),(payload->>'kind'),(payload->>'value')) WHERE payload->>'state'<>'archived';
CREATE INDEX IF NOT EXISTS keagent_collection_target_list ON keagent_collection_targets(owner_id,device_id,seq DESC);
CREATE TABLE IF NOT EXISTS keagent_collection_runs (
 id text PRIMARY KEY, owner_id text NOT NULL, device_id text NOT NULL, target_id text NOT NULL,
 seq bigserial UNIQUE NOT NULL, request_key text NOT NULL, fingerprint text NOT NULL, payload jsonb NOT NULL,
 lease_token text NOT NULL DEFAULT '', expires_at timestamptz, observed_at timestamptz,
 UNIQUE(owner_id,device_id,request_key), UNIQUE(owner_id,id),
 FOREIGN KEY(owner_id,device_id,target_id) REFERENCES keagent_collection_targets(owner_id,device_id,id));
CREATE UNIQUE INDEX IF NOT EXISTS keagent_collection_run_active ON keagent_collection_runs(target_id)
 WHERE payload->>'state' IN ('queued','running');
CREATE INDEX IF NOT EXISTS keagent_collection_run_list ON keagent_collection_runs(owner_id,device_id,seq DESC);
CREATE INDEX IF NOT EXISTS keagent_collection_run_target ON keagent_collection_runs(target_id,seq DESC);
CREATE INDEX IF NOT EXISTS keagent_collection_run_verified ON keagent_collection_runs
 (owner_id,device_id,(payload->>'verifiedWorkId'),observed_at DESC,seq DESC) WHERE observed_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS keagent_monitored_videos (
 owner_id text NOT NULL, work_id text NOT NULL, last_run_id text NOT NULL, observed_at timestamptz NOT NULL,
 PRIMARY KEY(owner_id,work_id), FOREIGN KEY(owner_id,last_run_id) REFERENCES keagent_collection_runs(owner_id,id));
`

type targetFields struct {
	Kind      string `json:"kind"`
	Value     string `json:"value"`
	Name      string `json:"name"`
	AccountID string `json:"accountId"`
}
type collectionTarget struct {
	targetFields
	ID        string `json:"id"`
	DeviceID  string `json:"deviceId"`
	State     string `json:"state"`
	Version   int    `json:"version"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}
type observedAuthor struct {
	Name string `json:"name"`
	URL  string `json:"url"`
}
type collectionResult struct {
	State          string          `json:"state"`
	PanelStatus    string          `json:"panelStatus"`
	VerifiedWorkID string          `json:"verifiedWorkId,omitempty"`
	Title          string          `json:"title,omitempty"`
	Author         *observedAuthor `json:"author,omitempty"`
	ErrorCode      string          `json:"errorCode,omitempty"`
	Reason         string          `json:"reason,omitempty"`
}
type collectionRun struct {
	collectionResult
	ID             string `json:"id"`
	TargetID       string `json:"targetId"`
	TargetName     string `json:"targetName"`
	TargetArchived bool   `json:"targetArchived,omitempty"`
	TargetVersion  int    `json:"targetVersion"`
	TargetURL      string `json:"targetUrl"`
	InputWorkID    string `json:"inputWorkId"`
	AccountID      string `json:"accountId"`
	DeviceID       string `json:"deviceId"`
	CreatedAt      string `json:"createdAt"`
	StartedAt      string `json:"startedAt,omitempty"`
	EndedAt        string `json:"endedAt,omitempty"`
}

var collectionCreatorPath = regexp.MustCompile(`^/user/[A-Za-z0-9_-]+/?$`)
var collectionVideoPath = regexp.MustCompile(`^/video/([0-9]{5,30})/?$`)

const videoBase = "https://www.douyin.com/video/"

func collectionInvalid() error {
	return exchangeFail(422, "INVALID_INPUT", "目标或运行参数无效")
}
func collectionMissing() error {
	return exchangeFail(404, "NOT_FOUND", "此设备工作区内没有该记录")
}

func cleanTarget(in *targetFields) error {
	in.Name = strings.TrimSpace(in.Name)
	in.Value = strings.TrimSpace(in.Value)
	if !exchangeID.MatchString(in.AccountID) || !validExchangeText(in.Name, 80) || strings.IndexFunc(in.Name, unicode.IsControl) >= 0 {
		return collectionInvalid()
	}
	if in.Kind == "keyword" {
		if !validExchangeText(in.Value, 100) || strings.IndexFunc(in.Value, unicode.IsControl) >= 0 {
			return collectionInvalid()
		}
		return nil
	}
	u, err := url.Parse(in.Value)
	if err != nil || len(in.Value) > 2048 || u.Scheme != "https" || !(strings.EqualFold(u.Host, "www.douyin.com") || strings.EqualFold(u.Host, "www.douyin.com:443")) || u.User != nil || u.RawPath != "" || strings.Contains(in.Value, "\\") || strings.IndexFunc(in.Value, unicode.IsSpace) >= 0 {
		return exchangeFail(422, "INVALID_TARGET", "请填写完整的抖音标准链接")
	}
	if in.Kind == "creator" && collectionCreatorPath.MatchString(u.Path) {
		in.Value = "https://www.douyin.com" + strings.TrimSuffix(u.Path, "/")
		return nil
	}
	if in.Kind == "video" {
		query, err := url.ParseQuery(u.RawQuery)
		if err != nil {
			return collectionInvalid()
		}
		modal := query["modal_id"]
		video := ""
		if path := collectionVideoPath.FindStringSubmatch(u.Path); path != nil && (len(modal) == 0 || (len(modal) == 1 && modal[0] == path[1])) {
			video = path[1]
		}
		if collectionCreatorPath.MatchString(u.Path) && len(modal) == 1 && douyinPostID.MatchString(modal[0]) {
			video = modal[0]
		}
		if video != "" {
			in.Value = videoBase + video
			return nil
		}
	}
	return exchangeFail(422, "INVALID_TARGET", "目标类型与抖音链接不匹配")
}

func (s *server) collection(ctx context.Context, a actor, op string, body []byte) (any, error) {
	if a.DeviceID == "" {
		return nil, exchangeFail(403, "DEVICE_REQUIRED", "请使用已绑定的桌面设备")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	// The same lock order applies to user edits, the executor and expiry. Other devices remain independent.
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "collection:"+a.DeviceID); err != nil {
		return nil, err
	}
	var valid int
	err = tx.QueryRowContext(ctx, `SELECT 1 FROM keagent_device WHERE id=$1 AND owner_id=$2 AND session_id=$3 AND NOT revoked FOR SHARE`, a.DeviceID, a.UserID, a.SessionID).Scan(&valid)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, exchangeFail(403, "DEVICE_REQUIRED", "设备已解绑或登录会话已失效")
	}
	if err != nil {
		return nil, err
	}
	_, err = tx.ExecContext(ctx, `UPDATE keagent_collection_runs SET expires_at=NULL,payload=payload ||
	  jsonb_build_object('state','interrupted','endedAt',CURRENT_TIMESTAMP,'errorCode','INTERRUPTED','reason','设备未在有效期内回报运行状态')
	  WHERE owner_id=$1 AND device_id=$2 AND expires_at <= clock_timestamp()`, a.UserID, a.DeviceID)
	if err != nil {
		return nil, err
	}
	var v any
	switch op {
	case "targets/create", "targets/update", "targets/pause", "targets/resume", "targets/archive":
		v, err = changeTarget(ctx, tx, a, op, body)
	case "runs/create":
		v, err = createCollectionRun(ctx, tx, a, body)
	case "runs/claim", "runs/heartbeat", "runs/finish", "runs/cancel":
		v, err = changeRun(ctx, tx, a, op, body)
	case "targets/list", "targets/get", "runs/list", "runs/get", "videos/list", "videos/get":
		v, err = collectionRead(ctx, tx, a, op, body)
	default:
		return nil, collectionMissing()
	}
	if err != nil {
		var pg *pgconn.PgError
		if errors.As(err, &pg) && pg.Code == "23505" {
			return nil, exchangeFail(409, "DUPLICATE_TARGET", "该账号已配置相同目标")
		}
		return nil, err
	}
	return v, tx.Commit()
}

func accountStatus(ctx context.Context, tx *sql.Tx, a actor, account string) (string, error) {
	var state string
	err := tx.QueryRowContext(ctx, `SELECT COALESCE(payload->>'loginStatus','unknown') FROM keagent_douyin_account WHERE id=$1 AND owner_id=$2 AND device_id=$3 AND NOT(payload ? 'unboundAt') FOR SHARE`, account, a.UserID, a.DeviceID).Scan(&state)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return state, err
}

func targetByID(ctx context.Context, tx *sql.Tx, a actor, id string) (collectionTarget, error) {
	var v collectionTarget
	var raw []byte
	err := tx.QueryRowContext(ctx, `SELECT payload FROM keagent_collection_targets WHERE owner_id=$1 AND device_id=$2 AND id=$3`, a.UserID, a.DeviceID, id).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return v, collectionMissing()
	}
	if err == nil {
		err = json.Unmarshal(raw, &v)
	}
	return v, err
}

func createCollectionRun(ctx context.Context, tx *sql.Tx, a actor, body []byte) (any, error) {
	var in struct {
		TargetID        string `json:"targetId"`
		ExpectedVersion int    `json:"expectedVersion"`
		RequestKey      string `json:"requestKey"`
	}
	if decodeExchange(body, &in) != nil || !exchangeID.MatchString(in.TargetID) || !exchangeKey.MatchString(in.RequestKey) || in.ExpectedVersion < 1 {
		return nil, collectionInvalid()
	}
	fp := exchangeFingerprint(in)
	var raw json.RawMessage
	var saved string
	err := tx.QueryRowContext(ctx, `SELECT fingerprint,payload FROM keagent_collection_runs WHERE owner_id=$1 AND device_id=$2 AND request_key=$3`, a.UserID, a.DeviceID, in.RequestKey).Scan(&saved, &raw)
	if err == nil {
		if saved != fp {
			return nil, exchangeFail(409, "REQUEST_CONFLICT", "同一请求已用于不同观察")
		}
		return raw, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	t, err := targetByID(ctx, tx, a, in.TargetID)
	if err != nil {
		return nil, err
	}
	if t.Version != in.ExpectedVersion || t.State != "active" {
		return nil, exchangeFail(409, "TARGET_CHANGED", "目标已更新或暂停，请刷新后重试")
	}
	if t.Kind != "video" {
		return nil, exchangeFail(409, "SOURCE_UNAVAILABLE", "当前仅支持单视频手动观察")
	}
	err = tx.QueryRowContext(ctx, `SELECT payload FROM keagent_collection_runs WHERE target_id=$1 AND expires_at IS NOT NULL`, t.ID).Scan(&raw)
	if err == nil {
		return nil, exchangeFail(409, "RUN_ACTIVE", "该目标已有正在执行的观察，请查看运行历史")
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	run := collectionRun{collectionResult: collectionResult{State: "queued", PanelStatus: "not_checked"}, ID: id(), TargetID: t.ID, TargetName: t.Name, TargetVersion: t.Version, TargetURL: t.Value, InputWorkID: strings.TrimPrefix(t.Value, videoBase), AccountID: t.AccountID, DeviceID: a.DeviceID, CreatedAt: now()}
	available, err := checkRunAccount(ctx, tx, a, &run)
	if err != nil {
		return nil, err
	}
	raw, _ = json.Marshal(run)
	_, err = tx.ExecContext(ctx, `INSERT INTO keagent_collection_runs(id,owner_id,device_id,target_id,request_key,fingerprint,payload,expires_at)
	VALUES($1,$2,$3,$4,$5,$6,$7,CASE WHEN $8 THEN now()+interval '10 minutes' END)`, run.ID, a.UserID, a.DeviceID, t.ID, in.RequestKey, fp, raw, available)
	return run, err
}

func checkRunAccount(ctx context.Context, tx *sql.Tx, a actor, r *collectionRun) (bool, error) {
	state, err := accountStatus(ctx, tx, a, r.AccountID)
	if err != nil {
		return false, err
	}
	if state == "logged_in" {
		return true, nil
	}
	res := collectionResult{State: "blocked", PanelStatus: "restricted", ErrorCode: "LOGIN_REQUIRED", Reason: "请先在本机账号浏览器确认登录"}
	switch state {
	case "":
		res.PanelStatus = "not_checked"
		res.ErrorCode = "ACCOUNT_UNAVAILABLE"
		res.Reason = "账号已解绑或不属于当前设备"
	case "verification_required":
		res.ErrorCode = "VERIFICATION_REQUIRED"
		res.Reason = "该抖音账号需要人工完成验证"
	case "risk_controlled":
		res.ErrorCode = "ACCESS_RESTRICTED"
		res.Reason = "平台限制了该账号的访问"
	}
	r.collectionResult, r.EndedAt = res, now()
	return false, nil
}

func changeRun(ctx context.Context, tx *sql.Tx, a actor, op string, body []byte) (any, error) {
	var runID, token, observed string
	var result collectionResult
	switch op {
	case "runs/cancel":
		var in struct {
			ID string `json:"id"`
		}
		if decodeExchange(body, &in) != nil {
			return nil, collectionInvalid()
		}
		runID = in.ID
	case "runs/finish":
		var in struct {
			collectionResult
			ID         string `json:"id"`
			LeaseToken string `json:"leaseToken"`
			ObservedAt string `json:"observedAt,omitempty"`
		}
		if decodeExchange(body, &in) != nil {
			return nil, collectionInvalid()
		}
		runID, token, result, observed = in.ID, in.LeaseToken, in.collectionResult, in.ObservedAt
	default:
		var in struct {
			ID         string `json:"id"`
			LeaseToken string `json:"leaseToken"`
		}
		if decodeExchange(body, &in) != nil {
			return nil, collectionInvalid()
		}
		runID, token = in.ID, in.LeaseToken
	}
	if !exchangeID.MatchString(runID) || (op != "runs/cancel" && !exchangeID.MatchString(token)) {
		return nil, collectionInvalid()
	}
	var raw json.RawMessage
	var stored string
	err := tx.QueryRowContext(ctx, `SELECT payload,lease_token FROM keagent_collection_runs WHERE owner_id=$1 AND device_id=$2 AND id=$3 FOR UPDATE`, a.UserID, a.DeviceID, runID).Scan(&raw, &stored)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, collectionMissing()
	}
	if err != nil {
		return nil, err
	}
	var r collectionRun
	if err = json.Unmarshal(raw, &r); err != nil {
		return nil, err
	}
	active := r.State == "queued" || r.State == "running"
	if op != "runs/cancel" && stored != "" && stored != token {
		return nil, exchangeFail(409, "LEASE_CONFLICT", "此运行由另一执行实例持有")
	}
	if !active {
		return r, nil
	}
	var seen *time.Time
	switch {
	case op == "runs/cancel":
		r.State, r.EndedAt, r.ErrorCode, r.Reason = "canceled", now(), "CANCELED", "已取消本次观察"
	case op != "runs/claim" && (r.State != "running" || stored == ""):
		return nil, exchangeFail(409, "LEASE_REQUIRED", "请先领取此观察任务")
	default:
		available, err := checkRunAccount(ctx, tx, a, &r)
		if err != nil {
			return nil, err
		}
		if available {
			switch op {
			case "runs/claim":
				stored = token
				if r.StartedAt == "" {
					r.StartedAt = now()
				}
				r.State = "running"
			case "runs/finish":
				if err := validateCollectionResult(r, result); err != nil {
					return nil, err
				}
				r.collectionResult = result
				r.EndedAt = now()
				t := time.Now().UTC()
				if observed != "" {
					t, err = time.Parse(time.RFC3339Nano, observed)
					start, _ := time.Parse(time.RFC3339Nano, r.CreatedAt)
					if err != nil || t.Before(start.Add(-5*time.Minute)) || t.After(time.Now().Add(5*time.Minute)) {
						return nil, collectionInvalid()
					}
				}
				if r.VerifiedWorkID != "" {
					seen = &t
				}
			}
		}
	}
	raw, _ = json.Marshal(r)
	_, err = tx.ExecContext(ctx, `UPDATE keagent_collection_runs SET payload=$2,lease_token=$3,
		expires_at=CASE WHEN $4 THEN clock_timestamp()+interval '10 minutes' END,observed_at=$5 WHERE id=$1`, r.ID, raw, stored, r.State == "running", seen)
	if err != nil {
		return nil, err
	}
	if seen != nil {
		_, err = tx.ExecContext(ctx, `INSERT INTO keagent_monitored_videos(owner_id,work_id,last_run_id,observed_at) VALUES($1,$2,$3,$4)
		  ON CONFLICT(owner_id,work_id) DO UPDATE SET last_run_id=excluded.last_run_id,observed_at=excluded.observed_at
		  WHERE keagent_monitored_videos.observed_at<=excluded.observed_at`, a.UserID, r.VerifiedWorkID, r.ID, seen)
	}
	return r, err
}

func validateCollectionResult(r collectionRun, res collectionResult) error {
	validated := res.VerifiedWorkID != ""
	if validated {
		if res.VerifiedWorkID != r.InputWorkID || res.Author == nil || !validExchangeText(res.Author.Name, 100) || len(res.Author.URL) > 2048 || !strings.HasPrefix(res.Author.URL, "https://www.douyin.com/user/") || !collectionCreatorPath.MatchString(strings.TrimPrefix(res.Author.URL, "https://www.douyin.com")) {
			return collectionInvalid()
		}
	} else if res.Author != nil || res.Title != "" {
		return collectionInvalid()
	}
	if len([]rune(res.Title)) > 200 || len([]rune(res.Reason)) > 500 || strings.ContainsRune(res.Title+res.Reason, 0) || (res.ErrorCode != "" && !douyinWord.MatchString(res.ErrorCode)) {
		return collectionInvalid()
	}
	switch res.State {
	case "succeeded":
		if validated && res.ErrorCode == "" && (res.PanelStatus == "visible" || res.PanelStatus == "explicitly_empty" || res.PanelStatus == "not_visible") {
			return nil
		}
	case "partial":
		if validated && (res.PanelStatus == "unknown" || res.PanelStatus == "loading" || res.PanelStatus == "load_failed") {
			return nil
		}
	case "blocked":
		if res.ErrorCode != "" && (res.PanelStatus == "restricted" || res.PanelStatus == "not_checked") {
			return nil
		}
	case "failed", "canceled", "interrupted":
		if !validated && res.ErrorCode != "" && res.PanelStatus == "not_checked" {
			return nil
		}
	}
	return collectionInvalid()
}

// Use the latest verified run visible to this device and target. A user's two accounts can see different panel states.
const collectionVideoSource = `SELECT DISTINCT ON (v.work_id) r.seq,v.work_id AS id,
  jsonb_strip_nulls(jsonb_build_object('id',v.work_id,'targetUrl',r.payload->'targetUrl','title',r.payload->'title',
  'author',r.payload->'author','lastRunId',r.id,'lastObservedAt',r.observed_at,'accountId',r.payload->'accountId',
  'deviceId',r.device_id,'panelStatus',r.payload->'panelStatus')) AS payload
 FROM keagent_monitored_videos v JOIN keagent_collection_runs r ON r.owner_id=v.owner_id AND r.payload->>'verifiedWorkId'=v.work_id
 WHERE v.owner_id=$1 AND r.device_id=$2 AND r.observed_at IS NOT NULL AND ($3='' OR r.target_id=$3)
 ORDER BY v.work_id,r.observed_at DESC,r.seq DESC`

func collectionRead(ctx context.Context, tx *sql.Tx, a actor, op string, body []byte) (any, error) {
	var in struct {
		ID       string `json:"id"`
		TargetID string `json:"targetId"`
		State    string `json:"state"`
		Cursor   string `json:"cursor"`
		Limit    int    `json:"limit"`
	}
	if decodeExchange(body, &in) != nil {
		return nil, collectionInvalid()
	}
	get := strings.HasSuffix(op, "/get")
	if get {
		if in.TargetID != "" || in.State != "" || in.Cursor != "" || in.Limit != 0 || !(exchangeID.MatchString(in.ID) || (op == "videos/get" && douyinPostID.MatchString(in.ID))) {
			return nil, collectionInvalid()
		}
	} else if in.ID != "" {
		return nil, collectionInvalid()
	}
	limit := in.Limit
	if limit == 0 {
		limit = 50
	}
	var cursor int64
	var err error
	if in.Cursor != "" {
		cursor, err = strconv.ParseInt(in.Cursor, 10, 64)
		if err != nil || cursor <= 0 {
			return nil, collectionInvalid()
		}
	}
	if limit < 1 || limit > 100 || (in.TargetID != "" && !exchangeID.MatchString(in.TargetID)) || (in.State != "" && in.State != "queued" && in.State != "running") {
		return nil, collectionInvalid()
	}
	var source string
	args := []any{a.UserID, a.DeviceID}
	switch strings.SplitN(op, "/", 2)[0] {
	case "targets":
		if in.TargetID != "" || in.State != "" {
			return nil, collectionInvalid()
		}
		source = `SELECT seq,id,payload FROM keagent_collection_targets WHERE owner_id=$1 AND device_id=$2`
		if !get {
			source += ` AND payload->>'state'<>'archived'`
		}
	case "runs":
		source = `SELECT seq,id,payload FROM keagent_collection_runs WHERE owner_id=$1 AND device_id=$2 AND ($3='' OR target_id=$3) AND ($4='' OR payload->>'state'=$4)`
		args = append(args, in.TargetID, in.State)
	case "videos":
		if in.State != "" {
			return nil, collectionInvalid()
		}
		source = collectionVideoSource
		args = append(args, in.TargetID)
	}
	placeholder := "$" + strconv.Itoa(len(args)+1)
	if get {
		var raw json.RawMessage
		err = tx.QueryRowContext(ctx, "SELECT payload FROM ("+source+") items WHERE id="+placeholder, append(args, in.ID)...).Scan(&raw)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, collectionMissing()
		}
		return raw, err
	}
	query := "SELECT seq,payload FROM (" + source + ") items WHERE (" + placeholder + "::bigint=0 OR seq<" + placeholder + ") ORDER BY seq DESC LIMIT $" + strconv.Itoa(len(args)+2)
	rows, err := tx.QueryContext(ctx, query, append(args, cursor, limit+1)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []json.RawMessage{}
	response := object{}
	var last int64
	for rows.Next() {
		var seq int64
		var raw json.RawMessage
		if err = rows.Scan(&seq, &raw); err != nil {
			return nil, err
		}
		if len(items) == limit {
			response["nextCursor"] = strconv.FormatInt(last, 10)
			break
		}
		last = seq
		items = append(items, raw)
	}
	response["items"] = items
	return response, rows.Err()
}

func changeTarget(ctx context.Context, tx *sql.Tx, a actor, op string, body []byte) (any, error) {
	var v collectionTarget
	var fields targetFields
	var targetID string
	var expected int
	switch op {
	case "targets/create":
		var in struct {
			targetFields
			RequestKey string `json:"requestKey"`
		}
		if decodeExchange(body, &in) != nil || !exchangeKey.MatchString(in.RequestKey) {
			return nil, collectionInvalid()
		}
		if err := cleanTarget(&in.targetFields); err != nil {
			return nil, err
		}
		fingerprint := exchangeFingerprint(in.targetFields)
		var saved string
		var raw json.RawMessage
		err := tx.QueryRowContext(ctx, `SELECT fingerprint,payload FROM keagent_collection_targets WHERE owner_id=$1 AND device_id=$2 AND request_key=$3`, a.UserID, a.DeviceID, in.RequestKey).Scan(&saved, &raw)
		if err == nil {
			if saved != fingerprint {
				return nil, exchangeFail(409, "REQUEST_CONFLICT", "同一请求已用于不同目标")
			}
			return raw, nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		status, err := accountStatus(ctx, tx, a, in.AccountID)
		if err != nil {
			return nil, err
		}
		if status == "" {
			return nil, exchangeFail(409, "ACCOUNT_UNAVAILABLE", "请选择本机已绑定的抖音账号")
		}
		at := now()
		v = collectionTarget{targetFields: in.targetFields, ID: id(), DeviceID: a.DeviceID, State: "active", Version: 1, CreatedAt: at, UpdatedAt: at}
		raw, err = json.Marshal(v)
		if err != nil {
			return nil, err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO keagent_collection_targets(id,owner_id,device_id,request_key,fingerprint,payload) VALUES($1,$2,$3,$4,$5,$6)`, v.ID, a.UserID, a.DeviceID, in.RequestKey, fingerprint, raw)
		return v, err
	case "targets/update":
		var in struct {
			targetFields
			ID              string `json:"id"`
			ExpectedVersion int    `json:"expectedVersion"`
		}
		if decodeExchange(body, &in) != nil {
			return nil, collectionInvalid()
		}
		if err := cleanTarget(&in.targetFields); err != nil {
			return nil, err
		}
		fields, targetID, expected = in.targetFields, in.ID, in.ExpectedVersion
	default:
		var in struct {
			ID              string `json:"id"`
			ExpectedVersion int    `json:"expectedVersion"`
		}
		if decodeExchange(body, &in) != nil {
			return nil, collectionInvalid()
		}
		targetID, expected = in.ID, in.ExpectedVersion
	}
	if !exchangeID.MatchString(targetID) || expected < 1 {
		return nil, collectionInvalid()
	}
	v, err := targetByID(ctx, tx, a, targetID)
	if err != nil {
		return nil, err
	}
	state := v.State
	switch op {
	case "targets/pause":
		state = "paused"
	case "targets/resume":
		state = "active"
	case "targets/archive":
		state = "archived"
	}
	unchanged := state == v.State && (op != "targets/update" || v.targetFields == fields)
	if unchanged && (expected == v.Version || expected == v.Version-1) {
		return v, nil
	}
	if expected != v.Version || v.State == "archived" {
		return nil, exchangeFail(409, "TARGET_CHANGED", "目标已更新或删除，请刷新后重试")
	}
	if op == "targets/update" || op == "targets/resume" {
		account := v.AccountID
		if op == "targets/update" {
			account = fields.AccountID
		}
		status, err := accountStatus(ctx, tx, a, account)
		if err != nil {
			return nil, err
		}
		if status == "" {
			return nil, exchangeFail(409, "ACCOUNT_UNAVAILABLE", "请选择本机已绑定的抖音账号")
		}
	}
	if op == "targets/update" {
		var busy bool
		err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM keagent_collection_runs WHERE target_id=$1 AND expires_at IS NOT NULL)`, v.ID).Scan(&busy)
		if err != nil {
			return nil, err
		}
		if busy {
			return nil, exchangeFail(409, "RUN_ACTIVE", "请在观察结束或取消后编辑目标")
		}
		v.targetFields = fields
	}
	v.Version++
	v.State, v.UpdatedAt = state, now()
	raw, _ := json.Marshal(v)
	if _, err = tx.ExecContext(ctx, `UPDATE keagent_collection_targets SET payload=$2 WHERE id=$1`, v.ID, raw); err != nil {
		return nil, err
	}
	if state != "active" {
		var canceled string
		err = tx.QueryRowContext(ctx, `UPDATE keagent_collection_runs SET expires_at=NULL,payload=payload ||
		  jsonb_build_object('state','canceled','endedAt',CURRENT_TIMESTAMP,'errorCode','CANCELED','reason','目标已暂停或删除')
		  WHERE target_id=$1 AND expires_at IS NOT NULL RETURNING id`, v.ID).Scan(&canceled)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		if state == "archived" {
			_, err = tx.ExecContext(ctx, `UPDATE keagent_collection_runs SET payload=payload || '{"targetArchived":true}'::jsonb WHERE target_id=$1`, v.ID)
			if err != nil {
				return nil, err
			}
		}
		// Only the local desktop needs this transaction's canceled run; it isn't a target field.
		return struct {
			collectionTarget
			CanceledRunID string `json:"canceledRunId,omitempty"`
		}{v, canceled}, nil
	}
	return v, err
}
