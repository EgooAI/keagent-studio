package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAIVerificationRetriesAndConcurrentConfigurationChanges(t *testing.T) {
	db := productionTestDB(t)
	ctx := t.Context()
	t.Setenv("AI_CONFIG_ENCRYPTION_KEY", base64.StdEncoding.EncodeToString(make([]byte, 32)))
	t.Setenv("DASHSCOPE_API_KEY", "current-test-credential")
	t.Setenv("DASHSCOPE_WORKSPACE_ID", "llm-fixture")
	t.Setenv("DASHSCOPE_VOICE_CLONE_ENABLED", "false")
	if _, err := db.ExecContext(ctx, publicVoiceSchema); err != nil {
		t.Fatal(err)
	}
	if err := seedDefaultPublicVoice(ctx, db); err != nil {
		t.Fatal(err)
	}
	s := &server{db: db}
	post := func(path string, body object) (object, error) {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		req := httptest.NewRequest(http.MethodPost, "/v1/admin/ai-config/"+path, nil).WithContext(ctx)
		result, err := s.admin(req, actor{UserID: "verification-admin", Role: "admin"}, raw)
		return obj(result), err
	}
	verify := func(requestID, key string, revision int64) (object, error) {
		return post("verify-enable", object{
			"requestId": requestID, "service": "tts", "revision": revision, "confirmed": true,
			"fields": object{"DASHSCOPE_API_KEY": key}, "sample": object{"voiceId": defaultPublicVoiceID},
		})
	}
	assertConflict := func(err error) {
		t.Helper()
		var response fault
		if !errors.As(err, &response) || response.status != http.StatusConflict {
			t.Fatalf("expected a conflict, got %v", err)
		}
	}

	const requestID = "concurrent-verification-retry"
	const stagedKey = "staged-test-credential"
	type response struct {
		result object
		err    error
	}
	ready := make(chan struct{})
	results := make(chan response, 2)
	for range 2 {
		go func() {
			<-ready
			result, err := verify(requestID, stagedKey, 0)
			results <- response{result, err}
		}()
	}
	close(ready)
	for range 2 {
		r := <-results
		if r.err != nil || r.result["id"] != requestID || r.result["version"] != int64(1) {
			t.Fatalf("expected the same queued verification for both submissions, got %v / %v", r.result, r.err)
		}
	}
	var requests int
	if err := db.QueryRowContext(ctx, "SELECT count(*) FROM keagent_ai_probe").Scan(&requests); err != nil || requests != 1 {
		t.Fatalf("expected one probe, got %d / %v", requests, err)
	}
	_, err := verify(requestID, "different-test-credential", 0)
	assertConflict(err)
	_, err = verify("another-concurrent-verification", "different-test-credential", 1)
	assertConflict(err)

	// An older client can still save while a provider request is in flight.
	// The worker must never overwrite the newer configuration.
	calls := 0
	s.speech = func(providerCtx context.Context, operation string, _ object, _ string) ([]byte, error) {
		calls++
		if operation != qwenSynthesis || aiValue(providerCtx, "DASHSCOPE_API_KEY") != stagedKey {
			t.Fatal("the provider call did not use the staged credential")
		}
		if _, err := post("save", object{"service": "tts", "revision": 1, "fields": object{"DASHSCOPE_API_KEY": "newer-test-credential"}}); err != nil {
			t.Fatal(err)
		}
		return []byte(qwenSpeechFixture), nil
	}
	probe, err := s.claimAIProbe(ctx)
	if err != nil {
		t.Fatal(err)
	}
	s.executeAIProbe(ctx, probe)
	result, err := s.aiProbeByID(ctx, requestID)
	if err != nil || result["status"] != "failed" || result["message"] != "验证期间配置已变化，请刷新后重试" || calls != 1 {
		t.Fatalf("expected only one verification which reports the concurrent update, got %v / %v", result, err)
	}
	head, err := readAIHead(ctx, db, speechAIGroup, false)
	if err != nil || head.Active != 0 || head.Candidate != 2 || head.Revision != 2 {
		t.Fatalf("expected the active and newer settings to remain in place, got %v / %v", head, err)
	}
	if _, err := readAIValues(ctx, db, speechAIGroup, probe.Version); err == nil {
		t.Fatal("the superseded staged credential was retained")
	}
	retry, err := verify(requestID, stagedKey, 0)
	if err != nil || retry["status"] != "failed" {
		t.Fatalf("a retry should return the original terminal result, got %v / %v", retry, err)
	}
}
