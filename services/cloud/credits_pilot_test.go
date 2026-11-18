package main

import (
	"testing"
)

func TestCreditPilotPackOffersAndRedemption(t *testing.T) {
	s := creditTestServer(t)
	ctx := t.Context()
	admin := actor{UserID: "pilot-admin"}
	price := int64(990)
	pilot := creditPilot{
		Instructions:        "联系试点运营领取兑换码",
		TypicalVideoCredits: 150,
		Packs: []creditPack{
			{ID: "starter", Enabled: true, Credits: 300, PriceFen: &price},
			{ID: "regular", Credits: 1500},
		},
	}
	if _, err := s.updateCreditPilot(ctx, admin, mustJSON(pilot)); err != nil {
		t.Fatal(err)
	}
	out, err := s.creditPackOffers(ctx)
	if err != nil {
		t.Fatal(err)
	}
	public := out.(creditPilot)
	if len(public.Packs) != 1 || public.Packs[0].ID != "starter" || public.TypicalVideoCredits != 150 {
		t.Fatalf("public pilot = %+v", public)
	}

	issue := func(packID string, count float64) object {
		t.Helper()
		result, err := s.adminCreditCodesCreate(ctx, admin, object{"packId": packID, "amount": float64(1), "count": count})
		if err != nil {
			t.Fatal(err)
		}
		return result.(object)
	}
	if _, err = s.adminCreditCodesCreate(ctx, admin, object{"packId": "regular", "count": float64(1)}); err == nil {
		t.Fatal("issued disabled pack")
	}
	starter := issue("starter", 2)
	var snapshottedPrice int64
	if err = s.db.QueryRowContext(ctx, `SELECT price_fen FROM keagent_credit_pack_batch WHERE batch_id=$1`, starter["batchId"]).Scan(&snapshottedPrice); err != nil || snapshottedPrice != price {
		t.Fatalf("batch price = %d, %v", snapshottedPrice, err)
	}

	pilot.Packs[0].Enabled = false
	pilot.Packs[1].Enabled = true
	if _, err = s.updateCreditPilot(ctx, admin, mustJSON(pilot)); err != nil {
		t.Fatal(err)
	}
	regular := issue("regular", 1)
	redeem := func(code string, credits int64) {
		t.Helper()
		result, err := s.redeemCreditCode(ctx, "pilot-buyer", code)
		if err != nil || result["amount"] != credits {
			t.Fatalf("redemption = %v, %v", result, err)
		}
	}
	redeem(starter["codes"].([]string)[0], 300)
	redeem(regular["codes"].([]string)[0], 1500)
	out, err = s.creditPackStatistics(ctx)
	if err != nil {
		t.Fatal(err)
	}
	stats := out.([]creditPackStats)
	wantStarter := creditPackStats{ID: "starter", Issued: 2, Redeemed: 1, FirstRedeemers: 1}
	wantRegular := creditPackStats{ID: "regular", Issued: 1, Redeemed: 1, ReturningRedeemers: 1}
	if len(stats) != 2 || stats[0] != wantStarter || stats[1] != wantRegular {
		t.Fatalf("stats = %+v", stats)
	}
}

func TestCreditPilotQuoteStatsUsesSettledAllocation(t *testing.T) {
	s := creditTestServer(t)
	ctx := t.Context()
	grantForTest(t, s, "quoted-owner", creditKindPurchased, 100, 0)
	meta := object{"stage": "tts", "estimatedCredits": int64(15), "estimateVersion": "v1"}
	hold, err := s.holdCredits(ctx, "quoted-owner", "tts", "task-1", 20, "q-1", "v1", meta)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.captureHold(ctx, hold.ID, 12); err != nil {
		t.Fatal(err)
	}
	hold, err = s.holdCredits(ctx, "quoted-owner", "script", "task-1", 7, "q-2", "v1", object{"stage": "script"})
	if err != nil {
		t.Fatal(err)
	}
	if err = s.captureHold(ctx, hold.ID, 7); err != nil {
		t.Fatal(err)
	}
	out, err := s.creditPilotQuoteStats(ctx)
	if err != nil {
		t.Fatal(err)
	}
	got := out.(object)
	if got["sample"] != int64(1) || got["aboveEstimate"] != int64(1) ||
		got["averageEstimate"] != float64(15) || got["averageSettled"] != float64(19) ||
		got["meanAbsoluteDifference"] != float64(4) {
		t.Fatalf("quote stats = %v", got)
	}
}
