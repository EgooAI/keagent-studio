package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"sort"
	"strings"
)

// Metadata only. No file IO, renderer, production scheduler, or platform client.
const artifactExchangeSchema = `
CREATE TABLE IF NOT EXISTS keagent_media_asset (
 id text PRIMARY KEY, owner_id text NOT NULL, device_id text NOT NULL, file_token text NOT NULL,
 request_key text NOT NULL, fingerprint text NOT NULL, payload jsonb NOT NULL,
 UNIQUE(owner_id,id), UNIQUE(owner_id,request_key), UNIQUE(owner_id,device_id,file_token));
CREATE TABLE IF NOT EXISTS keagent_video_artifact (
 id text PRIMARY KEY, owner_id text NOT NULL, producer text NOT NULL, task_id text NOT NULL,
 source_revision integer NOT NULL CHECK(source_revision>0), request_key text NOT NULL, fingerprint text NOT NULL,
 video_asset_id text NOT NULL, cover_asset_id text NOT NULL, subtitle_asset_id text, payload jsonb NOT NULL,
 UNIQUE(owner_id,id), UNIQUE(owner_id,request_key), UNIQUE(owner_id,producer,task_id,source_revision),
 FOREIGN KEY(owner_id,video_asset_id) REFERENCES keagent_media_asset(owner_id,id),
 FOREIGN KEY(owner_id,cover_asset_id) REFERENCES keagent_media_asset(owner_id,id),
 FOREIGN KEY(owner_id,subtitle_asset_id) REFERENCES keagent_media_asset(owner_id,id));
CREATE INDEX IF NOT EXISTS keagent_video_artifact_owner_idx ON keagent_video_artifact(owner_id,(payload->>'createdAt') DESC,id DESC);
CREATE TABLE IF NOT EXISTS keagent_credit_artifact_task (
 artifact_id text PRIMARY KEY, owner_id text NOT NULL, task_id text NOT NULL,
 FOREIGN KEY(owner_id,artifact_id) REFERENCES keagent_video_artifact(owner_id,id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS keagent_credit_artifact_task_owner_idx ON keagent_credit_artifact_task(owner_id,task_id);
CREATE TABLE IF NOT EXISTS keagent_artifact_handoff (
 id text PRIMARY KEY, owner_id text NOT NULL, artifact_id text NOT NULL, request_key text NOT NULL,
 fingerprint text NOT NULL, payload jsonb NOT NULL, UNIQUE(owner_id,request_key),
 FOREIGN KEY(owner_id,artifact_id) REFERENCES keagent_video_artifact(owner_id,id));
`

