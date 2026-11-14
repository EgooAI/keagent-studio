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

func creatorHubConsent(t *testing.T, f *commentScenario, account string) {
	t.Helper()
	mustCollection(t, f.server, f.actor, "creatorhub/consent/save", object{
		"accountId": f.scope.AccountID, "workId": f.scope.WorkID, "label": "CreatorHub 来源",
		"retentionDays": 7, "expiresAt": time.Now().UTC().Add(24 * time.Hour),
		"baseUrl": "http://127.0.0.1:8000", "creatorhubAccountId": account,
	})
}

func creatorHubImportOne(t *testing.T, f *commentScenario) object {
	t.Helper()
	return mustCollection(t, f.server, f.actor, "comments/import", object{
		"accountId": f.scope.AccountID, "workId": f.scope.WorkID, "requestKey": id(),
		"snapshotId": id(), "observedAt": time.Now().UTC().Format(time.RFC3339Nano),
		"coverage": "partial", "items": []object{
			{"comment_id": "c1", "comment_text": "想在上海买房", "commenter_name": "甲"},
		},
	})
}

func TestCreatorHubImportCreatesSyntheticVerification(t *testing.T) {
	f := commentFixture(t)
	if _, err := f.db.Exec(leadSchema); err != nil {
		t.Fatal(err)
	}
	disableFileGrant(t)
	enableTestAI(t)
	if _, err := f.db.Exec(`DELETE FROM keagent_monitored_videos WHERE owner_id=$1 AND work_id=$2`, f.actor.UserID, f.scope.WorkID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec(`DELETE FROM keagent_collection_runs WHERE owner_id=$1 AND device_id=$2 AND payload->>'accountId'=$3`, f.actor.UserID, f.actor.DeviceID, f.scope.AccountID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec(`DELETE FROM keagent_collection_targets WHERE owner_id=$1 AND device_id=$2 AND payload->>'accountId'=$3 AND payload->>'kind'='video'`, f.actor.UserID, f.actor.DeviceID, f.scope.AccountID); err != nil {
		t.Fatal(err)
	}
	creatorHubConsent(t, f, id())
	if got := creatorHubImportOne(t, f); got["addedCount"] != float64(1) {
		t.Fatal(got)
	}
	counts := []struct {
		name  string
		query string
		args  []any
	}{
		{"targets", `SELECT count(*) FROM keagent_collection_targets
			WHERE owner_id=$1 AND device_id=$2 AND payload->>'accountId'=$3`,
			[]any{f.actor.UserID, f.actor.DeviceID, f.scope.AccountID}},
		{"runs", `SELECT count(*) FROM keagent_collection_runs
			WHERE owner_id=$1 AND device_id=$2 AND payload->>'accountId'=$3`,
			[]any{f.actor.UserID, f.actor.DeviceID, f.scope.AccountID}},
		{"monitored", `SELECT count(*) FROM keagent_monitored_videos
			WHERE owner_id=$1 AND work_id=$2`,
			[]any{f.actor.UserID, f.scope.WorkID}},
	}
	for _, c := range counts {
		var n int
		if err := f.db.QueryRow(c.query, c.args...).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 1 {
			t.Fatalf("expected one %s, got %d", c.name, n)
		}
	}
	page := mustCollection(t, f.server, f.actor, "comments/list", object{
		"accountId": f.scope.AccountID, "workId": f.scope.WorkID, "limit": 10,
	})
	if page["sourceState"] != "active" || len(rows(page["items"])) != 1 {
		t.Fatal(page)
	}
}

func TestCreatorHubImportPreservesDesktopObservation(t *testing.T) {
	f := commentFixture(t)
	disableFileGrant(t)
	enableTestAI(t)
	var runID string
	var observed time.Time
	if err := f.db.QueryRow(`SELECT last_run_id,observed_at FROM keagent_monitored_videos
		WHERE owner_id=$1 AND work_id=$2`, f.actor.UserID, f.scope.WorkID).Scan(&runID, &observed); err != nil {
		t.Fatal(err)
	}
	creatorHubConsent(t, f, id())
	creatorHubImportOne(t, f)
	var afterRun string
	var afterObserved time.Time
	if err := f.db.QueryRow(`SELECT last_run_id,observed_at FROM keagent_monitored_videos
		WHERE owner_id=$1 AND work_id=$2`, f.actor.UserID, f.scope.WorkID).Scan(&afterRun, &afterObserved); err != nil {
		t.Fatal(err)
	}
	if afterRun != runID || !afterObserved.Equal(observed) {
		t.Fatalf("desktop observation repointed: %s@%s -> %s@%s", runID, observed, afterRun, afterObserved)
	}
}

func TestCreatorHubImportRevivesArchivedTarget(t *testing.T) {
	f := commentFixture(t)
	disableFileGrant(t)
	enableTestAI(t)
	var targetID string
	if err := f.db.QueryRow(`SELECT id FROM keagent_collection_targets
		WHERE owner_id=$1 AND device_id=$2 AND payload->>'accountId'=$3
		AND payload->>'kind'='video' AND payload->>'value'=$4`,
		f.actor.UserID, f.actor.DeviceID, f.scope.AccountID, videoBase+f.scope.WorkID).Scan(&targetID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec(`UPDATE keagent_collection_targets SET payload=jsonb_set(payload,'{state}','"archived"') WHERE id=$1`, targetID); err != nil {
		t.Fatal(err)
	}
	creatorHubConsent(t, f, id())
	creatorHubImportOne(t, f)
	var state string
	if err := f.db.QueryRow(`SELECT payload->>'state' FROM keagent_collection_targets WHERE id=$1`, targetID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "active" {
		t.Fatalf("expected revived target, got %q", state)
	}
	page := mustCollection(t, f.server, f.actor, "comments/list", object{
		"accountId": f.scope.AccountID, "workId": f.scope.WorkID, "limit": 10,
	})
	if page["sourceState"] != "active" || len(rows(page["items"])) != 1 {
		t.Fatal(page)
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
