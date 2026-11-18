package main

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

const qwenSpeechFixture = "data: {\"output\":{\"audio\":{\"data\":\"AQIDBA==\"}}}\n\ndata: {\"output\":{\"finish_reason\":\"stop\"}}\n\n"

func qwenVoiceCreated(prefix any) []byte {
	return []byte(`{"output":{"voice_id":"` + qwenAudioModel + "-" + str(prefix) + `-synthetic"}}`)
}

func qwenVoiceStatus(status string) []byte {
	return []byte(`{"output":{"status":"` + status + `","target_model":"` + qwenAudioModel + `"}}`)
}

func uploadFixture() object {
	data := make([]byte, 128)
	copy(data, "RIFF")
	copy(data[8:], "WAVE")
	return object{"name": "我的声音", "language": "zh-CN", "authorized": true, "provider": "bailian", "format": "wav", "audio": base64.StdEncoding.EncodeToString(data), "requestKey": id()}
}
func TestVoiceUploadValidation(t *testing.T) {
	if _, err := validateVoiceUpload(uploadFixture()); err != nil {
		t.Fatal(err)
	}
	for key, value := range (object{"authorized": false, "provider": "", "language": "bad", "name": "", "requestKey": "short", "format": "mp3", "audio": "%%%"}) {
		input := uploadFixture()
		input[key] = value
		if _, err := validateVoiceUpload(input); err == nil {
			t.Fatal("invalid upload accepted", key)
		}
	}
	input := uploadFixture()
	input["audio"] = strings.Repeat("a", base64.StdEncoding.EncodedLen(maxVoiceAudio)+1)
	if _, err := validateVoiceUpload(input); err == nil {
		t.Fatal("oversized audio accepted")
	}
	s := &server{}
	body, _ := json.Marshal(uploadFixture())
	t.Setenv("DASHSCOPE_VOICE_CLONE_ENABLED", "false")
	if _, err := s.voices(t.Context(), actor{UserID: "a"}, "create", body); err == nil {
		t.Fatal("unconfigured training accepted")
	}
	if _, err := s.synthesizeVoice(t.Context(), actor{UserID: "a"}, object{"kind": "personal", "voice": "old-ready-voice", "text": "文案", "rate": float64(1)}); err == nil {
		t.Fatal("disabled personal voice service synthesized")
	}
}
func TestVoiceProviderStates(t *testing.T) {
	for status, want := range map[string]string{"DEPLOYING": "processing", "OK": "ready", "UNDEPLOYED": "failed"} {
		v := storedVoice{}
		if err := voiceResult(&v, status); err != nil || v.Status != want {
			t.Fatalf("status %s: %#v %v", status, v, err)
		}
	}
	for _, raw := range []string{`{}`, `{"code":"InvalidParameter"}`, `{"output":`} {
		if _, err := parseQwenVoiceResponse([]byte(raw)); err == nil {
			t.Fatal("malformed provider response accepted")
		}
	}
	if voiceResult(&storedVoice{}, "invalid") == nil {
		t.Fatal("unknown status accepted")
	}
}
func voiceTestServer(t *testing.T) *server {
	t.Helper()
	connection := os.Getenv("ADMIN_TEST_DATABASE_URL")
	if connection == "" {
		t.Skip("set ADMIN_TEST_DATABASE_URL for isolated voice persistence tests")
	}
	base, err := sql.Open("pgx", connection)
	if err != nil {
		t.Fatal(err)
	}
	schemaName := "keagent_voice_test_" + id()
	if _, err = base.Exec(`CREATE SCHEMA ` + schemaName); err != nil {
		t.Fatal(err)
	}
	config, err := pgx.ParseConfig(connection)
	if err != nil {
		t.Fatal(err)
	}
	config.RuntimeParams["search_path"] = schemaName
	db := stdlib.OpenDB(*config)
	t.Cleanup(func() {
		db.Close()
		if _, err := base.Exec(`DROP SCHEMA ` + schemaName + ` CASCADE`); err != nil {
			t.Error(err)
		}
		base.Close()
	})
	if _, err = db.Exec(schema + voiceSchema + publicVoiceSchema); err != nil {
		t.Fatal(err)
	}
	configureBailianTest(t)
	return &server{db: db}
}

func configureBailianTest(t *testing.T) {
	t.Helper()
	t.Setenv("DASHSCOPE_VOICE_CLONE_ENABLED", "true")
	t.Setenv("DASHSCOPE_API_KEY", "server-only-test-key")
	t.Setenv("DASHSCOPE_WORKSPACE_ID", "llm-voicetest")
}

