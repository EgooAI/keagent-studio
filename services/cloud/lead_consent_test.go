package main

import (
	"os"
	"path/filepath"
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
	if page["sourceState"] != "active" {
		t.Fatal(page)
	}

	mustCollection(t, f.server, f.actor, "creatorhub/consent/revoke", object{
		"accountId": f.scope.AccountID, "workId": f.scope.WorkID,
	})
	revoked := f.call(t, "list", nil)
	if revoked["sourceState"] != "revoked" {
		t.Fatal(revoked)
	}
}
