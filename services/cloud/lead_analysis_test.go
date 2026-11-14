package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
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
	conflict := object{
		"accountId": f.scope.AccountID, "workId": f.scope.WorkID,
		"criteria": "只找北京购房客户", "maxComments": 10, "requestKey": key,
	}
	if _, err := collectionCall(f.server, f.actor, "comments/analyze-batch", conflict); err == nil {
		t.Fatal("conflicting payload reused the request key")
	} else {
		var e exchangeFault
		if !errors.As(err, &e) || e.code != "REQUEST_CONFLICT" {
			t.Fatalf("expected REQUEST_CONFLICT, got %v", err)
		}
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

func TestAnalysisJobSameCriteriaRunsAgain(t *testing.T) {
	f, first := analysisFixture(t)
	analysisRun(t, f, first)
	second := analysisStart(t, f)
	analysisRun(t, f, second)
	job := mustCollection(t, f.server, f.actor, "comments/analysis/job", object{"jobId": second})
	if job["status"] != "done" || job["processed"] != float64(2) {
		t.Fatalf("second job did not analyze again: %v", job)
	}
	list := mustCollection(t, f.server, f.actor, "comments/analysis/list", object{"jobId": second, "limit": 10})
	if len(rows(list["items"])) != 2 {
		t.Fatalf("second job list: %v", list)
	}
}

func TestAnalysisJobDedupesBeforeLimit(t *testing.T) {
	f := analysisScenario(t)
	analysisImport(t, f, []object{
		{"comment_id": "c1", "comment_text": "想在上海买房", "commenter_profile": "https://www.douyin.com/user/secB",
			"comment_time": "2026-01-01T00:00:00Z"},
		{"comment_id": "c2", "comment_text": "想在上海买房", "commenter_profile": "https://www.douyin.com/user/secA",
			"comment_time": "2026-01-02T00:00:00Z"},
		{"comment_id": "c3", "comment_text": "想在上海买房", "commenter_profile": "https://www.douyin.com/user/secA",
			"comment_time": "2026-01-03T00:00:00Z"},
	})
	f.server.leadComplete = analysisOK
	jobID := analysisStart(t, f)
	job := mustCollection(t, f.server, f.actor, "comments/analysis/job", object{"jobId": jobID})
	if job["total"] != float64(2) {
		t.Fatalf("deduped total: %v", job)
	}
	analysisRun(t, f, jobID)
	job = mustCollection(t, f.server, f.actor, "comments/analysis/job", object{"jobId": jobID})
	if job["processed"] != float64(2) || job["status"] != "done" {
		t.Fatalf("dedupe-before-limit job: %v", job)
	}
	list := mustCollection(t, f.server, f.actor, "comments/analysis/list", object{"jobId": jobID, "limit": 10})
	profiles := map[string]bool{}
	for _, item := range rows(list["items"]) {
		profile, _ := item.(object)["commenterProfile"].(string)
		profiles[profile] = true
	}
	if len(rows(list["items"])) != 2 || !profiles["https://www.douyin.com/user/secA"] ||
		!profiles["https://www.douyin.com/user/secB"] {
		t.Fatalf("distinct commenter hidden by limit: %v", list)
	}
}

func TestAnalysisJobRejectsCommentChangeAfterModel(t *testing.T) {
	f := analysisScenario(t)
	analysisImport(t, f, []object{
		{"comment_id": "c1", "comment_text": "想在上海买房", "commenter_name": "甲"},
	})
	jobID := analysisStart(t, f)
	f.server.leadComplete = func(ctx context.Context, content any, prompt string) (string, error) {
		if _, err := f.db.Exec(`UPDATE keagent_comment_observations o
			SET fields=jsonb_set(o.fields,'{comment_text}','"评论已更新"')
			WHERE o.source_id=(SELECT j.source_id FROM keagent_comment_analysis_jobs j WHERE j.id=$1)`, jobID); err != nil {
			return "", err
		}
		return analysisOK(ctx, content, prompt)
	}
	analysisRun(t, f, jobID)
	var status, errText, draft string
	var qualified bool
	if err := f.db.QueryRow(`SELECT status,error,qualified,draft FROM keagent_comment_analyses
		WHERE job_id=$1`, jobID).Scan(&status, &errText, &qualified, &draft); err != nil {
		t.Fatal(err)
	}
	if status != "failed" || qualified || draft != "" || !strings.Contains(errText, "评论或授权已更新") {
		t.Fatalf("comment change not rejected: status=%s error=%q qualified=%v draft=%q",
			status, errText, qualified, draft)
	}
}

func failedAnalysisJob(t *testing.T) (*commentScenario, string, []string) {
	t.Helper()
	f := analysisScenario(t)
	analysisImport(t, f, analysisComments())
	f.server.leadComplete = func(context.Context, any, string) (string, error) {
		return "", errors.New("模型失败")
	}
	jobID := analysisStart(t, f)
	analysisRun(t, f, jobID)
	list := mustCollection(t, f.server, f.actor, "comments/analysis/list", object{"jobId": jobID, "limit": 10})
	items := rows(list["items"])
	if len(items) != 2 {
		t.Fatalf("expected two failed analyses: %v", list)
	}
	ids := make([]string, 0, len(items))
	for _, item := range items {
		ids = append(ids, obj(item)["id"].(string))
	}
	return f, jobID, ids
}

func TestAnalysisRetryAllWhenSelectionOmitted(t *testing.T) {
	f, jobID, _ := failedAnalysisJob(t)
	job := mustCollection(t, f.server, f.actor, "comments/analysis/retry", object{"jobId": jobID})
	if job["status"] != "queued" {
		t.Fatalf("retry-all did not requeue: %v", job)
	}
	var remaining int
	if err := f.db.QueryRow(`SELECT count(*) FROM keagent_comment_analyses WHERE job_id=$1`,
		jobID).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining != 0 {
		t.Fatalf("retry-all kept failed analyses: %d", remaining)
	}
}

func TestAnalysisRetrySelectedFailures(t *testing.T) {
	f, jobID, ids := failedAnalysisJob(t)
	job := mustCollection(t, f.server, f.actor, "comments/analysis/retry", object{
		"jobId": jobID, "analysisIds": []string{ids[0]},
	})
	if job["status"] != "queued" {
		t.Fatalf("selected retry did not requeue: %v", job)
	}
	var remaining []string
	rs, err := f.db.Query(`SELECT id FROM keagent_comment_analyses WHERE job_id=$1`, jobID)
	if err != nil {
		t.Fatal(err)
	}
	defer rs.Close()
	for rs.Next() {
		var analysisID string
		if err = rs.Scan(&analysisID); err != nil {
			t.Fatal(err)
		}
		remaining = append(remaining, analysisID)
	}
	if len(remaining) != 1 || remaining[0] != ids[1] {
		t.Fatalf("selected retry touched other analyses: %v", remaining)
	}
}

func TestAnalysisRetryRejectsUnknownSelection(t *testing.T) {
	f, jobID, _ := failedAnalysisJob(t)
	_, err := collectionCall(f.server, f.actor, "comments/analysis/retry", object{
		"jobId": jobID, "analysisIds": []string{id()},
	})
	expectExchangeStatus(t, err, 409)
	var remaining int
	if err = f.db.QueryRow(`SELECT count(*) FROM keagent_comment_analyses WHERE job_id=$1`,
		jobID).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining != 2 {
		t.Fatalf("unknown selection deleted analyses: %d", remaining)
	}
	job := mustCollection(t, f.server, f.actor, "comments/analysis/job", object{"jobId": jobID})
	if job["status"] != "partial" {
		t.Fatalf("unknown selection changed the job: %v", job)
	}
}

func TestAnalysisListFiltersByIntent(t *testing.T) {
	f := analysisScenario(t)
	analysisImport(t, f, []object{
		{"comment_id": "c1", "comment_text": "想在上海买房", "commenter_profile": "https://www.douyin.com/user/sec1"},
		{"comment_id": "c2", "comment_text": "想在上海租房", "commenter_profile": "https://www.douyin.com/user/sec2"},
	})
	f.server.leadComplete = func(_ context.Context, content any, _ string) (string, error) {
		if strings.Contains(content.(string), "租房") {
			return `{"intent":"rent","evidence":"想在上海租房","qualified":true,"reason":"明确租房需求","draft":"您好"}`, nil
		}
		return `{"intent":"buy","evidence":"想在上海买房","qualified":true,"reason":"明确购房需求","draft":"您好"}`, nil
	}
	jobID := analysisStart(t, f)
	analysisRun(t, f, jobID)
	buy := mustCollection(t, f.server, f.actor, "comments/analysis/list", object{
		"jobId": jobID, "intent": "buy", "limit": 10,
	})
	buyItems := rows(buy["items"])
	if len(buyItems) != 1 || obj(buyItems[0])["intent"] != "buy" {
		t.Fatalf("intent filter returned wrong rows: %v", buy)
	}
	rent := mustCollection(t, f.server, f.actor, "comments/analysis/list", object{
		"jobId": jobID, "intent": "rent", "limit": 10,
	})
	rentItems := rows(rent["items"])
	if len(rentItems) != 1 || obj(rentItems[0])["intent"] != "rent" {
		t.Fatalf("intent filter returned wrong rows: %v", rent)
	}
	_, err := collectionCall(f.server, f.actor, "comments/analysis/list", object{
		"jobId": jobID, "intent": "bogus",
	})
	expectExchangeStatus(t, err, 422)
}

func TestAnalysisListCursorPaging(t *testing.T) {
	f := analysisScenario(t)
	analysisImport(t, f, []object{
		{"comment_id": "c1", "comment_text": "想在上海买房", "commenter_profile": "https://www.douyin.com/user/sec1"},
		{"comment_id": "c2", "comment_text": "想在上海买房", "commenter_profile": "https://www.douyin.com/user/sec2"},
		{"comment_id": "c3", "comment_text": "想在上海买房", "commenter_profile": "https://www.douyin.com/user/sec3"},
	})
	f.server.leadComplete = analysisOK
	jobID := analysisStart(t, f)
	analysisRun(t, f, jobID)
	first := mustCollection(t, f.server, f.actor, "comments/analysis/list", object{
		"jobId": jobID, "limit": 2,
	})
	firstItems := rows(first["items"])
	if len(firstItems) != 2 || first["hasMore"] != true {
		t.Fatalf("first page: %v", first)
	}
	cursor, _ := first["nextCursor"].(string)
	if cursor == "" {
		t.Fatalf("first page missing nextCursor: %v", first)
	}
	second := mustCollection(t, f.server, f.actor, "comments/analysis/list", object{
		"jobId": jobID, "limit": 2, "cursor": cursor,
	})
	secondItems := rows(second["items"])
	if len(secondItems) != 1 || second["hasMore"] != false || second["nextCursor"] != nil {
		t.Fatalf("second page: %v", second)
	}
	seen := map[string]bool{}
	order := []string{}
	for _, item := range append(firstItems, secondItems...) {
		analysisID := obj(item)["id"].(string)
		if seen[analysisID] {
			t.Fatalf("cursor paging repeated %s", analysisID)
		}
		seen[analysisID] = true
		order = append(order, analysisID)
	}
	if len(order) != 3 {
		t.Fatalf("cursor paging lost rows: %v", order)
	}
	stable := mustCollection(t, f.server, f.actor, "comments/analysis/list", object{
		"jobId": jobID, "limit": 2,
	})
	stableItems := rows(stable["items"])
	for index, item := range stableItems {
		if obj(item)["id"] != obj(firstItems[index])["id"] {
			t.Fatalf("cursor paging order changed: %v", stable)
		}
	}
}

func TestAnalyzeBatchRespondsAccepted(t *testing.T) {
	f := analysisScenario(t)
	analysisImport(t, f, analysisComments())
	f.server.leadComplete = analysisOK
	body, err := json.Marshal(object{
		"accountId": f.scope.AccountID, "workId": f.scope.WorkID,
		"criteria": "只找上海购房客户", "maxComments": 10, "requestKey": id(),
	})
	if err != nil {
		t.Fatal(err)
	}
	value, err := f.server.leadAnalysis(context.Background(), f.actor, "comments/analyze-batch", body)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := value.(accepted); !ok {
		t.Fatalf("analyze-batch did not mark the response accepted: %T", value)
	}
	w := httptest.NewRecorder()
	respond(w, value, nil)
	if w.Code != http.StatusAccepted {
		t.Fatalf("analyze-batch status = %d, want 202", w.Code)
	}
	var payload object
	if err = json.Unmarshal(w.Body.Bytes(), &payload); err != nil || payload["id"] == nil {
		t.Fatalf("accepted body: %v %v", payload, err)
	}
}

func analysisCommentText(t *testing.T, f *commentScenario, analysisID string) string {
	t.Helper()
	var text string
	if err := f.db.QueryRow(`SELECT o.fields->>'comment_text'
		FROM keagent_comment_analyses a
		JOIN keagent_comment_observations o ON o.id=a.comment_row_id
		WHERE a.id=$1`, analysisID).Scan(&text); err != nil {
		t.Fatal(err)
	}
	return text
}

func TestAnalysisRetryRunsOnlySelectedFailure(t *testing.T) {
	f, jobID, ids := failedAnalysisJob(t)
	selected := analysisCommentText(t, f, ids[0])
	var mu sync.Mutex
	var analyzed []string
	f.server.leadComplete = func(_ context.Context, content any, _ string) (string, error) {
		var payload struct {
			CommentText string `json:"comment_text"`
		}
		_ = json.Unmarshal([]byte(content.(string)), &payload)
		mu.Lock()
		analyzed = append(analyzed, payload.CommentText)
		mu.Unlock()
		return analysisOK(context.Background(), content, "")
	}
	mustCollection(t, f.server, f.actor, "comments/analysis/retry", object{
		"jobId": jobID, "analysisIds": []string{ids[0]},
	})
	analysisRun(t, f, jobID)
	mu.Lock()
	defer mu.Unlock()
	if len(analyzed) != 1 || analyzed[0] != selected {
		t.Fatalf("selected retry analyzed %v, want only %q", analyzed, selected)
	}
}

func TestAnalysisRetryAllRunsEveryFailure(t *testing.T) {
	f, jobID, ids := failedAnalysisJob(t)
	expected := map[string]bool{}
	for _, analysisID := range ids {
		expected[analysisCommentText(t, f, analysisID)] = true
	}
	var mu sync.Mutex
	var analyzed []string
	f.server.leadComplete = func(_ context.Context, content any, _ string) (string, error) {
		var payload struct {
			CommentText string `json:"comment_text"`
		}
		_ = json.Unmarshal([]byte(content.(string)), &payload)
		mu.Lock()
		analyzed = append(analyzed, payload.CommentText)
		mu.Unlock()
		return analysisOK(context.Background(), content, "")
	}
	mustCollection(t, f.server, f.actor, "comments/analysis/retry", object{"jobId": jobID})
	analysisRun(t, f, jobID)
	mu.Lock()
	defer mu.Unlock()
	if len(analyzed) != 2 {
		t.Fatalf("retry-all analyzed %v, want both failures", analyzed)
	}
	for _, text := range analyzed {
		if !expected[text] {
			t.Fatalf("retry-all analyzed unexpected comment %q", text)
		}
		delete(expected, text)
	}
	if len(expected) != 0 {
		t.Fatalf("retry-all skipped comments: %v", expected)
	}
}
