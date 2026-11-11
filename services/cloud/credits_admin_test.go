package main

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func adminCreditServer(t *testing.T) *server {
	t.Helper()
	s := creditTestServer(t)
	// admin 接口需要账号表；与生产一致的最小列集。
	if _, err := s.db.ExecContext(t.Context(), `CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY, name text, email text, role text, banned boolean)`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.ExecContext(t.Context(), `INSERT INTO "user"(id,name,email,role) VALUES('u1','测试用户','u1@example.test','user'),('u2','另一用户','u2@example.test','user') ON CONFLICT DO NOTHING`); err != nil {
		t.Fatal(err)
	}
	return s
}

func adminCall(t *testing.T, s *server, a actor, method, path string, body any) (any, error) {
	t.Helper()
	var payload []byte
	if body != nil {
		payload, _ = json.Marshal(body)
	}
	r := httptest.NewRequest(method, "http://internal"+path, bytes.NewReader(payload))
	return s.admin(r, a, payload)
}

func TestAdminCreditGrantAndList(t *testing.T) {
	s := adminCreditServer(t)
	admin := actor{UserID: "admin-1", Role: "admin"}

	if _, err := adminCall(t, s, admin, "POST", "/v1/admin/credits/grant", object{"ownerId": "u1", "kind": "purchased", "amount": 120, "note": ""}); err == nil {
		t.Fatal("grant without note accepted")
	}
	if _, err := adminCall(t, s, admin, "POST", "/v1/admin/credits/grant", object{"ownerId": "missing", "kind": "purchased", "amount": 10, "note": "x"}); err == nil {
		t.Fatal("grant to unknown user accepted")
	}
	if _, err := adminCall(t, s, admin, "POST", "/v1/admin/credits/grant", object{"ownerId": "u1", "kind": "granted", "amount": 30, "note": "x"}); err == nil {
		t.Fatal("granted without validity accepted")
	}
	result, err := adminCall(t, s, admin, "POST", "/v1/admin/credits/grant", object{"ownerId": "u1", "kind": "purchased", "amount": 120, "note": "线下收款充值"})
	if err != nil {
		t.Fatal(err)
	}
	if obj(result)["balance"] != int64(120) {
		t.Fatalf("grant result: %#v", result)
	}
	if _, err = adminCall(t, s, admin, "POST", "/v1/admin/credits/grant", object{"ownerId": "u1", "kind": "granted", "amount": 50, "validityDays": 30, "note": "活动赠送"}); err != nil {
		t.Fatal(err)
	}

	list, err := adminCall(t, s, admin, "GET", "/v1/admin/credits/list", nil)
	if err != nil {
		t.Fatal(err)
	}
	items := rows(obj(list)["items"])
	if len(items) != 1 || obj(items[0])["ownerId"] != "u1" || obj(items[0])["purchasedAvailable"] != int64(120) || obj(items[0])["grantedAvailable"] != int64(50) {
		t.Fatalf("admin credit list wrong: %#v", list)
	}
	if obj(items[0])["nextExpiry"] == nil {
		t.Fatal("nextExpiry missing in admin list")
	}

	detail, err := adminCall(t, s, admin, "GET", "/v1/admin/credits/list?ownerId=u1", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows(obj(detail)["lots"])) != 2 || len(rows(obj(detail)["ledger"])) != 2 {
		t.Fatalf("owner detail wrong: %#v", detail)
	}
	// 操作记录已写入。
	var audits int
	if err := s.db.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM keagent_audit WHERE action='credit.grant' AND target_id='u1'`).Scan(&audits); err != nil || audits != 2 {
		t.Fatalf("grant audits: %d %v", audits, err)
	}
}

func TestAdminCreditAdjustAndSettle(t *testing.T) {
	s := adminCreditServer(t)
	admin := actor{UserID: "admin-1", Role: "admin"}
	grantForTest(t, s, "u1", creditKindPurchased, 100, 0)

	if _, err := adminCall(t, s, admin, "POST", "/v1/admin/credits/adjust", object{"ownerId": "u1", "delta": -30, "note": "差错扣减"}); err != nil {
		t.Fatal(err)
	}
	var adjustRows int
	if err := s.db.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM keagent_audit WHERE action='credit.adjust'`).Scan(&adjustRows); err != nil || adjustRows != 1 {
		t.Fatalf("adjust audit: %d %v", adjustRows, err)
	}

	hold, err := s.holdCredits(t.Context(), "u1", "script", "r1", 20, "admin-hold-key", "v1", nil)
	if err != nil {
		t.Fatal(err)
	}
	holds, err := adminCall(t, s, admin, "GET", "/v1/admin/credits/holds", nil)
	if err != nil || len(rows(holds)) != 1 {
		t.Fatalf("holds list: %#v %v", holds, err)
	}
	if _, err = adminCall(t, s, admin, "POST", "/v1/admin/credits/settle", object{"holdId": hold.ID, "action": "release"}); err != nil {
		t.Fatal(err)
	}
	available, held := creditBalances(t, s, "u1")
	if available != 70 || held != 0 {
		t.Fatalf("after settle release: available=%d held=%d", available, held)
	}
	if _, err = adminCall(t, s, admin, "POST", "/v1/admin/credits/settle", object{"holdId": hold.ID, "action": "release"}); err == nil {
		t.Fatal("settled hold accepted again")
	} else if fault, ok := err.(fault); !ok || fault.status != 409 {
		t.Fatalf("expected 409, got %#v", err)
	}
}

