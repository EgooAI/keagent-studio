package main

import (
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// Opt-in because it launches an installed Electron and probes real controlled media.
// Business writes stay in the test helper's temporary PostgreSQL schema; platform HTTPS is intercepted.
func TestArtifactMediaElectronAgainstSharedAPI(t *testing.T) {
	if os.Getenv("ARTIFACT_MEDIA_ELECTRON_INTEGRATION") != "1" {
		t.Skip("set ARTIFACT_MEDIA_ELECTRON_INTEGRATION=1 for real registry + Go HTTP + Electron integration")
	}
	if runtime.GOOS != "windows" {
		t.Skip("this hidden Electron integration runner is validated on Windows")
	}
	if os.Getenv("FFPROBE_PATH") == "" {
		t.Fatal("FFPROBE_PATH must identify the test media probe")
	}
	s := exchangeTestServer(t)
	if _, err := s.db.Exec(douyinSchema); err != nil {
		t.Fatal(err)
	}
	s.secret = "artifact-registry-integration-" + id()
	t.Setenv("ALLOW_LEGACY_GATEWAY", "true")
	if _, err := s.db.Exec(`INSERT INTO keagent_device(id,owner_id,session_id,name,platform) VALUES('fixture-device','fixture-owner','registry-integration-session','registry integration','test')`); err != nil {
		t.Fatal(err)
	}
	endpoint := httptest.NewServer(s)
	defer endpoint.Close()
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	command := exec.CommandContext(t.Context(), "node", filepath.Join(root, "scripts", "douyin-electron-integration.mjs"))
	command.Dir = root
	command.Env = append(os.Environ(), "ARTIFACT_EXCHANGE_TEST_URL="+endpoint.URL, "ARTIFACT_EXCHANGE_TEST_SECRET="+s.secret)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("real registry integration failed: %v\n%s", err, output)
	}
	if !strings.Contains(string(output), "Hidden Electron verified: real file registration") {
		t.Fatalf("Electron verification marker missing: %s", output)
	}
	var artifacts, assets, handoffs, accepted, unknown int
	for query, destination := range map[string]*int{
		`SELECT count(*) FROM keagent_video_artifact`:                        &artifacts,
		`SELECT count(*) FROM keagent_media_asset`:                           &assets,
		`SELECT count(*) FROM keagent_artifact_handoff`:                      &handoffs,
		`SELECT count(*) FROM keagent_douyin_publish WHERE state='accepted'`: &accepted,
		`SELECT count(*) FROM keagent_douyin_publish WHERE state='unknown'`:  &unknown,
	} {
		if err = s.db.QueryRow(query).Scan(destination); err != nil {
			t.Fatal(err)
		}
	}
	if artifacts != 1 || assets != 2 || handoffs != 1 || accepted != 1 || unknown != 1 {
		t.Fatalf("unexpected shared facts: artifacts=%d assets=%d handoffs=%d accepted=%d unknown=%d", artifacts, assets, handoffs, accepted, unknown)
	}
	t.Log("Real local registry + shared Go/PostgreSQL API + review/handoff + intercepted Electron publishing verified; no production data or real platform writes")
}
