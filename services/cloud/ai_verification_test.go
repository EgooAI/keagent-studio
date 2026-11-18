package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAIVerificationSelectsAuthorizedCloneTraining(t *testing.T) {
	db := productionTestDB(t)
	ctx := t.Context()
	t.Setenv("AI_CONFIG_ENCRYPTION_KEY", base64.StdEncoding.EncodeToString(make([]byte, 32)))
	t.Setenv("DASHSCOPE_API_KEY", "current-test-credential")
	t.Setenv("DASHSCOPE_WORKSPACE_ID", "llm-test")
	t.Setenv("DASHSCOPE_VOICE_CLONE_ENABLED", "false")

	const newKey = "staged-test-credential"
	requestID := id()
	prefix := "p" + digestBytes([]byte(requestID))[:9]
	var calls []string
	s := &server{db: db, speech: func(ctx context.Context, operation string, _ object, _ string) ([]byte, error) {
		if aiValue(ctx, "DASHSCOPE_API_KEY") != newKey {
			t.Fatal("provider call used the active credential instead of the staged key")
		}
		calls = append(calls, operation)
		switch operation {
		case "create_voice":
			return qwenVoiceCreated(prefix), nil
		case "query_voice":
			return qwenVoiceStatus("OK"), nil
		case qwenSynthesis:
			return []byte(qwenSpeechFixture), nil
		case "delete_voice":
			return []byte(`{"output":{}}`), nil
		}
		t.Fatal("unexpected provider call")
		return nil, nil
	}}
	audio := make([]byte, 128)
	copy(audio, "ID3")
	post := func(authorized bool) (object, error) {
		body, _ := json.Marshal(object{
			"service": "tts", "revision": 0, "requestId": requestID, "confirmed": true,
			"fields": object{"DASHSCOPE_VOICE_CLONE_ENABLED": true, "DASHSCOPE_API_KEY": newKey},
			"sample": object{"audio": base64.StdEncoding.EncodeToString(audio), "format": "mp3", "authorized": authorized},
		})
		r := httptest.NewRequest(http.MethodPost, "/v1/admin/ai-config/verify-enable", nil).WithContext(ctx)
		value, err := s.admin(r, actor{UserID: "verify-admin"}, body)
		return obj(value), err
	}
	var response fault
	if _, err := post(false); !errors.As(err, &response) || response.status != 422 {
		t.Fatalf("expected missing sample authorization to fail before queueing, got %v", err)
	}
	result, err := post(true)
	if err != nil || result["service"] != "voice-clone" || result["mode"] != "training" {
		t.Fatalf("expected clone training when enabling clone, got %#v / %v", result, err)
	}
	probe, err := s.claimAIProbe(ctx)
	if err != nil {
		t.Fatal(err)
	}
	s.executeAIProbe(ctx, probe)
	result, err = s.aiProbeByID(ctx, requestID)
	if err != nil || result["status"] != "passed" {
		t.Fatalf("clone verification could not activate the shared configuration: %#v / %v", result, err)
	}
	active, err := s.activeAI(ctx)
	if err != nil || aiValue(active, "DASHSCOPE_API_KEY") != newKey || !cloneConfigured(active) {
		t.Fatal("verified key and enabling clone were not applied together", err)
	}
	if got := strings.Join(calls, ","); got != "create_voice,query_voice,"+qwenSynthesis+",delete_voice" {
		t.Fatalf("unexpected operation sequence %q", got)
	}
}

func TestAIVerificationReusesSavedBeikeKeyAndOnlyActivatesOnSuccess(t *testing.T) {
	db := productionTestDB(t)
	ctx := t.Context()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("AI_CONFIG_ENCRYPTION_KEY", base64.StdEncoding.EncodeToString(make([]byte, 32)))
	t.Setenv("BEIKE_MCP_API_KEY", "current-beike-test-key")
	t.Setenv("BEIKE_CLI_PATH", executable)
	s := &server{db: db}
	adminCall := func(action string, input object) object {
		t.Helper()
		body, _ := json.Marshal(input)
		path := "/v1/admin/ai-config/" + action
		request := httptest.NewRequest(http.MethodPost, path, nil).WithContext(ctx)
		result, err := s.admin(request, actor{UserID: "beike-admin"}, body)
		if err != nil {
			t.Fatal(err)
		}
		resultJSON, _ := json.Marshal(result)
		for _, value := range []string{beikeCLITestKey, "current-beike-test-key", "trial-key"} {
			if strings.Contains(string(resultJSON), value) {
				t.Fatal("admin response includes a credential")
			}
		}
		return obj(result)
	}
	assertHead := func(revision, active, candidate int64, key string) {
		t.Helper()
		head, err := readAIHead(ctx, db, "beike-cli", false)
		if err != nil || head.Revision != revision || head.Active != active || head.Candidate != candidate {
			t.Fatalf("unexpected head %+v / %v", head, err)
		}
		current, err := s.activeAI(ctx)
		if err != nil || aiValue(current, "BEIKE_MCP_API_KEY") != key {
			t.Fatal("active credential did not match the expected version", err)
		}
	}
	runProbe := func(requestID, expectedStatus string) {
		t.Helper()
		probe, err := s.claimAIProbe(ctx)
		if err != nil || probe.ID != requestID || probe.Service != "beike-cli" || probe.Mode != "sample" || probe.Progress.ActivationRevision == nil {
			t.Fatalf("unexpected queued verification %q / %v", probe.ID, err)
		}
		s.executeAIProbe(ctx, probe)
		result, err := s.aiProbeByID(ctx, requestID)
		if err != nil || result["status"] != expectedStatus {
			t.Fatalf("expected verification %q, got %#v / %v", expectedStatus, result, err)
		}
	}

	adminCall("save", object{"service": "beike-cli", "revision": 0, "fields": object{"BEIKE_MCP_API_KEY": beikeCLITestKey}})
	assertHead(1, 0, 1, "current-beike-test-key")
	failedID := id()
	adminCall("verify-enable", object{"service": "beike-cli", "revision": 1, "requestId": failedID, "confirmed": true,
		"fields": object{"BEIKE_MCP_API_KEY": "trial-key", "BEIKE_CLI_PATH": filepath.Join(t.TempDir(), "missing-beike.exe")}})
	assertHead(2, 0, 1, "current-beike-test-key")
	runProbe(failedID, "failed")
	assertHead(2, 0, 1, "current-beike-test-key")
	if _, err := readAIValues(ctx, db, "beike-cli", 2); err == nil {
		t.Fatal("failed verification retained its staged credential")
	}

	savedID := id()
	adminCall("verify-enable", object{"service": "beike-cli", "revision": 2, "requestId": savedID, "confirmed": true, "useSaved": true})
	assertHead(3, 0, 1, "current-beike-test-key")
	runProbe(savedID, "passed")
	assertHead(4, 3, 0, beikeCLITestKey)
	latest, err := s.latestAIVerification(ctx, "beike-cli")
	if err != nil || latest["id"] != savedID || latest["status"] != "passed" {
		t.Fatalf("unexpected latest verification metadata %#v / %v", latest, err)
	}
}
