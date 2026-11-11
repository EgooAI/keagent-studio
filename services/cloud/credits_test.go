package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

func creditTestServer(t *testing.T) *server {
	t.Helper()
	connection := os.Getenv("ADMIN_TEST_DATABASE_URL")
	if connection == "" {
		t.Skip("set ADMIN_TEST_DATABASE_URL for isolated credit persistence tests")
	}
	base, err := sql.Open("pgx", connection)
	if err != nil {
		t.Fatal(err)
	}
	schemaName := "keagent_credit_test_" + id()
	if _, err = base.Exec(`CREATE SCHEMA ` + schemaName); err != nil {
		t.Fatal(err)
	}
	config, err := pgx.ParseConfig(connection)
	if err != nil {
		t.Fatal(err)
	}
	config.RuntimeParams["search_path"] = schemaName
	db := stdlib.OpenDB(*config)
	db.SetMaxOpenConns(20)
	db.SetMaxIdleConns(20)
	t.Cleanup(func() {
		db.Close()
		if _, err := base.Exec(`DROP SCHEMA ` + schemaName + ` CASCADE`); err != nil {
			t.Error(err)
		}
		base.Close()
	})
	if _, err = db.Exec(schema + creditSchema); err != nil {
		t.Fatal(err)
	}
	return &server{db: db}
}

func grantForTest(t *testing.T, s *server, ownerID, kind string, amount int64, expiresIn time.Duration) string {
	t.Helper()
	tx, err := s.db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	var expires *time.Time
	if expiresIn > 0 {
		at := time.Now().Add(expiresIn)
		expires = &at
	}
	lotID, err := grantCredits(t.Context(), tx, ownerID, kind, amount, "admin_grant", "", expires, "tester", "测试发放")
	if err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	return lotID
}

// creditInvariant 校验流水守恒：sum(ledger.amount) == sum(lot.remaining)。
func creditInvariant(t *testing.T, s *server, ownerID string) {
	t.Helper()
	var ledgerSum, lotSum int64
	if err := s.db.QueryRowContext(t.Context(), `SELECT COALESCE(SUM(amount),0) FROM keagent_credit_ledger WHERE owner_id=$1`, ownerID).Scan(&ledgerSum); err != nil {
		t.Fatal(err)
	}
	if err := s.db.QueryRowContext(t.Context(), `SELECT COALESCE(SUM(remaining),0) FROM keagent_credit_lot WHERE owner_id=$1`, ownerID).Scan(&lotSum); err != nil {
		t.Fatal(err)
	}
	if ledgerSum != lotSum {
		t.Fatalf("流水守恒被破坏：ledger=%d lot.remaining=%d", ledgerSum, lotSum)
	}
}

func creditBalances(t *testing.T, s *server, ownerID string) (available, held int64) {
	t.Helper()
	if err := s.db.QueryRowContext(t.Context(), `SELECT COALESCE(SUM(remaining),0), COALESCE(SUM(held),0) FROM keagent_credit_lot WHERE owner_id=$1`, ownerID).Scan(&available, &held); err != nil {
		t.Fatal(err)
	}
	return available, held
}

func requireCoded(t *testing.T, err error, status int, code string) {
	t.Helper()
	if err == nil {
		t.Fatal("expected coded error, got nil")
	}
	fault, ok := err.(codedFault)
	if !ok || fault.ErrorCode() != code {
		t.Fatalf("expected %s, got %#v", code, err)
	}
	if fault.status != status {
		t.Fatalf("expected HTTP %d, got %d (%s)", status, fault.status, fault.message)
	}
}

