package main

import (
	"context"
	"errors"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func setTrialLimits(t *testing.T, s *server, body string) {
	t.Helper()
	request := httptest.NewRequest("POST", "/v1/admin/credits/lead-trial", nil)
	if _, err := s.adminLeadTrial(request, actor{UserID: "admin"}, []byte(body)); err != nil {
		t.Fatal(err)
	}
}

func TestLeadTrialAccountLimitAndConcurrentConsumers(t *testing.T) {
	s := creditTestServer(t)
	if _, err := s.db.Exec(leadTrialSchema); err != nil {
		t.Fatal(err)
	}
	ctx := t.Context()
	setTrialLimits(t, s, `{"analysisLimit":3,"draftLimit":0}`)
	if _, err := s.db.Exec(`INSERT INTO keagent_lead_trial_usage VALUES('owner',` + leadTrialDay + `-1,'analysis',900)`); err != nil {
		t.Fatal(err)
	}
	var allowed atomic.Int32
	var wg sync.WaitGroup
	for range 10 {
		wg.Go(func() {
			err := s.consumeLeadTrial(ctx, "owner", leadTrialAnalysis)
			if err == nil {
				allowed.Add(1)
				return
			}
			var quota exchangeFault
			if !errors.As(err, &quota) || quota.code != "LEAD_TRIAL_EXHAUSTED" {
				t.Errorf("unexpected consumption error: %v", err)
			}
		})
	}
	wg.Wait()
	if allowed.Load() != 3 {
		t.Fatalf("allowed %d concurrent requests, want 3", allowed.Load())
	}
	trial, err := s.leadTrialStatus(ctx, s.db, "owner")
	if err != nil || trial.Analysis != (leadTrialBalance{Limit: 3, Used: 3, Remaining: 0}) ||
		trial.Draft != (leadTrialBalance{}) || !trial.ResetsAt.After(time.Now()) {
		t.Fatalf("wrong trial status: %+v %v", trial, err)
	}
	if err := s.consumeLeadTrial(ctx, "different-owner", leadTrialAnalysis); err != nil {
		t.Fatalf("owner blocked by someone else's quota: %v", err)
	}
	if err := s.consumeLeadTrial(ctx, "different-owner", leadTrialDraft); err == nil {
		t.Fatal("zero draft limit was ignored")
	}
	if draft, err := s.allowLegacyLeadDraft(ctx, "different-owner", true); err != nil || draft {
		t.Fatalf("legacy analysis should proceed without a draft: %t %v", draft, err)
	}
}

func TestLeadTrialBatchAndDraftUseIndependentQuotas(t *testing.T) {
	f, jobID := analysisFixture(t)
	setTrialLimits(t, f.server, `{"analysisLimit":1,"draftLimit":0}`)
	_, err := collectionCall(f.server, f.actor, "comments/analyze-batch", object{
		"accountId": f.scope.AccountID, "workId": f.scope.WorkID, "requestKey": id(),
	})
	expectExchangeStatus(t, err, 429)
	var analyses, drafts atomic.Int32
	f.server.leadComplete = func(ctx context.Context, content any, prompt string) (string, error) {
		if prompt == leadDraftPrompt {
			drafts.Add(1)
		} else {
			analyses.Add(1)
		}
		return analysisOK(ctx, content, prompt)
	}
	analysisRun(t, f, jobID)
	if analyses.Load() != 1 || drafts.Load() != 0 {
		t.Fatalf("model called for %d analyses and %d drafts", analyses.Load(), drafts.Load())
	}
	list := mustCollection(t, f.server, f.actor, "comments/analysis/list", object{"jobId": jobID, "qualified": true})
	if len(rows(list["items"])) != 1 {
		t.Fatalf("qualified comment should remain reviewable: %v", list)
	}
	analysisID := obj(rows(list["items"])[0])["id"]
	_, err = collectionCall(f.server, f.actor, "comments/analysis/retry-draft", object{"analysisId": analysisID})
	expectExchangeStatus(t, err, 429)
	_, err = collectionCall(f.server, f.actor, "comments/analysis/retry", object{"jobId": jobID})
	expectExchangeStatus(t, err, 429)
	setTrialLimits(t, f.server, `{"analysisLimit":1,"draftLimit":1}`)
	for range 2 {
		mustCollection(t, f.server, f.actor, "comments/analysis/retry-draft", object{"analysisId": analysisID})
	}
	if drafts.Load() != 1 {
		t.Fatalf("retrying a saved draft should not use additional quota, model calls: %d", drafts.Load())
	}
}
