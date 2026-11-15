package main

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
)

func TestLeadDraftFailureRetryAndManualContact(t *testing.T) {
	f := analysisScenario(t)
	analysisImport(t, f, analysisComments()[:1])
	jobID := analysisStart(t, f)
	var judgments, drafts int
	f.server.leadComplete = func(ctx context.Context, content any, prompt string) (string, error) {
		var payload object
		if err := json.Unmarshal([]byte(content.(string)), &payload); err != nil || payload["manual_contact_allowed"] != true || payload["ai_analysis_allowed"] != true {
			t.Errorf("missing explicit authorization: %v", payload)
		}
		if prompt == leadAnalysisPrompt {
			judgments++
			return `{"intent":"buy","qualified":true,"evidence":"想在上海买房","reason":"明确购房"}`, nil
		}
		if prompt != leadDraftPrompt {
			t.Errorf("unexpected prompt")
		}
		drafts++
		if drafts == 1 {
			return "", errors.New("draft provider failed")
		}
		if drafts == 2 {
			return `{"draft":42}`, nil
		}
		return `{"draft":"请问您主要考虑哪个区域？"}`, nil
	}
	analysisRun(t, f, jobID)
	status := mustCollection(t, f.server, f.actor, "comments/analysis/job", object{"jobId": jobID})
	if status["qualified"] != float64(1) || status["failed"] != float64(0) || status["status"] != "done" {
		t.Fatal(status)
	}
	list := mustCollection(t, f.server, f.actor, "comments/analysis/list", object{"jobId": jobID, "qualified": true})
	row := obj(rows(list["items"])[0])
	if row["draftError"] == "" || row["draft"] != "" || row["reason"] != "明确购房" {
		t.Fatal(row)
	}
	input := object{"analysisId": row["id"]}
	other := f.actor
	other.DeviceID = "other-device"
	_, err := collectionCall(f.server, other, "comments/analysis/retry-draft", input)
	expectExchangeStatus(t, err, 404)
	_, err = collectionCall(f.server, f.actor, "comments/analysis/retry-draft", input)
	expectExchangeStatus(t, err, 502)
	for range 2 {
		result := mustCollection(t, f.server, f.actor, "comments/analysis/retry-draft", input)
		if result["draft"] != "请问您主要考虑哪个区域？" {
			t.Fatal(result)
		}
	}
	if judgments != 1 || drafts != 3 {
		t.Fatalf("judgments=%d drafts=%d", judgments, drafts)
	}
	list = mustCollection(t, f.server, f.actor, "comments/analysis/list", object{"jobId": jobID, "qualified": true})
	row = obj(rows(list["items"])[0])
	if row["draftError"] != "" || row["reason"] != "明确购房" || row["evidence"] != "想在上海买房" {
		t.Fatal(row)
	}
}

func TestLeadDraftLegacyRecovery(t *testing.T) {
	f, jobID := analysisFixture(t)
	analysisRun(t, f, jobID)
	_, err := f.db.Exec(`UPDATE keagent_comment_analyses SET status='failed',qualified=false,intent='',reason='',evidence='',draft='',
 error=CASE WHEN comment_id='c1' THEN '模型没有返回可核对的私信草稿' ELSE '模型返回的结构无效' END WHERE job_id=$1`, jobID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.db.Exec(`UPDATE keagent_comment_analysis_jobs SET status='partial',failed=2,qualified=0 WHERE id=$1`, jobID)
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if _, err = f.db.Exec(leadSchema); err != nil {
			t.Fatal(err)
		}
	}
	status := mustCollection(t, f.server, f.actor, "comments/analysis/job", object{"jobId": jobID})
	if status["qualified"] != float64(1) || status["failed"] != float64(1) || status["processed"] != float64(2) || status["status"] != "partial" {
		t.Fatal(status)
	}
	list := mustCollection(t, f.server, f.actor, "comments/analysis/list", object{"jobId": jobID, "qualified": true})
	row := obj(rows(list["items"])[0])
	if row["commentId"] != "c1" || row["reason"] != "" || row["draftError"] == "" {
		t.Fatal(row)
	}
	f.server.leadComplete = func(context.Context, any, string) (string, error) {
		t.Error("manual draft triggered a model call")
		return "", nil
	}
	result := mustCollection(t, f.server, f.actor, "outreach/submit", object{"analysisId": row["id"], "requestKey": id(), "draft": "您好，方便聊聊区域吗？"})
	if result["status"] != "approved" {
		t.Fatal(result)
	}
	_, err = collectionCall(f.server, f.actor, "comments/analysis/retry-draft", object{"analysisId": row["id"]})
	expectExchangeStatus(t, err, 409)
}

func TestLeadDraftRecoveryAboveOriginalLimit(t *testing.T) {
	f, jobID := analysisFixture(t)
	analysisRun(t, f, jobID)
	if _, err := f.db.Exec(`UPDATE keagent_comment_analyses SET status='failed',qualified=false,draft='',
		error='模型没有返回可核对的私信草稿' WHERE job_id=$1`, jobID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec(`UPDATE keagent_comment_analysis_jobs SET status='partial',
		total=1,processed=2,failed=2,qualified=0 WHERE id=$1`, jobID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec(leadSchema); err != nil {
		t.Fatal(err)
	}
	job := mustCollection(t, f.server, f.actor, "comments/analysis/job", object{"jobId": jobID})
	if job["status"] != "done" || job["qualified"] != float64(2) || job["failed"] != float64(0) || job["processed"] != float64(2) {
		t.Fatal(job)
	}
}

func TestLeadDraftRevokedDuringGeneration(t *testing.T) {
	f, jobID := analysisFixture(t)
	var calls int
	f.server.leadComplete = func(ctx context.Context, content any, prompt string) (string, error) {
		if prompt == leadDraftPrompt {
			return "", errors.New("initial draft failed")
		}
		return analysisOK(ctx, content, prompt)
	}
	analysisRun(t, f, jobID)
	list := mustCollection(t, f.server, f.actor, "comments/analysis/list", object{"jobId": jobID})
	row := obj(rows(list["items"])[0])
	f.server.leadComplete = func(ctx context.Context, content any, prompt string) (string, error) {
		calls++
		mustCollection(t, f.server, f.actor, "creatorhub/consent/revoke", object{"accountId": f.scope.AccountID, "workId": f.scope.WorkID})
		return `{"draft":"不应保存"}`, nil
	}
	_, err := collectionCall(f.server, f.actor, "comments/analysis/retry-draft", object{"analysisId": row["id"]})
	if err == nil || calls != 1 {
		t.Fatal("retry accepted after revocation", err, calls)
	}
	var draft string
	if err = f.db.QueryRow(`SELECT draft FROM keagent_comment_analyses WHERE id=$1`, row["id"]).Scan(&draft); err != nil || draft != "" {
		t.Fatal(draft, err)
	}
}
