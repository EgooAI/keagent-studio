package main

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

func analysisScenario(t *testing.T) *commentScenario {
	t.Helper()
	const endpoint = "https://approved.example/v1"
	t.Setenv("AI_BASE_URL", endpoint)
	t.Setenv("AI_ALLOWED_HOSTS", "approved.example")
	t.Setenv("AI_MODEL", "synthetic-test-model")
	t.Setenv("AI_API_KEY", "synthetic-test-key")
	f := commentFixture(t)
	disableFileGrant(t)
	if _, err := f.db.Exec(leadSchema); err != nil {
		t.Fatal(err)
	}
	_, _ = f.db.Exec(`DELETE FROM keagent_comment_sources`)
	mustCollection(t, f.server, f.actor, "creatorhub/consent/save", object{
		"accountId": f.scope.AccountID, "workId": f.scope.WorkID, "label": "CreatorHub 来源",
		"retentionDays": 7, "expiresAt": time.Now().UTC().Add(24 * time.Hour),
		"baseUrl": "http://127.0.0.1:8000", "creatorhubAccountId": id(),
	})
	return f
}

func analysisImport(t *testing.T, f *commentScenario, items []object) {
	t.Helper()
	mustCollection(t, f.server, f.actor, "comments/import", object{
		"accountId": f.scope.AccountID, "workId": f.scope.WorkID, "requestKey": id(),
		"snapshotId": id(), "observedAt": time.Now().UTC().Format(time.RFC3339Nano),
		"coverage": "partial", "items": items,
	})
}

func analysisStart(t *testing.T, f *commentScenario) string {
	t.Helper()
	job := mustCollection(t, f.server, f.actor, "comments/analyze-batch", object{
		"accountId": f.scope.AccountID, "workId": f.scope.WorkID,
		"criteria": "只找上海购房客户", "maxComments": 10, "requestKey": id(),
	})
	return job["id"].(string)
}

// analysisRun mirrors the producer: the worker claims a queued job by marking it running.
func analysisRun(t *testing.T, f *commentScenario, jobID string) {
	t.Helper()
	if _, err := f.db.Exec(`UPDATE keagent_comment_analysis_jobs SET status='running',started_at=now() WHERE id=$1`, jobID); err != nil {
		t.Fatal(err)
	}
	f.server.runAnalysisJob(context.Background(), jobID)
}

func analysisOK(context.Context, any, string) (string, error) {
	return `{"intent":"buy","evidence":"想在上海买房","qualified":true,"reason":"明确购房需求","draft":"您好，想了解哪个区域？"}`, nil
}

func analysisComments() []object {
	return []object{
		{"comment_id": "c1", "comment_text": "想在上海买房", "commenter_name": "甲",
			"commenter_profile": "https://www.douyin.com/user/sec1"},
		{"comment_id": "c2", "comment_text": "想在上海买房，预算多少", "commenter_name": "乙",
			"commenter_profile": "https://www.douyin.com/user/sec2"},
	}
}

func analysisFixture(t *testing.T) (*commentScenario, string) {
	t.Helper()
	f := analysisScenario(t)
	analysisImport(t, f, analysisComments())
	f.server.leadComplete = analysisOK
	return f, analysisStart(t, f)
}

func TestAnalysisJobProducesQualifiedRows(t *testing.T) {
	f, jobID := analysisFixture(t)
	analysisRun(t, f, jobID)
	job := mustCollection(t, f.server, f.actor, "comments/analysis/job", object{"jobId": jobID})
	if job["status"] != "done" || job["processed"] != float64(2) {
		t.Fatal(job)
	}
	list := mustCollection(t, f.server, f.actor, "comments/analysis/list", object{"jobId": jobID, "limit": 10})
	items := rows(list["items"])
	if len(items) != 2 || items[0].(object)["qualified"] != true {
		t.Fatal(list)
	}
}

func TestLeadAnalysisRejectsUngroundedEvidence(t *testing.T) {
	original := "想在上海买房"
	raw := `{"intent":"buy","evidence":"原文没有这句","qualified":true,"reason":"x","draft":""}`
	if _, err := parseLeadAnalysis(original, raw, true); err == nil {
		t.Fatal("ungrounded evidence accepted")
	}
}

