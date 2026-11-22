package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
)

// chargeTestServer 在完整业务 schema（含积分表）之上补齐音色表与公共音色种子。
func chargeTestServer(t *testing.T) *server {
	t.Helper()
	db := productionTestDB(t)
	if _, err := db.Exec(voiceSchema + publicVoiceSchema); err != nil {
		t.Fatal(err)
	}
	if err := seedDefaultPublicVoice(t.Context(), db); err != nil {
		t.Fatal(err)
	}
	return &server{db: db}
}

func chargeBalance(t *testing.T, s *server, ownerID string) (available, held int64) {
	t.Helper()
	if err := s.db.QueryRowContext(t.Context(), `SELECT COALESCE(SUM(remaining),0), COALESCE(SUM(held),0) FROM keagent_credit_lot WHERE owner_id=$1`, ownerID).Scan(&available, &held); err != nil {
		t.Fatal(err)
	}
	return available, held
}

func TestChargeSyncSettlesReleasesAndReplays(t *testing.T) {
	s := chargeTestServer(t)
	grantForTest(t, s, "u1", creditKindPurchased, 100, 0)

	var calls atomic.Int32
	ok := func(context.Context) (any, error) {
		calls.Add(1)
		return "result", nil
	}
	first, err := s.chargeSync(t.Context(), "u1", "script", "", 10, "key-1", "v1", nil, ok)
	if err != nil || first != "result" {
		t.Fatalf("first charge: %v %v", first, err)
	}
	available, held := chargeBalance(t, s, "u1")
	if available != 90 || held != 0 {
		t.Fatalf("after charge: available=%d held=%d", available, held)
	}

	// 同内容重放：再次调用供应商但不重复扣费。
	replay, err := s.chargeSync(t.Context(), "u1", "script", "", 10, "key-1", "v1", nil, ok)
	if err != nil || replay != "result" || calls.Load() != 2 {
		t.Fatalf("replay: %v %v calls=%d", replay, err, calls.Load())
	}
	if available, _ = chargeBalance(t, s, "u1"); available != 90 {
		t.Fatalf("replay must not double charge: available=%d", available)
	}

	// 失败释放，重试重新扣费。
	failing := func(context.Context) (any, error) { return nil, fail(502, "供应商失败") }
	if _, err = s.chargeSync(t.Context(), "u1", "script", "", 10, "key-2", "v1", nil, failing); err == nil {
		t.Fatal("failing run accepted")
	}
	if available, held = chargeBalance(t, s, "u1"); available != 90 || held != 0 {
		t.Fatalf("failed run must release: available=%d held=%d", available, held)
	}
	var releaseRows int
	if err = s.db.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM keagent_credit_ledger WHERE owner_id='u1' AND kind='release'`).Scan(&releaseRows); err != nil || releaseRows != 1 {
		t.Fatalf("release ledger rows: %d %v", releaseRows, err)
	}
	if _, err = s.chargeSync(t.Context(), "u1", "script", "", 10, "key-2", "v1", nil, ok); err != nil {
		t.Fatalf("retry after release: %v", err)
	}
	if available, _ = chargeBalance(t, s, "u1"); available != 80 {
		t.Fatalf("retry must charge once: available=%d", available)
	}
	creditInvariant(t, s, "u1")

	// 单价为 0：完全跳过扣费。
	if _, err = s.chargeSync(t.Context(), "u1", "script", "", 0, "key-3", "v1", nil, ok); err != nil || calls.Load() != 4 {
		t.Fatalf("free op: %v calls=%d", err, calls.Load())
	}
	var holds int
	if err = s.db.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM keagent_credit_hold WHERE owner_id='u1' AND idem_key='key-3'`).Scan(&holds); err != nil || holds != 0 {
		t.Fatalf("free op must not hold: %d %v", holds, err)
	}
}

func TestPanoramaTTSCreditsPerKiloChar(t *testing.T) {
	s := chargeTestServer(t)
	grantForTest(t, s, "u1", creditKindPurchased, 25, 0)
	var synthCalls atomic.Int32
	s.speech = func(_ context.Context, operation string, _ object, _ string) ([]byte, error) {
		if operation != qwenSynthesis {
			t.Errorf("unexpected speech operation %s", operation)
		}
		synthCalls.Add(1)
		return []byte(qwenSpeechFixture), nil
	}
	call := func(text string) (object, error) {
		body, _ := json.Marshal(object{"text": text, "voice": defaultPublicVoiceID, "kind": "builtin", "rate": float64(1)})
		value, err := s.panorama(t.Context(), actor{UserID: "u1"}, "tts", body)
		if err != nil {
			return nil, err
		}
		return obj(value), nil
	}
	text := strings.Repeat("好", 1500) // ceil(1500/1000)=2 千字 → 默认 20
	result, err := call(text)
	if err == nil {
		_, err = json.Marshal(result["pcm"])
	}
	if err != nil {
		t.Fatalf("tts call: %v", err)
	}
	available, held := chargeBalance(t, s, "u1")
	if available != 5 || held != 0 {
		t.Fatalf("tts charge: available=%d held=%d", available, held)
	}

	// 同内容重放免费重调，不重复扣费。
	if _, err = call(text); err != nil || synthCalls.Load() != 2 {
		t.Fatalf("tts replay: %v calls=%d", err, synthCalls.Load())
	}
	if available, _ = chargeBalance(t, s, "u1"); available != 5 {
		t.Fatalf("tts replay double charged: available=%d", available)
	}

	// 余额不足：干净的 402，不产生冻结。
	if _, err = call(strings.Repeat("好", 1500) + "!"); err == nil {
		t.Fatal("insufficient tts accepted")
	}
	requireCoded(t, err, 402, "CREDITS_INSUFFICIENT")
	creditInvariant(t, s, "u1")
}

