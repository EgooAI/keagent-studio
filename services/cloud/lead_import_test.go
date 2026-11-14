package main

import (
	"errors"
	"testing"
	"time"
)

func TestCreatorHubImportIdempotent(t *testing.T) {
	f := commentFixture(t)
	if _, err := f.db.Exec(leadSchema); err != nil {
		t.Fatal(err)
	}
	disableFileGrant(t)
	enableTestAI(t)
	_, _ = f.db.Exec(`DELETE FROM keagent_comment_sources`)
	mustCollection(t, f.server, f.actor, "creatorhub/consent/save", object{
		"accountId": f.scope.AccountID, "workId": f.scope.WorkID, "label": "CreatorHub 来源",
		"retentionDays": 7, "expiresAt": time.Now().UTC().Add(24 * time.Hour),
		"baseUrl": "http://127.0.0.1:8000", "creatorhubAccountId": id(),
	})
	in := object{
		"accountId": f.scope.AccountID, "workId": f.scope.WorkID, "requestKey": id(),
		"snapshotId": id(), "observedAt": time.Now().UTC().Format(time.RFC3339Nano),
		"coverage": "partial",
		"items": []object{
			{"comment_id": "c1", "comment_text": "想在上海买房", "commenter_name": "甲",
				"commenter_profile": "https://www.douyin.com/user/sec1", "like_count": 3},
			{"comment_id": "c2", "comment_text": "这个小区多少钱", "commenter_name": "乙"},
		},
	}
	first := mustCollection(t, f.server, f.actor, "comments/import", in)
	if first["addedCount"] != float64(2) {
		t.Fatal(first)
	}
	again := mustCollection(t, f.server, f.actor, "comments/import", in)
	if again["addedCount"] != first["addedCount"] {
		t.Fatal(again)
	}
	page := mustCollection(t, f.server, f.actor, "comments/list", object{
		"accountId": f.scope.AccountID, "workId": f.scope.WorkID, "limit": 10,
	})
	if len(rows(page["items"])) != 2 || page["sourceState"] != "active" {
		t.Fatal(page)
	}
}

func TestCreatorHubImportRequiresConsent(t *testing.T) {
	f := commentFixture(t)
	if _, err := f.db.Exec(leadSchema); err != nil {
		t.Fatal(err)
	}
	disableFileGrant(t)
	_, _ = f.db.Exec(`DELETE FROM keagent_comment_sources`)
	in := object{
		"accountId": f.scope.AccountID, "workId": f.scope.WorkID, "requestKey": id(),
		"snapshotId": id(), "observedAt": time.Now().UTC().Format(time.RFC3339Nano),
		"coverage": "partial", "items": []object{},
	}
	_, err := collectionCall(f.server, f.actor, "comments/import", in)
	var e exchangeFault
	if !errors.As(err, &e) || e.code != "COMMENT_SOURCE_UNCONFIGURED" {
		t.Fatalf("expected unconfigured, got %v", err)
	}
}

func TestCreatorHubImportAfterConsentRefresh(t *testing.T) {
	f := commentFixture(t)
	if _, err := f.db.Exec(leadSchema); err != nil {
		t.Fatal(err)
	}
	disableFileGrant(t)
	enableTestAI(t)
	_, _ = f.db.Exec(`DELETE FROM keagent_comment_sources`)
	const account = "creator-account-1"
	save := func(expires time.Time) {
		mustCollection(t, f.server, f.actor, "creatorhub/consent/save", object{
			"accountId": f.scope.AccountID, "workId": f.scope.WorkID, "label": "CreatorHub 来源",
			"retentionDays": 7, "expiresAt": expires,
			"baseUrl": "http://127.0.0.1:8000", "creatorhubAccountId": account,
		})
	}
	save(time.Now().UTC().Add(24 * time.Hour))
	items := []object{
		{"comment_id": "c1", "comment_text": "想在上海买房", "commenter_name": "甲",
			"commenter_profile": "https://www.douyin.com/user/sec1", "like_count": 3},
		{"comment_id": "c2", "comment_text": "这个小区多少钱", "commenter_name": "乙"},
	}
	first := mustCollection(t, f.server, f.actor, "comments/import", object{
		"accountId": f.scope.AccountID, "workId": f.scope.WorkID, "requestKey": id(),
		"snapshotId": id(), "observedAt": time.Now().UTC().Format(time.RFC3339Nano),
		"coverage": "partial", "items": items,
	})
	if first["addedCount"] != float64(2) {
		t.Fatal(first)
	}

	save(time.Now().UTC().Add(48 * time.Hour))
	second := mustCollection(t, f.server, f.actor, "comments/import", object{
		"accountId": f.scope.AccountID, "workId": f.scope.WorkID, "requestKey": id(),
		"snapshotId": id(), "observedAt": time.Now().UTC().Add(time.Second).Format(time.RFC3339Nano),
		"coverage": "partial", "items": items,
	})
	if second["addedCount"] != float64(0) {
		t.Fatal(second)
	}
	page := mustCollection(t, f.server, f.actor, "comments/list", object{
		"accountId": f.scope.AccountID, "workId": f.scope.WorkID, "limit": 10,
	})
	if len(rows(page["items"])) != 2 || page["sourceState"] != "active" {
		t.Fatal(page)
	}
	var sources int
	if err := f.db.QueryRow(`SELECT count(*) FROM keagent_comment_sources
		WHERE owner_id=$1 AND device_id=$2 AND account_id=$3 AND work_id=$4`,
		f.actor.UserID, f.actor.DeviceID, f.scope.AccountID, f.scope.WorkID).Scan(&sources); err != nil {
		t.Fatal(err)
	}
	if sources != 1 {
		t.Fatalf("expected one source, got %d", sources)
	}
}
