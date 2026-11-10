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
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestBeikeCLIEndpointsStayClosedUntilContractVerified(t *testing.T) {
	t.Setenv("BEIKE_CLI_PATH", "relative/beike")
	t.Setenv("BEIKE_MCP_API_KEY", "fixture-key")
	s := &server{secret: "beike-test-gateway-secret-at-least-32-characters"}
	call := func(method, path string, signed bool) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, nil)
		if signed {
			data, _ := json.Marshal(actor{UserID: "agent", SessionID: "session", Timestamp: time.Now().Unix(), Nonce: id()})
			encoded := base64.RawURLEncoding.EncodeToString(data)
			signature := hmac.New(sha256.New, []byte(s.secret))
			fmt.Fprintf(signature, "%s\n%s\n%s\n%x", method, path, encoded, sha256.Sum256(nil))
			r.Header.Set("X-Keagent-Context", encoded)
			r.Header.Set("X-Keagent-Signature", hex.EncodeToString(signature.Sum(nil)))
		}
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		return w
	}
	const status = "/v1/beike-cli/status"
	if w := call(http.MethodPost, status, false); w.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status returned %d", w.Code)
	}
	if w := call(http.MethodGet, status, true); w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET status returned %d", w.Code)
	}
	assertStatus := func(configured bool, reason string) {
		t.Helper()
		w := call(http.MethodPost, status, true)
		var response struct {
			Available  *bool  `json:"available"`
			Configured *bool  `json:"configured"`
			Reason     string `json:"reason"`
		}
		if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &response) != nil ||
			response.Available == nil || *response.Available || response.Configured == nil ||
			*response.Configured != configured || response.Reason != reason {
			t.Fatalf("unexpected status %d %s", w.Code, w.Body)
		}
	}
	assertStatus(false, "not_configured")
	path := filepath.Join(t.TempDir(), "beike")
	if err := os.WriteFile(path, []byte("fixture"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("BEIKE_CLI_PATH", path)
	assertStatus(true, "contract_unverified")
	for _, op := range []string{"search", "preview", "import"} {
		if w := call(http.MethodPost, "/v1/beike-cli/"+op, true); w.Code != http.StatusServiceUnavailable {
			t.Fatalf("%s returned %d", op, w.Code)
		}
	}
}
