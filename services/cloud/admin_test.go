package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

func TestAdminPageValidation(t *testing.T) {
	for _, query := range []string{"limit=0", "limit=101", "offset=-1", "limit=abc", "offset=9999999999999999999999", "limit=1&limit=2", "role=owner", "banned=yes"} {
		q, _ := url.ParseQuery(query)
		if _, err := parseAdminPage("users", q); err == nil {
			t.Fatalf("invalid query accepted: %s", query)
		}
	}
	for _, query := range []string{"status=unknown", "from=2026-11-01", "from=2026-11-03T00:00:00Z&to=2026-11-01T00:00:00Z"} {
		q, _ := url.ParseQuery(query)
		if _, err := parseAdminPage("auth-audit", q); err == nil {
			t.Fatalf("invalid audit query accepted: %s", query)
		}
	}
	p, err := parseAdminPage("users", url.Values{"q": {"100%_\\"}, "role": {"user"}, "banned": {"false"}})
	if err != nil || len(p.args) != 3 || p.args[0] != `%100\%\_\\%` {
		t.Fatalf("literal search or combined filters failed: %#v %v", p, err)
	}
}

func TestAdminAISafeConfiguration(t *testing.T) {
	for _, key := range []string{"AI_API_KEY", "AI_BASE_URL", "AI_MODEL", "AI_ALLOWED_HOSTS", "DASHSCOPE_API_KEY", "DASHSCOPE_WORKSPACE_ID", "DASHSCOPE_VOICE_CLONE_ENABLED", "MINIMAX_API_KEY"} {
		t.Setenv(key, "")
	}
	if services := aiServices(); services[0].State != "missing" || services[1].State != "missing" || services[len(services)-1].State != "missing" {
		t.Fatal("missing providers reported configured")
	}
	t.Setenv("AI_API_KEY", "secret-key-do-not-expose")
	t.Setenv("AI_MODEL", "model")
	t.Setenv("AI_BASE_URL", "https://api.example.com/v1")
	t.Setenv("AI_ALLOWED_HOSTS", "api.example.com")
	if aiServices()[0].State != "configured" {
		t.Fatal("complete script configuration rejected")
	}
	for _, endpoint := range []string{"https://user:private-password@api.example.com", "https://api.example.com?key=private-password", "https://127.0.0.1", "https:///missing-host", "http://api.example.com"} {
		t.Setenv("AI_BASE_URL", endpoint)
		config := adminAIConfig()
		raw, _ := json.Marshal(config)
		if config["configured"] != false || strings.Contains(string(raw), "private-password") || strings.Contains(string(raw), "secret-key-do-not-expose") {
			t.Fatalf("unsafe config leaked or accepted: %s", raw)
		}
		if _, err := generate(t.Context(), object{}); err == nil {
			t.Fatal("generation ignored unsafe configuration")
		}
	}
	t.Setenv("DASHSCOPE_API_KEY", "private-tts-key")
	if service := aiServices()[1]; service.State != "incomplete" || service.Endpoint != "" {
		t.Fatal("TTS unexpectedly available without a business workspace")
	}
	for _, workspace := range []string{"llm-test.example.org", "ws-test.cn-beijing.maas.aliyuncs.com", "ws-test/other", "ws-"} {
		t.Setenv("DASHSCOPE_WORKSPACE_ID", workspace)
		if service := aiServices()[1]; service.State != "incomplete" || service.Endpoint != "" || len(service.Issues) == 0 {
			t.Fatalf("invalid TTS workspace %q was accepted", workspace)
		}
	}
	t.Setenv("DASHSCOPE_VOICE_CLONE_ENABLED", "true")
	for _, workspace := range []string{"llm-test", "ws-test3example42"} {
		t.Setenv("DASHSCOPE_WORKSPACE_ID", workspace)
		base := "https://" + workspace + ".cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/"
		services := aiServices()
		if services[1].State != "configured" || services[1].Endpoint != base+"SpeechSynthesizer" {
			t.Fatalf("valid TTS workspace %q rejected", workspace)
		}
		if services[2].State != "configured" || services[2].Endpoint != base+"customization" || !cloneConfigured(t.Context()) {
			t.Fatalf("valid clone workspace %q rejected", workspace)
		}
	}
	if _, exists := specFor("avatar"); exists {
		t.Fatal("retired avatar service is still exposed")
	}
	value, err := (&server{}).panorama(t.Context(), actor{}, "capabilities", []byte(`{}`))
	if err != nil || value.(object)["ai"] != false || value.(object)["bailianTts"] != true {
		t.Fatal("capability rules diverged from admin checks", value, err)
	}
}

