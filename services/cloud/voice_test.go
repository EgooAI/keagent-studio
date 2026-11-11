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

func uploadFixture() object {
	data := make([]byte, 128)
	copy(data, "RIFF")
	copy(data[8:], "WAVE")
	return object{"name": "我的声音", "language": "zh-CN", "authorized": true, "format": "wav", "audio": base64.StdEncoding.EncodeToString(data), "requestKey": id()}
}
func TestVoiceUploadValidation(t *testing.T) {
	if _, err := validateVoiceUpload(uploadFixture()); err != nil {
		t.Fatal(err)
	}
	for key, value := range (object{"authorized": false, "language": "bad", "name": "", "requestKey": "short", "format": "mp3", "audio": "%%%"}) {
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
	t.Setenv("VOLC_VOICE_CLONE_ENABLED", "false")
	if _, err := s.voices(t.Context(), actor{UserID: "a"}, "create", body); err == nil {
		t.Fatal("unconfigured training accepted")
	}
	if _, err := s.synthesizeVoice(t.Context(), actor{UserID: "a"}, object{"kind": "personal", "voice": "old-ready-voice", "text": "文案", "rate": float64(1)}); err == nil {
		t.Fatal("disabled personal voice service synthesized")
	}
}
func TestVoiceProviderStates(t *testing.T) {
	for status, want := range map[int]string{0: "unknown", 1: "processing", 2: "ready", 3: "failed", 4: "ready"} {
		raw, _ := json.Marshal(object{"status": status, "speaker_status": []object{{"model_type": 4, "demo_audio": "https://example.test/audio.wav"}}})
		v := storedVoice{}
		if err := voiceResult(&v, raw); err != nil || v.Status != want {
			t.Fatalf("status %d: %#v %v", status, v, err)
		}
	}
	for _, raw := range []string{`{}`, `{"status":"ready"}`, `{"status":`} {
		if voiceResult(&storedVoice{}, []byte(raw)) == nil {
			t.Fatal("malformed provider status accepted")
		}
	}
	v := storedVoice{}
	if err := voiceResult(&v, []byte(`{"code":45001127}`)); err != nil || v.Status != "failed" {
		t.Fatal("provider rejection ignored")
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
	t.Setenv("VOLC_VOICE_CLONE_ENABLED", "true")
	t.Setenv("VOLC_TTS_API_KEY", "server-only-test-key")
	return &server{db: db}
}
func TestVoiceIsolationIdempotencyAndSynthesis(t *testing.T) {
	s := voiceTestServer(t)
	grantForTest(t, s, "a", creditKindPurchased, 500, 0)
	var training atomic.Int32
	s.speech = func(ctx context.Context, operation string, payload object, resource string) ([]byte, error) {
		switch operation {
		case "voice_clone":
			training.Add(1)
			if payload["speaker_id"] != "custom_speaker_id" || !strings.HasPrefix(str(payload["custom_speaker_id"]), "keagent") {
				t.Error("client controlled provider identity")
			}
			return []byte(`{"status":1}`), nil
		case "get_voice":
			return []byte(`{"status":2}`), nil
		case "unidirectional":
			if resource != "seed-icl-2.0" || !strings.HasPrefix(str(obj(payload["req_params"])["speaker"]), "keagent") {
				t.Error("wrong cloned voice synthesis resource")
			}
			return []byte(`{"code":0,"data":"AQIDBA=="}`), nil
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
	s.speech = func(context.Context, string, object, string) ([]byte, error) {
		calls++
		return nil, context.DeadlineExceeded
	}
	body, _ := json.Marshal(uploadFixture())
	for range 2 {
		value, err := s.voices(t.Context(), actor{UserID: "a"}, "create", body)
		if err != nil || value.(userVoice).Status != "unknown" {
			t.Fatal(value, err)
		}
	}
	if calls != 1 {
		t.Fatal("unknown paid submission replayed")
	}
}

func TestVoiceConcurrentSubmitAndDisconnectedCheckpoint(t *testing.T) {
	s := voiceTestServer(t)
	grantForTest(t, s, "a", creditKindPurchased, 500, 0)
	entered, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	s.speech = func(context.Context, string, object, string) ([]byte, error) {
		calls.Add(1)
		close(entered)
		<-release
		return []byte(`{"status":2}`), nil
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
	s.speech = func(context.Context, string, object, string) ([]byte, error) {
		cancel()
		return []byte(`{"status":2}`), nil
	}
	body, _ = json.Marshal(uploadFixture())
	v, err := s.voices(ctx, actor{UserID: "a"}, "create", body)
	if err != nil {
		t.Fatal("disconnected submission lost checkpoint", err)
	}
	saved, err := s.ownedVoice(t.Context(), "a", v.(userVoice).ID)
	if err != nil || saved.Status != "ready" {
		t.Fatal("checkpoint not persisted", err)
	}
}
