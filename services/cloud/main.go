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
	"net/url"
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
	Role      string `json:"role"`
	Timestamp int64  `json:"timestamp"`
	Nonce     string `json:"nonce"`
}
type server struct {
	db     *sql.DB
	secret string
	nonces sync.Map
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

const schema = `
CREATE TABLE IF NOT EXISTS keagent_workspace (owner_id text PRIMARY KEY, payload jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS keagent_resource (id text PRIMARY KEY, payload jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS keagent_device (id text PRIMARY KEY, owner_id text NOT NULL, session_id text NOT NULL, name text NOT NULL, platform text NOT NULL, revoked boolean NOT NULL DEFAULT false, seen_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS keagent_setting (id text PRIMARY KEY, payload jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS keagent_audit (id text PRIMARY KEY, actor_id text NOT NULL, action text NOT NULL, target_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
`

func (s *server) verify(r *http.Request, body []byte) (actor, error) {
	var a actor
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
		_ = json.NewEncoder(w).Encode(object{"error": object{"message": message}})
		return
	}
	_ = json.NewEncoder(w).Encode(value)
}
func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/health" {
		respond(w, object{"status": "ok"}, nil)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil {
		respond(w, nil, fail(413, "请求过大"))
		return
	}
	a, err := s.verify(r, body)
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
	if strings.HasPrefix(r.URL.Path, "/v1/admin/") {
		if !strings.Contains(","+a.Role+",", ",admin,") {
			respond(w, nil, fail(403, "需要管理员权限"))
			return
		}
		v, e := s.admin(r, a, body)
		respond(w, v, e)
		return
	}
	if r.Method == "GET" && r.URL.Path == "/v1/workspace" {
		v, e := s.workspace(r.Context(), a)
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
func (s *server) workspace(ctx context.Context, a actor) (object, error) {
	seed, _ := json.Marshal(initial(a.Name))
	_, err := s.db.ExecContext(ctx, `INSERT INTO keagent_workspace(owner_id,payload) VALUES($1,$2) ON CONFLICT DO NOTHING`, a.UserID, seed)
	if err != nil {
		return nil, err
	}
	var b []byte
	err = s.db.QueryRowContext(ctx, `SELECT payload FROM keagent_workspace WHERE owner_id=$1`, a.UserID).Scan(&b)
	if err != nil {
		return nil, err
	}
	var w object
	if err = json.Unmarshal(b, &w); err != nil {
		return nil, err
	}
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
		w["resources"] = append(rows(w["resources"]), resource)
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
	case "createProperty", "updateProperty":
		input := obj(arg(0))
		var property object
		if cmd == "updateProperty" {
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
	kind := strings.TrimPrefix(r.URL.Path, "/v1/admin/")
	if r.Method == "GET" {
		query := ""
		switch kind {
		case "devices":
			query = `SELECT jsonb_build_object('id',id,'ownerId',owner_id,'name',name,'platform',platform,'revoked',revoked,'lastSeenAt',seen_at) FROM keagent_device ORDER BY seen_at DESC LIMIT 100`
		case "resources":
			query = `SELECT payload FROM keagent_resource ORDER BY id`
		case "tasks":
			query = `SELECT t.value || jsonb_build_object('ownerId',owner_id) FROM keagent_workspace CROSS JOIN LATERAL jsonb_array_elements(payload->'tasks') t(value) LIMIT 100`
		case "audit":
			query = `SELECT jsonb_build_object('id',id,'actorId',actor_id,'action',action,'targetId',target_id,'createdAt',created_at) FROM keagent_audit ORDER BY created_at DESC LIMIT 100`
		case "ai-config":
			return object{"configured": os.Getenv("AI_API_KEY") != "", "model": os.Getenv("AI_MODEL"), "baseURL": os.Getenv("AI_BASE_URL"), "note": "密钥通过服务端环境配置，浏览器无法读取"}, nil
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
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	target := str(input["id"])
	switch kind {
	case "devices/revoke":
		result, e := tx.ExecContext(ctx, `UPDATE keagent_device SET revoked=true WHERE id=$1`, target)
		if e != nil {
			return nil, e
		}
		n, _ := result.RowsAffected()
		if n == 0 {
			return nil, fail(404, "设备不存在")
		}
	case "resources":
		if target == "" {
			target = id()
			input["id"] = target
		}
		if str(input["name"]) == "" || str(input["version"]) == "" || !strings.Contains(",video,style,prompt,cover,subtitle,", ","+str(input["type"])+",") {
			return nil, fail(422, "资源名称、版本、类型无效")
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
		if prior != nil && prior["publishedOnce"] == true {
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
			var patch object
			_ = json.Unmarshal(body, &patch)
			input["published"] = patch["published"]
		}
		if input["published"] == true {
			input["publishedOnce"] = true
		}
		input["installed"] = false
		input["downloadStatus"] = "idle"
		input["downloadProgress"] = 0
		b, _ := json.Marshal(input)
		_, err = tx.ExecContext(ctx, `INSERT INTO keagent_resource(id,payload) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload`, target, b)
	default:
		return nil, fail(501, "此管理能力尚未接入，未保存模拟配置")
	}
	if err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO keagent_audit(id,actor_id,action,target_id) VALUES($1,$2,$3,$4)`, id(), a.UserID, kind, target); err != nil {
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
	text, callErr := generate(ctx, obj(task["propertySnapshot"]))
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
	if os.Getenv("AI_API_KEY") == "" || os.Getenv("AI_MODEL") == "" {
		return "", errors.New("云端 AI 服务未配置，请联系管理员")
	}
	base, err := url.Parse(os.Getenv("AI_BASE_URL"))
	if err != nil || base.Scheme != "https" || base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return "", errors.New("云端 AI 地址配置无效")
	}
	allowed := false
	for _, h := range strings.Split(os.Getenv("AI_ALLOWED_HOSTS"), ",") {
		if h != "" && strings.EqualFold(h, base.Hostname()) {
			allowed = true
		}
	}
	if !allowed {
		return "", errors.New("AI 服务域名未加入服务端允许列表")
	}
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
			if !ip.IP.IsGlobalUnicast() || ip.IP.IsPrivate() || ip.IP.IsLoopback() || ip.IP.IsLinkLocalUnicast() {
				return nil, errors.New("private target refused")
			}
		}
		if len(ips) == 0 {
			return nil, errors.New("no address")
		}
		return (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, network, net.JoinHostPort(ips[0].IP.String(), port))
	}}
	client := &http.Client{Transport: transport, Timeout: 55 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect refused") }}
	defer transport.CloseIdleConnections()
	return completion(ctx, client, strings.TrimRight(base.String(), "/")+"/chat/completions", os.Getenv("AI_MODEL"), os.Getenv("AI_API_KEY"), p)
}
func completion(ctx context.Context, client *http.Client, endpoint, model, key string, p object) (string, error) {
	property, _ := json.Marshal(p)
	payload, _ := json.Marshal(object{"model": model, "messages": []any{object{"role": "system", "content": "你是房产视频文案助手。仅依据给定房源资料写中文口播文案，不编造价格、配套或承诺。"}, object{"role": "user", "content": string(property)}}})
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
	secret := os.Getenv("INTERNAL_API_SECRET")
	if len(secret) < 32 {
		log.Fatal("INTERNAL_API_SECRET must have 32+ characters")
	}
	db, err := sql.Open("pgx", os.Getenv("DATABASE_URL"))
	if err != nil {
		log.Fatal("database configuration invalid")
	}
	defer db.Close()
	if err = db.Ping(); err != nil {
		log.Fatal("database unavailable")
	}
	if _, err = db.Exec(schema); err != nil {
		log.Fatal("business migration failed")
	}
	s := &server{db: db, secret: secret}
	go s.work(context.Background())
	log.Println("Go business API listening on 127.0.0.1:18081")
	log.Fatal((&http.Server{Addr: "127.0.0.1:18081", Handler: s, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 65 * time.Second}).ListenAndServe())
}
