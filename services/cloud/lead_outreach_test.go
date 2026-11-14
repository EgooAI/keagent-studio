package main

import (
	"context"
	"testing"
)

func TestOutreachSubmitAndStatusMonotonic(t *testing.T) {
	f, jobID := analysisFixture(t)
	f.server.runAnalysisJob(context.Background(), jobID)
	list := mustCollection(t, f.server, f.actor, "comments/analysis/list", object{"jobId": jobID, "limit": 10})
	var analysis object
	for _, item := range rows(list["items"]) {
		row := obj(item)
		if row["commenterProfile"] != nil {
			analysis = row
			break
		}
	}
	if analysis == nil {
		t.Fatal("no analysis with a commenter profile")
	}
	outreach := mustCollection(t, f.server, f.actor, "outreach/submit", object{
		"analysisId": analysis["id"], "draft": "您好，想了解哪个区域？", "requestKey": id(),
	})
	if outreach["status"] != "approved" {
		t.Fatal(outreach)
	}
	submitted := mustCollection(t, f.server, f.actor, "outreach/result", object{
		"id": outreach["id"], "status": "submitted", "creatorhubTaskId": "42", "method": "browser",
	})
	if submitted["status"] != "submitted" {
		t.Fatal(submitted)
	}
	sent := mustCollection(t, f.server, f.actor, "outreach/result", object{
		"id": outreach["id"], "status": "sent",
	})
	if sent["status"] != "sent" {
		t.Fatal(sent)
	}
	stale := mustCollection(t, f.server, f.actor, "outreach/result", object{
		"id": outreach["id"], "status": "submitted",
	})
	if stale["status"] != "sent" {
		t.Fatal(stale)
	}
}
