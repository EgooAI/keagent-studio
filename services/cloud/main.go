package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	_ "github.com/jackc/pgx/v5/stdlib"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

type object = map[string]any
type actor struct {
	DeviceID  string `json:"deviceId"`
	UserID    string `json:"userId"`
	SessionID string `json:"sessionId"`
	Name      string `json:"name"`
	Email     string `json:"email"`
	Role      string `json:"role"`
	Timestamp int64  `json:"timestamp"`
	Nonce     string `json:"nonce"`
}
type server struct {
	db         *sql.DB
	secret     string
	nonces     sync.Map
	jwt        *jwtVerifier
	origins    []string
	speech     func(context.Context, string, object, string) ([]byte, error)
	sourceHTTP func(context.Context, string, string, http.Header, []byte, int64) ([]byte, error)
}
type fault struct {
	status  int
	message string
}

func (f fault) Error() string               { return f.message }
func fail(status int, message string) error { return fault{status, message} }
func id() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
func now() string      { return time.Now().UTC().Format(time.RFC3339Nano) }
func str(v any) string { s, _ := v.(string); return s }
func obj(v any) object { m, _ := v.(map[string]any); return m }
func rows(v any) []any {
	a, _ := v.([]any)
	if a == nil {
		return []any{}
	}
	return a
}
func number(v any) float64 { n, _ := v.(float64); return n }
func find(list any, key string) object {
	for _, r := range rows(list) {
		if obj(r)["id"] == key {
			return obj(r)
		}
	}
	return nil
}
func jsonCopy(v any) any {
	b, _ := json.Marshal(v)
	var out any
	_ = json.Unmarshal(b, &out)
	return out
}
func initial(name string) object {
	ref := func(kind string) object { return object{"id": "builtin-" + kind, "version": "1"} }
	config := object{"propertyIds": []any{}, "videoMode": "voiceover", "promptTemplate": ref("prompt"), "videoTemplate": ref("video"), "styleTemplate": ref("style"), "coverTemplate": ref("cover"), "voiceId": "", "requireScriptReview": true, "aspectRatio": "9:16", "outputResolution": "1080p"}
	w := object{"schemaVersion": 1, "profile": object{"name": name, "brokerage": "", "city": "", "regions": "", "phone": "", "introduction": "", "defaults": config}, "draft": jsonCopy(config), "requests": object{}, "updatedAt": now()}
	for _, k := range []string{"properties", "resources", "tasks", "batches", "publishTasks", "voices", "avatars", "accounts", "leads", "analysisJobs"} {
		w[k] = []any{}
	}
	return w
}

const schema = aiSettingsSchema + minimaxOpeningSchema + creditSchema + `
CREATE TABLE IF NOT EXISTS keagent_workspace (owner_id text PRIMARY KEY, payload jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS keagent_resource (id text PRIMARY KEY, payload jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS keagent_device (id text PRIMARY KEY, owner_id text NOT NULL, session_id text NOT NULL, name text NOT NULL, platform text NOT NULL, revoked boolean NOT NULL DEFAULT false, seen_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS keagent_setting (id text PRIMARY KEY, payload jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS keagent_audit (id text PRIMARY KEY, actor_id text NOT NULL, action text NOT NULL, target_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE keagent_audit ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
`