func TestVoiceIsolationIdempotencyAndSynthesis(t *testing.T) {
	s := voiceTestServer(t)
	grantForTest(t, s, "a", creditKindPurchased, 500, 0)
	var training atomic.Int32
	s.speech = func(ctx context.Context, operation string, payload object, resource string) ([]byte, error) {
		switch operation {
		case "create_voice":
			training.Add(1)
			hints, ok := payload["language_hints"].([]string)
			if len(str(payload["prefix"])) != 10 || payload["target_model"] != qwenAudioModel || !strings.HasPrefix(str(payload["audio"]), "data:audio/wav;base64,") || !ok || len(hints) != 1 || hints[0] != "zh" {
				t.Errorf("invalid enrollment parameters: %v", payload)
			}
			return qwenVoiceCreated(payload["prefix"]), nil
		case "query_voice":
			return qwenVoiceStatus("OK"), nil
		case qwenSynthesis:
			if resource != qwenAudioModel || !strings.HasPrefix(str(payload["voice"]), qwenAudioModel+"-") || payload["rate"] != float64(1) || payload["format"] != "pcm" || payload["sample_rate"] != 24000 {
				t.Errorf("wrong cloned voice synthesis parameters: %v", payload)
			}
			return []byte(qwenSpeechFixture), nil
		case "delete_voice":
			return nil, providerHTTPError{fault: fault{502, "音色已删除"}, httpStatus: 400, name: "BadRequest.VoiceNotFound"}
		}
		return nil, errors.New("unexpected operation")
	}
	input := uploadFixture()
	body, _ := json.Marshal(input)
	a := actor{UserID: "a"}
	b := actor{UserID: "b"}
	value, err := s.voices(t.Context(), a, "create", body)
	if err != nil {
		t.Fatal(err)
	}
	created := value.(userVoice)
	if created.Status != "processing" {
		t.Fatal(created)
	}
	replay, err := s.voices(t.Context(), a, "create", body)
	if err != nil || replay.(userVoice).ID != created.ID || training.Load() != 1 {
		t.Fatal("training replayed", err)
	}
	input["name"] = "different"
	changed, _ := json.Marshal(input)
	if _, err = s.voices(t.Context(), a, "create", changed); err == nil {
		t.Fatal("idempotency key content mismatch accepted")
	}
	identity, _ := json.Marshal(object{"id": created.ID})
	for _, operation := range []string{"refresh", "preview", "remove"} {
		if _, err = s.voices(t.Context(), b, operation, identity); err == nil {
			t.Fatal("cross-user voice access", operation)
		}
	}
	speech := object{"text": "新的房源文案", "voice": created.ID, "kind": "personal", "rate": float64(1)}
	if _, err = s.synthesizeVoice(t.Context(), a, speech); err == nil {
		t.Fatal("processing voice synthesized")
	}
	stale, _ := s.ownedVoice(t.Context(), a.UserID, created.ID)
	if _, err = s.voices(t.Context(), a, "refresh", identity); err != nil {
		t.Fatal(err)
	}
	if _, err = s.synthesizeVoice(t.Context(), a, speech); err != nil {
		t.Fatal(err)
	}
	if preview, err := s.voices(t.Context(), a, "preview", identity); err != nil || obj(preview)["mime"] != "audio/wav" {
		t.Fatalf("personal preview was not WAV: %v %v", preview, err)
	}
	if _, err = s.synthesizeVoice(t.Context(), b, speech); err == nil {
		t.Fatal("cross-user synthesis accepted")
	}
	catalog, err := s.voices(t.Context(), a, "list", []byte(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	public, _ := json.Marshal(catalog)
	if strings.Contains(string(public), "speaker") || strings.Contains(string(public), "server-only-test-key") || strings.Contains(string(public), "previewURL") {
		t.Fatal("private provider fields leaked")
	}
	var stored string
	if err = s.db.QueryRow(`SELECT payload::text FROM keagent_voice WHERE id=$1`, created.ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(stored, str(input["audio"])) || strings.Contains(stored, `"audio"`) {
		t.Fatal("training audio persisted")
	}
	stale.Status = "processing"
	if err = s.saveVoiceStatus(t.Context(), a.UserID, stale); err != nil {
		t.Fatal(err)
	}
	latest, _ := s.ownedVoice(t.Context(), a.UserID, created.ID)
	if latest.Status != "ready" {
		t.Fatal("late query downgraded ready voice")
	}
	if _, err = s.voices(t.Context(), a, "remove", identity); err != nil {
		t.Fatal(err)
	}
	if _, err = s.synthesizeVoice(t.Context(), a, speech); err == nil {
		t.Fatal("archived voice synthesized")
	}

	if _, err = s.synthesizeVoice(t.Context(), a, object{"text": "文案", "voice": latest.Speaker, "rate": float64(1)}); err == nil {
		t.Fatal("private provider speaker bypassed ownership via builtin route")
	}
}
func TestVoiceUnknownSubmissionIsNotRepeated(t *testing.T) {
	s := voiceTestServer(t)
	grantForTest(t, s, "a", creditKindPurchased, 500, 0)
	var calls int
	var prefix string
	s.speech = func(_ context.Context, operation string, payload object, _ string) ([]byte, error) {
		switch operation {
		case "create_voice":
			calls++
			prefix = str(payload["prefix"])
			return nil, context.DeadlineExceeded
		case "list_voice":
			if payload["prefix"] != prefix {
				t.Fatal("recovery queried a different enrollment")
			}
			return []byte(`{"output":{"voice_list":[{"voice_id":"` + qwenAudioModel + "-" + prefix + `-recovered"}]}}`), nil
		case "query_voice":
			if payload["voice_id"] != qwenAudioModel+"-"+prefix+"-recovered" {
				t.Fatal("recovery queried a different speaker")
			}
			return qwenVoiceStatus("OK"), nil
		}
		return nil, errors.New("unexpected operation")
	}
	body, _ := json.Marshal(uploadFixture())
	owner := actor{UserID: "a"}
	var voiceID string
	for range 2 {
		value, err := s.voices(t.Context(), owner, "create", body)
		if err != nil || value.(userVoice).Status != "unknown" {
			t.Fatal(value, err)
		}
		voiceID = value.(userVoice).ID
	}
	identity, _ := json.Marshal(object{"id": voiceID})
	value, err := s.voices(t.Context(), owner, "refresh", identity)
	if err != nil || value.(userVoice).Status != "ready" {
		t.Fatalf("unknown submission could not be recovered: %v %v", value, err)
	}
	if calls != 1 {
		t.Fatal("unknown submission replayed")
	}
}

func TestRetiredPersonalVoiceRequiresReEnrollment(t *testing.T) {
	s := voiceTestServer(t)
	a := actor{UserID: "a"}
	_, err := s.db.Exec(`INSERT INTO keagent_voice(id,owner_id,request_key,fingerprint,payload)
		VALUES('retired',$1,'old-request','old-fingerprint','{"id":"retired","status":"ready","resource":"seed-icl-2.0","speaker":"retired-speaker"}')`, a.UserID)
	if err != nil {
		t.Fatal(err)
	}
	s.speech = func(context.Context, string, object, string) ([]byte, error) {
		t.Fatal("retired voice routed to a provider")
		return nil, nil
	}
	list, err := s.voices(t.Context(), a, "list", []byte(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	if got := obj(list)["voices"].([]userVoice); len(got) != 1 || got[0].Status != "failed" || got[0].Error != retiredVoiceMessage {
		t.Fatalf("retired voice advertised as usable: %+v", got)
	}
	if _, err = s.synthesizeVoice(t.Context(), a, object{"kind": "personal", "voice": "retired", "text": "文案", "rate": float64(1)}); err == nil || err.Error() != retiredVoiceMessage {
		t.Fatalf("retired voice synthesis: %v", err)
	}
	if _, err = s.voices(t.Context(), a, "remove", []byte(`{"id":"retired"}`)); err != nil {
		t.Fatal(err)
	}
}

func TestVoiceConcurrentSubmitAndDisconnectedCheckpoint(t *testing.T) {
	s := voiceTestServer(t)
	grantForTest(t, s, "a", creditKindPurchased, 500, 0)
	entered, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	s.speech = func(_ context.Context, _ string, payload object, _ string) ([]byte, error) {
		calls.Add(1)
		close(entered)
		<-release
		return qwenVoiceCreated(payload["prefix"]), nil
	}
	body, _ := json.Marshal(uploadFixture())
	type outcome struct {
		value any
		err   error
	}
	first := make(chan outcome, 1)
	go func() { v, err := s.voices(t.Context(), actor{UserID: "a"}, "create", body); first <- outcome{v, err} }()
	<-entered
	duplicate, err := s.voices(t.Context(), actor{UserID: "a"}, "create", body)
	close(release)
	original := <-first
	if err != nil || original.err != nil || duplicate.(userVoice).ID != original.value.(userVoice).ID || calls.Load() != 1 {
		t.Fatal("concurrent request duplicated training", err, original.err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	s.speech = func(_ context.Context, _ string, payload object, _ string) ([]byte, error) {
		cancel()
		return qwenVoiceCreated(payload["prefix"]), nil
	}
	body, _ = json.Marshal(uploadFixture())
	v, err := s.voices(ctx, actor{UserID: "a"}, "create", body)
	if err != nil {
		t.Fatal("disconnected submission lost checkpoint", err)
	}
	saved, err := s.ownedVoice(t.Context(), "a", v.(userVoice).ID)
	if err != nil || saved.Status != "processing" || saved.Speaker == "" {
		t.Fatal("checkpoint not persisted", err)
	}
}