func TestPanoramaScriptChargesViaPricing(t *testing.T) {
	s := chargeTestServer(t)
	grantForTest(t, s, "u1", creditKindPurchased, 100, 0)
	if _, err := s.db.ExecContext(t.Context(), `INSERT INTO keagent_setting(id,payload) VALUES('credit_pricing',$1) ON CONFLICT (id) DO UPDATE SET payload=$1`, []byte(`{"version":9,"prices":{"script":7}}`)); err != nil {
		t.Fatal(err)
	}
	// 无 AI 供应商配置：生成失败 → 冻结必须被释放。
	body, _ := json.Marshal(object{
		"language": "zh-CN",
		"segments": []any{
			object{"id": "s1", "text": "一"},
			object{"id": "s2", "text": "二"},
			object{"id": "s3", "text": "三"},
		},
	})
	if _, err := s.panorama(t.Context(), actor{UserID: "u1"}, "script", body); err == nil {
		t.Fatal("script without AI provider must fail")
	}
	available, held := chargeBalance(t, s, "u1")
	if available != 100 || held != 0 {
		t.Fatalf("failed script must release: available=%d held=%d", available, held)
	}
	creditInvariant(t, s, "u1")
}

func TestRetiredOpeningQuerySettlesHistoricalHold(t *testing.T) {
	t.Setenv("AI_CONFIG_ENCRYPTION_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
	t.Setenv("MINIMAX_API_KEY", "fallback-key")
	s := &server{db: productionTestDB(t)}
	pinnedKey, err := sealAI(aiVersionLabel("opening", 2), aiValues{"MINIMAX_API_KEY": "pinned-key"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.ExecContext(t.Context(), `INSERT INTO keagent_ai_version(service_group,version,encrypted,actor_id)
		VALUES('opening',2,$1,'admin')`, pinnedKey); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		status    string
		version   int64
		apiKey    string
		available int64
	}{
		{"succeeded", 2, "pinned-key", 0},
		{"failed", 0, "fallback-key", 100},
	} {
		t.Run(tc.status, func(t *testing.T) {
			owner := actor{UserID: tc.status}
			key := digestBytes([]byte(owner.UserID))
			grantForTest(t, s, owner.UserID, creditKindPurchased, 100, 0)
			if _, err := s.holdCredits(t.Context(), owner.UserID, "opening", key, 100, key, "v1", nil); err != nil {
				t.Fatal(err)
			}
			if _, err := s.db.ExecContext(t.Context(), `INSERT INTO keagent_minimax_opening(owner_id,input_hash,config_version,task_id)
				VALUES($1,$2,$3,'123')`, owner.UserID, key, tc.version); err != nil {
				t.Fatal(err)
			}
			calls := 0
			s.sourceHTTP = func(_ context.Context, method, endpoint string, headers http.Header, _ []byte, _ int64) ([]byte, error) {
				calls++
				if method != http.MethodGet || endpoint != minimaxBase+"/v2/query/video_generation/123" || headers.Get("Authorization") != "Bearer "+tc.apiKey {
					t.Fatal("historical lookup did not use original credentials")
				}
				return json.Marshal(object{"task": object{"id": "123", "status": tc.status, "content": object{"url": "https://cdn.hailuoai.com/test.mp4"}}})
			}
			query := []byte(`{"requestKey":"` + key + `"}`)
			if _, err = s.panorama(t.Context(), actor{UserID: "other"}, "opening-query", query); err == nil || calls != 0 {
				t.Fatal("another owner could query the historical task")
			}
			if _, err = s.panorama(t.Context(), owner, "opening-submit", query); err == nil || calls != 0 {
				t.Fatal("retired submit reached the provider")
			}
			if available, held := chargeBalance(t, s, owner.UserID); available != 0 || held != 100 {
				t.Fatalf("retired submit changed the old hold: available=%d held=%d", available, held)
			}
			result, err := s.panorama(t.Context(), owner, "opening-query", query)
			if err != nil || obj(result)["status"] != tc.status || calls != 1 {
				t.Fatalf("historical query: %#v %v", result, err)
			}
			if available, held := chargeBalance(t, s, owner.UserID); available != tc.available || held != 0 {
				t.Fatalf("historical hold settlement: available=%d held=%d", available, held)
			}
			creditInvariant(t, s, owner.UserID)
		})
	}
}

func TestVoiceCloneCreditsLifecycle(t *testing.T) {
	s := chargeTestServer(t)
	configureBailianTest(t)
	grantForTest(t, s, "u1", creditKindPurchased, 200, 0)
	status := "DEPLOYING"
	s.speech = func(_ context.Context, operation string, payload object, _ string) ([]byte, error) {
		switch operation {
		case "create_voice":
			return qwenVoiceCreated(payload["prefix"]), nil
		case "query_voice":
			return qwenVoiceStatus(status), nil
		}
		return nil, errors.New("unexpected operation")
	}
	input := uploadFixture()
	body, _ := json.Marshal(input)
	created, err := s.voices(t.Context(), actor{UserID: "u1"}, "create", body)
	if err != nil {
		t.Fatal(err)
	}
	available, held := chargeBalance(t, s, "u1")
	if available != 0 || held != 200 {
		t.Fatalf("voice clone submit must hold: available=%d held=%d", available, held)
	}
	// 重放同一 requestKey：不重复冻结。
	if _, err = s.voices(t.Context(), actor{UserID: "u1"}, "create", body); err != nil {
		t.Fatalf("replay create: %v", err)
	}
	available, held = chargeBalance(t, s, "u1")
	if available != 0 || held != 200 {
		t.Fatalf("replay create must not add holds: available=%d held=%d", available, held)
	}

	// 复刻成功 → 刷新后结算。
	status = "OK"
	identity, _ := json.Marshal(object{"id": created.(userVoice).ID})
	if _, err = s.voices(t.Context(), actor{UserID: "u1"}, "refresh", identity); err != nil {
		t.Fatalf("refresh to ready: %v", err)
	}
	available, held = chargeBalance(t, s, "u1")
	if available != 0 || held != 0 {
		t.Fatalf("ready refresh must capture: available=%d held=%d", available, held)
	}
	creditInvariant(t, s, "u1")

	// 失败的复刻：刷新后退款。
	grantForTest(t, s, "u2", creditKindPurchased, 200, 0)
	failing := uploadFixture()
	failingBody, _ := json.Marshal(failing)
	if _, err = s.voices(t.Context(), actor{UserID: "u2"}, "create", failingBody); err != nil {
		t.Fatal(err)
	}
	if _, held = chargeBalance(t, s, "u2"); held != 200 {
		t.Fatal("u2 clone must hold")
	}
	status = "UNDEPLOYED"
	if _, err = s.voices(t.Context(), actor{UserID: "u2"}, "refresh", identity); err == nil {
		t.Fatal("refreshing another owner's voice must fail")
	}
	ownIdentity, _ := json.Marshal(object{"id": mustVoiceID(t, s, "u2")})
	if _, err = s.voices(t.Context(), actor{UserID: "u2"}, "refresh", ownIdentity); err != nil {
		t.Fatalf("refresh to failed: %v", err)
	}
	available, held = chargeBalance(t, s, "u2")
	if available != 200 || held != 0 {
		t.Fatalf("failed clone must release: available=%d held=%d", available, held)
	}
	creditInvariant(t, s, "u2")
}

func mustVoiceID(t *testing.T, s *server, owner string) string {
	t.Helper()
	var voiceID string
	if err := s.db.QueryRowContext(t.Context(), `SELECT id FROM keagent_voice WHERE owner_id=$1 AND NOT archived LIMIT 1`, owner).Scan(&voiceID); err != nil {
		t.Fatal(err)
	}
	return voiceID
}

func TestStaleHoldsReleasedBySweeper(t *testing.T) {
	s := chargeTestServer(t)
	grantForTest(t, s, "u1", creditKindPurchased, 100, 0)
	hold, err := s.holdCredits(t.Context(), "u1", "opening", "stale", 40, "stale-key", "v1", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.ExecContext(t.Context(), `UPDATE keagent_credit_hold SET created_at=now()-interval '8 days' WHERE id=$1`, hold.ID); err != nil {
		t.Fatal(err)
	}
	count, err := s.releaseAllStaleHolds(t.Context())
	if err != nil || count != 1 {
		t.Fatalf("stale sweep: count=%d err=%v", count, err)
	}
	available, held := chargeBalance(t, s, "u1")
	if available != 100 || held != 0 {
		t.Fatalf("stale hold must release: available=%d held=%d", available, held)
	}
	// 同键可以重新冻结。
	if _, err = s.holdCredits(t.Context(), "u1", "opening", "stale", 40, "stale-key", "v1", nil); err != nil {
		t.Fatalf("re-hold after stale release: %v", err)
	}
	creditInvariant(t, s, "u1")
}
