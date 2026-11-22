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
		Body:       io.NopCloser(strings.NewReader(`{"code":"InvalidApiKey","message":"invalid API key: private-value"}`)),
	}
	err := providerResponseFailure(response)
	status, category, message := aiProbeFailure("tts", err)
	if status != "failed" || category != "authentication" || !strings.Contains(message, "百炼 API Key 和业务空间 ID") ||
		!strings.Contains(message, "HTTP 401，百炼错误码 InvalidApiKey") ||
		strings.Contains(message, "private-value") {
		t.Fatalf("unexpected probe result: %s / %s / %s", status, category, message)
	}
	var apiError fault
	if !errors.As(err, &apiError) || apiError.status != http.StatusBadGateway {
		t.Fatalf("unexpected client API error: %v", err)
	}

	response.StatusCode = http.StatusForbidden
	response.Body = io.NopCloser(strings.NewReader(`{"code":"AccessDenied","request_id":"private-value","message":"private-value"}`))
	status, category, message = aiProbeFailure("tts", providerResponseFailure(response))
	if status != "failed" || category != "permission" || !strings.Contains(message, "HTTP 403，百炼错误码 AccessDenied") || strings.Contains(message, "private-value") {
		t.Fatalf("unexpected probe result: %s / %s / %s", status, category, message)
	}
}

func TestAICloneProbeHTTPFailureIncludesProviderDetails(t *testing.T) {
	response := &http.Response{
		StatusCode: http.StatusBadRequest,
		Header:     http.Header{},
		Body:       io.NopCloser(strings.NewReader(`{"code":"InvalidParameter","request_id":"a2c3d567-6b11-471a-b4f8-ab12cd345678","message":"private response details"}`)),
	}
	status, category, message := aiProbeFailure("voice-clone", providerResponseFailure(response))
	if status != "failed" || category != "validation" ||
		!strings.Contains(message, "HTTP 400，百炼错误码 InvalidParameter，百炼请求 ID a2c3d567-6b11-471a-b4f8-ab12cd345678") ||
		strings.Contains(message, "private response details") {
		t.Fatalf("unexpected probe result: %s / %s / %s", status, category, message)
	}
}

