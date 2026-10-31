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
