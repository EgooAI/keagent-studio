package main

import (
	"context"
	"errors"
	"testing"
)

func outreachRows(t *testing.T) (*commentScenario, []object) {
	t.Helper()
	f, jobID := analysisFixture(t)
	f.server.runAnalysisJob(context.Background(), jobID)
	list := mustCollection(t, f.server, f.actor, "comments/analysis/list", object{"jobId": jobID, "limit": 10})
	var analyses []object
	for _, item := range rows(list["items"]) {
		row := obj(item)
		if row["commenterProfile"] != nil {
			analyses = append(analyses, row)
		}
	}
	if len(analyses) == 0 {
		t.Fatal("no analysis with a commenter profile")
	}
	return f, analyses
}

func outreachAnalysis(t *testing.T) (*commentScenario, object) {
	t.Helper()
	f, analyses := outreachRows(t)
	return f, analyses[0]
}

func outreachSubmitCall(t *testing.T, f *commentScenario, analysisID string, draft string, key string) object {
	t.Helper()
	return mustCollection(t, f.server, f.actor, "outreach/submit", object{
		"analysisId": analysisID, "draft": draft, "requestKey": key,
	})
}

func expectCollectionError(t *testing.T, f *commentScenario, op string, input object, code string) {
	t.Helper()
	if _, err := collectionCall(f.server, f.actor, op, input); err == nil {
		t.Fatalf("%s: expected %s, got success", op, code)
	} else {
		var e exchangeFault
		if !errors.As(err, &e) || e.code != code {
			t.Fatalf("%s: expected %s, got %v", op, code, err)
		}
	}
}

func outreachRow(t *testing.T, f *commentScenario, outreachID any) object {
	t.Helper()
	list := mustCollection(t, f.server, f.actor, "outreach/list", object{"id": outreachID})
	items := rows(list["items"])
	if len(items) != 1 {
		t.Fatalf("outreach list: %v", list)
	}
	return obj(items[0])
}

func TestOutreachSubmitAndStatusMonotonic(t *testing.T) {
	f, analysis := outreachAnalysis(t)
	outreach := outreachSubmitCall(t, f, analysis["id"].(string), "您好，想了解哪个区域？", id())
	if outreach["status"] != "approved" || outreach["attempt"] != float64(1) {
		t.Fatal(outreach)
	}
	submitted := mustCollection(t, f.server, f.actor, "outreach/result", object{
		"id": outreach["id"], "status": "submitted", "creatorhubTaskId": "42", "method": "browser",
		"attempt": outreach["attempt"],
	})
	if submitted["status"] != "submitted" {
		t.Fatal(submitted)
	}
	sent := mustCollection(t, f.server, f.actor, "outreach/result", object{
		"id": outreach["id"], "status": "sent", "attempt": outreach["attempt"],
	})
	if sent["status"] != "sent" {
		t.Fatal(sent)
	}
	row := outreachRow(t, f, outreach["id"])
	if row["creatorhubTaskId"] != "42" || row["method"] != "browser" {
		t.Fatalf("traceability lost on status update: %v", row)
	}
	stale := mustCollection(t, f.server, f.actor, "outreach/result", object{
		"id": outreach["id"], "status": "submitted", "attempt": outreach["attempt"],
	})
	if stale["status"] != "sent" || stale["ignored"] != true {
		t.Fatal(stale)
	}
}

