package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAITTSProbeHTTPFailure(t *testing.T) {
	response := &http.Response{
		StatusCode: http.StatusUnauthorized,
		Header:     http.Header{},
		Body:       io.NopCloser(strings.NewReader(`{"header":{"code":45000010,"message":"invalid API key: private-value"}}`)),
	}
	response.Header.Set("X-Tt-Logid", "20261110102945ABCD0123ABCD0123ABCD")
	err := providerResponseFailure(response)
	status, category, message := aiProbeFailure("tts", err)
	if status != "failed" || category != "authentication" || !strings.Contains(message, "API Key 无效") ||
		!strings.Contains(message, "HTTP 401，火山错误码 45000010，火山日志 ID 20261110102945ABCD0123ABCD0123ABCD") ||
		strings.Contains(message, "private-value") {
		t.Fatalf("unexpected probe result: %s / %s / %s", status, category, message)
	}
	var apiError fault
	if !errors.As(err, &apiError) || apiError.status != http.StatusBadGateway {
		t.Fatalf("unexpected client API error: %v", err)
	}

	response.StatusCode = http.StatusForbidden
	response.Header.Set("X-Tt-Logid", "private-value")
	response.Body = io.NopCloser(strings.NewReader(`{"code":1,"message":"private-value"}`))
	status, category, message = aiProbeFailure("tts", providerResponseFailure(response))
	if status != "failed" || category != "permission" || !strings.Contains(message, "HTTP 403，火山错误码 1") || strings.Contains(message, "private-value") {
		t.Fatalf("unexpected probe result: %s / %s / %s", status, category, message)
	}
}

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
	if _, err = patchAIValues(spec, values, object{"AI_BASE_URL": "https://second.example"}); err == nil {
		t.Fatal("allowed reusing a key at a different origin")
	}
	if _, err = patchAIValues(spec, values, object{"AI_BASE_URL": "https://127.0.0.1", "AI_API_KEY": "replacement"}); err == nil {
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

func TestAIProbeEnvironmentWithoutConfigKey(t *testing.T) {
	db := productionTestDB(t)
	ctx := t.Context()
	t.Setenv("AI_CONFIG_ENCRYPTION_KEY", "")
	t.Setenv("AI_BASE_URL", "")
	s := &server{db: db}
	queue := func(input object) (any, error) {
		body, _ := json.Marshal(input)
		r := httptest.NewRequest("POST", "/v1/admin/ai-config/test", nil).WithContext(ctx)
		return s.admin(r, actor{UserID: "ai-config-admin"}, body)
	}
	assertStatus := func(err error, expected int) {
		t.Helper()
		var f fault
		if !errors.As(err, &f) || f.status != expected {
			t.Fatalf("expected HTTP %d, got %v", expected, err)
		}
	}
	input := object{"service": "script", "mode": "connection", "requestId": "connection-without-key"}
	_, err := queue(input)
	assertStatus(err, 422)
	input["version"] = 0
	if _, err = queue(input); err != nil {
		t.Fatal(err)
	}
	p, err := s.claimAIProbe(ctx)
	if err != nil || len(p.Input) != 0 || p.Version != 0 {
		t.Fatalf("unexpected environment probe: %#v / %v", p.public(), err)
	}
	input["requestId"] = "connection-without-key-retry"
	_, err = queue(input)
	assertStatus(err, 409)
	s.executeAIProbe(ctx, p)
	result, err := s.aiProbeByID(ctx, p.ID)
	if err != nil || result["status"] != "failed" || result["message"] != "请先配置服务地址" {
		t.Fatalf("expected a missing address diagnosis: %#v / %v", result, err)
	}
	if _, err = queue(input); err != nil {
		t.Fatal("completed test prevented immediate retry", err)
	}
	_, err = queue(object{"service": "tts", "version": 0, "mode": "sample", "requestId": "sample-without-key", "confirmed": true, "sample": object{"voiceId": "test-voice"}})
	assertStatus(err, 503)
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
	expectedKey := "existing-environment-key"
	s.speech = func(ctx context.Context, operation string, payload object, resource string) ([]byte, error) {
		calls++
		if operation != "unidirectional" || aiValue(ctx, "VOLC_TTS_API_KEY") != expectedKey || resource == "" {
			t.Fatal("test did not use the selected configuration and public voice")
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
	assertUnchanged := func(revision, version int64, key string) {
		t.Helper()
		result, err := adminCall("/save", object{"service": "tts", "revision": revision, "fields": object{"VOLC_TTS_API_KEY": key}})
		if err != nil || obj(result)["changed"] != false || obj(result)["version"] != version {
			t.Fatalf("save should leave the configuration unchanged, got %#v / %v", result, err)
		}
	}
	assertUnchanged(0, 0, "")
	activeSample := object{"service": "tts", "version": 0, "mode": "sample", "requestId": "tts-environment-test", "confirmed": true, "sample": object{"voiceId": voiceID}}
	if _, err := adminCall("/test", activeSample); err != nil {
		t.Fatal("sample test rejected for the current environment configuration", err)
	}
	environmentProbe, err := s.claimAIProbe(ctx)
	if err != nil || len(environmentProbe.Input) == 0 {
		t.Fatal("sample was not queued with encrypted input", err)
	}
	s.executeAIProbe(ctx, environmentProbe)
	environmentResult, err := s.latestAIProbe(ctx, "tts", 0)
	if err != nil || environmentResult["status"] != "passed" || calls != 1 {
		t.Fatalf("expected one passed environment test, got %#v / %v / %d", environmentResult, err, calls)
	}
	expectedKey = "candidate-key"
	calls = 0
	_, err = adminCall("/save", object{"service": "tts", "revision": 0, "fields": object{"VOLC_TTS_API_KEY": "candidate-key"}})
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
	assertUnchanged(1, 1, "")
	assertUnchanged(1, 1, " candidate-key ")
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
	assertUnchanged(2, 1, "")
	test["requestId"] = "tts-active-managed-test"
	if _, err = adminCall("/test", test); err != nil {
		t.Fatal("sample test rejected for the active managed version", err)
	}
	activeProbe, err := s.claimAIProbe(ctx)
	if err != nil || activeProbe.Version != 1 {
		t.Fatal("managed active test was not queued", err)
	}
	s.executeAIProbe(ctx, activeProbe)
	if _, err = adminCall("/save", object{"service": "tts", "revision": 2, "fields": object{"VOLC_TTS_API_KEY": "replacement"}}); err != nil {
		t.Fatal(err)
	}
	_, err = adminCall("/activate", object{"service": "tts", "revision": 3, "version": 3})
	assertStatus(err, 409)
	t.Setenv("AI_CONFIG_ENCRYPTION_KEY", base64.StdEncoding.EncodeToString(append([]byte{1}, make([]byte, 31)...)))
	active, err = s.activeAI(ctx)
	if err != nil || !aiSnapshotFrom(active).locked["speech"] || aiValue(active, "VOLC_TTS_API_KEY") != "" {
		t.Fatal("bad master key silently fell back to the environment", err)
	}
}