type assetMetadata struct {
	Kind       string `json:"kind"`
	MimeType   string `json:"mimeType"`
	ByteSize   int64  `json:"byteSize"`
	SHA256     string `json:"sha256"`
	Width      int    `json:"width,omitempty"`
	Height     int    `json:"height,omitempty"`
	DurationMs int64  `json:"durationMs,omitempty"`
}
type assetLocation struct {
	Kind      string `json:"kind"`
	DeviceID  string `json:"deviceId"`
	FileToken string `json:"fileToken"`
}
type assetAvailability struct {
	State      string `json:"state"`
	Revision   int    `json:"revision"`
	ReportedAt string `json:"reportedAt"`
}
type mediaAsset struct {
	assetMetadata
	SchemaVersion int               `json:"schemaVersion"`
	ID            string            `json:"id"`
	OwnerID       string            `json:"ownerId"`
	Location      assetLocation     `json:"location"`
	Availability  assetAvailability `json:"availability"`
	CreatedAt     string            `json:"createdAt"`
}
type registerAssetInput struct {
	assetMetadata
	RequestKey string `json:"requestKey"`
	FileToken  string `json:"fileToken"`
}
type artifactSource struct {
	Producer string `json:"producer"`
	TaskID   string `json:"taskId"`
	Revision int    `json:"revision"`
}
type artifactProperty struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}
type artifactContent struct {
	Title    string            `json:"title"`
	Script   string            `json:"script"`
	Property *artifactProperty `json:"property,omitempty"`
}
type artifactAssets struct {
	Video    string `json:"video"`
	Cover    string `json:"cover"`
	Subtitle string `json:"subtitle,omitempty"`
}
type artifactReview struct {
	State      string `json:"state"`
	Revision   int    `json:"revision"`
	ReviewedAt string `json:"reviewedAt,omitempty"`
	Note       string `json:"note,omitempty"`
}
type videoArtifact struct {
	SchemaVersion int             `json:"schemaVersion"`
	ID            string          `json:"id"`
	OwnerID       string          `json:"ownerId"`
	Source        artifactSource  `json:"source"`
	Content       artifactContent `json:"content"`
	Assets        artifactAssets  `json:"assets"`
	Review        artifactReview  `json:"review"`
	CreatedAt     string          `json:"createdAt"`
}
type createArtifactInput struct {
	RequestKey    string          `json:"requestKey"`
	Source        artifactSource  `json:"source"`
	Content       artifactContent `json:"content"`
	Assets        artifactAssets  `json:"assets"`
	BillingTaskID string          `json:"billingTaskId,omitempty"`
}
type artifactHandoff struct {
	SchemaVersion int           `json:"schemaVersion"`
	ID            string        `json:"id"`
	OwnerID       string        `json:"ownerId"`
	DeviceID      string        `json:"deviceId"`
	Artifact      videoArtifact `json:"artifact"`
	Assets        []mediaAsset  `json:"assets"`
	CreatedAt     string        `json:"createdAt"`
}
type exchangeReader interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

type exchangeFault struct {
	cause error
	code  string
}

func (e exchangeFault) Error() string     { return e.cause.Error() }
func (e exchangeFault) Unwrap() error     { return e.cause }
func (e exchangeFault) ErrorCode() string { return e.code }
func exchangeFail(status int, code, message string) error {
	return exchangeFault{cause: fail(status, message), code: code}
}

var exchangeID = regexp.MustCompile(`^[a-f0-9]{32}$`)
var exchangeKey = regexp.MustCompile(`^[A-Za-z0-9_-]{16,100}$`)
var localFileToken = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)
var producerName = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,39}$`)
var sourceTaskID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,149}$`)
var assetHash = regexp.MustCompile(`^[a-f0-9]{64}$`)

