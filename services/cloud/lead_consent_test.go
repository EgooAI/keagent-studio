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
	} {
		input["creatorhubAccountId"] = value
		_, err := collectionCall(f.server, f.actor, "creatorhub/consent/save", input)
		t.Run(name, func(t *testing.T) { expectExchangeStatus(t, err, 422) })
	}
}
