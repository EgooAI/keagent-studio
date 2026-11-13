package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestRespondPreservesBusinessErrors(t *testing.T) {
	credit := creditFail(http.StatusPaymentRequired, "CREDITS_INSUFFICIENT", "积分不足，请先充值或兑换")
	for _, test := range []struct {
		name    string
		err     error
		status  int
		message string
		code    string
	}{
		{"credit", credit, 402, "积分不足，请先充值或兑换", "CREDITS_INSUFFICIENT"},
		{"wrapped credit", fmt.Errorf("charge: %w", credit), 402, "积分不足，请先充值或兑换", "CREDITS_INSUFFICIENT"},
		{"validation", fail(422, "请选择房源"), 422, "请选择房源", ""},
		{"exchange", exchangeFail(409, "CONFLICT", "成片已更新"), 409, "成片已更新", "CONFLICT"},
		{"provider", providerHTTPError{fault: fault{502, "配音服务返回错误"}}, 502, "配音服务返回错误", ""},
		{"unknown", fmt.Errorf("private database connection details"), 500, "业务服务错误", ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			respond(w, nil, test.err)
			var body struct {
				Error struct{ Message, Code string }
			}
			if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if w.Code != test.status || body.Error.Message != test.message || body.Error.Code != test.code {
				t.Fatalf("response = %d %s", w.Code, w.Body.String())
			}
		})
	}
}

func TestGatewayIdentity(t *testing.T) {
	s := &server{secret: "test-secret-with-at-least-32-characters"}
	context, _ := json.Marshal(actor{UserID: "user-a", SessionID: "session-a", Timestamp: time.Now().Unix(), Nonce: "nonce-a"})
	encoded := base64.RawURLEncoding.EncodeToString(context)
	r := httptest.NewRequest("POST", "http://internal/v1/commands/saveDraft", nil)
	h := hmac.New(sha256.New, []byte(s.secret))
	digest := sha256.Sum256(nil)
	fmt.Fprintf(h, "POST\n/v1/commands/saveDraft\n%s\n%x", encoded, digest)
	r.Header.Set("X-Keagent-Context", encoded)
	r.Header.Set("X-Keagent-Signature", hex.EncodeToString(h.Sum(nil)))
	a, err := s.verify(r, nil)
	if err != nil || a.UserID != "user-a" {
		t.Fatalf("valid signature refused: %v", err)
	}
	if _, err = s.verify(r, nil); err == nil {
		t.Fatal("replay accepted")
	}
	r.URL.Path = "/v1/admin/resources"
	if _, err = s.verify(r, nil); err == nil {
		t.Fatal("changed target accepted")
	}
	r.Header.Set("X-Keagent-Signature", "bad")
	if _, err = s.verify(r, nil); err == nil {
		t.Fatal("forged identity accepted")
	}
}

func TestCloudCompletion(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer server-only-test-key" {
			t.Error("missing provider credential")
		}
		var body object
		if json.NewDecoder(r.Body).Decode(&body) != nil || body["model"] != "test-model" {
			t.Error("invalid provider payload")
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"真实接口测试文案"}}]}`))
	}))
	defer provider.Close()
	text, err := completion(t.Context(), provider.Client(), provider.URL, "test-model", "server-only-test-key", object{"community": "测试小区"})
	if err != nil || text != "真实接口测试文案" {
		t.Fatalf("completion failed: %v", err)
	}
}
func TestUnconfiguredAI(t *testing.T) {
	t.Setenv("AI_API_KEY", "")
	if _, err := generate(t.Context(), object{}); err == nil {
		t.Fatal("unconfigured AI succeeded")
	}
}
func TestWorkspaceStartsEmpty(t *testing.T) {
	w := initial("Alice")
	if len(rows(w["tasks"])) != 0 || len(rows(w["properties"])) != 0 || obj(w["profile"])["name"] != "Alice" {
		t.Fatal("real workspace contains demo data")
	}
}
