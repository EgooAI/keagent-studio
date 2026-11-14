package main

import (
	"context"
	"testing"
	"time"
)

func analysisFixture(t *testing.T) (*commentScenario, string) {
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
	mustCollection(t, f.server, f.actor, "comments/import", object{
		"accountId": f.scope.AccountID, "workId": f.scope.WorkID, "requestKey": id(),
		"snapshotId": id(), "observedAt": time.Now().UTC().Format(time.RFC3339Nano),
		"coverage": "partial",
		"items": []object{
			{"comment_id": "c1", "comment_text": "想在上海买房", "commenter_name": "甲",
				"commenter_profile": "https://www.douyin.com/user/sec1"},
			{"comment_id": "c2", "comment_text": "想在上海买房，预算多少", "commenter_name": "乙",
				"commenter_profile": "https://www.douyin.com/user/sec2"},
		},
	})
	f.server.leadComplete = func(ctx context.Context, content any, prompt string) (string, error) {
		return `{"intent":"buy","evidence":"想在上海买房","qualified":true,"reason":"明确购房需求","draft":"您好，想了解哪个区域？"}`, nil
	}
	job := mustCollection(t, f.server, f.actor, "comments/analyze-batch", object{
		"accountId": f.scope.AccountID, "workId": f.scope.WorkID,
		"criteria": "只找上海购房客户", "maxComments": 10, "requestKey": id(),
	})
	return f, job["id"].(string)
}

func TestAnalysisJobProducesQualifiedRows(t *testing.T) {
	f, jobID := analysisFixture(t)
	f.server.runAnalysisJob(context.Background(), jobID)
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
