package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func disableFileGrant(t *testing.T) {
	t.Helper()
	file := filepath.Join(t.TempDir(), "grants.json")
	if err := os.WriteFile(file, []byte("[]"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("KEAGENT_COMMENT_GRANTS_FILE", file)
}

func enableTestAI(t *testing.T) {
	t.Helper()
	t.Setenv("AI_BASE_URL", "https://approved.example/v1")
	t.Setenv("AI_ALLOWED_HOSTS", "approved.example")
	t.Setenv("AI_MODEL", "synthetic-test-model")
	t.Setenv("AI_API_KEY", "synthetic-test-key")
}

func TestCreatorHubConsentEnablesCommentSource(t *testing.T) {
	f := commentFixture(t)
	if _, err := f.db.Exec(leadSchema); err != nil {
		t.Fatal(err)
	}
	disableFileGrant(t)
	enableTestAI(t)
	_, _ = f.db.Exec(`DELETE FROM keagent_comment_sources`)
	unconfigured := f.call(t, "list", nil)
	if unconfigured["sourceState"] != "unconfigured" {
		t.Fatal(unconfigured)
	}

	mustCollection(t, f.server, f.actor, "creatorhub/consent/save", object{
		"accountId": f.scope.AccountID, "workId": f.scope.WorkID, "label": "CreatorHub 来源",
		"retentionDays": 7, "expiresAt": time.Now().UTC().Add(24 * time.Hour),
		"baseUrl": "http://127.0.0.1:8000", "creatorhubAccountId": id(),
	})
	page := f.call(t, "list", nil)
	if page["sourceState"] != "active" || page["canAnalyze"] != true {
		t.Fatal(page)
	}
	_, _ = f.db.Exec(`UPDATE keagent_comment_consents SET ai_endpoint='https://other.example/v1' WHERE owner_id=$1 AND device_id=$2 AND account_id=$3 AND work_id=$4`,
		f.actor.UserID, f.actor.DeviceID, f.scope.AccountID, f.scope.WorkID)
	drifted := f.call(t, "list", nil)
	if drifted["sourceState"] != "active" || drifted["canAnalyze"] != false {
		t.Fatal(drifted)
	}

	mustCollection(t, f.server, f.actor, "creatorhub/consent/revoke", object{
		"accountId": f.scope.AccountID, "workId": f.scope.WorkID,
	})
	revoked := f.call(t, "list", nil)
	if revoked["sourceState"] != "revoked" {
		t.Fatal(revoked)
	}
}

func TestCreatorHubConsentPolicyKeyStableAcrossRefresh(t *testing.T) {
	f := commentFixture(t)
	disableFileGrant(t)
	enableTestAI(t)
	creatorHubAccountID := id()
	save := func(expiresAt time.Time) {
		t.Helper()
		mustCollection(t, f.server, f.actor, "creatorhub/consent/save", object{
			"accountId": f.scope.AccountID, "workId": f.scope.WorkID, "label": "CreatorHub 来源",
			"retentionDays": 7, "expiresAt": expiresAt, "baseUrl": "http://127.0.0.1:8000",
			"creatorhubAccountId": creatorHubAccountID,
		})
	}
	grantFor := func() *commentGrant {
		t.Helper()
		tx, err := f.db.Begin()
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback()
		g, err := loadCreatorHubConsent(context.Background(), tx, f.actor, f.scope)
		if err != nil || g == nil {
			t.Fatalf("load consent: %v", err)
		}
		return g
	}
	save(time.Now().UTC().Add(24 * time.Hour))
	first := grantFor()
	save(time.Now().UTC().Add(48 * time.Hour))
	second := grantFor()
	if first.policyKey() != second.policyKey() {
		t.Fatalf("consent refresh rotated policy key: %q != %q", first.policyKey(), second.policyKey())
	}
}

func TestCreatorHubConsentAccountValidation(t *testing.T) {
	f := commentFixture(t)
	disableFileGrant(t)
	enableTestAI(t)
	input := object{
		"accountId": f.scope.AccountID, "workId": f.scope.WorkID, "label": "CreatorHub 来源",
		"retentionDays": 7, "expiresAt": time.Now().UTC().Add(24 * time.Hour),
		"baseUrl": "http://127.0.0.1:8000", "creatorhubAccountId": "valid-account",
	}
	if _, err := collectionCall(f.server, f.actor, "creatorhub/consent/save", input); err != nil {
		t.Fatal(err)
	}
	for name, value := range map[string]string{
		"too long": strings.Repeat("a", 65),
		"slash":    "bad/value",
		"empty":    "",
	} {
		input["creatorhubAccountId"] = value
		_, err := collectionCall(f.server, f.actor, "creatorhub/consent/save", input)
		t.Run(name, func(t *testing.T) { expectExchangeStatus(t, err, 422) })
	}
}

func TestCreatorHubConsentRefreshPreservesSource(t *testing.T) {
	f := commentFixture(t)
	if _, err := f.db.Exec(leadSchema); err != nil {
		t.Fatal(err)
	}
	disableFileGrant(t)
	enableTestAI(t)
	_, _ = f.db.Exec(`DELETE FROM keagent_comment_sources`)
	account := "creator-account-1"
	save := func(expires time.Time) {
		mustCollection(t, f.server, f.actor, "creatorhub/consent/save", object{
			"accountId": f.scope.AccountID, "workId": f.scope.WorkID, "label": "CreatorHub 来源",
			"retentionDays": 7, "expiresAt": expires,
			"baseUrl": "http://127.0.0.1:8000", "creatorhubAccountId": account,
		})
	}
	ctx := context.Background()
	save(time.Now().UTC().Add(24 * time.Hour))

	tx, err := f.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	g, state, sourceID, err := prepareCommentSource(ctx, tx, f.actor, f.scope)
	if err != nil || state != "active" {
		t.Fatalf("prepare source: state=%s err=%v", state, err)
	}
	if sourceID == "" {
		sourceID, err = insertCommentSource(ctx, tx, f.actor, f.scope, g, false)
		if err != nil {
			t.Fatal(err)
		}
	}
	if _, err = tx.Exec(`INSERT INTO keagent_comment_observations
		(id,source_id,row_key,fields,first_seen_at,last_seen_at,updated_at,retain_until)
		VALUES($1,$2,'id:survival','{"comment_id":"survival","comment_text":"测试"}'::jsonb,now(),now(),now(),now()+interval '7 days')`,
		id(), sourceID); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}

	if _, err = f.db.Exec(`UPDATE keagent_comment_sources SET expires_at=now()-interval '1 hour' WHERE id=$1`, sourceID); err != nil {
		t.Fatal(err)
	}
	save(time.Now().UTC().Add(48 * time.Hour))

	tx2, err := f.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx2.Rollback()
	_, state2, sourceID2, err := prepareCommentSource(ctx, tx2, f.actor, f.scope)
	if err != nil || state2 != "active" {
		t.Fatalf("prepare refreshed source: state=%s err=%v", state2, err)
	}
	if sourceID2 != sourceID {
		t.Fatalf("source replaced: %s -> %s", sourceID, sourceID2)
	}
	var observations int
	if err = f.db.QueryRow(`SELECT count(*) FROM keagent_comment_observations WHERE source_id=$1`, sourceID).Scan(&observations); err != nil {
		t.Fatal(err)
	}
	if observations != 1 {
		t.Fatalf("expected observation to survive, got %d", observations)
	}
}
