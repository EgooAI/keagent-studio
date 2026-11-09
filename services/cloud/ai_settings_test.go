package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAIConfigProtection(t *testing.T) {
	t.Setenv("AI_CONFIG_ENCRYPTION_KEY", base64.StdEncoding.EncodeToString(make([]byte, 32)))
	values := aiValues{"AI_API_KEY": "a-secret", "AI_BASE_URL": "https://first.example"}
	sealed, err := sealAI(aiVersionLabel("script", 1), values)
	if err != nil || strings.Contains(string(sealed), "a-secret") {
		t.Fatal("credential was not encrypted", err)
	}
	var opened aiValues
	if err = openAI(aiVersionLabel("script", 1), sealed, &opened); err != nil || opened["AI_API_KEY"] != "a-secret" {
		t.Fatal("cannot decrypt", err)
	}
	if openAI(aiVersionLabel("script", 2), sealed, &opened) == nil {
		t.Fatal("ciphertext accepted for a different version")
	}
	t.Setenv("AI_ALLOWED_HOSTS", "first.example,second.example,127.0.0.1")
	spec, _ := specFor("script")
	if patchAIValues(spec, values, object{"AI_BASE_URL": "https://second.example"}) == nil {
		t.Fatal("allowed reusing a key at a different origin")
	}
	if patchAIValues(spec, values, object{"AI_BASE_URL": "https://127.0.0.1", "AI_API_KEY": "replacement"}) == nil {
		t.Fatal("allowed a loopback provider")
	}
	for _, address := range []string{"127.0.0.1", "10.0.0.2", "100.64.0.1", "169.254.169.254", "::1", "fc00::1"} {
		if publicProviderIP(net.ParseIP(address)) {
			t.Fatalf("allowed private target %s", address)
		}
	}
	if !validOpeningWAV(aiProbeSpeech) {
		t.Fatal("bundled test audio does not match the production format")
	}
}

