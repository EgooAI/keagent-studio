package main

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const aiSettingsSchema = `
CREATE TABLE IF NOT EXISTS keagent_ai_version (
 service_group text NOT NULL, version bigint NOT NULL, encrypted bytea NOT NULL,
 actor_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(service_group,version));
CREATE TABLE IF NOT EXISTS keagent_ai_head (
 service_group text PRIMARY KEY, revision bigint NOT NULL DEFAULT 0,
 active bigint NOT NULL DEFAULT 0, candidate bigint NOT NULL DEFAULT 0,
 activated_at timestamptz);
CREATE TABLE IF NOT EXISTS keagent_ai_probe (
 id text PRIMARY KEY, service_group text NOT NULL, service text NOT NULL,
 version bigint NOT NULL, mode text NOT NULL, status text NOT NULL,
 encrypted_input bytea, result jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 lease_until timestamptz, actor_id text NOT NULL, request_hash text NOT NULL,
 worker text NOT NULL DEFAULT '');
CREATE UNIQUE INDEX IF NOT EXISTS keagent_ai_probe_running
 ON keagent_ai_probe(service_group,service) WHERE status IN ('queued','running');
`

type aiField struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Kind  string `json:"kind"`
}
type aiSpec struct {
	ID, Group, Name, Vendor string
	Fields                  []aiField
}

var aiSpecs = []aiSpec{
	{"script", "script", "多模态文案", "OpenAI 兼容接口", []aiField{{"AI_BASE_URL", "服务地址", "url"}, {"AI_MODEL", "模型名", "text"}, {"AI_API_KEY", "API Key", "secret"}}},
	{"tts", "speech", "火山配音", "火山引擎", []aiField{{"VOLC_TTS_API_KEY", "共享 API Key", "secret"}}},
	{"voice-clone", "speech", "声音复刻", "火山引擎", []aiField{{"VOLC_TTS_API_KEY", "共享 API Key", "secret"}, {"VOLC_VOICE_CLONE_ENABLED", "启用声音复刻", "toggle"}, {"VOLC_VOICE_CLONE_RESOURCE_ID", "复刻资源编号", "text"}}},
	{"expansion", "expansion", "百炼扩图", "阿里云百炼", []aiField{{"DASHSCOPE_BASE_URL", "服务地址", "url"}, {"DASHSCOPE_API_KEY", "API Key", "secret"}}},
	{"beike", "beike", "贝壳取材", "贝壳开放平台", []aiField{{"BEIKE_ACCESS_TOKEN", "Access Token", "secret"}}},
	{"opening", "opening", "MiniMax 开场", "MiniMax", []aiField{{"MINIMAX_API_KEY", "API Key", "secret"}}},
}

func specFor(id string) (aiSpec, bool) {
	for _, spec := range aiSpecs {
		if spec.ID == id {
			return spec, true
		}
	}
	return aiSpec{}, false
}
func groupFields(group string) map[string]aiField {
	fields := map[string]aiField{}
	for _, spec := range aiSpecs {
		if spec.Group == group {
			for _, field := range spec.Fields {
				fields[field.Key] = field
			}
		}
	}
	return fields
}

type aiValues map[string]string

func environmentAI(group string) aiValues {
	values := aiValues{}
	for key := range groupFields(group) {
		values[key] = strings.TrimSpace(os.Getenv(key))
	}
	switch group {
	case "speech":
		if values["VOLC_VOICE_CLONE_RESOURCE_ID"] == "" {
			values["VOLC_VOICE_CLONE_RESOURCE_ID"] = "seed-icl-2.0"
		}
		values["VOLC_VOICE_CLONE_ENABLED"] = strconv.FormatBool(values["VOLC_VOICE_CLONE_ENABLED"] == "true")
	case "expansion":
		if values["DASHSCOPE_BASE_URL"] == "" {
			values["DASHSCOPE_BASE_URL"] = "https://dashscope.aliyuncs.com"
		}
	}
	return values
}

type aiSnapshot struct {
	values   aiValues
	versions map[string]int64
	locked   map[string]bool
}
type aiContextKey struct{}

func aiSnapshotFrom(ctx context.Context) aiSnapshot {
	if value, ok := ctx.Value(aiContextKey{}).(aiSnapshot); ok {
		return value
	}
	snapshot := aiSnapshot{aiValues{}, map[string]int64{}, map[string]bool{}}
	for _, spec := range aiSpecs {
		for key, value := range environmentAI(spec.Group) {
			snapshot.values[key] = value
		}
	}
	return snapshot
}
func aiValue(ctx context.Context, key string) string { return aiSnapshotFrom(ctx).values[key] }
func withAIGroup(ctx context.Context, group string, version int64, values aiValues) context.Context {
	old := aiSnapshotFrom(ctx)
	snapshot := aiSnapshot{aiValues{}, map[string]int64{}, map[string]bool{}}
	for k, v := range old.values {
		snapshot.values[k] = v
	}
	for k, v := range old.versions {
		snapshot.versions[k] = v
	}
	for k, v := range old.locked {
		snapshot.locked[k] = v
	}
	for key := range groupFields(group) {
		snapshot.values[key] = values[key]
	}
	snapshot.versions[group] = version
	snapshot.locked[group] = values == nil
	return context.WithValue(ctx, aiContextKey{}, snapshot)
}
func aiCipher() (cipher.AEAD, error) {
	key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(os.Getenv("AI_CONFIG_ENCRYPTION_KEY")))
	if err != nil || len(key) != 32 {
		return nil, fail(503, "AI 配置加密密钥未设置或无效")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
func sealAI(label string, value any) ([]byte, error) {
	box, err := aiCipher()
	if err != nil {
		return nil, err
	}
	clear, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, box.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return nil, err
	}
	return box.Seal(nonce, nonce, clear, []byte(label)), nil
}
func openAI(label string, sealed []byte, target any) error {
	box, err := aiCipher()
	if err != nil {
		return err
	}
	if len(sealed) < box.NonceSize()+box.Overhead() {
		return fail(503, "AI 配置无法解密")
	}
	clear, err := box.Open(nil, sealed[:box.NonceSize()], sealed[box.NonceSize():], []byte(label))
	if err != nil || json.Unmarshal(clear, target) != nil {
		return fail(503, "AI 配置无法解密")
	}
	return nil
}
func aiVersionLabel(group string, version int64) string {
	return fmt.Sprintf("ai-config:%s:%d", group, version)
}

