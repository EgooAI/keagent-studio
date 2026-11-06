package main

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Manual live bridge for scripts/verify-live-production-sources.mjs. Normal tests
// skip it. The script alone submits paid jobs, using persistent request keys.
func TestProductionSourcesLiveBridge(t *testing.T) {
	if os.Getenv("KEAGENT_LIVE_SOURCE_BRIDGE") != "1" {
		t.Skip("manual live-provider verification only")
	}
	u, err := url.Parse(os.Getenv("ADMIN_TEST_DATABASE_URL"))
	if err != nil || (u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost") || u.Path != "/keagent_production_test" {
		t.Fatal("live bridge requires the isolated local keagent_production_test database")
	}
	if len(os.Getenv("INTERNAL_API_SECRET")) < 32 || os.Getenv("DASHSCOPE_API_KEY") == "" {
		t.Fatal("live bridge credentials missing")
	}
	db, err := sql.Open("pgx", u.String())
	if err != nil {
		t.Fatal("test database configuration invalid")
	}
	defer db.Close()
	if _, err = db.Exec(productionImageSchema); err != nil {
		t.Fatal("test image schema unavailable")
	}
	s := &server{db: db, secret: os.Getenv("INTERNAL_API_SECRET")}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/panorama/image-submit", "/v1/panorama/image-query", "/v1/panorama/capabilities":
			s.ServeHTTP(w, r)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	ready := os.Getenv("KEAGENT_LIVE_SOURCE_READY_FILE")
	if !filepath.IsAbs(ready) {
		t.Fatal("absolute ready file required")
	}
	encoded, _ := json.Marshal(object{"url": server.URL})
	if err = os.WriteFile(ready, encoded, 0600); err != nil {
		t.Fatal("cannot announce live bridge")
	}
	defer os.Remove(ready)
	for deadline := time.Now().Add(15 * time.Minute); time.Now().Before(deadline); {
		if _, err := os.Stat(ready + ".stop"); err == nil {
			return
		}
		time.Sleep(time.Second)
	}
	t.Fatal("live bridge timed out; saved image requests remain recoverable")
}
