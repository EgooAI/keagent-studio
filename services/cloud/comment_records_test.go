package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// PostgreSQL plus operator file adapter; this fixture is synthetic and never contacts Douyin.
type commentScenario struct {
	*server
	actor
	scope commentScope
	grant commentGrant
	at    time.Time
	file  string
}

func commentFixture(t *testing.T) *commentScenario {
	t.Helper()
	s, a, p := douyinFixture(t)
	if _, err := s.db.Exec(collectionSchema); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(leadSchema); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`INSERT INTO keagent_device(id,owner_id,session_id,name,platform) VALUES($1,$2,$3,'测试','test') ON CONFLICT DO NOTHING`, a.DeviceID, a.UserID, a.SessionID); err != nil {
		t.Fatal(err)
	}
	scope := commentScope{WorkID: "7707599736451158395", AccountID: p.AccountID}
	target := mustCollection(t, s, a, "targets/create", object{"requestKey": id(), "kind": "video", "value": videoBase + scope.WorkID, "name": "测试作品", "accountId": p.AccountID})
	run := mustCollection(t, s, a, "runs/create", object{"targetId": target["id"], "expectedVersion": 1, "requestKey": id()})
	token := id()
	mustCollection(t, s, a, "runs/claim", object{"id": run["id"], "leaseToken": token})
	mustCollection(t, s, a, "runs/finish", object{"id": run["id"], "leaseToken": token, "state": "succeeded", "panelStatus": "visible", "verifiedWorkId": scope.WorkID, "title": "测试作品", "author": object{"name": "测试作者", "url": "https://www.douyin.com/user/test"}})
	file := filepath.Join(t.TempDir(), "grants.json")
	t.Setenv("KEAGENT_COMMENT_GRANTS_FILE", file)
	f := &commentScenario{s, a, scope, commentGrant{OwnerID: a.UserID, DeviceID: a.DeviceID, AccountID: p.AccountID, WorkID: scope.WorkID, Ref: "test-authorization", Kind: "export", Label: "测试脱敏导出", ExpiresAt: time.Now().UTC().Add(24 * time.Hour), RetentionDays: 2, Fields: append([]string{}, allowedCommentFields...), ExportFile: "snapshot.json"}, time.Now().UTC().Add(-2 * time.Hour).Truncate(time.Microsecond), file}
	f.saveGrant(t)
	return f
}
func commentWriteJSON(t *testing.T, path string, v any) {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
}
func (f *commentScenario) saveGrant(t *testing.T) {
	t.Helper()
	commentWriteJSON(t, f.file, []commentGrant{f.grant})
}
func (f *commentScenario) export(t *testing.T, key string, at time.Time, coverage string, entries []object) {
	t.Helper()
	commentWriteJSON(t, filepath.Join(filepath.Dir(f.file), f.grant.ExportFile), object{"ownerId": f.UserID, "deviceId": f.DeviceID, "accountId": f.scope.AccountID, "workId": f.scope.WorkID, "sourceRef": f.grant.Ref, "snapshotId": key, "observedAt": at, "coverage": coverage, "items": entries})
}
func (f *commentScenario) request(extra object) object {
	input := object{"workId": f.scope.WorkID, "accountId": f.scope.AccountID}
	for k, v := range extra {
		input[k] = v
	}
	return input
}
func (f *commentScenario) call(t *testing.T, op string, extra object) object {
	t.Helper()
	return mustCollection(t, f.server, f.actor, "comments/"+op, f.request(extra))
}
func (f *commentScenario) checkCode(t *testing.T, op string, extra object, code string) {
	t.Helper()
	_, err := collectionCall(f.server, f.actor, "comments/"+op, f.request(extra))
	var e exchangeFault
	if !errors.As(err, &e) || e.code != code {
		t.Fatalf("%s: expected %s, got %v", op, code, err)
	}
}
func (f *commentScenario) count(t *testing.T) int {
	t.Helper()
	var n int
	if err := f.db.QueryRow(`SELECT count(*) FROM keagent_comment_observations`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestCommentRecordsIncremental(t *testing.T) {
	f := commentFixture(t)
	if p := f.call(t, "list", nil); p["sourceState"] != "active" || p["coverage"] != "unknown" || len(rows(p["items"])) != 0 || p["lastSyncedAt"] != nil {
		t.Fatal(p)
	}
	items := []object{
		{"comment_id": "top", "comment_text": "一级评论", "reply_count": 1, "like_count": 0, "commenter_name": "同名"},
		{"comment_id": "reply", "parent_comment_id": "top", "comment_text": "回复", "truncated": true},
		{"commenter_name": "同名", "comment_text": "无 ID"},
		{"commenter_name": "同名", "comment_text": "无 ID"},
	}
	f.export(t, "first", f.at, "partial", items)
	var sourceReads atomic.Int64
	f.server.commentRead = func(ctx context.Context, g *commentGrant) (commentBatch, error) {
		sourceReads.Add(1)
		return readCommentSource(ctx, g)
	}
	in := f.request(object{"requestKey": id()})
	// Concurrent retries get the same committed receipt, including original counts.
	var wg sync.WaitGroup
	var receipts [4]object
	var errs [4]error
	for i := range receipts {
		wg.Add(1)
		go func() { defer wg.Done(); receipts[i], errs[i] = collectionCall(f.server, f.actor, "comments/sync", in) }()
	}
	wg.Wait()
	if sourceReads.Load() != 1 {
		t.Fatal("same request caused repeated source reads", sourceReads.Load())
	}
	for i, receipt := range receipts {
		if errs[i] != nil || receipt["addedCount"] != float64(4) || receipt["syncedAt"] != receipts[0]["syncedAt"] {
			t.Fatal(i, receipt, errs[i])
		}
	}
	page := f.call(t, "list", object{"limit": 2})
	if page["coverage"] != "partial" || page["nextCursor"] == nil || len(rows(page["items"])) != 2 {
		t.Fatal(page)
	}
	next := f.call(t, "list", object{"limit": 2, "cursor": page["nextCursor"]})
	if next["nextCursor"] != nil || len(rows(next["items"])) != 2 {
		t.Fatal(next)
	}
	seen := map[string]bool{}
	var top, reply object
	for _, v := range append(rows(page["items"]), rows(next["items"])...) {
		r := v.(object)
		rowID := r["id"].(string)
		if seen[rowID] {
			t.Fatal("page repeated a row")
		}
		seen[rowID] = true
		d := f.call(t, "get", object{"id": rowID})
		if d["workId"] != f.scope.WorkID || d["accountId"] != f.scope.AccountID {
			t.Fatal(d)
		}
		switch d["comment_id"] {
		case "top":
			top = d
		case "reply":
			reply = d
		}
	}
	if top == nil || reply == nil || top["like_count"] != float64(0) || top["commenter_profile"] != nil || reply["parent_comment_id"] != "top" || reply["truncated"] != true {
		t.Fatal(top, reply)
	}
	again := f.call(t, "sync", object{"requestKey": id()})
	if again["addedCount"] != float64(0) || again["updatedCount"] != float64(0) {
		t.Fatal(again)
	}
	items[0]["like_count"] = 2
	f.export(t, "first", f.at, "partial", items)
	f.checkCode(t, "sync", object{"requestKey": id()}, "COMMENT_SNAPSHOT_CONFLICT")
	delete(items[1], "parent_comment_id")
	items[1]["comment_text"] = "回复已展开"
	items[1]["truncated"] = false
	f.export(t, "second", f.at.Add(time.Hour), "complete", items)
	result := f.call(t, "sync", object{"requestKey": id()})
	if result["readCount"] != float64(4) || result["addedCount"] != float64(2) || result["updatedCount"] != float64(2) || f.count(t) != 6 {
		t.Fatal(result)
	}
	changed := f.call(t, "get", object{"id": reply["id"]})
	if changed["firstSeenAt"] != reply["firstSeenAt"] || changed["lastSeenAt"] == reply["lastSeenAt"] || changed["updatedAt"] == reply["updatedAt"] || changed["parent_comment_id"] != "top" || changed["comment_text"] != "回复已展开" {
		t.Fatal(changed)
	}
	f.export(t, "old", f.at.Add(time.Minute), "partial", items)
	f.checkCode(t, "sync", object{"requestKey": id()}, "COMMENT_STALE_SNAPSHOT")
	items[1]["parent_comment_id"] = "other"
	f.export(t, "wrong-parent", f.at.Add(90*time.Minute), "partial", items)
	f.checkCode(t, "sync", object{"requestKey": id()}, "COMMENT_PARENT_CONFLICT")
	if f.count(t) != 6 {
		t.Fatal("failed batch left new rows")
	}
	f.export(t, "empty", f.at.Add(110*time.Minute), "complete", []object{})
	if r := f.call(t, "sync", object{"requestKey": id()}); r["readCount"] != float64(0) || r["coverage"] != "complete" || f.count(t) != 6 {
		t.Fatal(r)
	}
	f.checkCode(t, "get", object{"id": reply["id"], "workId": "12345"}, "NOT_FOUND")
	f.checkCode(t, "sync", object{"requestKey": id(), "accountId": id()}, "NOT_FOUND")
	f.checkCode(t, "sync", object{"requestKey": id(), "items": items}, "INVALID_INPUT")
}

func TestCommentRecordsGrantLifecycle(t *testing.T) {
	f := commentFixture(t)
	entries := []object{{"comment_text": "脱敏测试"}}
	load := func() {
		t.Helper()
		f.export(t, "sample", f.at, "partial", entries)
		f.call(t, "sync", object{"requestKey": id()})
		if f.count(t) != 1 {
			t.Fatal("fixture import failed")
		}
	}
	sweep := func() {
		t.Helper()
		if err := f.purgeCommentRecords(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	load()
	f.grant.Revoked = true
	f.saveGrant(t)
	if page := f.call(t, "list", nil); page["sourceState"] != "revoked" || len(rows(page["items"])) != 0 || f.count(t) != 0 {
		t.Fatal(page)
	}
	f.checkCode(t, "sync", object{"requestKey": id()}, "COMMENT_GRANT_REVOKED")
	f.grant.Revoked = false
	f.saveGrant(t)
	load()
	oldID := rows(f.call(t, "list", nil)["items"])[0].(object)["id"]
	f.grant.Ref = "replacement-scope"
	f.saveGrant(t)
	f.checkCode(t, "get", object{"id": oldID}, "NOT_FOUND")
	if f.count(t) != 0 {
		t.Fatal("opening an obsolete row after grant rotation retained records")
	}
	load()
	f.grant.ExpiresAt = time.Now().UTC().Add(-time.Minute)
	f.saveGrant(t)
	sweep()
	if page := f.call(t, "list", nil); page["sourceState"] != "expired" || f.count(t) != 0 {
		t.Fatal(page)
	}
	f.grant.ExpiresAt = time.Now().UTC().Add(time.Hour)
	f.saveGrant(t)
	load()
	commentWriteJSON(t, f.file, []commentGrant{})
	if page := f.call(t, "list", nil); page["sourceState"] != "unconfigured" || page["coverage"] != "unknown" || f.count(t) != 0 {
		t.Fatal(page)
	}
	f.saveGrant(t)
	f.export(t, "outside-window", f.at.AddDate(0, 0, -4), "partial", entries)
	f.checkCode(t, "sync", object{"requestKey": id()}, "COMMENT_RETENTION_EXPIRED")
	load()
	for _, sql := range []string{`UPDATE keagent_comment_observations SET retain_until=now()-interval '1 minute'`, `UPDATE keagent_comment_snapshots SET retain_until=now()-interval '1 minute'`} {
		if _, err := f.db.Exec(sql); err != nil {
			t.Fatal(err)
		}
	}
	sweep()
	if p := f.call(t, "list", nil); len(rows(p["items"])) != 0 || p["coverage"] != "unknown" || p["lastSyncedAt"] != nil {
		t.Fatal(p)
	}
	var receipts int
	if err := f.db.QueryRow(`SELECT count(*) FROM keagent_comment_requests`).Scan(&receipts); err != nil || receipts != 0 {
		t.Fatal(receipts, err)
	}
	load()
	if _, err := f.db.Exec(`UPDATE keagent_douyin_account SET payload=payload || '{"unboundAt":"test"}'::jsonb WHERE id=$1`, f.scope.AccountID); err != nil {
		t.Fatal(err)
	}
	f.checkCode(t, "list", nil, "NOT_FOUND")
	sweep()
	if f.count(t) != 0 {
		t.Fatal("unbound account retained private data")
	}
}

func TestCommentRecordsLateSourceAndProviderDenial(t *testing.T) {
	f := commentFixture(t)
	f.export(t, "fixture", f.at, "partial", []object{{"comment_text": "fixture"}})
	f.call(t, "sync", object{"requestKey": id()})
	entered, release := make(chan struct{}), make(chan struct{})
	f.server.commentRead = func(ctx context.Context, g *commentGrant) (commentBatch, error) {
		close(entered)
		select {
		case <-ctx.Done():
			return commentBatch{}, ctx.Err()
		case <-release:
		}
		return readCommentSource(ctx, g)
	}
	done := make(chan error, 1)
	go func() {
		_, err := collectionCall(f.server, f.actor, "comments/sync", f.request(object{"requestKey": id()}))
		done <- err
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("did not start source read")
	}
	// Canceling a queued sync must also release its waiter without canceling the active source read.
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	req, _ := json.Marshal(f.request(object{"requestKey": id()}))
	_, err := f.collection(ctx, f.actor, "comments/sync", req)
	cancel()
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("queued cancellation: %v", err)
	}
	f.grant.Revoked = true
	f.saveGrant(t)
	// A concurrent list is allowed while provider I/O is blocked and atomically purges after revocation.
	if p := f.call(t, "list", nil); p["sourceState"] != "revoked" {
		t.Fatal(p)
	}
	close(release)
	var e exchangeFault
	if err := <-done; !errors.As(err, &e) || e.code != "COMMENT_GRANT_REVOKED" || f.count(t) != 0 {
		t.Fatal("late sync survived revoke", err)
	}
	f.grant.Revoked = false
	f.saveGrant(t)
	f.server.commentRead = nil
	f.call(t, "sync", object{"requestKey": id()})
	requestCtx, stopRequest := context.WithCancel(context.Background())
	defer stopRequest()
	f.server.commentRead = func(context.Context, *commentGrant) (commentBatch, error) {
		stopRequest()
		return commentBatch{}, exchangeFail(403, "COMMENT_SCOPE_DENIED", "fixture denial")
	}
	body, _ := json.Marshal(f.request(object{"requestKey": id()}))
	if _, err := f.collection(requestCtx, f.actor, "comments/sync", body); !errors.As(err, &e) || e.code != "COMMENT_SCOPE_DENIED" {
		t.Fatalf("lost provider denial on client close: %v", err)
	}
	if p := f.call(t, "list", nil); p["sourceState"] != "revoked" || f.count(t) != 0 {
		t.Fatal(p)
	}
	f.checkCode(t, "sync", object{"requestKey": id()}, "COMMENT_GRANT_REVOKED")
}