func TestAICloneTrainingVerifiesSynthesisAndDeletesTemporaryVoice(t *testing.T) {
	db := productionTestDB(t)
	ctx := t.Context()
	t.Setenv("AI_CONFIG_ENCRYPTION_KEY", base64.StdEncoding.EncodeToString(make([]byte, 32)))
	t.Setenv("DASHSCOPE_API_KEY", "test-key")
	t.Setenv("DASHSCOPE_WORKSPACE_ID", "ws-test")
	t.Setenv("DASHSCOPE_VOICE_CLONE_ENABLED", "true")
	data := make([]byte, 128)
	copy(data, "ID3")
	audio := base64.StdEncoding.EncodeToString(data)
	requestID := id()
	var calls []string
	prefix := "p" + digestBytes([]byte(requestID))[:9]
	speaker := qwenAudioModel + "-" + prefix + "-synthetic"
	s := &server{db: db, speech: func(_ context.Context, operation string, payload object, model string) ([]byte, error) {
		calls = append(calls, operation)
		switch operation {
		case "create_voice":
			hints, ok := payload["language_hints"].([]string)
			if payload["target_model"] != qwenAudioModel || payload["prefix"] != prefix ||
				payload["audio"] != "data:audio/mpeg;base64,"+audio || !ok || len(hints) != 1 || hints[0] != "zh" {
				t.Fatalf("unexpected enrollment payload: %#v", payload)
			}
			return qwenVoiceCreated(prefix), nil
		case "query_voice":
			if payload["voice_id"] != speaker {
				t.Fatal("query targeted a different voice")
			}
			return qwenVoiceStatus("OK"), nil
		case qwenSynthesis:
			if payload["voice"] != speaker || model != qwenAudioModel {
				t.Fatal("synthesis targeted a different voice")
			}
			return []byte(qwenSpeechFixture), nil
		case "delete_voice":
			if payload["voice_id"] != speaker {
				t.Fatal("cleanup targeted a different voice")
			}
			return []byte(`{"output":{}}`), nil
		default:
			t.Fatalf("unexpected operation %q", operation)
			return nil, nil
		}
	}}
	post := func(authorized bool) (any, error) {
		body, _ := json.Marshal(object{"service": "voice-clone", "version": 0, "mode": "training", "requestId": requestID, "confirmed": true,
			"sample": object{"audio": audio, "format": "mp3", "authorized": authorized}})
		r := httptest.NewRequest("POST", "/v1/admin/ai-config/test", nil).WithContext(ctx)
		return s.manageAI(r, actor{UserID: "admin"}, "ai-config/test", body)
	}
	if _, err := post(false); err == nil || err.Error() != "请确认已获得这份测试录音的使用授权" {
		t.Fatalf("expected test authorization check, got %v", err)
	}
	if _, err := post(true); err != nil {
		t.Fatalf("admin MP3 sample could not be queued: %v", err)
	}
	p, err := s.claimAIProbe(ctx)
	if err != nil {
		t.Fatal(err)
	}
	s.executeAIProbe(ctx, p)
	result, err := s.aiProbeByID(ctx, requestID)
	if err != nil || result["status"] != "passed" {
		t.Fatalf("voice training did not pass: %v %v", result, err)
	}
	if got := strings.Join(calls, ","); got != "create_voice,query_voice,"+qwenSynthesis+",delete_voice" {
		t.Fatalf("unexpected probe sequence %s", got)
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

func TestAISpeechActivationWithVoiceCloneRequiresOnlyTraining(t *testing.T) {
	db := productionTestDB(t)
	ctx := t.Context()
	t.Setenv("AI_CONFIG_ENCRYPTION_KEY", base64.StdEncoding.EncodeToString(make([]byte, 32)))
	t.Setenv("DASHSCOPE_API_KEY", "shared-speech-key")
	t.Setenv("DASHSCOPE_WORKSPACE_ID", "llm-test")
	t.Setenv("DASHSCOPE_VOICE_CLONE_ENABLED", "false")
	s := &server{db: db, speech: func(_ context.Context, operation string, _ object, _ string) ([]byte, error) {
		t.Fatalf("activation made an unexpected speech call: %s", operation)
		return nil, nil
	}}
	post := func(action string, body object) error {
		raw, _ := json.Marshal(body)
		r := httptest.NewRequest("POST", "/v1/admin/ai-config/"+action, nil).WithContext(ctx)
		_, err := s.admin(r, actor{UserID: "ai-config-admin"}, raw)
		return err
	}
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.ExecContext(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	check := func() aiActivation {
		t.Helper()
		head, err := readAIHead(ctx, db, speechAIGroup, false)
		if err != nil {
			t.Fatal(err)
		}
		activation, err := s.checkAIActivation(ctx, db, speechAIGroup, head)
		if err != nil {
			t.Fatal(err)
		}
		return activation
	}
	seed := func(probeID, service, mode, status string, version int64) {
		t.Helper()
		exec(`INSERT INTO keagent_ai_probe(id,service_group,service,version,mode,status,actor_id,request_hash,finished_at,result)
			VALUES($1,$2,$3,$4,$5,$6,'ai-config-admin',$1,now(),jsonb_build_object('speechConfigFingerprint',$7::text))`,
			probeID, speechAIGroup, service, version, mode, status, speechConfigFingerprint(environmentAI(speechAIGroup)))
	}

	// A test from the retired provider must not carry over even if the version matches.
	exec(`INSERT INTO keagent_ai_probe(id,service_group,service,version,mode,status,actor_id,request_hash,finished_at)
		VALUES('retired-tts-sample','speech','tts',0,'sample','passed','ai-config-admin','retired-tts-sample',now())`)
	if got, err := s.latestAIProbe(ctx, "tts", 0); err != nil || got != nil {
		t.Fatalf("retired probe should not be displayed for current service: %+v / %v", got, err)
	}
	seed("active-tts-sample", "tts", "sample", "passed", 0)
	if err := post("save", object{"service": "voice-clone", "revision": 0, "fields": object{"DASHSCOPE_VOICE_CLONE_ENABLED": true}}); err != nil {
		t.Fatal(err)
	}
	seed("candidate-clone-sample", "voice-clone", "sample", "passed", 1)
	if got := check(); got.ready || !got.ttsTestPassed || got.reusedTTSTestAt == nil {
		t.Fatalf("expected only TTS to be reusable before clone testing: %+v", got)
	}
	activation := object{"service": "voice-clone", "revision": 1, "version": 1}
	var f fault
	if err := post("activate", activation); !errors.As(err, &f) || f.status != 409 {
		t.Fatalf("activation without clone training: %v", err)
	}

	seed("candidate-clone-training", "voice-clone", "training", "passed", 1)
	seed("candidate-tts-connection", "tts", "connection", "passed", 1)
	if got := check(); !got.ready || !got.ttsTestPassed || got.reusedTTSTestAt == nil {
		t.Fatalf("expected to activate with the clone test and existing TTS sample: %+v", got)
	}

	t.Setenv("DASHSCOPE_API_KEY", "different-key")
	if got := check(); !got.ready || got.ttsTestPassed || got.reusedTTSTestAt != nil {
		t.Fatalf("expected activation without reusing TTS with different credentials: %+v", got)
	}
	t.Setenv("DASHSCOPE_API_KEY", "shared-speech-key")
	t.Setenv("DASHSCOPE_WORKSPACE_ID", "llm-different")
	if got := check(); !got.ready || got.ttsTestPassed || got.reusedTTSTestAt != nil {
		t.Fatalf("expected activation without reusing TTS with a different workspace: %+v", got)
	}
	t.Setenv("DASHSCOPE_WORKSPACE_ID", "llm-test")
	exec(`UPDATE keagent_ai_probe SET finished_at=now()-interval '25 hours' WHERE id='active-tts-sample'`)
	if got := check(); !got.ready || got.ttsTestPassed || got.reusedTTSTestAt != nil {
		t.Fatalf("expected activation without reusing an expired TTS sample: %+v", got)
	}
	exec(`UPDATE keagent_ai_probe SET finished_at=now(),result=jsonb_build_object('speechConfigFingerprint',$1::text) WHERE id='active-tts-sample'`, speechConfigFingerprint(aiValues{"DASHSCOPE_API_KEY": "shared-speech-key", "DASHSCOPE_WORKSPACE_ID": "llm-previous"}))
	if got := check(); !got.ready || got.ttsTestPassed || got.reusedTTSTestAt != nil {
		t.Fatalf("expected activation without reusing a TTS sample from a previous workspace: %+v", got)
	}
	exec(`UPDATE keagent_ai_probe SET result=jsonb_build_object('speechConfigFingerprint',$1::text) WHERE id='active-tts-sample'`, speechConfigFingerprint(environmentAI(speechAIGroup)))
	seed("candidate-tts-failure", "tts", "sample", "failed", 1)
	if got := check(); !got.ready || got.ttsTestPassed || got.reusedTTSTestAt != nil {
		t.Fatalf("failed TTS sample should not block verified clone training: %+v", got)
	}
	exec(`UPDATE keagent_ai_probe SET finished_at=now()-interval '25 hours' WHERE id='candidate-clone-training'`)
	if err := post("activate", activation); !errors.As(err, &f) || f.status != 409 {
		t.Fatalf("activation with expired clone training: %v", err)
	}
	exec(`UPDATE keagent_ai_probe SET finished_at=now() WHERE id='candidate-clone-training'`)
	if err := post("activate", activation); err != nil {
		t.Fatalf("activation with passing training alone failed: %v", err)
	}
}

func TestAIManagedConfigurationLifecycle(t *testing.T) {
	db := productionTestDB(t)
	ctx := t.Context()
	t.Setenv("AI_CONFIG_ENCRYPTION_KEY", base64.StdEncoding.EncodeToString(make([]byte, 32)))
	t.Setenv("DASHSCOPE_API_KEY", "existing-environment-key")
	t.Setenv("DASHSCOPE_WORKSPACE_ID", "llm-test")
	t.Setenv("DASHSCOPE_VOICE_CLONE_ENABLED", "false")
	legacy, err := sealAI(aiVersionLabel("speech", 1), aiValues{"legacy-token": "retired-key"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.ExecContext(ctx, `INSERT INTO keagent_ai_version(service_group,version,encrypted,actor_id)
		VALUES('speech',1,$1,'admin')`, legacy); err != nil {
		t.Fatal(err)
	}
	if _, err = db.ExecContext(ctx, `INSERT INTO keagent_ai_head(service_group,revision,active)
		VALUES('speech',1,1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, publicVoiceSchema); err != nil {
		t.Fatal(err)
	}
	if err := seedDefaultPublicVoice(ctx, db); err != nil {
		t.Fatal(err)
	}
	voiceID := defaultPublicVoiceID
	s := &server{db: db}
	admin := actor{UserID: "ai-config-admin"}
	calls := 0
	expectedKey := "existing-environment-key"
	s.speech = func(ctx context.Context, operation string, payload object, resource string) ([]byte, error) {
		calls++
		if operation != qwenSynthesis || aiValue(ctx, "DASHSCOPE_API_KEY") != expectedKey || resource != qwenAudioModel {
			t.Fatal("test did not use the selected configuration and public voice")
		}
		return []byte(qwenSpeechFixture), nil
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
		result, err := adminCall("/save", object{"service": "tts", "revision": revision, "fields": object{"DASHSCOPE_API_KEY": key}})
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
	var fingerprint string
	err = db.QueryRowContext(ctx, `SELECT result->>'speechConfigFingerprint' FROM keagent_ai_probe WHERE id=$1`, environmentProbe.ID).Scan(&fingerprint)
	if err != nil || fingerprint == "" || fingerprint != speechConfigFingerprint(environmentAI(speechAIGroup)) {
		t.Fatalf("TTS sample did not record the tested credential fingerprint: %v", err)
	}
	environmentResult, err := s.latestAIProbe(ctx, "tts", 0)
	if err != nil || environmentResult["status"] != "passed" || calls != 1 {
		t.Fatalf("expected one passed environment test, got %#v / %v / %d", environmentResult, err, calls)
	}
	expectedKey = "candidate-key"
	calls = 0
	_, err = adminCall("/save", object{"service": "tts", "revision": 0, "fields": object{"DASHSCOPE_API_KEY": "candidate-key"}})
	if err != nil {
		t.Fatal(err)
	}
	_, err = adminCall("/save", object{"service": "tts", "revision": 0, "fields": object{"DASHSCOPE_API_KEY": "stale"}})
	assertStatus(err, 409)
	active, err := s.activeAI(ctx)
	if err != nil || aiValue(active, "DASHSCOPE_API_KEY") != "existing-environment-key" {
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
	if err != nil || aiValue(active, "DASHSCOPE_API_KEY") != "candidate-key" {
		t.Fatal("activation did not take effect", err)
	}
	pinned, err := s.pinnedAI(active, speechAIGroup, 0)
	if err != nil || aiValue(pinned, "DASHSCOPE_API_KEY") != "existing-environment-key" {
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
	if _, err = adminCall("/save", object{"service": "tts", "revision": 2, "fields": object{"DASHSCOPE_API_KEY": "replacement"}}); err != nil {
		t.Fatal(err)
	}
	_, err = adminCall("/activate", object{"service": "tts", "revision": 3, "version": 3})
	assertStatus(err, 409)
	t.Setenv("AI_CONFIG_ENCRYPTION_KEY", base64.StdEncoding.EncodeToString(append([]byte{1}, make([]byte, 31)...)))
	active, err = s.activeAI(ctx)
	if err != nil || !aiSnapshotFrom(active).locked[speechAIGroup] || aiValue(active, "DASHSCOPE_API_KEY") != "" {
		t.Fatal("bad master key silently fell back to the environment", err)
	}
}
