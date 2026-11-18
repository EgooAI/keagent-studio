package main

import (
	"net/url"
	"testing"
)

func TestCreditActivityTaskSettlement(t *testing.T) {
	s := creditTestServer(t)
	grantForTest(t, s, "u1", creditKindPurchased, 100, 0)
	grantForTest(t, s, "u2", creditKindPurchased, 100, 0)
	input := object{
		"text": "房源介绍",
		"billingContext": object{
			"taskId": "video-1", "batchId": "batch-1", "estimatedCredits": 15, "estimateVersion": "v3",
		},
	}
	ctx, err := withBillingTask(t.Context(), input, "tts")
	if err != nil {
		t.Fatal(err)
	}
	if _, included := input["billingContext"]; included {
		t.Fatal("billing context was left in the provider request")
	}
	reference, metadata := creditChargeDetails(ctx, "", "kilo_char", 2, 10)
	metadata["characters"] = 1500
	createHold := func(owner, key string) string {
		t.Helper()
		hold, err := s.holdCredits(ctx, owner, "tts", reference, 20, key, "v4", metadata)
		if err != nil {
			t.Fatal(err)
		}
		return hold.ID
	}
	paidID := createHold("u1", "pay-part")
	if err = s.captureHold(ctx, paidID, 10); err != nil {
		t.Fatal(err)
	}
	returnedID := createHold("u1", "return")
	if err = s.releaseHoldWithReason(ctx, returnedID, "operation_failed"); err != nil {
		t.Fatal(err)
	}
	createHold("u1", "still-held")
	createHold("u2", "other-owner")
	if _, err = s.holdCredits(ctx, "u1", "voice_clone", "elsewhere", 1, "legacy", "v2", nil); err != nil {
		t.Fatal(err)
	}

	result, err := s.creditActivity(ctx, "u1", url.Values{"taskId": {"video-1"}, "batchId": {"batch-1"}})
	if err != nil {
		t.Fatal(err)
	}
	activity := result.(object)
	items := activity["items"].([]creditActivityItem)
	if len(items) != 3 || activity["totalSpent"] != int64(10) || activity["hasMore"] != false || activity["estimate"].(object)["version"] != "v3" {
		t.Fatalf("unexpected activity: %#v", activity)
	}
	for _, item := range items {
		if item.TaskID != "video-1" || item.BatchID != "batch-1" || item.Stage != "tts" || item.PriceVersion != "v4" || item.Characters == nil || *item.Characters != 1500 {
			t.Fatalf("missing invoice details: %+v", item)
		}
		switch item.ID {
		case paidID:
			if item.State != creditStateCaptured || item.Spent != 10 || item.Released != 10 || item.ReleaseReason != "unused" {
				t.Fatalf("unexpected partial settlement: %+v", item)
			}
		case returnedID:
			if item.State != creditStateReleased || item.Released != 20 || item.Spent != 0 || item.ReleaseReason != "operation_failed" {
				t.Fatalf("unexpected release: %+v", item)
			}
		default:
			if item.State != creditStateHeld || item.Held != 20 || item.Spent != 0 {
				t.Fatalf("unexpected hold: %+v", item)
			}
		}
	}
}

func TestCreditActivityLegacyAndPagination(t *testing.T) {
	s := creditTestServer(t)
	grantForTest(t, s, "u1", creditKindPurchased, 100, 0)
	ctx := t.Context()
	hold, err := s.holdCredits(ctx, "u1", "script", "", 1, "historical", "v1", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.captureHold(ctx, hold.ID, 0); err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.ExecContext(ctx, `
INSERT INTO keagent_credit_hold(id,owner_id,op,amount,state,allocation,idem_key)
SELECT 'page-' || k, 'u1', 'script', 1, 'released', '[]'::jsonb, 'page-' || k
FROM generate_series(1, 20) AS k`); err != nil {
		t.Fatal(err)
	}
	first, err := s.creditActivity(ctx, "u1", nil)
	if err != nil {
		t.Fatal(err)
	}
	if page := first.(object); len(page["items"].([]creditActivityItem)) != 20 || page["hasMore"] != true {
		t.Fatalf("unexpected first page: %+v", page)
	}
	second, err := s.creditActivity(ctx, "u1", url.Values{"page": {"2"}})
	if err != nil {
		t.Fatal(err)
	}
	page := second.(object)
	entries := page["items"].([]creditActivityItem)
	if len(entries) != 1 || page["hasMore"] != false || entries[0].ID != hold.ID || entries[0].TaskID != "" || entries[0].Spent != 0 {
		t.Fatalf("unexpected second page: %+v", page)
	}
}