func TestAdminResourceValidation(t *testing.T) {
	valid := object{"name": "测试资源", "type": "prompt", "version": "1", "compatibleModes": []any{"voiceover"}, "thumbnail": "/media/thumb.jpg", "sizeMb": float64(0), "published": false}
	if err := validateResource(valid); err != nil {
		t.Fatal(err)
	}
	for field, value := range map[string]any{"name": " ", "type": "unknown", "compatibleModes": []any{"invalid"}, "thumbnail": "javascript:alert(1)", "sizeMb": float64(-1), "published": "true"} {
		bad := jsonCopy(valid).(object)
		bad[field] = value
		if err := validateResource(bad); err == nil {
			t.Fatalf("invalid %s accepted", field)
		}
	}
	if _, ok := publicResource(object{"name": "valid", "apiKey": "hidden"})["apiKey"]; ok {
		t.Fatal("resource did not enforce public field allowlist")
	}
	if raw, _ := json.Marshal(publicFields(object{"description": object{"token": "hidden"}, "sellingPoints": []any{"valid", object{"token": "hidden"}}}, "description", "sellingPoints")); strings.Contains(string(raw), "hidden") {
		t.Fatal("nested data bypassed the response allowlist")
	}
	if len(auditDetails(object{"name": "valid", "token": "secret", "credentials": object{"a": "b"}})) != 1 {
		t.Fatal("audit metadata leaked unknown fields")
	}
}

