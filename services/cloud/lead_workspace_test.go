package main

import "testing"

func TestWorkspaceHistoryAndSavedReview(t *testing.T) {
	f, job := analysisFixture(t)
	analysisRun(t, f, job)
	call := func(op string, in object) object {
		if op != "accounts" && op != "save-review" {
			in["accountId"] = f.scope.AccountID
		}
		return mustCollection(t, f.server, f.actor, "lead/workspace/"+op, in)
	}
	accounts := rows(call("accounts", object{})["items"])
	if len(accounts) != 1 || accounts[0].(object)["id"] != f.scope.AccountID {
		t.Fatal(accounts)
	}
	works := rows(call("works", object{})["items"])
	if len(works) != 1 || works[0].(object)["readCount"] != float64(2) || works[0].(object)["commentCount"] != float64(2) {
		t.Fatal(works)
	}
	first := call("comments", object{"limit": 1})
	next := call("comments", object{"cursor": first["nextCursor"]})
	if len(rows(next["items"])) != 1 || rows(first["items"])[0].(object)["id"] == rows(next["items"])[0].(object)["id"] {
		t.Fatal(first, next)
	}
	leads := rows(call("leads", object{"search": "甲"})["items"])
	if len(leads) != 1 {
		t.Fatal(leads)
	}
	lead := leads[0].(object)
	analysis := lead["id"]
	if lead["jobId"] != job || lead["commentText"] != "想在上海买房" || lead["canContact"] != true || lead["manualDraft"] != nil {
		t.Fatal(lead)
	}
	jobs := rows(call("jobs", object{})["items"])
	if len(jobs) != 1 || jobs[0].(object)["id"] != job || jobs[0].(object)["criteria"] != "只找上海购房客户" {
		t.Fatal(jobs)
	}
	call("save-review", object{"analysisId": analysis, "draft": "手写草稿", "skipped": true})
	if _, err := collectionCall(f.server, f.actor, "outreach/submit", object{"analysisId": analysis, "draft": "手写草稿", "requestKey": id()}); err == nil {
		t.Fatal("skipped lead accepted an outreach task")
	}
	skipped := rows(call("leads", object{"status": "skipped"})["items"])
	if len(skipped) != 1 || skipped[0].(object)["manualDraft"] != "手写草稿" {
		t.Fatal(skipped)
	}
	call("save-review", object{"analysisId": analysis, "skipped": false})
	task := mustCollection(t, f.server, f.actor, "outreach/submit", object{"analysisId": analysis, "draft": "手写草稿", "requestKey": id()})
	if _, err := f.db.Exec(`UPDATE keagent_outreach_tasks SET status='sent',method='browser' WHERE id=$1`, task["id"]); err != nil {
		t.Fatal(err)
	}
	receipt := rows(call("outreach", object{"status": "uncertain"})["items"])
	if len(receipt) != 1 || receipt[0].(object)["status"] != "sent" || receipt[0].(object)["commenterName"] != "甲" {
		t.Fatal(receipt)
	}
	overview := call("overview", object{})
	if overview["pending"] != float64(1) || overview["uncertain"] != float64(1) {
		t.Fatal(overview)
	}
	if got := rows(call("leads", object{})["items"]); len(got) != 2 {
		t.Fatal("all leads, including old dispatched results", got)
	}
	outside := mustCollection(t, f.server, f.actor, "lead/workspace/comments", object{"accountId": id()})
	if len(rows(outside["items"])) != 0 {
		t.Fatal(outside)
	}
	mustCollection(t, f.server, f.actor, "lead/consent/revoke", f.request(object{}))
	if got := rows(call("comments", object{})["items"]); len(got) != 0 {
		t.Fatal("revoked comment leaked", got)
	}
	if got := rows(call("leads", object{})["items"]); len(got) != 0 {
		t.Fatal("revoked analysis leaked", got)
	}
	if got := rows(call("works", object{})["items"]); len(got) != 1 || got[0].(object)["sourceState"] != "revoked" {
		t.Fatal(got)
	}
}