func TestCreditHoldCaptureLifecycle(t *testing.T) {
	s := creditTestServer(t)
	grantForTest(t, s, "u1", creditKindPurchased, 100, 0)
	grantForTest(t, s, "u1", creditKindGranted, 50, 24*time.Hour)

	hold, err := s.holdCredits(t.Context(), "u1", "opening", "ref-1", 60, "hash-1", "default", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(hold.Allocation) != 2 || hold.Allocation[0].LotID == hold.Allocation[1].LotID {
		t.Fatalf("expected two-lot allocation, got %#v", hold.Allocation)
	}
	var grantedHeld, purchasedHeld int64
	if err = s.db.QueryRowContext(t.Context(), `SELECT COALESCE(SUM(held),0) FROM keagent_credit_lot WHERE owner_id='u1' AND kind='granted'`).Scan(&grantedHeld); err != nil {
		t.Fatal(err)
	}
	if err = s.db.QueryRowContext(t.Context(), `SELECT COALESCE(SUM(held),0) FROM keagent_credit_lot WHERE owner_id='u1' AND kind='purchased'`).Scan(&purchasedHeld); err != nil {
		t.Fatal(err)
	}
	if grantedHeld != 50 || purchasedHeld != 10 {
		t.Fatalf("hold must consume expiring granted first: granted=%d purchased=%d", grantedHeld, purchasedHeld)
	}
	available, held := creditBalances(t, s, "u1")
	if available != 90 || held != 60 {
		t.Fatalf("after hold: available=%d held=%d", available, held)
	}
	creditInvariant(t, s, "u1")

	if err = s.captureHold(t.Context(), hold.ID, 60); err != nil {
		t.Fatal(err)
	}
	available, held = creditBalances(t, s, "u1")
	if available != 90 || held != 0 {
		t.Fatalf("after capture: available=%d held=%d", available, held)
	}
	creditInvariant(t, s, "u1")

	if _, err = s.holdCredits(t.Context(), "u1", "opening", "ref-2", 100, "hash-2", "default", nil); err == nil {
		t.Fatal("insufficient hold accepted")
	} else {
		requireCoded(t, err, 402, "CREDITS_INSUFFICIENT")
	}
}

func TestCreditHoldIdempotentReplay(t *testing.T) {
	s := creditTestServer(t)
	grantForTest(t, s, "u1", creditKindPurchased, 100, 0)

	first, err := s.holdCredits(t.Context(), "u1", "script", "task-1", 40, "idem-1", "v1", nil)
	if err != nil {
		t.Fatal(err)
	}
	replay, err := s.holdCredits(t.Context(), "u1", "script", "task-1", 40, "idem-1", "v1", nil)
	if err != nil || replay.ID != first.ID {
		t.Fatalf("replay returned different hold: %v %#v", err, replay)
	}
	available, held := creditBalances(t, s, "u1")
	if available != 60 || held != 40 {
		t.Fatalf("replay double-deducted: available=%d held=%d", available, held)
	}
	other, err := s.holdCredits(t.Context(), "u1", "tts", "task-1", 20, "idem-1", "v1", nil)
	if err != nil || other.ID == first.ID {
		t.Fatalf("same key under different op must be a new hold: %v %#v", err, other)
	}
	otherOwner, err := s.holdCredits(t.Context(), "u2", "script", "task-1", 20, "idem-1", "v1", nil)
	if err == nil {
		t.Fatal("other owner without balance must fail")
	}
	requireCoded(t, err, 402, "CREDITS_INSUFFICIENT")
	_ = otherOwner
	creditInvariant(t, s, "u1")
}

func TestCreditConcurrentHolds(t *testing.T) {
	s := creditTestServer(t)
	grantForTest(t, s, "u1", creditKindGranted, 90, 24*time.Hour)
	grantForTest(t, s, "u1", creditKindPurchased, 30, 0)

	const workers = 8
	var success, insufficient atomic.Int32
	var mu sync.Mutex
	holdIDs := map[string]bool{}
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			hold, err := s.holdCredits(t.Context(), "u1", "script", "concurrent", 40, "key-"+string(rune('a'+i)), "v1", nil)
			if err == nil {
				success.Add(1)
				mu.Lock()
				holdIDs[hold.ID] = true
				mu.Unlock()
				return
			}
			var fault codedFault
			if !errors.As(err, &fault) || fault.ErrorCode() != "CREDITS_INSUFFICIENT" || fault.status != 402 {
				t.Errorf("expected CREDITS_INSUFFICIENT, got %#v", err)
				return
			}
			insufficient.Add(1)
		}(i)
	}
	wg.Wait()
	if success.Load() != 3 || insufficient.Load() != workers-3 {
		t.Fatalf("concurrent holds: success=%d insufficient=%d", success.Load(), insufficient.Load())
	}
	if len(holdIDs) != 3 {
		t.Fatalf("expected 3 distinct holds, got %d", len(holdIDs))
	}
	available, held := creditBalances(t, s, "u1")
	if available != 0 || held != 120 {
		t.Fatalf("after concurrent holds: available=%d held=%d", available, held)
	}
	creditInvariant(t, s, "u1")

	// 并发同幂等键：只允许创建一个冻结单，只扣一次。
	grantForTest(t, s, "u2", creditKindPurchased, 100, 0)
	var sameKey sync.WaitGroup
	duplicateHolds := make(chan string, workers)
	for i := 0; i < workers; i++ {
		sameKey.Add(1)
		go func() {
			defer sameKey.Done()
			hold, err := s.holdCredits(t.Context(), "u2", "voice_clone", "same", 60, "shared-key", "v1", nil)
			if err != nil {
				t.Error(err)
				return
			}
			duplicateHolds <- hold.ID
		}()
	}
	sameKey.Wait()
	close(duplicateHolds)
	seen := map[string]bool{}
	for holdID := range duplicateHolds {
		seen[holdID] = true
	}
	if len(seen) != 1 {
		t.Fatalf("same idem key must yield one hold, got %d", len(seen))
	}
	available, held = creditBalances(t, s, "u2")
	if available != 40 || held != 60 {
		t.Fatalf("same-key concurrency deducted twice: available=%d held=%d", available, held)
	}
	creditInvariant(t, s, "u2")
}