func TestAdminCreditPricingAndWelcome(t *testing.T) {
	s := adminCreditServer(t)
	admin := actor{UserID: "admin-1", Role: "admin"}

	configured, err := adminCall(t, s, admin, "GET", "/v1/admin/credits/pricing", nil)
	if err != nil || obj(configured)["version"] != "default" {
		t.Fatalf("default pricing: %#v %v", configured, err)
	}
	if _, err = adminCall(t, s, admin, "PUT", "/v1/admin/credits/pricing", object{"prices": object{"opening": 150, "bogus": 3}}); err == nil {
		t.Fatal("unknown price key accepted")
	}
	updated, err := adminCall(t, s, admin, "PUT", "/v1/admin/credits/pricing", object{"prices": object{"opening": 150}})
	if err != nil || obj(updated)["version"] != "v1" {
		t.Fatalf("pricing update: %#v %v", updated, err)
	}
	grantForTest(t, s, "u1", creditKindPurchased, 200, 0)
	hold, err := s.holdCredits(t.Context(), "u1", "opening", "priced", 150, "priced-key", "v1", nil)
	if err != nil {
		t.Fatalf("hold must use updated price: %v", err)
	}
	if hold.Amount != 150 {
		t.Fatalf("hold amount %d", hold.Amount)
	}

	if _, err = adminCall(t, s, admin, "GET", "/v1/admin/credits/welcome", nil); err != nil {
		t.Fatal(err)
	}
	welcome, err := adminCall(t, s, admin, "PUT", "/v1/admin/credits/welcome", object{"enabled": true, "amount": 20, "validityDays": 14})
	if err != nil || obj(welcome)["enabled"] != true {
		t.Fatalf("welcome update: %#v %v", welcome, err)
	}
	tx, err := s.db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if err = maybeGrantWelcomeCredits(t.Context(), tx, "fresh-user"); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	var remaining int64
	if err = s.db.QueryRowContext(t.Context(), `SELECT COALESCE(SUM(remaining),0) FROM keagent_credit_lot WHERE owner_id='fresh-user'`).Scan(&remaining); err != nil || remaining != 20 {
		t.Fatalf("welcome grant after config: remaining=%d err=%v", remaining, err)
	}
}

func TestAdminCreditCodes(t *testing.T) {
	s := adminCreditServer(t)
	admin := actor{UserID: "admin-1", Role: "admin"}

	if _, err := adminCall(t, s, admin, "POST", "/v1/admin/credit-codes", object{"amount": 0, "count": 3}); err == nil {
		t.Fatal("zero amount batch accepted")
	}
	if _, err := adminCall(t, s, admin, "POST", "/v1/admin/credit-codes", object{"amount": 50, "count": 501}); err == nil {
		t.Fatal("oversized batch accepted")
	}
	result, err := adminCall(t, s, admin, "POST", "/v1/admin/credit-codes", object{"amount": 50, "count": 3, "validityDays": 90, "note": "首批代理码"})
	if err != nil {
		t.Fatal(err)
	}
	codes, okCodes := obj(result)["codes"].([]string)
	if !okCodes || len(codes) != 3 || obj(result)["batchId"] == "" {
		t.Fatalf("codes result: %#v", result)
	}
	code := str(codes[0])
	if !strings.HasPrefix(code, "KECODE-") || len(code) != 7+16+3 {
		t.Fatalf("code format wrong: %s", code)
	}

	redeemed, err := s.redeemCreditCode(t.Context(), "u1", strings.ToLower(code))
	if err != nil || redeemed["amount"] != int64(50) {
		t.Fatalf("redeem generated code: %#v %v", redeemed, err)
	}
	batches, err := adminCall(t, s, admin, "GET", "/v1/admin/credit-codes", nil)
	if err != nil {
		t.Fatal(err)
	}
	items := rows(batches)
	if len(items) != 1 || obj(items[0])["total"] != int64(3) || obj(items[0])["used"] != int64(1) || obj(items[0])["expiresAt"] == nil {
		t.Fatalf("batch list wrong: %#v", batches)
	}
	var storedHashes int
	if err := s.db.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM keagent_credit_code WHERE code_hash NOT LIKE 'kecode%'`).Scan(&storedHashes); err != nil || storedHashes != 3 {
		t.Fatalf("codes must be stored hashed: %d %v", storedHashes, err)
	}
}
