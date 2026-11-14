package main

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
)

func TestCommentActionsAuthorizedEndToEnd(t *testing.T) {
	f := commentFixture(t)
	const endpoint = "https://approved.example/v1"
	t.Setenv("AI_BASE_URL", endpoint)
	t.Setenv("AI_ALLOWED_HOSTS", "approved.example,unapproved.example")
	t.Setenv("AI_MODEL", "synthetic-test-model")
	t.Setenv("AI_API_KEY", "synthetic-test-key")
	f.grant.AnalyzeWithAI, f.grant.AIEndpoint, f.grant.ManualContact = true, endpoint, true
	f.saveGrant(t)

	const profile = "https://www.douyin.com/user/exampleSynthetic"
	fixture := []object{
		{"comment_id": "buy-row", "comment_text": "想买两室的房子", "commenter_name": "仅本地测试昵称", "commenter_profile": profile},
		{"comment_id": "comic-row", "comment_text": "漫画何时更新"},
		{"comment_id": "unclear-row", "comment_text": "看看"},
		{"comment_id": "cut-row", "comment_text": "想租", "truncated": true},
	}
	f.export(t, "synthetic-action-fixture", f.at, "partial", fixture)
	f.call(t, "sync", object{"requestKey": id()})
	ids := map[string]string{}
	for _, val := range rows(f.call(t, "list", nil)["items"]) {
		row := obj(val)
		ids[str(row["comment_id"])] = str(row["id"])
	}
	if len(ids) != len(fixture) {
		t.Fatalf("imported %d distinct comments", len(ids))
	}
	body := func(key string) []byte {
		t.Helper()
		b, err := json.Marshal(f.request(object{"id": ids[key]}))
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	assertCode := func(err error, code string) {
		t.Helper()
		var fault exchangeFault
		if !errors.As(err, &fault) || fault.code != code {
			t.Fatalf("expected %s, got %v", code, err)
		}
	}
	neverCall := func(context.Context, any, string) (string, error) {
		t.Fatal("model called without usable text and purpose-specific authorization")
		return "", nil
	}

	for _, tc := range []struct {
		key, text, intent, evidence, wantDraft string
	}{
		{"buy-row", "想买两室的房子", "buy", "想买两室", "您有偏好的地段吗？"},
		{"comic-row", "漫画何时更新", "unrelated", "漫画", ""},
		{"unclear-row", "看看", "unclear", "", ""},
	} {
		t.Run(tc.intent, func(t *testing.T) {
			calls := 0
			out, err := f.analyzeCommentUsing(t.Context(), f.actor, body(tc.key), func(ctx context.Context, content any, instruction string) (string, error) {
				calls++
				userBody, ok := content.(string)
				var data map[string]string
				if !ok || json.Unmarshal([]byte(userBody), &data) != nil || len(data) != 1 || data["comment_text"] != tc.text || instruction != commentIntentPrompt {
					t.Fatal("model was sent data other than the selected text and server instruction")
				}
				if deadline, ok := ctx.Deadline(); !ok || deadline.After(f.grant.ExpiresAt) {
					t.Fatal("model request outlives authorization")
				}
				raw, err := json.Marshal(commentAnalysis{Intent: tc.intent, Evidence: tc.evidence, Draft: "您有偏好的地段吗？"})
				return string(raw), err
			})
			if err != nil || calls != 1 {
				t.Fatalf("model calls=%d, error=%v", calls, err)
			}
			if result, ok := out.(commentAnalysis); !ok || result.Intent != tc.intent || result.Evidence != tc.evidence || result.Draft != tc.wantDraft {
				t.Fatalf("unexpected result: %+v", out)
			}
		})
	}
	if result := f.call(t, "contact", object{"id": ids["buy-row"]}); len(result) != 1 || result["profileUrl"] != profile {
		t.Fatalf("unexpected contact action: %+v", result)
	}
	f.checkCode(t, "contact", object{"id": ids["comic-row"]}, "COMMENT_PROFILE_UNAVAILABLE")
	_, err := f.analyzeCommentUsing(t.Context(), f.actor, body("cut-row"), neverCall)
	assertCode(err, "COMMENT_TEXT_INCOMPLETE")

	t.Setenv("AI_BASE_URL", "https://unapproved.example/v1")
	_, err = f.analyzeCommentUsing(t.Context(), f.actor, body("buy-row"), neverCall)
	assertCode(err, "COMMENT_AI_PROVIDER_UNAPPROVED")
	t.Setenv("AI_BASE_URL", endpoint)
	// Simulate removal of permission between sending the selected text and receiving the response.
	out, err := f.analyzeCommentUsing(t.Context(), f.actor, body("buy-row"), func(context.Context, any, string) (string, error) {
		f.grant.Revoked = true
		f.saveGrant(t)
		return `{"intent":"buy","evidence":"想买","draft":"想了解哪个区域？"}`, nil
	})
	assertCode(err, "COMMENT_GRANT_REVOKED")
	if out != nil || f.count(t) != 0 {
		t.Fatal("returned or retained content after revocation")
	}
	f.grant.Revoked, f.grant.AnalyzeWithAI, f.grant.ManualContact = false, false, false
	f.saveGrant(t)
	_, err = f.analyzeCommentUsing(t.Context(), f.actor, body("buy-row"), neverCall)
	assertCode(err, "COMMENT_PURPOSE_DENIED")
	f.checkCode(t, "contact", object{"id": ids["buy-row"]}, "COMMENT_PURPOSE_DENIED")
}