func TestCreditCapturePartialReleasesDifference(t *testing.T) {
	s := creditTestServer(t)
	grantForTest(t, s, "u1", creditKindPurchased, 100, 0)
	hold, err := s.holdCredits(t.Context(), "u1", "tts", "tts-1", 100, "tts-key", "v1", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.captureHold(t.Context(), hold.ID, 60); err != nil {
		t.Fatal(err)
	}
	available, held := creditBalances(t, s, "u1")
	if available != 40 || held != 0 {
		t.Fatalf("after partial capture: available=%d held=%d", available, held)
	}
	var state string
	var allocationRaw []byte
	if err = s.db.QueryRowContext(t.Context(), `SELECT state, allocation FROM keagent_credit_hold WHERE id=$1`, hold.ID).Scan(&state, &allocationRaw); err != nil {
		t.Fatal(err)
	}
	if state != "captured" {
		t.Fatalf("hold state %s", state)
	}
	var allocation []creditAllocation
	if json.Unmarshal(allocationRaw, &allocation) != nil || len(allocation) != 1 || allocation[0].Amount != 60 {
		t.Fatalf("captured allocation wrong: %s", allocationRaw)
	}
	creditInvariant(t, s, "u1")
	if err = s.releaseHold(t.Context(), hold.ID); err == nil {
		t.Fatal("captured hold released")
	}
}

func TestCreditExpirySweep(t *testing.T) {
	s := creditTestServer(t)
	grantForTest(t, s, "u1", creditKindPurchased, 20, 0)
	// 正常发放一个赠送批次，再把过期时间改到过去，模拟时间流逝（直接 INSERT 会绕过发放流水）。
	grantForTest(t, s, "u1", creditKindGranted, 30, 24*time.Hour)
	if _, err := s.db.ExecContext(t.Context(), `UPDATE keagent_credit_lot SET expires_at=now()-interval '1 hour' WHERE owner_id='u1' AND kind='granted'`); err != nil {
		t.Fatal(err)
	}
	count, err := s.expireAllCredits(t.Context())
	if err != nil || count != 1 {
		t.Fatalf("sweep: count=%d err=%v", count, err)
	}
	var remaining int64
	if err = s.db.QueryRowContext(t.Context(), `SELECT remaining FROM keagent_credit_lot WHERE owner_id='u1' AND kind='granted'`).Scan(&remaining); err != nil || remaining != 0 {
		t.Fatalf("expired lot remaining=%d err=%v", remaining, err)
	}
	var expireAmount int64
	if err = s.db.QueryRowContext(t.Context(), `SELECT amount FROM keagent_credit_ledger WHERE owner_id='u1' AND kind='expire'`).Scan(&expireAmount); err != nil || expireAmount != -30 {
		t.Fatalf("expire ledger row: amount=%d err=%v", expireAmount, err)
	}
	hold, err := s.holdCredits(t.Context(), "u1", "script", "after-expiry", 20, "sweep-key", "default", nil)
	if err != nil {
		t.Fatalf("purchased credits must survive expiry sweep: %v", err)
	}
	if len(hold.Allocation) != 1 || hold.Allocation[0].Amount != 20 {
		t.Fatalf("hold must skip expired lots: %#v", hold.Allocation)
	}
	creditInvariant(t, s, "u1")
}

func TestCreditReleaseExpiredGrantedBecomesPurchased(t *testing.T) {
	s := creditTestServer(t)
	grantForTest(t, s, "u1", creditKindGranted, 40, 2*time.Hour)
	hold, err := s.holdCredits(t.Context(), "u1", "opening", "opening-1", 40, "release-key", "default", nil)
	if err != nil {
		t.Fatal(err)
	}
	// 冻结期间批次过期。
	if _, err = s.db.ExecContext(t.Context(), `UPDATE keagent_credit_lot SET expires_at=now()-interval '1 hour' WHERE owner_id='u1'`); err != nil {
		t.Fatal(err)
	}
	if err = s.releaseHold(t.Context(), hold.ID); err != nil {
		t.Fatal(err)
	}
	var kind string
	var remaining, held int64
	if err = s.db.QueryRowContext(t.Context(), `SELECT kind, remaining, held FROM keagent_credit_lot WHERE owner_id='u1' AND kind='purchased'`).Scan(&kind, &remaining, &held); err != nil {
		t.Fatal(err)
	}
	if kind != creditKindPurchased || remaining != 40 || held != 0 {
		t.Fatalf("released expired granted must return as purchased: kind=%s remaining=%d held=%d", kind, remaining, held)
	}
	creditInvariant(t, s, "u1")
}

func TestCreditRedeemCode(t *testing.T) {
	s := creditTestServer(t)
	hash := func(code string) string {
		return digestBytes([]byte(code))
	}
	insertCode := func(code string, amount int64, expires string) {
		var expiresArg any
		if expires != "" {
			expiresArg = expires
		}
		if _, err := s.db.ExecContext(t.Context(), `INSERT INTO keagent_credit_code(batch_id, code_hash, amount, expires_at, note) VALUES('batch-1',$1,$2,$3,'测试码')`, hash(code), amount, expiresArg); err != nil {
			t.Fatal(err)
		}
	}
	insertCode("KECODE-ALIVE-0001", 200, "")
	insertCode("KECODE-DEAD-0001", 100, "2020-01-01T00:00:00Z")

	result, err := s.redeemCreditCode(t.Context(), "u1", "kecode-alive-0001")
	if err != nil || result["amount"] != int64(200) {
		t.Fatalf("redeem: %#v %v", result, err)
	}
	available, held := creditBalances(t, s, "u1")
	if available != 200 || held != 0 {
		t.Fatalf("after redeem: available=%d held=%d", available, held)
	}
	var kind string
	if err = s.db.QueryRowContext(t.Context(), `SELECT kind FROM keagent_credit_lot WHERE owner_id='u1'`).Scan(&kind); err != nil || kind != creditKindPurchased {
		t.Fatalf("redeemed credits must be purchased: %v", err)
	}
	if _, err = s.redeemCreditCode(t.Context(), "u1", "KECODE-ALIVE-0001"); err == nil {
		t.Fatal("reused code accepted")
	}
	if _, err = s.redeemCreditCode(t.Context(), "u1", "KECODE-DEAD-0001"); err == nil {
		t.Fatal("expired code accepted")
	}
	if _, err = s.redeemCreditCode(t.Context(), "u1", "KECODE-XXXX-9999"); err == nil {
		t.Fatal("unknown code accepted")
	}
	if _, err = s.redeemCreditCode(t.Context(), "u1", "short"); err == nil {
		t.Fatal("malformed code accepted")
	}
	creditInvariant(t, s, "u1")
}

func TestCreditAdjust(t *testing.T) {
	s := creditTestServer(t)
	grantForTest(t, s, "u1", creditKindPurchased, 50, 0)
	if _, err := s.adjustCredits(t.Context(), "u1", -10, "admin-1", ""); err == nil {
		t.Fatal("adjust without note accepted")
	}
	if _, err := s.adjustCredits(t.Context(), "u1", -80, "admin-1", "差错扣减"); err == nil {
		t.Fatal("over-deduct accepted")
	} else {
		requireCoded(t, err, 402, "CREDITS_INSUFFICIENT")
	}
	result, err := s.adjustCredits(t.Context(), "u1", -30, "admin-1", "差错扣减")
	if err != nil || result["balance"] != int64(20) {
		t.Fatalf("negative adjust: %#v %v", result, err)
	}
	result, err = s.adjustCredits(t.Context(), "u1", 15, "admin-1", "补偿")
	if err != nil || result["balance"] != int64(35) {
		t.Fatalf("positive adjust: %#v %v", result, err)
	}
	creditInvariant(t, s, "u1")
}

func TestCreditSummaryAndWelcomeGrant(t *testing.T) {
	s := creditTestServer(t)
	grantForTest(t, s, "u1", creditKindPurchased, 100, 0)
	grantForTest(t, s, "u1", creditKindGranted, 50, 72*time.Hour)
	hold, err := s.holdCredits(t.Context(), "u1", "opening", "sum-1", 30, "sum-key", "default", nil)
	if err != nil {
		t.Fatal(err)
	}
	summary, err := s.creditSummary(t.Context(), "u1")
	if err != nil {
		t.Fatal(err)
	}
	purchased := summary["purchased"].(object)
	granted := summary["granted"].(object)
	if purchased["available"] != int64(100) || purchased["held"] != int64(0) || granted["available"] != int64(20) || granted["held"] != int64(30) {
		t.Fatalf("summary wrong: %#v", summary)
	}
	if granted["nextExpiry"] == nil {
		t.Fatal("nextExpiry missing")
	}
	if len(summary["ledger"].([]any)) == 0 {
		t.Fatal("ledger missing")
	}

	if err = s.releaseHold(t.Context(), hold.ID); err != nil {
		t.Fatal(err)
	}

	// 欢迎赠送：读 credit_welcome 配置。
	seedSetting := func(payload string) {
		if _, err := s.db.ExecContext(t.Context(), `INSERT INTO keagent_setting(id,payload) VALUES('credit_welcome',$1) ON CONFLICT (id) DO UPDATE SET payload=$1`, []byte(payload)); err != nil {
			t.Fatal(err)
		}
	}
	seedSetting(`{"enabled":false,"amount":10,"validityDays":30}`)
	tx, err := s.db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = maybeGrantWelcomeCredits(t.Context(), tx, "u2"); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	var lots int
	if err = s.db.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM keagent_credit_lot WHERE owner_id='u2'`).Scan(&lots); err != nil || lots != 0 {
		t.Fatalf("disabled welcome must not grant: lots=%d err=%v", lots, err)
	}

	seedSetting(`{"enabled":true,"amount":10,"validityDays":30}`)
	tx, err = s.db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = maybeGrantWelcomeCredits(t.Context(), tx, "u2"); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	var remaining int64
	if err = s.db.QueryRowContext(t.Context(), `SELECT remaining FROM keagent_credit_lot WHERE owner_id='u2' AND kind='granted'`).Scan(&remaining); err != nil || remaining != 10 {
		t.Fatalf("welcome grant: remaining=%d err=%v", remaining, err)
	}
	creditInvariant(t, s, "u2")
}

func TestCreditPricingConfig(t *testing.T) {
	s := creditTestServer(t)
	prices, version, err := readCreditPricing(t.Context(), s.db)
	if err != nil || version != "default" || prices["opening"] != 100 {
		t.Fatalf("default pricing: %#v %s %v", prices, version, err)
	}
	if _, err = s.db.ExecContext(t.Context(), `INSERT INTO keagent_setting(id,payload) VALUES('credit_pricing',$1)`, []byte(`{"version":2,"prices":{"opening":150,"script":0,"bogus":99}}`)); err != nil {
		t.Fatal(err)
	}
	prices, version, err = readCreditPricing(t.Context(), s.db)
	if err != nil || version != "v2" {
		t.Fatalf("configured pricing version: %s %v", version, err)
	}
	if prices["opening"] != 150 || prices["script"] != 0 || prices["voice_clone"] != 200 {
		t.Fatalf("configured pricing merge wrong: %#v", prices)
	}
	if _, _, err = readCreditPricing(t.Context(), s.db); err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.ExecContext(t.Context(), `UPDATE keagent_setting SET payload=$1 WHERE id='credit_pricing'`, []byte(`{"version":0,"prices":{}}`)); err != nil {
		t.Fatal(err)
	}
	if _, _, err = readCreditPricing(t.Context(), s.db); err == nil {
		t.Fatal("invalid pricing version accepted")
	}
}

func TestCreditHoldValidation(t *testing.T) {
	s := creditTestServer(t)
	grantForTest(t, s, "u1", creditKindPurchased, 100, 0)
	if _, err := s.holdCredits(t.Context(), "u1", "not-an-op", "r", 10, "k", "v", nil); err == nil {
		t.Fatal("unknown op accepted")
	}
	if _, err := s.holdCredits(t.Context(), "u1", "script", "r", 0, "k", "v", nil); err == nil {
		t.Fatal("zero amount accepted")
	}
	if _, err := s.holdCredits(t.Context(), "u1", "script", "r", 10, "", "v", nil); err == nil {
		t.Fatal("empty idem key accepted")
	}
	if err := s.releaseHold(t.Context(), "missing"); err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			t.Fatalf("missing hold release: %v", err)
		}
	} else {
		t.Fatal("missing hold release accepted")
	}
}

func signedCreditsRequest(t *testing.T, s *server, method, path string, body []byte, userID string) *httptest.ResponseRecorder {
	t.Helper()
	contextHeader, _ := json.Marshal(actor{UserID: userID, SessionID: "sess-" + id(), Timestamp: time.Now().Unix(), Nonce: id()})
	encoded := base64.RawURLEncoding.EncodeToString(contextHeader)
	digest := sha256.Sum256(body)
	h := hmac.New(sha256.New, []byte(s.secret))
	fmt.Fprintf(h, "%s\n%s\n%s\n%x", method, path, encoded, digest)
	r := httptest.NewRequest(method, "http://internal"+path, bytes.NewReader(body))
	r.Header.Set("X-Keagent-Context", encoded)
	r.Header.Set("X-Keagent-Signature", hex.EncodeToString(h.Sum(nil)))
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}

func TestCreditsRoutes(t *testing.T) {
	s := creditTestServer(t)
	s.secret = "test-secret-with-at-least-32-characters"
	grantForTest(t, s, "u1", creditKindPurchased, 120, 0)
	insertCode := func(code string, amount int64) {
		if _, err := s.db.ExecContext(t.Context(), `INSERT INTO keagent_credit_code(batch_id, code_hash, amount, note) VALUES('route-batch',$1,$2,'路由测试')`, digestBytes([]byte(code)), amount); err != nil {
			t.Fatal(err)
		}
	}
	insertCode("KECODE-ROUTE-0001", 50)

	w := signedCreditsRequest(t, s, "GET", "/v1/credits", nil, "u1")
	if w.Code != 200 {
		t.Fatalf("credits summary status %d: %s", w.Code, w.Body.String())
	}
	var summary object
	if json.Unmarshal(w.Body.Bytes(), &summary) != nil || summary["purchased"].(object)["available"] != float64(120) {
		t.Fatalf("summary wrong: %s", w.Body.String())
	}

	body, _ := json.Marshal(object{"code": "kecode-route-0001"})
	w = signedCreditsRequest(t, s, "POST", "/v1/credits/redeem", body, "u1")
	if w.Code != 200 {
		t.Fatalf("redeem status %d: %s", w.Code, w.Body.String())
	}
	var result object
	if json.Unmarshal(w.Body.Bytes(), &result) != nil || result["amount"] != float64(50) {
		t.Fatalf("redeem result wrong: %s", w.Body.String())
	}
	w = signedCreditsRequest(t, s, "GET", "/v1/credits", nil, "u1")
	json.Unmarshal(w.Body.Bytes(), &summary)
	if summary["purchased"].(object)["available"] != float64(170) {
		t.Fatalf("balance after redeem wrong: %s", w.Body.String())
	}

	// 价目查询：用户侧只读，供桌面端预估展示。
	w = signedCreditsRequest(t, s, "GET", "/v1/credits/pricing", nil, "u1")
	if w.Code != 200 {
		t.Fatalf("pricing status %d: %s", w.Code, w.Body.String())
	}
	var priced object
	if json.Unmarshal(w.Body.Bytes(), &priced) != nil ||
		priced["version"] != "default" || obj(priced["prices"])["script"] != float64(5) {
		t.Fatalf("pricing wrong: %s", w.Body.String())
	}

	// 重复兑换与无效请求。
	w = signedCreditsRequest(t, s, "POST", "/v1/credits/redeem", body, "u1")
	if w.Code != 422 {
		t.Fatalf("reused code status %d", w.Code)
	}
	w = signedCreditsRequest(t, s, "POST", "/v1/credits/redeem", []byte(`{}`), "u1")
	if w.Code != 422 {
		t.Fatalf("missing code status %d", w.Code)
	}
	w = signedCreditsRequest(t, s, "GET", "/v1/credits/redeem", nil, "u1")
	if w.Code != 404 {
		t.Fatalf("GET redeem status %d: %s", w.Code, w.Body.String())
	}
	creditInvariant(t, s, "u1")
}

func TestWorkspaceWelcomeGrant(t *testing.T) {
	s := creditTestServer(t)
	if _, err := s.db.ExecContext(t.Context(), `INSERT INTO keagent_setting(id,payload) VALUES('credit_welcome',$1)`, []byte(`{"enabled":true,"amount":15,"validityDays":7}`)); err != nil {
		t.Fatal(err)
	}
	a := actor{UserID: "new-user", Name: "新手"}
	w, err := s.workspace(t.Context(), a)
	if err != nil {
		t.Fatal(err)
	}
	if w["schemaVersion"] != float64(1) {
		t.Fatal("workspace seed broken by welcome grant wiring")
	}
	var remaining, lots int64
	if err = s.db.QueryRowContext(t.Context(), `SELECT COALESCE(SUM(remaining),0), COUNT(*) FROM keagent_credit_lot WHERE owner_id='new-user' AND kind='granted'`).Scan(&remaining, &lots); err != nil || remaining != 15 || lots != 1 {
		t.Fatalf("welcome grant: remaining=%d lots=%d err=%v", remaining, lots, err)
	}
	// 再次进入：不重复发放。
	if _, err = s.workspace(t.Context(), a); err != nil {
		t.Fatal(err)
	}
	if err = s.db.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM keagent_credit_lot WHERE owner_id='new-user'`).Scan(&lots); err != nil || lots != 1 {
		t.Fatalf("welcome grant repeated: lots=%d err=%v", lots, err)
	}
	creditInvariant(t, s, "new-user")

	// 配置关闭：不发放。
	if _, err = s.db.ExecContext(t.Context(), `UPDATE keagent_setting SET payload=$1 WHERE id='credit_welcome'`, []byte(`{"enabled":false,"amount":15,"validityDays":7}`)); err != nil {
		t.Fatal(err)
	}
	if _, err = s.workspace(t.Context(), actor{UserID: "another-user", Name: "另一人"}); err != nil {
		t.Fatal(err)
	}
	if err = s.db.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM keagent_credit_lot WHERE owner_id='another-user'`).Scan(&lots); err != nil || lots != 0 {
		t.Fatalf("disabled welcome granted: lots=%d err=%v", lots, err)
	}
}