func decodeExchange(body []byte, v any) error {
	if trimmed := bytes.TrimSpace(body); len(trimmed) == 0 || trimmed[0] != '{' {
		return exchangeFail(422, "INVALID_INPUT", "交接参数必须为 JSON 对象")
	}
	d := json.NewDecoder(bytes.NewReader(body))
	d.DisallowUnknownFields()
	if d.Decode(v) != nil || d.Decode(new(any)) != io.EOF {
		return exchangeFail(422, "INVALID_INPUT", "交接参数无效或包含未支持的字段")
	}
	return nil
}
func exchangeFingerprint(v any) string { raw, _ := json.Marshal(v); return digestBytes(raw) }
func validReview(state string) bool {
	return state == "pending" || state == "approved" || state == "rejected"
}
func validExchangeText(s string, max int) bool {
	return strings.TrimSpace(s) != "" && len([]rune(s)) <= max && !strings.ContainsRune(s, 0)
}
func requireExchangeDevice(a actor) error {
	if a.DeviceID == "" {
		return exchangeFail(409, "DEVICE_REQUIRED", "本机资产交接需要已登记的桌面设备")
	}
	return nil
}
func validateAssetInput(v registerAssetInput) error {
	if !exchangeKey.MatchString(v.RequestKey) || !localFileToken.MatchString(v.FileToken) || !assetHash.MatchString(v.SHA256) || v.ByteSize < 1 || v.ByteSize > 9007199254740991 {
		return exchangeFail(422, "INVALID_INPUT", "资产请求标识、文件令牌、大小或 SHA-256 无效")
	}
	imageSize := v.Width > 0 && v.Width <= 16384 && v.Height > 0 && v.Height <= 16384
	valid := false
	switch v.Kind {
	case "video":
		valid = v.MimeType == "video/mp4" && imageSize && v.DurationMs > 0 && v.DurationMs <= 86400000
	case "cover":
		valid = (v.MimeType == "image/jpeg" || v.MimeType == "image/png") && imageSize && v.DurationMs == 0
	case "subtitle":
		valid = (v.MimeType == "text/vtt" || v.MimeType == "application/x-subrip") && v.Width == 0 && v.Height == 0 && v.DurationMs == 0
	}
	if !valid {
		return exchangeFail(422, "INVALID_INPUT", "资产类型与媒体信息不匹配")
	}
	return nil
}
func validateArtifactInput(v *createArtifactInput) error {
	v.Content.Title = strings.TrimSpace(v.Content.Title)
	if !exchangeKey.MatchString(v.RequestKey) || !producerName.MatchString(v.Source.Producer) || !sourceTaskID.MatchString(v.Source.TaskID) || v.Source.Revision < 1 || v.Source.Revision > 2147483647 || !validExchangeText(v.Content.Title, 200) || !validExchangeText(v.Content.Script, 20000) {
		return exchangeFail(422, "INVALID_INPUT", "成片来源、版本或内容无效")
	}
	if p := v.Content.Property; p != nil && (!validExchangeText(p.ID, 150) || !validExchangeText(p.Title, 200)) {
		return exchangeFail(422, "INVALID_INPUT", "成片房源快照无效")
	}
	if !exchangeID.MatchString(v.Assets.Video) || !exchangeID.MatchString(v.Assets.Cover) || (v.Assets.Subtitle != "" && !exchangeID.MatchString(v.Assets.Subtitle)) {
		return exchangeFail(422, "INVALID_INPUT", "成片资产 ID 无效")
	}
	return nil
}
func readExchangeAsset(ctx context.Context, q exchangeReader, owner, assetID string, lock bool) (mediaAsset, error) {
	var v mediaAsset
	var raw []byte
	query := `SELECT payload FROM keagent_media_asset WHERE owner_id=$1 AND id=$2`
	if lock {
		query += ` FOR SHARE`
	}
	err := q.QueryRowContext(ctx, query, owner, assetID).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return v, exchangeFail(404, "NOT_FOUND", "资产不存在或无权访问")
	}
	if err != nil {
		return v, err
	}
	err = json.Unmarshal(raw, &v)
	return v, err
}
func readExchangeArtifact(ctx context.Context, q exchangeReader, owner, artifactID, lock string) (videoArtifact, error) {
	var v videoArtifact
	var raw []byte
	err := q.QueryRowContext(ctx, `SELECT payload FROM keagent_video_artifact WHERE owner_id=$1 AND id=$2`+lock, owner, artifactID).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return v, exchangeFail(404, "NOT_FOUND", "成片不存在或无权访问")
	}
	if err != nil {
		return v, err
	}
	err = json.Unmarshal(raw, &v)
	return v, err
}
func readArtifactAssets(ctx context.Context, q exchangeReader, a actor, refs artifactAssets, requireAvailable bool) ([]mediaAsset, error) {
	kinds := map[string]string{refs.Video: "video", refs.Cover: "cover"}
	if refs.Subtitle != "" {
		kinds[refs.Subtitle] = "subtitle"
	}
	if len(kinds) != 2+boolInt(refs.Subtitle != "") {
		return nil, exchangeFail(422, "INVALID_INPUT", "不同用途不能引用同一个资产")
	}
	ids := make([]string, 0, len(kinds))
	for key := range kinds {
		ids = append(ids, key)
	}
	sort.Strings(ids)
	result := make([]mediaAsset, 0, len(ids))
	for _, key := range ids {
		v, err := readExchangeAsset(ctx, q, a.UserID, key, true)
		if err != nil {
			return nil, err
		}
		if v.Kind != kinds[key] {
			return nil, exchangeFail(422, "INVALID_INPUT", "成片资产类型不匹配")
		}
		if v.Location.DeviceID != a.DeviceID {
			return nil, exchangeFail(409, "WRONG_DEVICE", "成片文件属于另一台设备，请在文件所属设备操作")
		}
		if requireAvailable && v.Availability.State != "available" {
			return nil, exchangeFail(409, "ASSET_UNAVAILABLE", "成片文件已报告缺失，请先恢复文件")
		}
		result = append(result, v)
	}
	return result, nil
}
func boolInt(v bool) int {
	if v {
		return 1
	}
	return 0
}
func auditArtifact(ctx context.Context, tx *sql.Tx, a actor, action, target string, details any) error {
	raw, _ := json.Marshal(details)
	_, err := tx.ExecContext(ctx, `INSERT INTO keagent_audit(id,actor_id,action,target_id,metadata) VALUES($1,$2,$3,$4,$5)`, id(), a.UserID, action, target, raw)
	return err
}