func TestOutreachFailedResetStartsNewAttempt(t *testing.T) {
	f, analysis := outreachAnalysis(t)
	firstKey := id()
	first := outreachSubmitCall(t, f, analysis["id"].(string), "第一版草稿", firstKey)
	failed := mustCollection(t, f.server, f.actor, "outreach/result", object{
		"id": first["id"], "status": "failed", "attempt": first["attempt"], "error": "浏览器崩溃",
	})
	if failed["status"] != "failed" {
		t.Fatal(failed)
	}
	retryKey := id()
	retry := outreachSubmitCall(t, f, analysis["id"].(string), "第二版草稿", retryKey)
	if retry["id"] != first["id"] || retry["status"] != "approved" || retry["attempt"] != float64(2) {
		t.Fatalf("retry did not advance the generation: %v", retry)
	}
	row := outreachRow(t, f, retry["id"])
	if row["attempt"] != float64(2) || row["draft"] != "第二版草稿" || row["status"] != "approved" ||
		row["requestKey"] != retryKey ||
		row["creatorhubTaskId"] != "" || row["method"] != "" || row["error"] != "" ||
		row["submittedAt"] != nil || row["finishedAt"] != nil {
		t.Fatalf("reset left stale execution data: %v", row)
	}
	var count int
	if err := f.db.QueryRow(`SELECT count(*) FROM keagent_outreach_tasks WHERE analysis_id=$1`,
		analysis["id"]).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("retry created a second row: %d", count)
	}
}

func TestOutreachSubmitSameRequestReturnsReceipt(t *testing.T) {
	f, analysis := outreachAnalysis(t)
	key := id()
	first := outreachSubmitCall(t, f, analysis["id"].(string), "原草稿", key)
	second := outreachSubmitCall(t, f, analysis["id"].(string), "重放时不应覆盖草稿", key)
	if second["id"] != first["id"] || second["attempt"] != first["attempt"] ||
		second["status"] != "approved" {
		t.Fatalf("same request key was not idempotent: %v %v", first, second)
	}
	if row := outreachRow(t, f, first["id"]); row["draft"] != "原草稿" || row["requestKey"] != key {
		t.Fatalf("replay overwrote the receipt: %v", row)
	}
	var count int
	if err := f.db.QueryRow(`SELECT count(*) FROM keagent_outreach_tasks WHERE analysis_id=$1`,
		analysis["id"]).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("replay created a second row: %d", count)
	}
}

func TestOutreachDifferentRequestConflictWhenActive(t *testing.T) {
	f, analysis := outreachAnalysis(t)
	first := outreachSubmitCall(t, f, analysis["id"].(string), "原草稿", id())
	expectCollectionError(t, f, "outreach/submit", object{
		"analysisId": analysis["id"], "draft": "另一个草稿", "requestKey": id(),
	}, "OUTREACH_EXISTS")
	if row := outreachRow(t, f, first["id"]); row["attempt"] != float64(1) {
		t.Fatalf("conflicting submit changed the task: %v", row)
	}
}

func TestOutreachUncertainRequiresConfirmation(t *testing.T) {
	f, analysis := outreachAnalysis(t)
	first := outreachSubmitCall(t, f, analysis["id"].(string), "您好", id())
	uncertain := mustCollection(t, f.server, f.actor, "outreach/result", object{
		"id": first["id"], "status": "uncertain", "attempt": first["attempt"], "error": "未确认是否送达",
	})
	if uncertain["status"] != "uncertain" {
		t.Fatal(uncertain)
	}
	ignored := mustCollection(t, f.server, f.actor, "outreach/result", object{
		"id": first["id"], "status": "sent", "attempt": first["attempt"], "confirmed": false,
	})
	if ignored["status"] != "uncertain" || ignored["ignored"] != true {
		t.Fatalf("unconfirmed resolution was applied: %v", ignored)
	}
	accepted := mustCollection(t, f.server, f.actor, "outreach/result", object{
		"id": first["id"], "status": "sent", "attempt": first["attempt"], "confirmed": true,
	})
	if accepted["status"] != "sent" {
		t.Fatalf("confirmed resolution rejected: %v", accepted)
	}
	terminal := mustCollection(t, f.server, f.actor, "outreach/result", object{
		"id": first["id"], "status": "failed", "attempt": first["attempt"], "confirmed": true,
	})
	if terminal["status"] != "sent" || terminal["ignored"] != true {
		t.Fatalf("sent was not terminal: %v", terminal)
	}
}