func TestAIManagedConfigurationLifecycle(t *testing.T) {
	db := productionTestDB(t)
	ctx := t.Context()
	t.Setenv("AI_CONFIG_ENCRYPTION_KEY", base64.StdEncoding.EncodeToString(make([]byte, 32)))
	t.Setenv("VOLC_TTS_API_KEY", "existing-environment-key")
	t.Setenv("VOLC_VOICE_CLONE_ENABLED", "false")
	if _, err := db.ExecContext(ctx, publicVoiceSchema); err != nil {
		t.Fatal(err)
	}
	if err := seedDefaultPublicVoice(ctx, db); err != nil {
		t.Fatal(err)
	}
	var voiceID string
	if err := db.QueryRowContext(ctx, "SELECT id FROM keagent_public_voice LIMIT 1").Scan(&voiceID); err != nil {
		t.Fatal(err)
	}
	s := &server{db: db}
	admin := actor{UserID: "ai-config-admin"}
	calls := 0
	s.speech = func(ctx context.Context, operation string, payload object, resource string) ([]byte, error) {
		calls++
		if operation != "unidirectional" || aiValue(ctx, "VOLC_TTS_API_KEY") != "candidate-key" || resource == "" {
			t.Fatal("test did not use its candidate and public voice")
		}
		return []byte(`{"code":0,"data":"AAA="}`), nil
	}
	adminCall := func(path string, body object) (any, error) {
		method := "GET"
		if body != nil {
			method = "POST"
		}
		raw, _ := json.Marshal(body)
		return s.admin(httptest.NewRequest(method, "/v1/admin/ai-config"+path, nil).WithContext(ctx), admin, raw)
	}
	assertStatus := func(err error, expected int) {
		t.Helper()
		var fault fault
		if !errors.As(err, &fault) || fault.status != expected {
			t.Fatalf("expected HTTP %d, got %v", expected, err)
		}
	}
	_, err := adminCall("/save", object{"service": "tts", "revision": 0, "fields": object{"VOLC_TTS_API_KEY": "candidate-key"}})
	if err != nil {
		t.Fatal(err)
	}
	_, err = adminCall("/save", object{"service": "tts", "revision": 0, "fields": object{"VOLC_TTS_API_KEY": "stale"}})
	assertStatus(err, 409)
	active, err := s.activeAI(ctx)
	if err != nil || aiValue(active, "VOLC_TTS_API_KEY") != "existing-environment-key" {
		t.Fatal("draft affected production", err)
	}
	overview, err := adminCall("", nil)
	if err != nil {
		t.Fatal(err)
	}
	visible, _ := json.Marshal(overview)
	if strings.Contains(string(visible), "candidate-key") || strings.Contains(string(visible), "existing-environment-key") {
		t.Fatal("API exposed a secret")
	}
	activation := object{"service": "tts", "revision": 1, "version": 1}
	_, err = adminCall("/activate", activation)
	assertStatus(err, 409)
	test := object{"service": "tts", "version": 1, "mode": "sample", "requestId": "tts-test-request-1", "confirmed": true, "sample": object{"voiceId": voiceID}}
	for range 2 {
		run, err := adminCall("/test", test)
		if err != nil || obj(run)["id"] != test["requestId"] {
			t.Fatal("test was not idempotently queued", err)
		}
	}
	p, err := s.claimAIProbe(ctx)
	if err != nil {
		t.Fatal(err)
	}
	s.executeAIProbe(ctx, p)
	result, err := adminCall("/test?id=tts-test-request-1", nil)
	if err != nil || obj(result)["status"] != "passed" || calls != 1 {
		t.Fatalf("expected one passed test, got %#v / %v / %d", result, err, calls)
	}
	if _, err = db.ExecContext(ctx, `UPDATE keagent_ai_probe SET finished_at=now()-interval '25 hours' WHERE id=$1`, p.ID); err != nil {
		t.Fatal(err)
	}
	_, err = adminCall("/activate", activation)
	assertStatus(err, 409)
	if _, err = db.ExecContext(ctx, `UPDATE keagent_ai_probe SET finished_at=now() WHERE id=$1`, p.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = adminCall("/activate", activation); err != nil {
		t.Fatal(err)
	}
	active, err = s.activeAI(ctx)
	if err != nil || aiValue(active, "VOLC_TTS_API_KEY") != "candidate-key" {
		t.Fatal("activation did not take effect", err)
	}
	pinned, err := s.pinnedAI(active, "speech", 0)
	if err != nil || aiValue(pinned, "VOLC_TTS_API_KEY") != "existing-environment-key" {
		t.Fatal("in-flight version was not retained", err)
	}
	if _, err = adminCall("/rollback", object{"service": "tts", "revision": 2}); err != nil {
		t.Fatal(err)
	}
	restored, err := readAIValues(ctx, db, "speech", 3)
	if err != nil || restored["VOLC_TTS_API_KEY"] != "existing-environment-key" {
		t.Fatal("previous config was not restored as a candidate", err)
	}
	t.Setenv("AI_CONFIG_ENCRYPTION_KEY", base64.StdEncoding.EncodeToString(append([]byte{1}, make([]byte, 31)...)))
	active, err = s.activeAI(ctx)
	if err != nil || !aiSnapshotFrom(active).locked["speech"] || aiValue(active, "VOLC_TTS_API_KEY") != "" {
		t.Fatal("bad master key silently fell back to the environment", err)
	}
}

func TestAIAvatarOldBucketCleanup(t *testing.T) {
	db := productionTestDB(t)
	ctx := t.Context()
	t.Setenv("AI_CONFIG_ENCRYPTION_KEY", base64.StdEncoding.EncodeToString(make([]byte, 32)))
	t.Setenv("VOLC_TOS_BUCKET", "old-bucket")
	t.Setenv("VOLC_TOS_REGION", "cn-beijing")
	t.Setenv("VOLC_ACCESS_KEY_ID", "old-ak")
	if _, err := db.ExecContext(ctx, userAvatarSchema); err != nil {
		t.Fatal(err)
	}
	values := aiValues{"VOLC_TOS_BUCKET": "new-bucket", "VOLC_TOS_REGION": "cn-beijing", "VOLC_ACCESS_KEY_ID": "new-ak"}
	sealed, err := sealAI(aiVersionLabel("avatar", 1), values)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.ExecContext(ctx, `INSERT INTO keagent_ai_version(service_group,version,encrypted,actor_id) VALUES('avatar',1,$1,'admin')`, sealed); err != nil {
		t.Fatal(err)
	}
	if _, err = db.ExecContext(ctx, `INSERT INTO keagent_ai_probe(id,service_group,service,version,mode,status,actor_id,request_hash,worker) VALUES('avatar-probe','avatar','avatar',1,'sample','running','admin','hash','worker')`); err != nil {
		t.Fatal(err)
	}
	var calls []string
	s := &server{db: db, storage: func(ctx context.Context, method, path string, _ []byte, _ string) ([]byte, error) {
		key := aiValue(ctx, "VOLC_ACCESS_KEY_ID")
		calls = append(calls, method+":"+key+":"+strings.TrimPrefix(path, aiProbePath("avatar-probe")))
		if method == "DELETE" && len(calls) == 3 {
			return nil, errors.New("interrupted cleanup")
		}
		return []byte("keagent-ai-probe"), nil
	}}
	p := aiProbe{ID: "avatar-probe", Group: "avatar", Version: 1, Worker: "worker", Progress: aiProbeProgress{Assets: true}}
	if err = s.probeOldAvatarBuckets(withAIGroup(ctx, "avatar", 1, values), &p); err == nil || !strings.Contains(err.Error(), "旧存储桶的测试对象清理失败") {
		t.Fatal("expected an interrupted cleanup", err)
	}
	if _, err = db.ExecContext(ctx, `UPDATE keagent_ai_probe SET status='failed',finished_at=now()-interval '2 minutes',lease_until=NULL WHERE id=$1`, p.ID); err != nil {
		t.Fatal(err)
	}
	s.cleanAIProbeAssets(ctx)
	want := "PUT:old-ak:previous-bucket,GET:new-ak:previous-bucket,DELETE:old-ak:previous-bucket,DELETE:new-ak:photo,DELETE:new-ak:audio.wav,DELETE:old-ak:previous-bucket"
	if got := strings.Join(calls, ","); got != want {
		t.Fatalf("bucket verification and recovery used unexpected credentials: %s", got)
	}
}
