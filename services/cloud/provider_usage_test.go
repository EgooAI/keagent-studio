package main

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestProviderUsageCapturesCompletionAndBackfillsRate(t *testing.T) {
	s := &server{db: productionTestDB(t)}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = fmt.Fprint(w, `{"id":"request-1","model":"fixture-model","choices":[{"message":{"content":"文案"}}],
			"usage":{"prompt_tokens":510,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":10}}}`)
	}))
	t.Cleanup(upstream.Close)
	provider := providerHostname(upstream.URL)
	ctx := s.withProviderUsageReference(t.Context(), "owner", "script", "video-1", "batch-1")
	result, err := completionWithContent(ctx, upstream.Client(), upstream.URL, "alias", "not-a-real-key", "input", "prompt")
	if err != nil || result != "文案" {
		t.Fatalf("fixture completion: %q %v", result, err)
	}
	rows := reportProviderTestRows(t, s, url.Values{"batchId": {"batch-1"}})
	if len(rows) != 1 {
		t.Fatalf("usage rows: %#v", rows)
	}
	first := rows[0]
	if first.OwnerID != "owner" || first.TaskID != "video-1" || first.ProviderRef != "request-1" ||
		first.Model != "fixture-model" || first.Status != "succeeded" || first.Source != "provider" ||
		first.CachedInputTokens == nil || *first.CachedInputTokens != 10 || first.CostMicros != nil {
		t.Fatalf("unexpected metering or default cost: %#v", first)
	}
	for _, rate := range []int64{2_400_000, 4_800_000} {
		_, err = s.updateProviderRate(t.Context(), actor{UserID: "admin"}, []byte(fmt.Sprintf(
			`{"provider":%q,"model":"fixture-model","inputMicros":%d,"cachedInputMicros":600000,"outputMicros":8000000}`, provider, rate)))
		if err != nil {
			t.Fatal(err)
		}
	}
	rows = reportProviderTestRows(t, s, url.Values{"taskId": {"video-1"}})
	if len(rows) != 1 || rows[0].CostMicros == nil || *rows[0].CostMicros != 1366 {
		t.Fatalf("backfilled cost should preserve first configured rate: %#v", rows)
	}
}

