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
	"strings"
	"testing"
	"time"
)

func TestBeikeCLIEndpoints(t *testing.T) {
	t.Setenv("BEIKE_CLI_PATH", "relative/beike")
	t.Setenv("BEIKE_MCP_API_KEY", "fixture-key")
	s := &server{secret: "beike-test-gateway-secret-at-least-32-characters"}
	call := func(method, path, payload string, signed bool) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(payload))
		if signed {
			data, _ := json.Marshal(actor{UserID: "agent", SessionID: "session", Timestamp: time.Now().Unix(), Nonce: id()})
			encoded := base64.RawURLEncoding.EncodeToString(data)
			signature := hmac.New(sha256.New, []byte(s.secret))
			fmt.Fprintf(signature, "%s\n%s\n%s\n%x", method, path, encoded, sha256.Sum256([]byte(payload)))
			r.Header.Set("X-Keagent-Context", encoded)
			r.Header.Set("X-Keagent-Signature", hex.EncodeToString(signature.Sum(nil)))
		}
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		return w
	}
	const status = "/v1/beike-cli/status"
	if w := call(http.MethodPost, status, "", false); w.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status returned %d", w.Code)
	}
	if w := call(http.MethodGet, status, "", true); w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET status returned %d", w.Code)
	}
	assertStatus := func(available, configured bool, reason string) {
		t.Helper()
		w := call(http.MethodPost, status, "", true)
		var response struct {
			Available  *bool  `json:"available"`
			Configured *bool  `json:"configured"`
			Reason     string `json:"reason"`
		}
		if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &response) != nil ||
			response.Available == nil || *response.Available != available || response.Configured == nil ||
			*response.Configured != configured || response.Reason != reason {
			t.Fatalf("unexpected status %d %s", w.Code, w.Body)
		}
	}
	assertStatus(false, false, "not_configured")
	if w := call(http.MethodPost, "/v1/beike-cli/search", "not-json", true); w.Code != http.StatusBadRequest {
		t.Fatalf("search bad body returned %d", w.Code)
	}
	if w := call(http.MethodPost, "/v1/beike-cli/search", `{"city":"北京","query":"望京"}`, true); w.Code != http.StatusServiceUnavailable {
		t.Fatalf("search unconfigured returned %d", w.Code)
	}
	if w := call(http.MethodPost, "/v1/beike-cli/detail", "not-json", true); w.Code != http.StatusBadRequest {
		t.Fatalf("detail bad body returned %d", w.Code)
	}
	if w := call(http.MethodPost, "/v1/beike-cli/detail", `{"city":"北京","ids":["101138285186"]}`, true); w.Code != http.StatusServiceUnavailable {
		t.Fatalf("detail unconfigured returned %d", w.Code)
	}
	if w := call(http.MethodPost, "/v1/beike-cli/commands", "", true); w.Code != http.StatusOK {
		t.Fatalf("commands returned %d", w.Code)
	}
	if w := call(http.MethodPost, "/v1/beike-cli/call", "not-json", true); w.Code != http.StatusBadRequest {
		t.Fatalf("call bad body returned %d", w.Code)
	}
	if w := call(http.MethodPost, "/v1/beike-cli/call", `{"namespace":"buy","command":"market","args":{"city":"北京","query":"望京"}}`, true); w.Code != http.StatusServiceUnavailable {
		t.Fatalf("call unconfigured returned %d", w.Code)
	}
	path := filepath.Join(t.TempDir(), "beike")
	if err := os.WriteFile(path, []byte("fixture"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("BEIKE_CLI_PATH", path)
	assertStatus(true, true, "ready")
	for _, op := range []string{"preview", "import"} {
		if w := call(http.MethodPost, "/v1/beike-cli/"+op, "", true); w.Code != http.StatusServiceUnavailable {
			t.Fatalf("%s returned %d", op, w.Code)
		}
	}
}