func (s *server) verify(r *http.Request, body []byte) (actor, error) {
	var a actor
	if s.secret == "" {
		return a, fail(401, "请使用 Access Token 登录")
	}
	contextHeader := r.Header.Get("X-Keagent-Context")
	digest := sha256.Sum256(body)
	h := hmac.New(sha256.New, []byte(s.secret))
	fmt.Fprintf(h, "%s\n%s\n%s\n%x", r.Method, r.URL.RequestURI(), contextHeader, digest)
	signature, err := hex.DecodeString(r.Header.Get("X-Keagent-Signature"))
	if err != nil || !hmac.Equal(signature, h.Sum(nil)) {
		return a, fail(401, "无效的网关签名")
	}
	b, err := base64.RawURLEncoding.DecodeString(contextHeader)
	if err != nil || json.Unmarshal(b, &a) != nil || a.UserID == "" || a.SessionID == "" || a.Nonce == "" || time.Now().Unix()-a.Timestamp > 60 || a.Timestamp-time.Now().Unix() > 5 {
		return a, fail(401, "无效的身份上下文")
	}
	s.nonces.Range(func(k, v any) bool {
		if time.Now().Unix()-v.(int64) > 65 {
			s.nonces.Delete(k)
		}
		return true
	})
	if _, exists := s.nonces.LoadOrStore(a.Nonce, a.Timestamp); exists {
		return a, fail(401, "重复的网关请求")
	}
	return a, nil
}
func respond(w http.ResponseWriter, value any, err error) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if err != nil {
		status := 500
		message := "业务服务错误"
		var f fault
		if errors.As(err, &f) {
			status = f.status
			message = f.message
		} else {
			log.Printf("request failed: %T", err)
		}
		w.WriteHeader(status)
		details := object{"message": message}
		var coded interface{ ErrorCode() string }
		if errors.As(err, &coded) {
			details["code"] = coded.ErrorCode()
		}
		_ = json.NewEncoder(w).Encode(object{"error": details})
		return
	}
	_ = json.NewEncoder(w).Encode(value)
}
func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !s.cors(w, r) {
		return
	}
	if r.URL.Path == "/health" {
		respond(w, object{"status": "ok"}, nil)
		return
	}
	limit := int64(1 << 20)
	if r.URL.Path == "/v1/panorama/image-submit" {
		limit = 15 << 20
	}
	if r.URL.Path == "/v1/panorama/script-vision" || r.URL.Path == "/v1/panorama/opening-submit" {
		limit = 16 << 20
	}
	if r.URL.Path == "/v1/admin/resources/preview" {
		limit = 2 << 20
	}
	if r.URL.Path == "/v1/voices/create" {
		limit = 14 << 20
	}
	if r.URL.Path == "/v1/admin/ai-config/test" {
		limit = 16 << 20
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	if err != nil {
		respond(w, nil, fail(413, "请求过大"))
		return
	}
	a, err := s.authenticate(r, body)
	if err != nil {
		respond(w, nil, err)
		return
	}
	if a.DeviceID != "" && r.URL.Path != "/v1/devices/register" {
		var valid bool
		err = s.db.QueryRowContext(r.Context(), `SELECT EXISTS(SELECT 1 FROM keagent_device WHERE id=$1 AND owner_id=$2 AND session_id=$3 AND NOT revoked)`, a.DeviceID, a.UserID, a.SessionID).Scan(&valid)
		if err != nil {
			respond(w, nil, err)
			return
		}
		if !valid {
			respond(w, nil, fail(403, "设备已解绑，请重新登录或联系管理员"))
			return
		}
	}
	if strings.HasPrefix(r.URL.Path, "/v1/panorama/") || strings.HasPrefix(r.URL.Path, "/v1/voices/") {
		ctx, err := s.activeAI(r.Context())
		if err != nil {
			respond(w, nil, err)
			return
		}
		r = r.WithContext(ctx)
	}
	if strings.HasPrefix(r.URL.Path, "/v1/admin/") {
		if !strings.Contains(","+a.Role+",", ",admin,") {
			respond(w, nil, fail(403, "需要管理员权限"))
			return
		}
		v, e := s.admin(r, a, body)
		respond(w, v, e)
		return
	}
	if r.Method == "GET" && r.URL.Path == "/v1/session" {
		respond(w, object{"userId": a.UserID, "sessionId": a.SessionID, "name": a.Name, "email": a.Email, "role": a.Role}, nil)
		return
	}
	if r.Method == "GET" && r.URL.Path == "/v1/credits" {
		v, e := s.creditSummary(r.Context(), a.UserID)
		respond(w, v, e)
		return
	}
	if r.Method == "GET" && r.URL.Path == "/v1/credits/pricing" {
		prices, version, e := readCreditPricing(r.Context(), s.db)
		if e != nil {
			respond(w, nil, e)
			return
		}
		respond(w, object{"prices": prices, "version": version}, nil)
		return
	}
	if r.Method == "POST" && r.URL.Path == "/v1/credits/redeem" {
		var input struct {
			Code string `json:"code"`
		}
		if json.Unmarshal(body, &input) != nil {
			respond(w, nil, fail(400, "请求格式错误"))
			return
		}
		v, e := s.redeemCreditCode(r.Context(), a.UserID, input.Code)
		respond(w, v, e)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/v1/media-assets/") || strings.HasPrefix(r.URL.Path, "/v1/artifacts/") || strings.HasPrefix(r.URL.Path, "/v1/artifact-handoffs/") {
		if r.Method != "POST" {
			respond(w, nil, fail(405, "成片交接接口仅支持 POST"))
			return
		}
		v, e := s.artifactExchange(r.Context(), a, r.URL.Path, body)
		respond(w, v, e)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/v1/douyin/") {
		if r.Method != "POST" {
			respond(w, nil, fail(405, "抖音业务接口仅支持POST"))
			return
		}
		v, e := s.douyin(r.Context(), a, strings.TrimPrefix(r.URL.Path, "/v1/douyin/"), body)
		respond(w, v, e)
		return
	}
	if r.Method == "POST" && strings.HasPrefix(r.URL.Path, "/v1/panorama/") {
		v, e := s.panorama(r.Context(), a, strings.TrimPrefix(r.URL.Path, "/v1/panorama/"), body)
		respond(w, v, e)
		return
	}
	if r.Method == "POST" && strings.HasPrefix(r.URL.Path, "/v1/voices/") {
		v, e := s.voices(r.Context(), a, strings.TrimPrefix(r.URL.Path, "/v1/voices/"), body)
		respond(w, v, e)
		return
	}
	if r.Method == "GET" && r.URL.Path == "/v1/workspace" {
		v, e := s.workspace(r.Context(), a)
		respond(w, v, e)
		return
	}
	if r.Method == "POST" && r.URL.Path == "/v1/factory/properties" {
		v, e := s.factoryProperties(r.Context(), a, body)
		respond(w, v, e)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/v1/beike-cli/") {
		v, e := beikeCLIEndpoint(r.Method, r.URL.Path)
		respond(w, v, e)
		return
	}
	if r.Method == "POST" && r.URL.Path == "/v1/devices/register" {
		var input struct {
			Name     string
			Platform string
			ID       string
		}
		if json.Unmarshal(body, &input) != nil || len(input.Name) > 100 || len(input.Platform) > 50 {
			respond(w, nil, fail(422, "设备资料无效"))
			return
		}
		if input.ID == "" {
			input.ID = id()
		}
		var deviceID string
		err = s.db.QueryRowContext(r.Context(), `INSERT INTO keagent_device(id,owner_id,session_id,name,platform) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET seen_at=now(),session_id=EXCLUDED.session_id WHERE keagent_device.owner_id=EXCLUDED.owner_id AND NOT keagent_device.revoked RETURNING id`, input.ID, a.UserID, a.SessionID, input.Name, input.Platform).Scan(&deviceID)
		if errors.Is(err, sql.ErrNoRows) {
			err = fail(403, "设备已解绑或不属于当前账号，请联系管理员")
		}
		respond(w, object{"id": deviceID}, err)
		return
	}
	if r.Method == "POST" && strings.HasPrefix(r.URL.Path, "/v1/commands/") {
		var args []any
		if json.Unmarshal(body, &args) != nil {
			respond(w, nil, fail(400, "参数格式错误"))
			return
		}
		v, e := s.command(r.Context(), a, strings.TrimPrefix(r.URL.Path, "/v1/commands/"), args)
		respond(w, v, e)
		return
	}
	respond(w, nil, fail(404, "接口不存在"))
}
func (s *server) workspacePayload(ctx context.Context, a actor) (object, error) {
	seed, _ := json.Marshal(initial(a.Name))
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var b []byte
	err = tx.QueryRowContext(ctx, `INSERT INTO keagent_workspace(owner_id,payload) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING payload`, a.UserID, seed).Scan(&b)
	if errors.Is(err, sql.ErrNoRows) {
		// 已有工作区：正常读取。
		if err = tx.QueryRowContext(ctx, `SELECT payload FROM keagent_workspace WHERE owner_id=$1`, a.UserID).Scan(&b); err != nil {
			return nil, err
		}
	} else if err != nil {
		return nil, err
	} else if err = maybeGrantWelcomeCredits(ctx, tx, a.UserID); err != nil {
		// 仅在首次播种（新账号）时按后台配置发放欢迎积分。
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	var w object
	if err = json.Unmarshal(b, &w); err != nil {
		return nil, err
	}
	return w, nil
}

func (s *server) workspace(ctx context.Context, a actor) (object, error) {
	w, err := s.workspacePayload(ctx, a)
	if err != nil {
		return nil, err
	}
	properties := []any{builtinTestProperty()}
	for _, property := range rows(w["properties"]) {
		if obj(property)["id"] != "panorama-cc0-sample" {
			properties = append(properties, property)
		}
	}
	w["properties"] = properties
	rr, err := s.db.QueryContext(ctx, `SELECT payload FROM keagent_resource WHERE payload->>'published'='true' ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rr.Close()
	w["resources"] = []any{}
	for rr.Next() {
		var b []byte
		var resource object
		if err = rr.Scan(&b); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(b, &resource); err != nil {
			return nil, err
		}
		w["resources"] = append(rows(w["resources"]), publicResource(resource))
	}
	return w, rr.Err()
}
func (s *server) command(ctx context.Context, a actor, cmd string, args []any) (any, error) {
	if _, err := s.workspace(ctx, a); err != nil {
		return nil, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var b []byte
	if err = tx.QueryRowContext(ctx, `SELECT payload FROM keagent_workspace WHERE owner_id=$1 FOR UPDATE`, a.UserID).Scan(&b); err != nil {
		return nil, err
	}
	var w object
	if err = json.Unmarshal(b, &w); err != nil {
		return nil, err
	}
	arg := func(i int) any {
		if i < len(args) {
			return args[i]
		}
		return nil
	}
	var result any
	switch cmd {
	case "tick":
		return nil, nil
	case "saveDraft":
		if obj(arg(0)) == nil {
			return nil, fail(422, "配置无效")
		}
		w["draft"] = arg(0)
		result = arg(0)
	case "updateProfile":
		patch := obj(arg(0))
		if patch == nil {
			return nil, fail(422, "资料无效")
		}
		for _, k := range []string{"name", "brokerage", "city", "regions", "phone", "introduction", "defaults"} {
			if v, ok := patch[k]; ok {
				obj(w["profile"])[k] = v
			}
		}
		result = w["profile"]
	case "updateFactoryPreferences":
		input := obj(arg(0))
		if input == nil {
			return nil, fail(422, "默认制作配置无效")
		}
		preferences, err := s.factoryPreferences(ctx, a, input)
		if err != nil {
			return nil, err
		}
		defaults := obj(obj(w["profile"])["defaults"])
		if defaults == nil {
			return nil, fail(422, "原有默认配置无效")
		}
		for key, value := range preferences {
			defaults[key] = value
		}
		result = defaults
	case "createProperty", "updateProperty":
		input := obj(arg(0))
		var property object
		if cmd == "updateProperty" {
			if str(arg(0)) == "panorama-cc0-sample" {
				return nil, fail(422, "内置测试房源仅供测试，请另外添加真实房源")
			}
			property = find(w["properties"], str(arg(0)))
			input = obj(arg(1))
			if property == nil {
				return nil, fail(404, "房源不存在")
			}
		} else {
			property = object{"id": id(), "title": "", "community": "", "propertyNumber": "", "city": "", "district": "", "layout": "", "priceCents": float64(0), "areaSqm": float64(0), "description": "", "sellingPoints": []any{}, "image": "", "images": []any{}, "videoCount": float64(0), "importStatus": "incomplete"}
		}
		if input == nil {
			return nil, fail(422, "房源资料无效")
		}
		for _, k := range []string{"title", "community", "propertyNumber", "city", "district", "layout", "priceCents", "areaSqm", "description", "sellingPoints", "image", "images"} {
			if v, ok := input[k]; ok {
				property[k] = v
			}
		}
		if raw, ok := input["details"]; ok {
			details, err := normalizePropertyDetails(raw)
			if err != nil {
				return nil, err
			}
			if len(details) > 0 {
				property["details"] = details
			} else {
				delete(property, "details")
			}
		}
		if strings.TrimSpace(str(property["title"])) == "" || strings.TrimSpace(str(property["community"])) == "" || strings.TrimSpace(str(property["propertyNumber"])) == "" || number(property["priceCents"]) < 0 || number(property["areaSqm"]) <= 0 {
			return nil, fail(422, "请填写房源名称、小区、编号和有效面积")
		}
		for _, p := range rows(w["properties"]) {
			if obj(p)["id"] != property["id"] && obj(p)["propertyNumber"] == property["propertyNumber"] {
				return nil, fail(409, "房源编号已存在")
			}
		}
		property["lastVerifiedAt"] = now()
		if cmd == "createProperty" {
			w["properties"] = append([]any{property}, rows(w["properties"])...)
		}
		result = property
	case "importProperties":
		return nil, fail(501, "房源号自动获取尚未接入，请使用人工房源资料录入")
	case "createBatch":
		config := obj(arg(0))
		key := str(arg(1))
		if config == nil || key == "" || len(key) > 128 || len(rows(config["propertyIds"])) == 0 || len(rows(config["propertyIds"])) > 100 {
			return nil, fail(422, "批次配置无效")
		}
		encoded, _ := json.Marshal(config)
		sum := sha256.Sum256(encoded)
		fingerprint := hex.EncodeToString(sum[:])
		requests := obj(w["requests"])
		if old := obj(requests[key]); old != nil {
			if old["hash"] != fingerprint {
				return nil, fail(409, "幂等键内容冲突")
			}
			return find(w["batches"], str(old["id"])), nil
		}
		if str(config["videoMode"]) != "voiceover" && str(config["videoMode"]) != "avatar" {
			return nil, fail(422, "视频模式无效")
		}
		delete(config, "avatarId")
		for _, k := range []string{"promptTemplate", "videoTemplate", "styleTemplate", "coverTemplate"} {
			ref := obj(config[k])
			if ref == nil {
				return nil, fail(422, "资源配置缺失")
			}
			var allowed bool
			if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM keagent_resource WHERE id=$1 AND payload->>'version'=$2 AND payload->>'published'='true')`, str(ref["id"]), str(ref["version"])).Scan(&allowed); err != nil {
				return nil, err
			}
			if !allowed {
				return nil, fail(422, "资源版本未发布或已下架")
			}
		}
		batch := object{"id": id(), "configSnapshot": jsonCopy(config), "createdAt": now(), "taskIds": []any{}}
		seen := map[string]bool{}
		for _, pid := range rows(config["propertyIds"]) {
			p := find(w["properties"], str(pid))
			if p == nil || seen[str(pid)] {
				return nil, fail(422, "房源不可见或重复")
			}
			seen[str(pid)] = true
			task := object{"id": id(), "batchId": batch["id"], "propertyId": pid, "propertySnapshot": jsonCopy(p), "configSnapshot": jsonCopy(config), "status": "queued", "stage": "script", "script": "", "scriptRevision": float64(1), "productionRevision": float64(1), "createdAt": now(), "progress": float64(0)}
			w["tasks"] = append(rows(w["tasks"]), task)
			batch["taskIds"] = append(rows(batch["taskIds"]), task["id"])
		}
		w["batches"] = append(rows(w["batches"]), batch)
		requests[key] = object{"id": batch["id"], "hash": fingerprint}
		result = batch
	case "saveScript", "approveScript", "regenerateScript", "cancelTask", "retryTask":
		task := find(w["tasks"], str(arg(0)))
		if task == nil {
			return nil, fail(404, "任务不存在")
		}
		if task["status"] == "running" {
			return nil, fail(409, "任务正在调用供应商，请等待结果后操作")
		}
		if cmd == "cancelTask" {
			task["status"] = "canceled"
		} else if cmd == "retryTask" {
			if task["stage"] != "script" {
				return nil, fail(501, "配音及本地执行器尚未接通")
			}
			if strings.Contains(str(task["error"]), "结果未知") {
				return nil, fail(409, "请先核查供应商结果，不能直接重试")
			}
			task["status"] = "queued"
			delete(task, "error")
		} else {
			revision := arg(2)
			if cmd == "regenerateScript" {
				revision = arg(1)
			}
			if number(revision) != number(task["scriptRevision"]) {
				return nil, fail(409, "文案修订已变化，请刷新")
			}
			if cmd == "regenerateScript" || str(arg(1)) != str(task["script"]) {
				if str(task["script"]) != "" {
					task["history"] = append(rows(task["history"]), object{"revision": task["productionRevision"], "scriptRevision": task["scriptRevision"], "script": task["script"]})
				}
				task["productionRevision"] = number(task["productionRevision"]) + 1
			}
			if cmd == "regenerateScript" {
				task["scriptRevision"] = number(task["scriptRevision"]) + 1
				task["status"] = "queued"
				task["stage"] = "script"
			} else {
				if strings.TrimSpace(str(arg(1))) == "" {
					return nil, fail(422, "文案不能为空")
				}
				task["script"] = str(arg(1))
				task["scriptRevision"] = number(task["scriptRevision"]) + 1
				task["status"] = "awaiting_review"
				if cmd == "approveScript" {
					task["approvedRevision"] = task["scriptRevision"]
					task["stage"] = "tts"
					task["status"] = "failed"
					task["error"] = "文案审核已保存；TTS 服务与本地执行器尚未配置"
				}
			}
		}
		result = task
	default:
		return nil, fail(501, "此能力尚未接入真实服务，不会执行模拟操作")
	}
	w["updatedAt"] = now()
	b, err = json.Marshal(w)
	if err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE keagent_workspace SET payload=$2 WHERE owner_id=$1`, a.UserID, b); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return result, nil
}

func (s *server) admin(r *http.Request, a actor, body []byte) (any, error) {
	ctx := r.Context()
	if strings.HasPrefix(r.URL.Path, "/v1/admin/douyin/") {
		return s.adminDouyin(r, a, body)
	}
	kind := strings.TrimPrefix(r.URL.Path, "/v1/admin/")
	if kind == "ai-config" || strings.HasPrefix(kind, "ai-config/") {
		return s.manageAI(r, a, kind, body)
	}
	if kind == "voices" {
		return s.adminVoices(r, a, body)
	}
	if kind == "credit-codes" || strings.HasPrefix(kind, "credit-codes/") || strings.HasPrefix(kind, "credits/") {
		return s.adminCredits(r, a, kind, body)
	}
	if r.Method == "GET" {
		if kind == "resources/versions" {
			return queryResourceVersions(ctx, s.db, r.URL.Query().Get("id"))
		}
		if kind == "resources/preview" {
			return s.previewProduction(ctx, a, object{"id": r.URL.Query().Get("id")}, false)
		}
		if strings.HasSuffix(kind, "/list") {
			return queryAdminList(ctx, s.db, strings.TrimSuffix(kind, "/list"), r.URL.Query())
		}
		if kind == "overview" {
			ctx, err := s.activeAI(ctx)
			if err != nil {
				return nil, err
			}
			return queryAdminOverview(ctx, s.db)
		}
		if strings.HasPrefix(kind, "tasks/") {
			return queryAdminTask(ctx, s.db, strings.TrimPrefix(kind, "tasks/"))
		}
		query := ""
		switch kind {
		case "devices":
			query = `SELECT jsonb_build_object('id',id,'ownerId',owner_id,'name',name,'platform',platform,'revoked',revoked,'lastSeenAt',seen_at) FROM keagent_device ORDER BY seen_at DESC LIMIT 100`
		case "resources":
			query = `SELECT payload - 'previewSegments' FROM keagent_resource ORDER BY id`
		case "tasks":
			query = `SELECT t.value || jsonb_build_object('ownerId',owner_id) FROM keagent_workspace CROSS JOIN LATERAL jsonb_array_elements(payload->'tasks') t(value) LIMIT 100`
		case "audit":
			query = `SELECT jsonb_build_object('id',id,'actorId',actor_id,'action',action,'targetId',target_id,'createdAt',created_at) FROM keagent_audit ORDER BY created_at DESC LIMIT 100`
		case "releases", "remote-config":
			var b []byte
			err := s.db.QueryRowContext(ctx, `SELECT payload FROM keagent_setting WHERE id=$1`, kind).Scan(&b)
			if errors.Is(err, sql.ErrNoRows) {
				if kind == "releases" {
					return []any{}, nil
				}
				return object{}, nil
			}
			var v any
			if err == nil {
				err = json.Unmarshal(b, &v)
			}
			return v, err
		default:
			return nil, fail(404, "管理接口不存在")
		}
		rr, err := s.db.QueryContext(ctx, query)
		if err != nil {
			return nil, err
		}
		defer rr.Close()
		list := []any{}
		for rr.Next() {
			var b []byte
			var v any
			if err = rr.Scan(&b); err != nil {
				return nil, err
			}
			if err = json.Unmarshal(b, &v); err != nil {
				return nil, err
			}
			list = append(list, v)
		}
		return list, rr.Err()
	}
	if r.Method != "POST" {
		return nil, fail(405, "方法不支持")
	}
	var input object
	if json.Unmarshal(body, &input) != nil {
		return nil, fail(400, "参数无效")
	}
	if kind == "resources/preview" {
		return s.previewProduction(ctx, a, input, true)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	target := str(input["id"])
	metadata := object{}
	action := kind
	switch kind {
	case "devices/revoke":
		action = "device.revoke"
		var name, ownerID, platform string
		if err = tx.QueryRowContext(ctx, `SELECT name,owner_id,platform FROM keagent_device WHERE id=$1 FOR UPDATE`, target).Scan(&name, &ownerID, &platform); errors.Is(err, sql.ErrNoRows) {
			return nil, fail(404, "设备不存在")
		} else if err != nil {
			return nil, err
		}
		metadata = object{"name": name, "ownerId": ownerID, "platform": platform}
		result, e := tx.ExecContext(ctx, `UPDATE keagent_device SET revoked=true WHERE id=$1`, target)
		if e != nil {
			return nil, e
		}
		n, _ := result.RowsAffected()
		if n == 0 {
			return nil, fail(404, "设备不存在")
		}
	case "resources":
		source := str(input["versionOf"])
		if source != "" && target != "" {
			return nil, fail(422, "新版本须使用独立编号")
		}
		input = pickFields(input, "id", "name", "description", "type", "category", "version", "thumbnail", "compatibleModes", "published", "sizeMb", "production")
		if target == "" {
			target = id()
			input["id"] = target
		}
		// Row locks cannot protect a client-supplied ID before its first insert.
		if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('keagent-resource:' || $1, 0))`, target); err != nil {
			return nil, err
		}
		var family string
		family, err = resourceFamily(ctx, tx, target, source, input)
		if err != nil {
			return nil, err
		}
		var old []byte
		err = tx.QueryRowContext(ctx, `SELECT payload FROM keagent_resource WHERE id=$1 FOR UPDATE`, target).Scan(&old)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		var prior object
		if len(old) > 0 {
			if err = json.Unmarshal(old, &prior); err != nil {
				return nil, err
			}
		}
		action = "resource.update"
		if prior == nil {
			action = "resource.create"
		}
		if input["published"] == true {
			action = "resource.publish"
		}
		if input["published"] == false && prior != nil && prior["published"] == true {
			action = "resource.unpublish"
		}
		published, hasPublication := input["published"].(bool)
		if prior != nil && (prior["publishedOnce"] == true || prior["published"] == true || (hasPublication && len(input) == 2)) {
			if !hasPublication {
				return nil, fail(422, "请明确指定上下架状态")
			}
			for k, v := range input {
				if k != "published" && k != "id" {
					p, _ := json.Marshal(prior[k])
					n, _ := json.Marshal(v)
					if string(p) != string(n) {
						return nil, fail(409, "已发布资源不可修改，请新建版本")
					}
				}
			}
			input = prior
			input["published"] = published
		} else if err = validateResource(input); err != nil {
			return nil, err
		}
		if input["description"] == nil {
			input["description"] = ""
		}
		if input["category"] == nil {
			input["category"] = "通用"
		}
		if prior == nil || prior["version"] != input["version"] {
			var duplicate bool
			if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM keagent_resource WHERE id<>$1 AND `+resourceFamilySQL+`=$2 AND payload->>'version'=$3)`, target, family, str(input["version"])).Scan(&duplicate); err != nil {
				return nil, err
			}
			if duplicate {
				return nil, fail(409, "此模板已使用该版本号，请填写其他版本号")
			}
		}
		if input["production"] != nil {
			catalogKey := strings.ToLower(strings.TrimSpace(str(input["name"]))) + "@" + str(input["version"])
			if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('keagent-template-version:' || $1, 0))`, catalogKey); err != nil {
				return nil, err
			}
			var duplicate bool
			if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM keagent_resource WHERE id<>$1 AND lower(trim(payload->>'name'))=lower(trim($2)) AND payload->>'version'=$3 AND payload ? 'production')`, target, str(input["name"]), str(input["version"])).Scan(&duplicate); err != nil {
				return nil, err
			}
			if duplicate {
				return nil, fail(409, "相同名称和版本的制作模板已存在，请填写新版本号")
			}
			if prior != nil && prior["previewDigest"] == productionDigest(input) {
				input["previewDigest"] = prior["previewDigest"]
				if prior["previewSegments"] != nil {
					input["previewSegments"] = prior["previewSegments"]
				}
			}
			if input["published"] == true && input["previewDigest"] != productionDigest(input) {
				return nil, fail(422, "请先保存并预览校验当前模板，再上架")
			}
		}
		if input["published"] == true {
			if _, err = tx.ExecContext(ctx, `UPDATE keagent_resource SET payload=payload || '{"published":false,"publishedOnce":true}'::jsonb WHERE id<>$1 AND `+resourceFamilySQL+`=$2 AND payload->>'published'='true'`, target, family); err != nil {
				return nil, err
			}
			input["publishedOnce"] = true
		}
		input["familyId"] = family
		if input["thumbnail"] == nil {
			input["thumbnail"] = ""
		}
		if input["compatibleModes"] == nil {
			input["compatibleModes"] = []any{"voiceover", "avatar"}
		}
		if input["sizeMb"] == nil {
			input["sizeMb"] = float64(0)
		}
		if input["published"] == nil {
			input["published"] = false
		}
		input["installed"] = false
		input["downloadStatus"] = "idle"
		input["downloadProgress"] = 0
		b, _ := json.Marshal(input)
		_, err = tx.ExecContext(ctx, `INSERT INTO keagent_resource(id,payload) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload`, target, b)
		metadata = pickFields(input, "name", "type", "version", "published")
	default:
		return nil, fail(501, "此管理能力尚未接入，未保存模拟配置")
	}
	if err != nil {
		return nil, err
	}
	metadataJSON, _ := json.Marshal(metadata)
	if _, err = tx.ExecContext(ctx, `INSERT INTO keagent_audit(id,actor_id,action,target_id,metadata) VALUES($1,$2,$3,$4,$5)`, id(), a.UserID, action, target, metadataJSON); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return object{"id": target}, nil
}

// shortcut: 第一轮联调按用户文档加锁；增加跨用户业务检索前迁移为实体表。
func (s *server) work(ctx context.Context) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.workOnce(ctx)
		}
	}
}
func (s *server) workOnce(ctx context.Context) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return
	}
	defer tx.Rollback()
	var owner string
	var b []byte
	err = tx.QueryRowContext(ctx, `SELECT owner_id,payload FROM keagent_workspace WHERE payload @> '{"tasks":[{"status":"queued","stage":"script"}]}' FOR UPDATE SKIP LOCKED LIMIT 1`).Scan(&owner, &b)
	if err != nil {
		return
	}
	var w object
	if json.Unmarshal(b, &w) != nil {
		return
	}
	var task object
	for _, v := range rows(w["tasks"]) {
		t := obj(v)
		if t["status"] == "queued" && t["stage"] == "script" {
			task = t
			break
		}
	}
	if task == nil {
		return
	}
	// 每次执行前检查权威账号状态，封禁用户不再发起新的 AI 调用。
	var banned bool
	if err = tx.QueryRowContext(ctx, `SELECT COALESCE(banned,false) FROM "user" WHERE id=$1`, owner).Scan(&banned); err != nil || banned {
		return
	}
	task["status"] = "running"
	task["error"] = "供应商结果未知，若服务中断请先核查再处理"
	task["attemptId"] = id()
	attempt := task["attemptId"]
	b, _ = json.Marshal(w)
	if _, err = tx.ExecContext(ctx, `UPDATE keagent_workspace SET payload=$2 WHERE owner_id=$1`, owner, b); err != nil {
		return
	}
	if tx.Commit() != nil {
		return
	}
	providerCtx, callErr := s.activeAI(ctx)
	var text string
	if callErr == nil {
		text, callErr = generate(providerCtx, obj(task["propertySnapshot"]))
	}
	tx, err = s.db.BeginTx(ctx, nil)
	if err != nil {
		return
	}
	defer tx.Rollback()
	if tx.QueryRowContext(ctx, `SELECT payload FROM keagent_workspace WHERE owner_id=$1 FOR UPDATE`, owner).Scan(&b) != nil {
		return
	}
	if json.Unmarshal(b, &w) != nil {
		return
	}
	current := find(w["tasks"], str(task["id"]))
	if current == nil || current["attemptId"] != attempt {
		return
	}
	if callErr != nil {
		current["status"] = "failed"
		current["error"] = callErr.Error()
	} else {
		current["script"] = text
		current["progress"] = 25
		current["status"] = "awaiting_review"
		delete(current, "error")
		if obj(current["configSnapshot"])["requireScriptReview"] == false {
			current["stage"] = "tts"
			current["status"] = "failed"
			current["error"] = "文案已生成；TTS 服务与本地执行器尚未配置"
		}
	}
	b, _ = json.Marshal(w)
	if _, err = tx.ExecContext(ctx, `UPDATE keagent_workspace SET payload=$2 WHERE owner_id=$1`, owner, b); err == nil {
		_ = tx.Commit()
	}
}
func generate(ctx context.Context, p object) (string, error) {
	return generateWithInstruction(ctx, p, "你是房产视频文案助手。仅依据给定房源资料写中文口播文案，不编造价格、配套或承诺。")
}
func generateWithInstruction(ctx context.Context, p object, instruction string) (string, error) {
	property, _ := json.Marshal(p)
	return generateWithContent(ctx, string(property), instruction)
}
func generateWithContent(ctx context.Context, content any, instruction string) (string, error) {
	service := aiServicesFor(ctx)[0]
	if aiSnapshotFrom(ctx).locked["script"] {
		return "", fail(503, "生效的文案配置无法解密")
	}
	if service.State != "configured" {
		return "", errors.New("云端 AI 服务未配置，请联系管理员")
	}
	client, transport := providerClient()
	defer transport.CloseIdleConnections()
	return completionWithContent(ctx, client, service.Endpoint+"/chat/completions", aiValue(ctx, "AI_MODEL"), aiValue(ctx, "AI_API_KEY"), content, instruction)
}
func providerClient() (*http.Client, *http.Transport) {
	transport := &http.Transport{DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
		if err != nil {
			return nil, err
		}
		for _, ip := range ips {
			if !publicProviderIP(ip.IP) {
				return nil, errors.New("private target refused")
			}
		}
		if len(ips) == 0 {
			return nil, errors.New("no address")
		}
		return (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, network, net.JoinHostPort(ips[0].IP.String(), port))
	}}
	client := &http.Client{Transport: transport, Timeout: 55 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect refused") }}
	return client, transport
}
func publicProviderIP(ip net.IP) bool {
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	v4 := ip.To4()
	return v4 == nil || v4[0] != 100 || v4[1] < 64 || v4[1] >= 128
}
func completion(ctx context.Context, client *http.Client, endpoint, model, key string, p object) (string, error) {
	return completionWithInstruction(ctx, client, endpoint, model, key, p, "你是房产视频文案助手。仅依据给定房源资料写中文口播文案，不编造价格、配套或承诺。")
}
func completionWithInstruction(ctx context.Context, client *http.Client, endpoint, model, key string, p object, instruction string) (string, error) {
	property, _ := json.Marshal(p)
	return completionWithContent(ctx, client, endpoint, model, key, string(property), instruction)
}
func completionWithContent(ctx context.Context, client *http.Client, endpoint, model, key string, content any, instruction string) (string, error) {
	payload, _ := json.Marshal(object{"model": model, "messages": []any{object{"role": "system", "content": instruction}, object{"role": "user", "content": content}}})
	req, err := http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewReader(payload))
	if err != nil {
		return "", errors.New("AI 请求配置无效")
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	response, err := client.Do(req)
	if err != nil {
		return "", errors.New("供应商结果未知，请核查后再处理，不要直接重试")
	}
	defer response.Body.Close()
	if response.StatusCode/100 != 2 {

		if response.StatusCode >= 500 {
			return "", errors.New("供应商结果未知：服务异常，请先核查，不要直接重试")
		}
		return "", fmt.Errorf("AI 服务返回 HTTP %d，请检查服务端配置", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	if err != nil || len(data) > 1<<20 {
		return "", errors.New("供应商结果未知：读取响应失败")
	}
	var output struct {
		Choices []struct{ Message struct{ Content string } }
	}
	if json.Unmarshal(data, &output) != nil || len(output.Choices) == 0 || strings.TrimSpace(output.Choices[0].Message.Content) == "" {
		return "", errors.New("供应商结果未知：未取得有效文案")
	}
	return output.Choices[0].Message.Content, nil
}
func main() {
	if len(os.Args) > 1 && os.Args[1] == "beike-cli-probe" {
		if err := beikeCLIProbe(context.Background(), os.Args[2:], os.Stdout); err != nil {
			log.Fatal(err)
		}
		return
	}
	secret := os.Getenv("INTERNAL_API_SECRET")
	if os.Getenv("ALLOW_LEGACY_GATEWAY") == "false" {
		secret = ""
	} else if len(secret) < 32 {
		log.Fatal("INTERNAL_API_SECRET must have 32+ characters")
	}
	db, err := sql.Open("pgx", os.Getenv("DATABASE_URL"))
	if err != nil {
		log.Fatal("database configuration invalid")
	}
	defer db.Close()
	db.SetMaxOpenConns(20)
	db.SetMaxIdleConns(20)
	if err = db.Ping(); err != nil {
		log.Fatal("database unavailable")
	}
	if _, err = db.Exec(schema); err != nil {
		log.Fatal("business migration failed")
	}
	if err = seedVideoTemplates(context.Background(), db); err != nil {
		log.Fatal("video template migration failed")
	}
	if _, err = db.Exec(productionImageSchema); err != nil {
		log.Fatal("production image migration failed")
	}
	if _, err = db.Exec(voiceSchema); err != nil {
		log.Fatal("voice migration failed")
	}
	if _, err = db.Exec(publicVoiceSchema); err != nil {
		log.Fatal("public voice migration failed")
	}
	if err = seedDefaultPublicVoice(context.Background(), db); err != nil {
		log.Fatal("public voice seed failed")
	}
	if _, err = db.Exec(artifactExchangeSchema); err != nil {
		log.Fatal("artifact exchange migration failed")
	}
	if _, err = db.Exec(douyinSchema); err != nil {
		log.Fatal("douyin migration failed")
	}
	verifier, err := newJWTVerifier()
	if err != nil {
		log.Fatal(err)
	}
	origins := os.Getenv("TRUSTED_ORIGINS")
	if origins == "" {
		origins = "http://127.0.0.1:5174,http://127.0.0.1:5173"
	}
	s := &server{db: db, secret: secret, jwt: verifier, origins: strings.Split(origins, ",")}
	go s.work(context.Background())
	go s.douyinBackground(context.Background())
	go s.runAIProbes(context.Background())
	go s.creditExpireSweeper(context.Background())
	log.Println("Go business API listening on 127.0.0.1:18081")
	log.Fatal((&http.Server{Addr: "127.0.0.1:18081", Handler: s, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 65 * time.Second}).ListenAndServe())
}