func TestLeadAnalysisRejectsUnknownFieldWithoutPartialResult(t *testing.T) {
	raw := `{"intent":"buy","evidence":"想在上海买房","qualified":true,"reason":"x","draft":"d","extra":1}`
	result, err := parseLeadAnalysis("想在上海买房", raw, true)
	if err == nil {
		t.Fatal("unknown field accepted")
	}
	if result != (leadAnalysisResult{}) {
		t.Fatalf("partial result leaked: %+v", result)
	}
}

func TestAnalysisJobPersistsFailureWithoutPartialResult(t *testing.T) {
	f := analysisScenario(t)
	analysisImport(t, f, []object{
		{"comment_id": "c1", "comment_text": "想在上海买房", "commenter_name": "甲"},
	})
	f.server.leadComplete = func(context.Context, any, string) (string, error) {
		return `{"intent":"buy","evidence":"想在上海买房","qualified":true,"reason":"明确","draft":"您好","extra":1}`, nil
	}
	jobID := analysisStart(t, f)
	analysisRun(t, f, jobID)
	var status, draft, reason, evidence string
	var qualified bool
	if err := f.db.QueryRow(`SELECT status,qualified,draft,reason,evidence FROM keagent_comment_analyses
		WHERE job_id=$1`, jobID).Scan(&status, &qualified, &draft, &reason, &evidence); err != nil {
		t.Fatal(err)
	}
	if status != "failed" || qualified || draft != "" || reason != "" || evidence != "" {
		t.Fatalf("failed analysis persisted fields: status=%s qualified=%v draft=%q reason=%q evidence=%q",
			status, qualified, draft, reason, evidence)
	}
	job := mustCollection(t, f.server, f.actor, "comments/analysis/job", object{"jobId": jobID})
	if job["status"] != "partial" || job["failed"] != float64(1) || job["processed"] != float64(1) {
		t.Fatal(job)
	}
}

func TestLeadAnalysisUnrelatedAndUnclearCannotQualify(t *testing.T) {
	const original = "想在上海买房"
	for _, intent := range []string{"unrelated", "unclear"} {
		raw := `{"intent":"` + intent + `","evidence":"想在上海买房","qualified":true,"reason":"明确","draft":"您好"}`
		result, err := parseLeadAnalysis(original, raw, true)
		if err != nil {
			t.Fatalf("%s: %v", intent, err)
		}
		if result.Qualified || result.Draft != "" {
			t.Fatalf("%s: %+v", intent, result)
		}
	}
}

func TestAnalysisJobSuppressesDraftWithoutManualContact(t *testing.T) {
	f := analysisScenario(t)
	if _, err := f.db.Exec(`UPDATE keagent_comment_consents
		SET purposes='{"analyzeWithAI":true,"manualContact":false}'::jsonb
		WHERE owner_id=$1 AND device_id=$2 AND account_id=$3 AND work_id=$4`,
		f.actor.UserID, f.actor.DeviceID, f.scope.AccountID, f.scope.WorkID); err != nil {
		t.Fatal(err)
	}
	analysisImport(t, f, []object{
		{"comment_id": "c1", "comment_text": "想在上海买房", "commenter_name": "甲"},
	})
	f.server.leadComplete = analysisOK
	jobID := analysisStart(t, f)
	analysisRun(t, f, jobID)
	var status, draft string
	var qualified bool
	if err := f.db.QueryRow(`SELECT status,qualified,draft FROM keagent_comment_analyses
		WHERE job_id=$1`, jobID).Scan(&status, &qualified, &draft); err != nil {
		t.Fatal(err)
	}
	if status != "done" || !qualified || draft != "" {
		t.Fatalf("draft suppressed without manual contact: status=%s qualified=%v draft=%q",
			status, qualified, draft)
	}
}