func TestOutreachResultRejectsWrongAttempt(t *testing.T) {
	f, analysis := outreachAnalysis(t)
	first := outreachSubmitCall(t, f, analysis["id"].(string), "您好", id())
	ignored := mustCollection(t, f.server, f.actor, "outreach/result", object{
		"id": first["id"], "status": "sent", "attempt": float64(2),
	})
	if ignored["status"] != "approved" || ignored["attempt"] != float64(1) || ignored["ignored"] != true {
		t.Fatalf("stale generation applied: %v", ignored)
	}
}

func TestOutreachRejectsAnalysisWithoutProfile(t *testing.T) {
	f := analysisScenario(t)
	analysisImport(t, f, []object{
		{"comment_id": "c1", "comment_text": "想在上海买房", "commenter_name": "甲"},
	})
	f.server.leadComplete = analysisOK
	jobID := analysisStart(t, f)
	analysisRun(t, f, jobID)
	list := mustCollection(t, f.server, f.actor, "comments/analysis/list", object{"jobId": jobID, "limit": 10})
	var analysis object
	for _, item := range rows(list["items"]) {
		if obj(item)["commenterProfile"] == nil {
			analysis = obj(item)
		}
	}
	if analysis == nil {
		t.Fatal("expected an analysis without a commenter profile")
	}
	expectCollectionError(t, f, "outreach/submit", object{
		"analysisId": analysis["id"], "draft": "您好", "requestKey": id(),
	}, "COMMENT_PROFILE_UNAVAILABLE")
}

func TestOutreachRejectsUnqualifiedAnalysis(t *testing.T) {
	f := analysisScenario(t)
	analysisImport(t, f, []object{
		{"comment_id": "c1", "comment_text": "想在上海买房", "commenter_name": "甲",
			"commenter_profile": "https://www.douyin.com/user/sec1"},
	})
	f.server.leadComplete = func(context.Context, any, string) (string, error) {
		return `{"intent":"unrelated","evidence":"想在上海买房","qualified":false,"reason":"与房产无关","draft":""}`, nil
	}
	jobID := analysisStart(t, f)
	analysisRun(t, f, jobID)
	list := mustCollection(t, f.server, f.actor, "comments/analysis/list", object{"jobId": jobID, "limit": 10})
	items := rows(list["items"])
	if len(items) != 1 || obj(items[0])["qualified"] != false {
		t.Fatalf("expected one unqualified analysis: %v", list)
	}
	expectCollectionError(t, f, "outreach/submit", object{
		"analysisId": obj(items[0])["id"], "draft": "您好", "requestKey": id(),
	}, "COMMENT_NOT_QUALIFIED")
}

func TestOutreachCancelRestrictedToPending(t *testing.T) {
	f, analyses := outreachRows(t)
	first := outreachSubmitCall(t, f, analyses[0]["id"].(string), "您好", id())
	expectCollectionError(t, f, "outreach/cancel", object{"id": first["id"], "attempt": float64(2)}, "OUTREACH_NOT_CANCELABLE")
	canceled := mustCollection(t, f.server, f.actor, "outreach/cancel", object{
		"id": first["id"], "attempt": first["attempt"],
	})
	if canceled["status"] != "canceled" || canceled["attempt"] != float64(1) {
		t.Fatal(canceled)
	}
	expectCollectionError(t, f, "outreach/cancel", object{"id": first["id"], "attempt": first["attempt"]}, "OUTREACH_NOT_CANCELABLE")
	sent := outreachSubmitCall(t, f, analyses[1]["id"].(string), "您好", id())
	mustCollection(t, f.server, f.actor, "outreach/result", object{
		"id": sent["id"], "status": "sent", "attempt": sent["attempt"],
	})
	expectCollectionError(t, f, "outreach/cancel", object{"id": sent["id"], "attempt": sent["attempt"]}, "OUTREACH_NOT_CANCELABLE")
}
