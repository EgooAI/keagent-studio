package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func exchangeFixture(t *testing.T) artifactHandoff {
	t.Helper()
	raw, err := os.ReadFile("../../packages/shared-types/fixtures/artifact-handoff.v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var v artifactHandoff
	if err = decodeExchange(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestExchangeHTTPAuthorizationAndCodes(t *testing.T) {
	s := exchangeTestServer(t)
	s.secret = "artifact-test-gateway-secret-at-least-32-characters"
	a := actor{UserID: "owner", SessionID: "session", DeviceID: "device"}
	if _, err := s.db.Exec(`INSERT INTO keagent_device(id,owner_id,session_id,name,platform) VALUES('device','owner','session','fixture','test')`); err != nil {
		t.Fatal(err)
	}
	call := func(method, path string, who actor, body []byte, authenticated bool) *httptest.ResponseRecorder {
		request := httptest.NewRequest(method, path, bytes.NewReader(body))
		if authenticated {
			who.Timestamp = time.Now().Unix()
			who.Nonce = id()
			raw, _ := json.Marshal(who)
			encoded := base64.RawURLEncoding.EncodeToString(raw)
			h := hmac.New(sha256.New, []byte(s.secret))
			digest := sha256.Sum256(body)
			fmt.Fprintf(h, "%s\n%s\n%s\n%x", method, path, encoded, digest)
			request.Header.Set("X-Keagent-Context", encoded)
			request.Header.Set("X-Keagent-Signature", hex.EncodeToString(h.Sum(nil)))
		}
		response := httptest.NewRecorder()
		s.ServeHTTP(response, request)
		return response
	}
	if r := call("POST", "/v1/artifacts/list", a, []byte(`{}`), false); r.Code != 401 {
		t.Fatal("unauthenticated exchange allowed", r.Code)
	}
	if r := call("GET", "/v1/artifacts/list", a, []byte(`{}`), true); r.Code != 405 {
		t.Fatal("unsupported method allowed", r.Code)
	}
	invalid := a
	invalid.DeviceID = "missing-device"
	if r := call("POST", "/v1/artifacts/list", invalid, []byte(`{}`), true); r.Code != 403 {
		t.Fatal("revoked/unknown device accepted", r.Code)
	}
	if r := call("POST", "/v1/artifacts/delete", a, []byte(`{}`), true); r.Code != 404 {
		t.Fatal("unexpected mutation route", r.Code)
	}
	asset := exchangeFixture(t).Assets[0]
	input := registerAssetInput{assetMetadata: asset.assetMetadata, RequestKey: id(), FileToken: id()}
	body, _ := json.Marshal(input)
	r := call("POST", "/v1/media-assets/register", a, body, true)
	if r.Code != 200 {
		t.Fatal("HTTP asset registration", r.Code, r.Body.String())
	}
	var saved mediaAsset
	if json.Unmarshal(r.Body.Bytes(), &saved) != nil || saved.OwnerID != a.UserID || saved.Location.DeviceID != a.DeviceID {
		t.Fatal("actor did not bind asset ownership")
	}
	noDevice := a
	noDevice.DeviceID = ""
	r = call("POST", "/v1/media-assets/register", noDevice, body, true)
	var failure struct {
		Error struct {
			Code string `json:"code"`
		}
	}
	_ = json.Unmarshal(r.Body.Bytes(), &failure)
	if r.Code != 409 || failure.Error.Code != "DEVICE_REQUIRED" {
		t.Fatal("machine-readable conflict missing", r.Code, r.Body.String())
	}
}
func exchangeTestServer(t *testing.T) *server {
	t.Helper()
	s := voiceTestServer(t)
	if _, err := s.db.Exec(artifactExchangeSchema); err != nil {
		t.Fatal(err)
	}
	return s
}
func exchangeCall(s *server, a actor, operation string, v any) (any, error) {
	raw, _ := json.Marshal(v)
	return s.artifactExchange(context.Background(), a, operation, raw)
}
func mustExchange(t *testing.T, s *server, a actor, operation string, v any) any {
	t.Helper()
	value, err := exchangeCall(s, a, operation, v)
	if err != nil {
		t.Fatal(operation, err)
	}
	return value
}
func expectExchangeStatus(t *testing.T, err error, status int) {
	t.Helper()
	var f fault
	if !errors.As(err, &f) || f.status != status {
		t.Fatalf("expected %d, got %v", status, err)
	}
}
func exchangeInputs(t *testing.T, s *server, a actor) (createArtifactInput, []registerAssetInput) {
	t.Helper()
	fixture := exchangeFixture(t)
	refs := artifactAssets{}
	inputs := []registerAssetInput{}
	for _, asset := range fixture.Assets {
		input := registerAssetInput{assetMetadata: asset.assetMetadata, RequestKey: id(), FileToken: id()}
		inputs = append(inputs, input)
		result := mustExchange(t, s, a, "/v1/media-assets/register", input).(mediaAsset)
		if asset.Kind == "video" {
			refs.Video = result.ID
		} else {
			refs.Cover = result.ID
		}
	}
	return createArtifactInput{RequestKey: id(), Source: fixture.Artifact.Source, Content: fixture.Artifact.Content, Assets: refs}, inputs
}
func TestExchangeContractValidation(t *testing.T) {
	fixture := exchangeFixture(t)
	for _, asset := range fixture.Assets {
		if err := validateAssetInput(registerAssetInput{assetMetadata: asset.assetMetadata, RequestKey: "fixture-request-0001", FileToken: asset.Location.FileToken}); err != nil {
			t.Fatal(err)
		}
	}
	valid := createArtifactInput{RequestKey: "fixture-request-0001", Source: fixture.Artifact.Source, Content: fixture.Artifact.Content, Assets: fixture.Artifact.Assets}
	if err := validateArtifactInput(&valid); err != nil {
		t.Fatal(err)
	}
	for _, token := range []string{"C:\\private\\video.mp4", "../../video.mp4", "https://example.test/video.mp4", "keagent://media/foo"} {
		input := registerAssetInput{assetMetadata: fixture.Assets[0].assetMetadata, RequestKey: "fixture-request-0001", FileToken: token}
		if validateAssetInput(input) == nil {
			t.Fatal("path/URL accepted as token", token)
		}
	}
	for _, body := range []string{`{"id":"abc","ownerId":"victim"}`, `{} {}`, `null`, `[]`} {
		var v struct {
			ID string `json:"id"`
		}
		err := decodeExchange([]byte(body), &v)
		if err == nil {
			t.Fatal("invalid envelope accepted", body)
		}
	}
	bad := registerAssetInput{assetMetadata: fixture.Assets[0].assetMetadata, RequestKey: "fixture-request-0001", FileToken: "fixture-token-0001"}
	bad.Kind = "cover"
	if validateAssetInput(bad) == nil {
		t.Fatal("video metadata accepted as cover")
	}
}
func TestExchangeIsolationImmutabilityAndReceipt(t *testing.T) {
	s := exchangeTestServer(t)
	a := actor{UserID: "owner-a", DeviceID: "device-a"}
	b := actor{UserID: "owner-b", DeviceID: "device-b"}
	otherDevice := actor{UserID: a.UserID, DeviceID: "device-other"}
	input, assets := exchangeInputs(t, s, a)
	video := mustExchange(t, s, a, "/v1/media-assets/register", assets[0]).(mediaAsset)
	if video.ID != input.Assets.Video {
		t.Fatal("asset registration replayed")
	}
	modified := assets[0]
	modified.SHA256 = strings.Repeat("3", 64)
	_, err := exchangeCall(s, a, "/v1/media-assets/register", modified)
	expectExchangeStatus(t, err, 409)
	modified.RequestKey = id()
	_, err = exchangeCall(s, a, "/v1/media-assets/register", modified)
	expectExchangeStatus(t, err, 409)
	_, err = exchangeCall(s, actor{UserID: a.UserID}, "/v1/media-assets/register", assets[0])
	expectExchangeStatus(t, err, 409)
	_, err = exchangeCall(s, b, "/v1/artifacts/create", input)
	expectExchangeStatus(t, err, 404)
	_, err = exchangeCall(s, otherDevice, "/v1/artifacts/create", input)
	expectExchangeStatus(t, err, 409)
	v := mustExchange(t, s, a, "/v1/artifacts/create", input).(videoArtifact)
	if v.Review.State != "pending" || v.OwnerID != a.UserID {
		t.Fatal("new artifact incorrectly approved/owned")
	}
	if replay := mustExchange(t, s, a, "/v1/artifacts/create", input).(videoArtifact); replay.ID != v.ID {
		t.Fatal("artifact replayed")
	}
	changed := input
	changed.Content.Title = "不能覆盖"
	_, err = exchangeCall(s, a, "/v1/artifacts/create", changed)
	expectExchangeStatus(t, err, 409)
	changed.RequestKey = id()
	_, err = exchangeCall(s, a, "/v1/artifacts/create", changed)
	expectExchangeStatus(t, err, 409)
	for _, operation := range []string{"/v1/artifacts/get", "/v1/artifacts/review"} {
		_, err = exchangeCall(s, b, operation, object{"id": v.ID, "expectedRevision": 1, "state": "approved"})
		if operation == "/v1/artifacts/get" {
			_, err = exchangeCall(s, b, operation, object{"id": v.ID})
		}
		expectExchangeStatus(t, err, 404)
	}
	handoffInput := object{"requestKey": id(), "artifactId": v.ID, "expectedReviewRevision": 1}
	_, err = exchangeCall(s, a, "/v1/artifact-handoffs/create", handoffInput)
	expectExchangeStatus(t, err, 409)
	approved := mustExchange(t, s, a, "/v1/artifacts/review", object{"id": v.ID, "expectedRevision": 1, "state": "approved"}).(videoArtifact)
	_, err = exchangeCall(s, a, "/v1/artifact-handoffs/create", handoffInput)
	expectExchangeStatus(t, err, 409)
	handoffInput["expectedReviewRevision"] = approved.Review.Revision
	_, err = exchangeCall(s, otherDevice, "/v1/artifact-handoffs/create", handoffInput)
	expectExchangeStatus(t, err, 409)
	receipt := mustExchange(t, s, a, "/v1/artifact-handoffs/create", handoffInput).(artifactHandoff)
	if receipt.Artifact.ID != v.ID || len(receipt.Assets) != 2 || receipt.DeviceID != a.DeviceID {
		t.Fatal("incomplete receipt")
	}
	_, err = exchangeCall(s, b, "/v1/artifact-handoffs/get", object{"id": receipt.ID})
	expectExchangeStatus(t, err, 404)
	_, err = exchangeCall(s, b, "/v1/media-assets/get", object{"id": video.ID})
	expectExchangeStatus(t, err, 404)
	_, err = exchangeCall(s, b, "/v1/media-assets/availability", object{"id": video.ID, "expectedRevision": 1, "state": "missing"})
	expectExchangeStatus(t, err, 404)
	_, err = exchangeCall(s, otherDevice, "/v1/media-assets/availability", object{"id": video.ID, "expectedRevision": 1, "state": "missing"})
	expectExchangeStatus(t, err, 409)
	mustExchange(t, s, a, "/v1/media-assets/availability", object{"id": video.ID, "expectedRevision": 1, "state": "missing"})
	_, err = exchangeCall(s, a, "/v1/media-assets/availability", object{"id": video.ID, "expectedRevision": 1, "state": "available"})
	expectExchangeStatus(t, err, 409)
	fresh := object{"requestKey": id(), "artifactId": v.ID, "expectedReviewRevision": 2}
	_, err = exchangeCall(s, a, "/v1/artifact-handoffs/create", fresh)
	expectExchangeStatus(t, err, 409)
	mustExchange(t, s, a, "/v1/artifacts/review", object{"id": v.ID, "expectedRevision": 2, "state": "rejected", "note": "撤回验收"})
	// Receipts are immutable evidence, not a live publish permission.
	replayed := mustExchange(t, s, a, "/v1/artifact-handoffs/create", handoffInput).(artifactHandoff)
	before, _ := json.Marshal(receipt)
	after, _ := json.Marshal(replayed)
	if string(before) != string(after) {
		t.Fatal("receipt changed after review or availability update")
	}
	list := mustExchange(t, s, a, "/v1/artifacts/list", object{"review": "approved"}).(object)
	if list["total"].(int) != 0 {
		t.Fatal("review filter stale")
	}
	list = mustExchange(t, s, b, "/v1/artifacts/list", object{}).(object)
	if list["total"].(int) != 0 {
		t.Fatal("cross-user list leak")
	}
	changed.Source.Revision = 2
	newVersion := mustExchange(t, s, a, "/v1/artifacts/create", changed).(videoArtifact)
	if newVersion.ID == v.ID {
		t.Fatal("new output version overwrote existing artifact")
	}
	old := mustExchange(t, s, a, "/v1/artifacts/get", object{"id": v.ID}).(videoArtifact)
	if old.Content.Title != input.Content.Title {
		t.Fatal("old content mutated")
	}
	var count int
	if err = s.db.QueryRow(`SELECT count(*) FROM keagent_audit WHERE action='artifact.handoff'`).Scan(&count); err != nil || count != 1 {
		t.Fatal("handoff duplicated or missing audit", err, count)
	}
}
func TestExchangeConcurrentReviewAndHandoff(t *testing.T) {
	s := exchangeTestServer(t)
	a := actor{UserID: "owner", DeviceID: "device"}
	input, _ := exchangeInputs(t, s, a)
	v := mustExchange(t, s, a, "/v1/artifacts/create", input).(videoArtifact)
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := exchangeCall(s, a, "/v1/artifacts/review", object{"id": v.ID, "state": "approved", "expectedRevision": 1})
			results <- err
		}()
	}
	wg.Wait()
	close(results)
	success, conflict := 0, 0
	for err := range results {
		if err == nil {
			success++
		} else {
			expectExchangeStatus(t, err, 409)
			conflict++
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatal("stale concurrent review committed")
	}
	ids := make(chan string, 6)
	errorsCh := make(chan error, 6)
	key := id()
	for range 6 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			value, err := exchangeCall(s, a, "/v1/artifact-handoffs/create", object{"requestKey": key, "artifactId": v.ID, "expectedReviewRevision": 2})
			if err != nil {
				errorsCh <- err
				return
			}
			ids <- value.(artifactHandoff).ID
		}()
	}
	wg.Wait()
	close(ids)
	close(errorsCh)
	for err := range errorsCh {
		t.Fatal(err)
	}
	unique := map[string]bool{}
	for value := range ids {
		unique[value] = true
	}
	if len(unique) != 1 {
		t.Fatal("concurrent handoff created multiple receipts")
	}
}