func TestAdminQueriesPostgres(t *testing.T) {
	connection := os.Getenv("ADMIN_TEST_DATABASE_URL")
	if connection == "" {
		t.Skip("set ADMIN_TEST_DATABASE_URL to run isolated PostgreSQL query checks")
	}
	db, err := sql.Open("pgx", connection)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	tx, err := db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	// Temporary tables shadow production names and are discarded with this transaction.
	_, err = tx.ExecContext(t.Context(), `
	CREATE TEMP TABLE "user" (id text,name text,email text,role text,banned boolean,"banReason" text,"createdAt" timestamptz);
	CREATE TEMP TABLE keagent_device (id text,owner_id text,name text,platform text,revoked boolean,seen_at timestamptz);
	CREATE TEMP TABLE keagent_resource (id text,payload jsonb);
	CREATE TEMP TABLE keagent_workspace (owner_id text,payload jsonb);
	CREATE TEMP TABLE keagent_audit (id text,actor_id text,action text,target_id text,metadata jsonb,created_at timestamptz);
	CREATE TEMP TABLE "adminAuditLog" (id text,"actorId" text,"targetId" text,action text,"createdAt" timestamptz,"operationId" text,status text,reason text);
	INSERT INTO "user" VALUES ('u1','搜索用户','viewer@example.test','user',false,NULL,'2026-11-01T00:00:00Z'),('u2','管理员','admin@example.test','admin',false,NULL,'2026-11-02T00:00:00Z');
	INSERT INTO keagent_device VALUES ('d1','u1','工作电脑','win32',false,'2026-11-01T00:00:00Z'),('d2','missing-owner','旧电脑','win32',true,'2026-11-02T00:00:00Z');
	INSERT INTO keagent_resource VALUES ('r1','{"id":"r1","name":"资源一","type":"prompt","version":"1","published":true,"publishedOnce":true}'),('r2','{"id":"r2","name":"资源二","type":"style","version":"1","published":false,"publishedOnce":true}');
	INSERT INTO keagent_resource VALUES
	('r3','{"id":"r3","name":"房源带看","type":"video","version":"1.0.0","published":true,"production":{"schemaVersion":1}}'),
	('r4','{"id":"r4","name":"房源带看","type":"video","version":"2.0.0","published":true}'),
	('r5','{"id":"r5","name":"封面","type":"cover","version":"1","published":true}'),
	('r6','{"id":"r6","name":"字幕","type":"subtitle","version":"1","published":true}'),
	('b1','{"id":"b1","name":"推荐搭配","type":"video","version":"1.0.0","published":true,"definition":{"kind":"bundle"}}');
	INSERT INTO keagent_audit VALUES ('a1','u2','resources','r1','{"name":"资源一","token":"must-not-leak"}','2026-11-02T00:00:00Z');
	INSERT INTO "adminAuditLog" VALUES ('aa1','u2','u1','admin.ban-user','2026-11-02T00:00:00Z','op1','succeeded','Admin API request'),('aa2','u2','new-user','admin.create-user','2026-11-02T00:00:00Z','op2','succeeded','Admin API request'),('aa3','u2','missing-session','admin.revoke-user-session','2026-11-02T00:00:00Z','op3','succeeded','Admin API request');`)
	if err != nil {
		t.Fatal(err)
	}
	task := object{"id": "t1", "batchId": "b1", "propertyId": "p1", "propertySnapshot": object{"title": "测试房源", "propertyNumber": "SH100", "apiKey": "must-not-leak"}, "configSnapshot": object{"videoMode": "voiceover", "token": "must-not-leak"}, "status": "failed", "stage": "script", "progress": float64(0), "script": "待生成", "createdAt": "2026-11-03T00:00:00Z", "sessionToken": "must-not-leak"}
	payload, _ := json.Marshal(object{"tasks": []any{task}})
	if _, err = tx.ExecContext(t.Context(), `INSERT INTO keagent_workspace VALUES ('u1',$1)`, payload); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"users", "devices", "resources", "tasks", "audit", "auth-audit"} {
		result, err := queryAdminList(t.Context(), tx, kind, url.Values{"limit": {"1"}})
		if err != nil || result["total"].(int) < 1 || len(result["items"].([]any)) != 1 {
			t.Fatalf("%s query: %#v %v", kind, result, err)
		}
	}
	for _, query := range []url.Values{{"q": {"搜索用户"}, "role": {"user"}, "banned": {"false"}}, {"q": {"viewer@example.test"}}} {
		result, err := queryAdminList(t.Context(), tx, "users", query)
		if err != nil || result["total"] != 1 {
			t.Fatalf("OR search / combined filters failed: %#v %v", result, err)
		}
	}
	for _, query := range []string{"%", "_", "' OR true --"} {
		result, err := queryAdminList(t.Context(), tx, "users", url.Values{"q": {query}})
		if err != nil || result["total"] != 0 {
			t.Fatal("search interpreted wildcard or SQL input", query, result, err)
		}
	}
	result, err := queryAdminList(t.Context(), tx, "devices", url.Values{"ownerId": {"missing-owner"}})
	if err != nil || result["items"].([]any)[0].(object)["owner"] != nil {
		t.Fatal("missing identity did not remain null", result, err)
	}
	result, err = queryAdminList(t.Context(), tx, "resources", url.Values{"state": {"unpublished"}})
	if err != nil || result["items"].([]any)[0].(object)["id"] != "r2" {
		t.Fatal("unpublished filter failed", result, err)
	}
	result, err = queryAdminList(t.Context(), tx, "resources", url.Values{"productionOnly": {"true"}, "state": {"published"}, "limit": {"1"}})
	if err != nil || result["total"] != 1 || result["items"].([]any)[0].(object)["id"] != "r3" {
		t.Fatal("production filter must apply before version grouping and pagination", result, err)
	}
	if versions, err := queryResourceVersions(t.Context(), tx, "r3"); err != nil || len(versions) != 1 || versions[0].(object)["id"] != "r3" {
		t.Fatal("production history included incomplete video versions", versions, err)
	}
	for _, id := range []string{"r1", "r4"} {
		if _, err := queryResourceVersions(t.Context(), tx, id); err == nil {
			t.Fatal("hidden template could still be opened", id)
		}
	}
	result, err = queryAdminList(t.Context(), tx, "users", url.Values{"offset": {"99"}})
	if err != nil || result["total"] != 2 || len(result["items"].([]any)) != 0 {
		t.Fatal("empty page lost total", result, err)
	}
	result, err = queryAdminList(t.Context(), tx, "auth-audit", url.Values{"actorId": {"u2"}, "targetId": {"u1"}, "action": {"admin.ban-user"}, "status": {"succeeded"}, "from": {"2026-11-01T00:00:00Z"}, "to": {"2026-11-03T00:00:00Z"}})
	if err != nil || result["total"] != 1 || result["items"].([]any)[0].(object)["target"].(object)["name"] != "搜索用户" {
		t.Fatal("audit filter / identity join failed", result, err)
	}
	for target, label := range map[string]string{"new-user": "创建用户（未记录账号）", "missing-session": "登录会话（对象不可用）"} {
		result, err = queryAdminList(t.Context(), tx, "auth-audit", url.Values{"targetId": {target}})
		if err != nil || result["items"].([]any)[0].(object)["targetLabel"] != label || result["items"].([]any)[0].(object)["target"] != nil {
			t.Fatal("unknown audit target was misidentified", result, err)
		}
	}
	result, err = queryAdminTask(t.Context(), tx, "t1")
	encoded, _ := json.Marshal(result)
	if err != nil || strings.Contains(string(encoded), "must-not-leak") {
		t.Fatalf("task details leaked unknown fields: %s %v", encoded, err)
	}
	if _, err = queryAdminTask(t.Context(), tx, "missing"); err == nil {
		t.Fatal("missing task did not fail")
	}
	result, err = queryAdminOverview(t.Context(), tx)
	if err != nil || result["users"] != 2 || result["devices"] != 1 || result["publishedResources"] != 1 || result["failedTasks"] != 1 {
		t.Fatal("overview totals incorrect", result, err)
	}
	for i := 0; i < 105; i++ {
		if _, err = tx.ExecContext(t.Context(), `INSERT INTO "user" VALUES ($1,$1,$1||'@example.test','user',false,NULL,now())`, fmt.Sprintf("extra-%03d", i)); err != nil {
			t.Fatal(err)
		}
	}
	result, err = queryAdminList(t.Context(), tx, "users", url.Values{"offset": {"100"}, "limit": {"20"}})
	if err != nil || result["total"] != 107 || len(result["items"].([]any)) != 7 {
		t.Fatal("pagination truncated after 100", result, err)
	}
}