func TestAnalysisJobDedupesCommenters(t *testing.T) {
	f := analysisScenario(t)
	analysisImport(t, f, []object{
		{"comment_id": "c1", "comment_text": "想在上海买房", "commenter_profile": "https://www.douyin.com/user/sec1"},
		{"comment_id": "c2", "comment_text": "想在上海买房", "commenter_profile": "https://www.douyin.com/user/sec1"},
	})
	f.server.leadComplete = analysisOK
	jobID := analysisStart(t, f)
	job := mustCollection(t, f.server, f.actor, "comments/analysis/job", object{"jobId": jobID})
	if job["total"] != float64(1) {
		t.Fatalf("deduped total: %v", job)
	}
	analysisRun(t, f, jobID)
	var count int
	if err := f.db.QueryRow(`SELECT count(*) FROM keagent_comment_analyses WHERE job_id=$1`, jobID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	job = mustCollection(t, f.server, f.actor, "comments/analysis/job", object{"jobId": jobID})
	if count != 1 || job["processed"] != float64(1) || job["status"] != "done" {
		t.Fatalf("count=%d job=%v", count, job)
	}
}

func TestAnalysisJobRequestKeyIdempotent(t *testing.T) {
	f := analysisScenario(t)
	analysisImport(t, f, []object{
		{"comment_id": "c1", "comment_text": "想在上海买房", "commenter_name": "甲"},
	})
	f.server.leadComplete = analysisOK
	key := id()
	input := object{
		"accountId": f.scope.AccountID, "workId": f.scope.WorkID,
		"criteria": "只找上海购房客户", "maxComments": 10, "requestKey": key,
	}
	first := mustCollection(t, f.server, f.actor, "comments/analyze-batch", input)
	second := mustCollection(t, f.server, f.actor, "comments/analyze-batch", input)
	if first["id"] != second["id"] {
		t.Fatalf("retry created a second job: %v %v", first["id"], second["id"])
	}
	var jobs int
	if err := f.db.QueryRow(`SELECT count(*) FROM keagent_comment_analysis_jobs`).Scan(&jobs); err != nil {
		t.Fatal(err)
	}
	if jobs != 1 {
		t.Fatalf("expected one job, got %d", jobs)
	}
}

func TestAnalysisFailureDoesNotOverwriteDoneRow(t *testing.T) {
	f, jobID := analysisFixture(t)
	analysisRun(t, f, jobID)
	var sourceID, criteria, version string
	if err := f.db.QueryRow(`SELECT source_id,criteria,criteria_version FROM keagent_comment_analysis_jobs
		WHERE id=$1`, jobID).Scan(&sourceID, &criteria, &version); err != nil {
		t.Fatal(err)
	}
	var rowID string
	var raw []byte
	if err := f.db.QueryRow(`SELECT id,fields FROM keagent_comment_observations
		WHERE source_id=$1 AND fields->>'parent_comment_id' IS NULL ORDER BY seq LIMIT 1`,
		sourceID).Scan(&rowID, &raw); err != nil {
		t.Fatal(err)
	}
	var fields commentFields
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatal(err)
	}
	if err := f.server.saveAnalysis(jobID, f.actor, f.scope.AccountID, f.scope.WorkID, sourceID,
		version, criteria, rowID, fields, leadAnalysisResult{}, false, errors.New("retry failed")); err != nil {
		t.Fatal(err)
	}
	var status, draft string
	var qualified bool
	if err := f.db.QueryRow(`SELECT status,qualified,draft FROM keagent_comment_analyses
		WHERE job_id=$1 AND comment_row_id=$2`, jobID, rowID).Scan(&status, &qualified, &draft); err != nil {
		t.Fatal(err)
	}
	if status != "done" || !qualified || draft == "" {
		t.Fatalf("failed retry erased done analysis: status=%s qualified=%v draft=%q", status, qualified, draft)
	}
}

func TestAnalysisCancelIsNotOverwritten(t *testing.T) {
	f := analysisScenario(t)
	analysisImport(t, f, []object{
		{"comment_id": "c1", "comment_text": "想在上海买房", "commenter_name": "甲"},
	})
	f.server.leadComplete = analysisOK
	jobID := analysisStart(t, f)
	mustCollection(t, f.server, f.actor, "comments/analysis/cancel", object{"jobId": jobID})
	f.server.finishAnalysisJob(jobID, "done", "")
	job := mustCollection(t, f.server, f.actor, "comments/analysis/job", object{"jobId": jobID})
	if job["status"] != "canceled" {
		t.Fatalf("cancellation overwritten: %v", job)
	}
}