func TestProviderUsageSpeechAndOpeningAmounts(t *testing.T) {
	s := &server{db: productionTestDB(t)}
	s.speech = func(context.Context, string, object, string) ([]byte, error) {
		return []byte("data: {\"request_id\":\"speech-1\",\"output\":{\"audio\":{\"data\":\"AQIDBA==\"}},\"usage\":{\"characters\":26}}\n\n" +
			"data: {\"request_id\":\"speech-1\",\"output\":{\"finish_reason\":\"stop\"},\"usage\":{\"characters\":35}}\n\n"), nil
	}
	for _, body := range []string{
		`{"provider":"bailian","model":"qwen-audio-3.1-tts-plus","characterMicros":140000}`,
		`{"provider":"minimax","model":"MiniMax-H3","secondMicros":120000}`,
	} {
		if _, err := s.updateProviderRate(t.Context(), actor{UserID: "admin"}, []byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	ctx := s.withProviderUsageReference(t.Context(), "owner", "tts", "video-1", "batch-1")
	if _, err := s.synthesizePCM(ctx, "zh-CN", "配音", "fixture-voice", qwenAudioModel, 1); err != nil {
		t.Fatal(err)
	}
	rows := reportProviderTestRows(t, s, url.Values{"operation": {"tts"}})
	if len(rows) != 1 || rows[0].Source != "provider" || rows[0].ProviderRef != "speech-1" || rows[0].Characters == nil ||
		*rows[0].Characters != 35 || rows[0].CostMicros == nil || *rows[0].CostMicros != 4900 {
		t.Fatalf("Bailian must use final cumulative characters: %#v", rows)
	}
	s.recordOpeningUsage(t.Context(), "owner", "content-key", "minimax-task", []byte(`{"duration":5}`), nil)
	rows = reportProviderTestRows(t, s, url.Values{"operation": {"opening"}})
	if len(rows) != 1 || rows[0].Status != "pending" || rows[0].CostMicros != nil {
		t.Fatalf("pending opening should display unknown cost: %#v", rows)
	}
	s.finishProviderUsage(t.Context(), "other-owner", "opening", "content-key", "minimax-task", "failed")
	s.finishProviderUsage(t.Context(), "owner", "opening", "content-key", "minimax-task", "succeeded")
	s.finishProviderUsage(t.Context(), "owner", "opening", "content-key", "minimax-task", "failed")
	rows = reportProviderTestRows(t, s, url.Values{"operation": {"opening"}})
	if len(rows) != 1 || rows[0].Status != "succeeded" || rows[0].Source != "request" ||
		rows[0].ProviderRef != "minimax-task" || rows[0].CostMicros == nil || *rows[0].CostMicros != 600000 {
		t.Fatalf("terminal opening has one estimate using the submitted duration: %#v", rows)
	}
	var auditCount int
	err := s.db.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM keagent_audit WHERE action='credit.provider-rate.update'`).Scan(&auditCount)
	if err != nil && err != sql.ErrNoRows || auditCount != 2 {
		t.Fatalf("rate audit entries: %d, %v", auditCount, err)
	}
}

func TestFinishedVideoCostsExcludeUnarchivedAndIncompleteEstimates(t *testing.T) {
	s := &server{db: productionTestDB(t)}
	if _, err := s.db.ExecContext(t.Context(), artifactExchangeSchema); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.ExecContext(t.Context(), `
INSERT INTO keagent_media_asset(id,owner_id,device_id,file_token,request_key,fingerprint,payload)
VALUES ('asset','owner','device','token','asset-key','','{}');
INSERT INTO keagent_video_artifact(id,owner_id,producer,task_id,source_revision,request_key,fingerprint,video_asset_id,cover_asset_id,payload)
SELECT art,'owner','panorama',art,1,art,'','asset','asset',jsonb_build_object('createdAt', archived_at)
FROM (VALUES
 ('plain-a','2026-11-18T05:00:00Z'), ('plain-b','2026-11-18T07:00:00Z'),
 ('partial-a','2026-11-18T05:00:00Z'), ('opening-a','2026-11-18T05:00:00Z'),
 ('unknown-a','2026-11-18T05:00:00Z')
) AS input(art,archived_at);
INSERT INTO keagent_credit_artifact_task(artifact_id,owner_id,task_id) VALUES
 ('plain-a','owner','plain'),('plain-b','owner','plain'),('partial-a','owner','partial'),
 ('opening-a','owner','opening'),('unknown-a','owner','no-usage');
INSERT INTO keagent_provider_usage(id,owner_id,operation,task_id,batch_id,business_ref,provider,model,provider_ref,status,usage_source,unit,cost_micros,created_at)
SELECT k,account,op,task,'','','fixture','fixture','','succeeded','request','seconds',cost,at::timestamptz
FROM (VALUES
 ('1','owner','script','plain',1000,'2026-11-18T04:00:00Z'),
 ('2','owner','tts','plain',2000,'2026-11-18T04:00:00Z'),
 ('3','owner','opening','plain',5000,'2026-11-18T06:00:00Z'),
 ('4','other-owner','tts','plain',4000,'2026-11-18T04:00:00Z'),
 ('5','owner','tts','partial',NULL,'2026-11-18T04:00:00Z'),
 ('6','owner','opening','opening',6000,'2026-11-18T04:00:00Z'),
 ('7','owner','tts','never-archived',9000,'2026-11-18T04:00:00Z')
) AS input(k,account,op,task,cost,at)`); err != nil {
		t.Fatal(err)
	}
	report, err := s.finishedVideoCostReport(t.Context(), url.Values{"from": {"2026-11-18"}, "to": {"2026-11-18"}})
	if err != nil {
		t.Fatal(err)
	}
	items := obj(report)["items"].([]object)
	if len(items) != 3 {
		t.Fatalf("cost groups: %#v", items)
	}
	assertGroup := func(group object, category string, count, unpriced, average int64) {
		t.Helper()
		got := group["averageMicros"].(*int64)
		p90 := group["p90Micros"].(*int64)
		if group["category"] != category || group["count"] != count || group["unpriced"] != unpriced ||
			(average < 0 && (got != nil || p90 != nil)) ||
			(average >= 0 && (got == nil || *got != average || p90 == nil || *p90 != average)) {
			t.Fatalf("unexpected %s cost group: %#v", category, group)
		}
	}
	assertGroup(items[0], "standard", 2, 1, 3000)
	assertGroup(items[1], "minimax", 1, 0, 6000)
	assertGroup(items[2], "unclassified", 1, 1, -1)
}

func reportProviderTestRows(t *testing.T, s *server, query url.Values) []providerUsageRow {
	t.Helper()
	report, err := s.providerUsageReport(t.Context(), query)
	if err != nil {
		t.Fatal(err)
	}
	return obj(report)["items"].([]providerUsageRow)
}