type aiRowReader interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func readAIValues(ctx context.Context, db aiRowReader, group string, version int64) (aiValues, error) {
	var encrypted []byte
	err := db.QueryRowContext(ctx, `SELECT encrypted FROM keagent_ai_version WHERE service_group=$1 AND version=$2`, group, version).Scan(&encrypted)
	if errors.Is(err, sql.ErrNoRows) && version == 0 {
		return environmentAI(group), nil
	}
	if err != nil {
		return nil, fail(503, "AI 配置版本无法读取")
	}
	var values aiValues
	if err = openAI(aiVersionLabel(group, version), encrypted, &values); err != nil {
		return nil, err
	}
	return values, nil
}
func (s *server) activeAI(ctx context.Context) (context.Context, error) {
	if s.db == nil {
		return ctx, nil
	}
	list, err := s.db.QueryContext(ctx, `SELECT h.service_group,h.active,v.encrypted FROM keagent_ai_head h LEFT JOIN keagent_ai_version v ON v.service_group=h.service_group AND v.version=h.active WHERE h.active>0`)
	if err != nil {
		return ctx, fail(503, "无法读取生效的 AI 配置")
	}
	defer list.Close()
	for list.Next() {
		var group string
		var version int64
		var encrypted []byte
		if err = list.Scan(&group, &version, &encrypted); err != nil {
			return ctx, err
		}
		var values aiValues
		if openAI(aiVersionLabel(group, version), encrypted, &values) != nil {
			values = nil
		}
		ctx = withAIGroup(ctx, group, version, values)
	}
	return ctx, list.Err()
}
func (s *server) pinnedAI(ctx context.Context, group string, version int64) (context.Context, error) {
	if aiSnapshotFrom(ctx).versions[group] == version && !aiSnapshotFrom(ctx).locked[group] {
		return ctx, nil
	}
	values, err := readAIValues(ctx, s.db, group, version)
	if err != nil {
		return ctx, err
	}
	return withAIGroup(ctx, group, version, values), nil
}
func aiConfigIssues(spec aiSpec, values aiValues) (missing []string, issues []string) {
	missing, issues = []string{}, []string{}
	for _, field := range spec.Fields {
		if field.Kind != "toggle" && strings.TrimSpace(values[field.Key]) == "" {
			missing = append(missing, field.Key)
		}
	}
	switch spec.ID {
	case "script":
		if raw := values["AI_BASE_URL"]; raw != "" {
			u, err := url.Parse(raw)
			allowed := false
			if err == nil && u.Scheme == "https" && u.Hostname() != "" && u.User == nil && u.RawQuery == "" && u.Fragment == "" && u.Port() == "" {
				ip := net.ParseIP(u.Hostname())
				for _, host := range strings.Split(os.Getenv("AI_ALLOWED_HOSTS"), ",") {
					if strings.EqualFold(strings.TrimSpace(host), u.Hostname()) && !strings.EqualFold(strings.TrimSuffix(u.Hostname(), "."), "localhost") && (ip == nil || publicProviderIP(ip)) {
						allowed = true
					}
				}
			}
			if !allowed {
				issues = append(issues, "文案服务地址必须是已加入部署白名单的 HTTPS 地址")
			}
		}
		if strings.TrimSpace(os.Getenv("AI_ALLOWED_HOSTS")) == "" {
			missing = append(missing, "AI_ALLOWED_HOSTS")
		}
	case "voice-clone":
		if !speechResourceID.MatchString(values["VOLC_VOICE_CLONE_RESOURCE_ID"]) {
			issues = append(issues, "复刻资源编号格式无效")
		}
	case "expansion":
		if _, err := validateDashscopeBase(values["DASHSCOPE_BASE_URL"]); err != nil {
			issues = append(issues, err.Error())
		}
	}
	return
}

type aiHead struct {
	Revision    int64      `json:"revision"`
	Active      int64      `json:"active"`
	Candidate   int64      `json:"candidate"`
	ActivatedAt *time.Time `json:"activatedAt"`
}

func readAIHead(ctx context.Context, db aiRowReader, group string, lock bool) (aiHead, error) {
	var h aiHead
	query := `SELECT revision,active,candidate,activated_at FROM keagent_ai_head WHERE service_group=$1`
	if lock {
		query += " FOR UPDATE"
	}
	err := db.QueryRowContext(ctx, query, group).Scan(&h.Revision, &h.Active, &h.Candidate, &h.ActivatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		err = nil
	}
	return h, err
}
func aiAudit(ctx context.Context, tx *sql.Tx, actorID, service, action string, version int64, outcome string) error {
	data, _ := json.Marshal(object{"service": service, "version": version, "result": outcome})
	_, err := tx.ExecContext(ctx, `INSERT INTO keagent_audit(id,actor_id,action,target_id,metadata) VALUES($1,$2,$3,$4,$5)`, id(), actorID, "ai."+action, service, data)
	return err
}