func (s *server) registerExchangeAsset(ctx context.Context, a actor, body []byte) (any, error) {
	var input registerAssetInput
	if err := decodeExchange(body, &input); err != nil {
		return nil, err
	}
	if err := requireExchangeDevice(a); err != nil {
		return nil, err
	}
	if err := validateAssetInput(input); err != nil {
		return nil, err
	}
	v := mediaAsset{assetMetadata: input.assetMetadata, SchemaVersion: 1, ID: id(), OwnerID: a.UserID, Location: assetLocation{Kind: "local", DeviceID: a.DeviceID, FileToken: input.FileToken}, Availability: assetAvailability{State: "available", Revision: 1, ReportedAt: now()}, CreatedAt: now()}
	fingerprint := exchangeFingerprint(struct {
		Input  registerAssetInput
		Device string
	}{input, a.DeviceID})
	raw, _ := json.Marshal(v)
	result, err := s.db.ExecContext(ctx, `INSERT INTO keagent_media_asset(id,owner_id,device_id,file_token,request_key,fingerprint,payload) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`, v.ID, a.UserID, a.DeviceID, input.FileToken, input.RequestKey, fingerprint, raw)
	if err != nil {
		return nil, err
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		var prior string
		err = s.db.QueryRowContext(ctx, `SELECT fingerprint,payload FROM keagent_media_asset WHERE owner_id=$1 AND request_key=$2`, a.UserID, input.RequestKey).Scan(&prior, &raw)
		if errors.Is(err, sql.ErrNoRows) || err == nil && prior != fingerprint {
			return nil, exchangeFail(409, "IDEMPOTENCY_CONFLICT", "资产请求标识或文件令牌已绑定其他内容")
		}
		if err != nil {
			return nil, err
		}
		if err = json.Unmarshal(raw, &v); err != nil {
			return nil, err
		}
	}
	return v, nil
}
func (s *server) reportExchangeAvailability(ctx context.Context, a actor, body []byte) (any, error) {
	var input struct {
		ID               string `json:"id"`
		ExpectedRevision int    `json:"expectedRevision"`
		State            string `json:"state"`
	}
	if err := decodeExchange(body, &input); err != nil {
		return nil, err
	}
	if !exchangeID.MatchString(input.ID) || input.ExpectedRevision < 1 || input.ExpectedRevision > 2147483646 || (input.State != "available" && input.State != "missing") {
		return nil, exchangeFail(422, "INVALID_INPUT", "资产可用性参数无效")
	}
	v, err := readExchangeAsset(ctx, s.db, a.UserID, input.ID, false)
	if err != nil {
		return nil, err
	}
	if a.DeviceID == "" || a.DeviceID != v.Location.DeviceID {
		return nil, exchangeFail(409, "WRONG_DEVICE", "只能由文件所属设备报告可用性")
	}
	v.Availability = assetAvailability{State: input.State, Revision: input.ExpectedRevision + 1, ReportedAt: now()}
	raw, _ := json.Marshal(v.Availability)
	result, err := s.db.ExecContext(ctx, `UPDATE keagent_media_asset SET payload=jsonb_set(payload,'{availability}',$3::jsonb) WHERE owner_id=$1 AND id=$2 AND (payload->'availability'->>'revision')::integer=$4`, a.UserID, input.ID, raw, input.ExpectedRevision)
	if err != nil {
		return nil, err
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		return nil, exchangeFail(409, "REVISION_CONFLICT", "资产可用性已变化，请重新读取")
	}
	return v, nil
}
func (s *server) createExchangeArtifact(ctx context.Context, a actor, body []byte) (any, error) {
	var input createArtifactInput
	if err := decodeExchange(body, &input); err != nil {
		return nil, err
	}
	if err := requireExchangeDevice(a); err != nil {
		return nil, err
	}
	if err := validateArtifactInput(&input); err != nil {
		return nil, err
	}
	billingTaskID := input.BillingTaskID
	if billingTaskID != "" && (input.Source.Producer != "panorama" || !creditTaskID.MatchString(billingTaskID)) {
		return nil, exchangeFail(422, "INVALID_INPUT", "成片账单任务编号无效")
	}
	// Analytics attribution can be added to a replay of an existing artifact receipt.
	input.BillingTaskID = ""
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err = readArtifactAssets(ctx, tx, a, input.Assets, false); err != nil {
		return nil, err
	}
	v := videoArtifact{SchemaVersion: 1, ID: id(), OwnerID: a.UserID, Source: input.Source, Content: input.Content, Assets: input.Assets, Review: artifactReview{State: "pending", Revision: 1}, CreatedAt: now()}
	raw, _ := json.Marshal(v)
	fingerprint := exchangeFingerprint(input)
	var subtitle any
	if input.Assets.Subtitle != "" {
		subtitle = input.Assets.Subtitle
	}
	result, err := tx.ExecContext(ctx, `INSERT INTO keagent_video_artifact(id,owner_id,producer,task_id,source_revision,request_key,fingerprint,video_asset_id,cover_asset_id,subtitle_asset_id,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`, v.ID, a.UserID, input.Source.Producer, input.Source.TaskID, input.Source.Revision, input.RequestKey, fingerprint, input.Assets.Video, input.Assets.Cover, subtitle, raw)
	if err != nil {
		return nil, err
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		var prior string
		err = tx.QueryRowContext(ctx, `SELECT fingerprint,payload FROM keagent_video_artifact WHERE owner_id=$1 AND request_key=$2`, a.UserID, input.RequestKey).Scan(&prior, &raw)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, exchangeFail(409, "SOURCE_VERSION_EXISTS", "成片来源版本已登记，不能覆盖")
		}
		if err == nil && prior != fingerprint {
			return nil, exchangeFail(409, "IDEMPOTENCY_CONFLICT", "成片请求标识已绑定其他内容")
		}
		if err != nil {
			return nil, err
		}
		if err = json.Unmarshal(raw, &v); err != nil {
			return nil, err
		}
	} else if err = auditArtifact(ctx, tx, a, "artifact.create", v.ID, object{"source": v.Source}); err != nil {
		return nil, err
	}
	if billingTaskID != "" {
		if _, err = tx.ExecContext(ctx, `INSERT INTO keagent_credit_artifact_task(artifact_id,owner_id,task_id)
			VALUES($1,$2,$3) ON CONFLICT(artifact_id) DO NOTHING`, v.ID, a.UserID, billingTaskID); err != nil {
			return nil, err
		}
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return v, nil
}
func (s *server) reviewExchangeArtifact(ctx context.Context, a actor, body []byte) (any, error) {
	var input struct {
		ID               string `json:"id"`
		ExpectedRevision int    `json:"expectedRevision"`
		State            string `json:"state"`
		Note             string `json:"note"`
	}
	if err := decodeExchange(body, &input); err != nil {
		return nil, err
	}
	if !exchangeID.MatchString(input.ID) || input.ExpectedRevision < 1 || !validReview(input.State) || len([]rune(input.Note)) > 1000 || strings.ContainsRune(input.Note, 0) {
		return nil, exchangeFail(422, "INVALID_INPUT", "成片验收参数无效")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	v, err := readExchangeArtifact(ctx, tx, a.UserID, input.ID, " FOR UPDATE")
	if err != nil {
		return nil, err
	}
	if v.Review.Revision != input.ExpectedRevision {
		return nil, exchangeFail(409, "REVISION_CONFLICT", "成片验收状态已变化，请重新读取")
	}
	v.Review = artifactReview{State: input.State, Revision: v.Review.Revision + 1, ReviewedAt: now(), Note: strings.TrimSpace(input.Note)}
	raw, _ := json.Marshal(v)
	if _, err = tx.ExecContext(ctx, `UPDATE keagent_video_artifact SET payload=$3 WHERE owner_id=$1 AND id=$2`, a.UserID, v.ID, raw); err != nil {
		return nil, err
	}
	if err = auditArtifact(ctx, tx, a, "artifact.review", v.ID, v.Review); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return v, nil
}
func (s *server) createExchangeHandoff(ctx context.Context, a actor, body []byte) (any, error) {
	var input struct {
		RequestKey             string `json:"requestKey"`
		ArtifactID             string `json:"artifactId"`
		ExpectedReviewRevision int    `json:"expectedReviewRevision"`
	}
	if err := decodeExchange(body, &input); err != nil {
		return nil, err
	}
	if err := requireExchangeDevice(a); err != nil {
		return nil, err
	}
	if !exchangeKey.MatchString(input.RequestKey) || !exchangeID.MatchString(input.ArtifactID) || input.ExpectedReviewRevision < 1 {
		return nil, exchangeFail(422, "INVALID_INPUT", "成片交接参数无效")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "handoff:"+a.UserID+":"+input.RequestKey); err != nil {
		return nil, err
	}
	fingerprint := exchangeFingerprint(struct {
		Input  any
		Device string
	}{input, a.DeviceID})
	var raw []byte
	var prior string
	err = tx.QueryRowContext(ctx, `SELECT fingerprint,payload FROM keagent_artifact_handoff WHERE owner_id=$1 AND request_key=$2`, a.UserID, input.RequestKey).Scan(&prior, &raw)
	if err == nil {
		if prior != fingerprint {
			return nil, exchangeFail(409, "IDEMPOTENCY_CONFLICT", "交接请求标识已绑定其他内容或设备")
		}
		var v artifactHandoff
		if err = json.Unmarshal(raw, &v); err != nil {
			return nil, err
		}
		return v, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	artifact, err := readExchangeArtifact(ctx, tx, a.UserID, input.ArtifactID, " FOR SHARE")
	if err != nil {
		return nil, err
	}
	if artifact.Review.State != "approved" || artifact.Review.Revision != input.ExpectedReviewRevision {
		return nil, exchangeFail(409, "REVISION_CONFLICT", "成片尚未通过当前版本验收，请重新读取")
	}
	assets, err := readArtifactAssets(ctx, tx, a, artifact.Assets, true)
	if err != nil {
		return nil, err
	}
	v := artifactHandoff{SchemaVersion: 1, ID: id(), OwnerID: a.UserID, DeviceID: a.DeviceID, Artifact: artifact, Assets: assets, CreatedAt: now()}
	raw, _ = json.Marshal(v)
	if _, err = tx.ExecContext(ctx, `INSERT INTO keagent_artifact_handoff(id,owner_id,artifact_id,request_key,fingerprint,payload) VALUES($1,$2,$3,$4,$5,$6)`, v.ID, a.UserID, artifact.ID, input.RequestKey, fingerprint, raw); err != nil {
		return nil, err
	}
	if err = auditArtifact(ctx, tx, a, "artifact.handoff", v.ID, object{"artifactId": artifact.ID, "reviewRevision": artifact.Review.Revision}); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return v, nil
}
func (s *server) listExchangeArtifacts(ctx context.Context, a actor, body []byte) (any, error) {
	var input struct {
		Limit    int    `json:"limit"`
		Offset   int    `json:"offset"`
		Review   string `json:"review"`
		Producer string `json:"producer"`
	}
	if err := decodeExchange(body, &input); err != nil {
		return nil, err
	}
	if input.Limit == 0 {
		input.Limit = 20
	}
	if input.Limit < 1 || input.Limit > 100 || input.Offset < 0 || input.Offset > 1000000 || (input.Review != "" && !validReview(input.Review)) || (input.Producer != "" && !producerName.MatchString(input.Producer)) {
		return nil, exchangeFail(422, "INVALID_INPUT", "成片列表筛选无效")
	}
	where := ` WHERE owner_id=$1 AND ($2='' OR payload->'review'->>'state'=$2) AND ($3='' OR producer=$3)`
	var total int
	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM keagent_video_artifact`+where, a.UserID, input.Review, input.Producer).Scan(&total); err != nil {
		return nil, err
	}
	records, err := s.db.QueryContext(ctx, `SELECT payload FROM keagent_video_artifact`+where+` ORDER BY payload->>'createdAt' DESC,id DESC LIMIT $4 OFFSET $5`, a.UserID, input.Review, input.Producer, input.Limit, input.Offset)
	if err != nil {
		return nil, err
	}
	defer records.Close()
	items := []videoArtifact{}
	for records.Next() {
		var raw []byte
		var v videoArtifact
		if err = records.Scan(&raw); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(raw, &v); err != nil {
			return nil, err
		}
		items = append(items, v)
	}
	return object{"items": items, "total": total, "limit": input.Limit, "offset": input.Offset}, records.Err()
}
func (s *server) artifactExchange(ctx context.Context, a actor, path string, body []byte) (any, error) {
	switch path {
	case "/v1/media-assets/register":
		return s.registerExchangeAsset(ctx, a, body)
	case "/v1/media-assets/availability":
		return s.reportExchangeAvailability(ctx, a, body)
	case "/v1/artifacts/create":
		return s.createExchangeArtifact(ctx, a, body)
	case "/v1/artifacts/list":
		return s.listExchangeArtifacts(ctx, a, body)
	case "/v1/artifacts/review":
		return s.reviewExchangeArtifact(ctx, a, body)
	case "/v1/artifact-handoffs/create":
		return s.createExchangeHandoff(ctx, a, body)
	case "/v1/media-assets/get", "/v1/artifacts/get", "/v1/artifact-handoffs/get":
		var input struct {
			ID string `json:"id"`
		}
		if err := decodeExchange(body, &input); err != nil {
			return nil, err
		}
		if !exchangeID.MatchString(input.ID) {
			return nil, exchangeFail(422, "INVALID_INPUT", "交接对象 ID 无效")
		}
		if path == "/v1/media-assets/get" {
			return readExchangeAsset(ctx, s.db, a.UserID, input.ID, false)
		}
		if path == "/v1/artifacts/get" {
			return readExchangeArtifact(ctx, s.db, a.UserID, input.ID, "")
		}
		var v artifactHandoff
		var raw []byte
		err := s.db.QueryRowContext(ctx, `SELECT payload FROM keagent_artifact_handoff WHERE owner_id=$1 AND id=$2`, a.UserID, input.ID).Scan(&raw)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, exchangeFail(404, "NOT_FOUND", "交接记录不存在或无权访问")
		}
		if err != nil {
			return nil, err
		}
		err = json.Unmarshal(raw, &v)
		return v, err
	}
	return nil, exchangeFail(404, "NOT_FOUND", "成片交接接口不存在")
}