func TestUnknownAdminList(t *testing.T) {
	r := httptest.NewRequest("GET", "/v1/admin/not-a-page/list", nil)
	if _, err := (&server{}).admin(r, actor{}, nil); err == nil {
		t.Fatal("unknown list accepted")
	}
}

func TestResourceConcurrentFirstPublish(t *testing.T) {
	connection := os.Getenv("ADMIN_TEST_DATABASE_URL")
	if connection == "" {
		t.Skip("set ADMIN_TEST_DATABASE_URL to run isolated PostgreSQL concurrency checks")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	base, err := sql.Open("pgx", connection)
	if err != nil {
		t.Fatal(err)
	}
	defer base.Close()
	fixtureSchema := "keagent_admin_test_" + id()
	if _, err = base.ExecContext(ctx, `CREATE SCHEMA `+fixtureSchema); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if _, err := base.ExecContext(context.Background(), `DROP SCHEMA `+fixtureSchema+` CASCADE`); err != nil {
			t.Error(err)
		}
	}()
	config, err := pgx.ParseConfig(connection)
	if err != nil {
		t.Fatal(err)
	}
	config.RuntimeParams["search_path"] = fixtureSchema
	config.RuntimeParams["application_name"] = fixtureSchema
	db := stdlib.OpenDB(*config)
	defer db.Close()
	if _, err = db.ExecContext(ctx, schema); err != nil {
		t.Fatal(err)
	}
	holder, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Rollback()
	resourceID := "same-client-supplied-id"
	if _, err = holder.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('keagent-resource:' || $1, 0))`, resourceID); err != nil {
		t.Fatal(err)
	}
	s := &server{db: db}
	type outcome struct {
		published bool
		err       error
	}
	results := make(chan outcome, 2)
	start := make(chan struct{})
	for _, published := range []bool{true, false} {
		go func(published bool) {
			<-start
			name, version := "Published A", "1"
			if !published {
				name, version = "Competing B", "2"
			}
			body, _ := json.Marshal(object{"id": resourceID, "name": name, "version": version, "type": "prompt", "published": published})
			r := httptest.NewRequest("POST", "/v1/admin/resources", nil).WithContext(ctx)
			_, err := s.admin(r, actor{UserID: "isolated-test-admin"}, body)
			results <- outcome{published, err}
		}(published)
	}
	close(start)
	// Both requests must wait before reading the absent row, then serialize after release.
	waiting := 0
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		err = db.QueryRowContext(ctx, `SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE l.locktype='advisory' AND NOT l.granted AND a.application_name=$1`, fixtureSchema).Scan(&waiting)
		if err != nil || waiting == 2 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err != nil || waiting != 2 {
		t.Errorf("new resource requests bypassed the ID lock: waiting=%d err=%v", waiting, err)
	}
	if err = holder.Rollback(); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		result := <-results
		if result.published && result.err != nil {
			t.Fatalf("first publish failed: %v", result.err)
		}
		if !result.published && result.err != nil {
			var f fault
			if !errors.As(result.err, &f) || f.status != 409 {
				t.Fatalf("unexpected competing edit error: %v", result.err)
			}
		}
	}
	var raw []byte
	if err = db.QueryRowContext(ctx, `SELECT payload FROM keagent_resource WHERE id=$1`, resourceID).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var resource object
	if err = json.Unmarshal(raw, &resource); err != nil {
		t.Fatal(err)
	}
	if resource["name"] != "Published A" || resource["version"] != "1" || resource["published"] != true || resource["publishedOnce"] != true {
		t.Fatalf("competing first write replaced published content: %s", raw)
	}
}
