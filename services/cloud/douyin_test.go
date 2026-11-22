package main

import (
	"context"
	"encoding/json"
	"net"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func douyinCall(s *server, a actor, op string, input any) (any, error) {
	raw, _ := json.Marshal(input)
	return s.douyin(context.Background(), a, op, raw)
}
func mustDouyin(t *testing.T, s *server, a actor, op string, input any) any {
	t.Helper()
	v, err := douyinCall(s, a, op, input)
	if err != nil {
		t.Fatal(op, err)
	}
	return v
}
func douyinFixture(t *testing.T) (*server, actor, douyinInput) {
	t.Helper()
	s := exchangeTestServer(t)
	if _, err := s.db.Exec(douyinSchema); err != nil {
		t.Fatal(err)
	}
	a := actor{UserID: "publishing-owner", DeviceID: "publishing-device", SessionID: "session"}
	input, _ := exchangeInputs(t, s, a)
	artifact := mustExchange(t, s, a, "/v1/artifacts/create", input).(videoArtifact)
	artifact = mustExchange(t, s, a, "/v1/artifacts/review", object{"id": artifact.ID, "expectedRevision": 1, "state": "approved"}).(videoArtifact)
	handoff := mustExchange(t, s, a, "/v1/artifact-handoffs/create", object{"requestKey": id(), "artifactId": artifact.ID, "expectedReviewRevision": artifact.Review.Revision}).(artifactHandoff)
	account := id()
	mustDouyin(t, s, a, "accounts/bind", object{"id": account, "name": "测试抖音账号", "loginStatus": "logged_in", "platformUserId": "public-platform-id"})
	return s, a, douyinInput{RequestKey: id(), HandoffID: handoff.ID, AccountID: account, Title: "平台独立标题", Description: "平台独立文案", Hashtags: []string{"房产"}}
}
func createdDouyin(t *testing.T, s *server, a actor, input douyinInput) douyinRecord {
	t.Helper()
	return mustDouyin(t, s, a, "records/create", input).(object)["record"].(douyinRecord)
}
func TestDouyinScheduledPublishRecord(t *testing.T) {
	s, a, input := douyinFixture(t)
	input.ScheduledAt = time.Now().Add(time.Hour).Truncate(time.Minute).Unix()
	_, err := douyinCall(s, a, "records/create", input)
	expectExchangeStatus(t, err, 422)
	input.ScheduledAt += 86400
	record := createdDouyin(t, s, a, input)
	if record.ScheduledAt != input.ScheduledAt {
		t.Fatal("schedule missing from created record")
	}
	changed := input
	changed.ScheduledAt += 60
	_, err = douyinCall(s, a, "records/create", changed)
	expectExchangeStatus(t, err, 409)
	record.State = "submitting"
	mustDouyin(t, s, a, "records/report", record)
	record.State, record.Progress, record.ResultSource = "accepted", 100, "platform"
	record.ExternalID, record.URL = "123456789", "https://www.douyin.com/video/123456789"
	mustDouyin(t, s, a, "records/report", record)
	workspace := mustDouyin(t, s, a, "workspace", object{"status": "scheduled"}).(object)
	if workspace["total"] != float64(1) || rows(workspace["items"])[0].(object)["scheduledAt"] != float64(input.ScheduledAt) {
		t.Fatalf("missing scheduled workspace row: %v", workspace)
	}
	retry := input
	retry.RequestKey, retry.ScheduledAt = id(), 0
	_, err = douyinCall(s, a, "records/create", retry)
	expectExchangeStatus(t, err, 409)
	_, err = douyinCall(s, a, "records/reconcile", object{"id": record.ID, "published": true, "url": "https://www.douyin.com/video/987654321"})
	expectExchangeStatus(t, err, 422)
	cancel := object{"id": record.ID, "published": false}
	for range 2 {
		result := mustDouyin(t, s, a, "records/reconcile", cancel).(douyinRecord)
		if result.State != "canceled" || result.ResultSource != "manual" || result.URL != "" {
			t.Fatalf("schedule cancellation was not recorded: %+v", result)
		}
	}
	createdDouyin(t, s, a, retry)
}

func TestChannelsAndDouyinMayPublishSameArtifact(t *testing.T) {
	s, a, input := douyinFixture(t)
	input.Batch = true
	first := createdDouyin(t, s, a, input)
	first.State = "submitting"
	mustDouyin(t, s, a, "records/report", first)
	first.State, first.Progress, first.ResultSource = "accepted", 100, "platform"
	first.ExternalID, first.URL = "123456789", "https://www.douyin.com/video/123456789"
	mustDouyin(t, s, a, "records/report", first)

	input.RequestKey, input.Platform = id(), "channels"
	_, err := douyinCall(s, a, "records/create", input)
	expectExchangeStatus(t, err, 409)
	input.AccountID = id()
	mustDouyin(t, s, a, "accounts/bind", object{"id": input.AccountID, "platform": "channels", "name": "视频号测试", "loginStatus": "logged_in"})
	mustDouyin(t, s, a, "accounts/update", object{"id": input.AccountID, "platform": "channels", "name": "视频号测试", "loginStatus": "logged_in", "platformUserId": "fixture-channels", "savedProfile": true})
	workspace := mustDouyin(t, s, a, "workspace", object{"platform": "channels", "status": "unpublished"}).(object)
	if workspace["total"] != float64(1) {
		t.Fatal("a Douyin submission hid the Channels work item")
	}
	input.Batch = false
	input.ScheduledAt = time.Now().Add(24*time.Hour).Truncate(time.Hour).Unix() + 60
	_, err = douyinCall(s, a, "records/create", input)
	expectExchangeStatus(t, err, 422)
	input.ScheduledAt, input.Batch = 0, true
	record := createdDouyin(t, s, a, input)
	record.State = "submitting"
	mustDouyin(t, s, a, "records/report", record)
	record.State, record.Progress, record.ResultSource = "accepted", 100, "platform"
	mustDouyin(t, s, a, "records/report", record)
	input.RequestKey = id()
	_, err = douyinCall(s, a, "records/create", input)
	expectExchangeStatus(t, err, 409)
	list := mustDouyin(t, s, a, "records/list", object{"platform": "channels"}).(object)
	if list["total"] != 1 {
		t.Fatalf("unexpected Channels record count %v", list["total"])
	}
	var observed bool
	if err := s.db.QueryRow(`SELECT EXISTS(SELECT 1 FROM keagent_douyin_observation WHERE record_id=$1)`, record.ID).Scan(&observed); err != nil || observed {
		t.Fatal("Channels submission entered Douyin incident reporting", err)
	}
}

func TestDouyinConfirmPublishedWithoutLink(t *testing.T) {
	for _, scenario := range []string{"unknown", "scheduled"} {
		t.Run(scenario, func(t *testing.T) {
			s, a, input := douyinFixture(t)
			if scenario == "scheduled" {
				input.ScheduledAt = time.Now().Add(24 * time.Hour).Truncate(time.Minute).Unix()
			}
			record := createdDouyin(t, s, a, input)
			record.State = "submitting"
			mustDouyin(t, s, a, "records/report", record)
			record.State = "unknown"
			record.ErrorCode = "PUBLISH_OUTCOME_UNKNOWN"
			if scenario == "scheduled" {
				record.State, record.ResultSource, record.ErrorCode = "accepted", "platform", ""
				record.ExternalID, record.URL, record.Progress = "123456789", "https://www.douyin.com/video/123456789", 100
			}
			mustDouyin(t, s, a, "records/report", record)

			_, err := douyinCall(s, a, "records/reconcile", object{"id": record.ID})
			expectExchangeStatus(t, err, 422)
			_, err = douyinCall(s, a, "records/reconcile", object{"id": record.ID, "published": true, "url": "https://evil.test/video/123456789"})
			expectExchangeStatus(t, err, 422)
			for range 2 {
				result := mustDouyin(t, s, a, "records/reconcile", object{"id": record.ID, "published": true}).(douyinRecord)
				if result.State != "accepted" || result.ResultSource != "manual" || result.Progress != 100 || result.ErrorCode != "" ||
					result.URL != record.URL || result.ExternalID != record.ExternalID {
					t.Fatalf("unexpected manual result: %+v", result)
				}
			}
			_, err = douyinCall(s, a, "records/reconcile", object{"id": record.ID, "published": false})
			expectExchangeStatus(t, err, 409)
			workspace := mustDouyin(t, s, a, "workspace", object{"status": "accepted"}).(object)
			items := rows(workspace["items"])
			if len(items) != 1 || obj(items[0])["resultSource"] != "manual" {
				t.Fatal("manually published work missing from workspace", workspace)
			}
			input.RequestKey, input.Batch, input.ScheduledAt = id(), true, 0
			_, err = douyinCall(s, a, "records/create", input)
			if fault, ok := err.(exchangeFault); !ok || fault.ErrorCode() != "ARTIFACT_ALREADY_SUBMITTED" {
				t.Fatal("batch may repeat a known published work", err)
			}
		})
	}
}

func TestDouyinValidationAndTransitions(t *testing.T) {
	valid := douyinInput{RequestKey: id(), HandoffID: id(), AccountID: id(), Title: "😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀", Hashtags: []string{"上海"}}
	if err := validateDouyinInput(valid); err != nil {
		t.Fatal(err)
	}
	valid.Title += "😀"
	if validateDouyinInput(valid) == nil {
		t.Fatal("UTF16 title limit not enforced")
	}
	valid.Title = "标题"
	valid.Description = strings.Repeat("a", 999)
	if validateDouyinInput(valid) == nil {
		t.Fatal("caption and tags checked separately")
	}
	if !validDouyinResult("123456789", "https://www.douyin.com/video/123456789") || validDouyinResult("123456789", "https://evil.test/video/123456789") {
		t.Fatal("unsafe result URL")
	}
	prior := douyinRecord{State: "running"}
	next := douyinRecord{State: "accepted", ExternalID: "123456789", URL: "https://www.douyin.com/video/123456789", ResultSource: "platform"}
	if douyinTransition(prior, next) {
		t.Fatal("accepted without submitting boundary")
	}
	prior.State = "submitting"
	if !douyinTransition(prior, next) {
		t.Fatal("platform receipt rejected")
	}
	prior.State = "unknown"
	if !douyinTransition(prior, next) {
		t.Fatal("late platform receipt rejected")
	}
	prior.ResultSource = "manual"
	if douyinTransition(prior, next) {
		t.Fatal("late result replaced manual decision")
	}
	raw, _ := json.Marshal(douyinAdminProjection(douyinRecord{douyinInput: douyinInput{Title: "private title", Description: "private caption", CoverRef: "private local ref"}}, true))
	if strings.Contains(string(raw), "private") {
		t.Fatal("admin leaked local content")
	}
}
func TestPlatformAccountIsolation(t *testing.T) {
	s, a, input := douyinFixture(t)
	var accounts = mustDouyin(t, s, a, "accounts/list", object{}).(object)["items"].([]object)
	if len(accounts) != 1 || accounts[0]["platform"] != "douyin" {
		t.Fatal("legacy account must remain on Douyin")
	}
	profile := object{"id": id(), "name": "小红书", "platform": "xhs", "loginStatus": "logged_in", "platformUserId": "0123456789abcdef01234567"}
	mustDouyin(t, s, a, "accounts/bind", profile)
	profile["savedProfile"] = true
	mustDouyin(t, s, a, "accounts/update", profile)
	input.AccountID = profile["id"].(string)
	_, err := douyinCall(s, a, "records/create", input)
	expectExchangeStatus(t, err, 409)
	profile["platform"] = "douyin"
	_, err = douyinCall(s, a, "accounts/update", profile)
	expectExchangeStatus(t, err, 409)
	profile["id"], profile["platform"], profile["savedProfile"] = id(), "xhs", false
	mustDouyin(t, s, a, "accounts/bind", profile)
	profile["savedProfile"] = true
	_, err = douyinCall(s, a, "accounts/update", profile)
	expectExchangeStatus(t, err, 409)
}

func TestDouyinIdempotencyOwnershipAndUnknownRecovery(t *testing.T) {
	s, a, input := douyinFixture(t)
	record := createdDouyin(t, s, a, input)
	replay := mustDouyin(t, s, a, "records/create", input).(object)
	if replay["created"] != false || replay["record"].(douyinRecord).ID != record.ID {
		t.Fatal("idempotency failed")
	}
	changed := input
	changed.Title = "changed"
	_, err := douyinCall(s, a, "records/create", changed)
	expectExchangeStatus(t, err, 409)
	other := a
	other.UserID = "another-owner"
	_, err = douyinCall(s, other, "records/get", object{"id": record.ID})
	expectExchangeStatus(t, err, 404)
	other = a
	other.DeviceID = "other-device"
	record.State = "submitting"
	_, err = douyinCall(s, other, "records/report", record)
	expectExchangeStatus(t, err, 409)
	mustDouyin(t, s, a, "records/report", record)
	record.State = "unknown"
	record.ErrorCode = "PUBLISH_OUTCOME_UNKNOWN"
	mustDouyin(t, s, a, "records/report", record)
	next := input
	next.RequestKey = id()
	_, err = douyinCall(s, a, "records/create", next)
	expectExchangeStatus(t, err, 409)
	result := mustDouyin(t, s, a, "records/reconcile", object{"id": record.ID, "published": false}).(douyinRecord)
	if result.ResultSource != "manual" || result.ErrorCode != "USER_CONFIRMED_NOT_PUBLISHED" {
		t.Fatal("manual resolution missing")
	}
	if replay := mustDouyin(t, s, a, "records/reconcile", object{"id": record.ID, "published": false}).(douyinRecord); replay.ID != record.ID {
		t.Fatal("manual resolution replay failed")
	}
	record.State = "accepted"
	record.ErrorCode = ""
	record.ExternalID = "123456789"
	record.URL = "https://www.douyin.com/video/123456789"
	record.ResultSource = "platform"
	_, err = douyinCall(s, a, "records/report", record)
	expectExchangeStatus(t, err, 409)
	createdDouyin(t, s, a, next)
}
func TestDouyinReviewChangedAndAccountDeviceBlocked(t *testing.T) {
	s, a, input := douyinFixture(t)
	handoffRaw, err := s.artifactExchange(t.Context(), a, "/v1/artifact-handoffs/get", []byte(`{"id":"`+input.HandoffID+`"}`))
	if err != nil {
		t.Fatal(err)
	}
	handoff := handoffRaw.(artifactHandoff)
	mustExchange(t, s, a, "/v1/artifacts/review", object{"id": handoff.Artifact.ID, "expectedRevision": handoff.Artifact.Review.Revision, "state": "pending"})
	_, err = douyinCall(s, a, "records/create", input)
	expectExchangeStatus(t, err, 409)
}
func TestDouyinConcurrentDeviceExecutionAndHeartbeatRecovery(t *testing.T) {
	s, a, input := douyinFixture(t)
	var wg sync.WaitGroup
	var mu sync.Mutex
	created := []douyinRecord{}
	conflicts := 0
	for n := 0; n < 2; n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			value := input
			value.RequestKey = id()
			out, err := douyinCall(s, a, "records/create", value)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				conflicts++
				return
			}
			created = append(created, out.(object)["record"].(douyinRecord))
		}()
	}
	wg.Wait()
	if len(created) != 1 || conflicts != 1 {
		t.Fatalf("concurrent starts: %d records %d conflicts", len(created), conflicts)
	}
	record := created[0]
	record.State = "submitting"
	mustDouyin(t, s, a, "records/report", record)
	if _, err := s.db.Exec(`UPDATE keagent_douyin_publish SET heartbeat_at=now()-interval '2 minutes'`); err != nil {
		t.Fatal(err)
	}
	if err := s.sweepDouyin(t.Context()); err != nil {
		t.Fatal(err)
	}
	got := mustDouyin(t, s, a, "records/get", object{"id": record.ID}).(douyinRecord)
	if got.State != "unknown" {
		t.Fatal("submitted interruption not unknown")
	}
	record.State = "accepted"
	record.ExternalID = "123456789"
	record.URL = "https://www.douyin.com/video/123456789"
	record.ResultSource = "platform"
	mustDouyin(t, s, a, "records/report", record)
}
func TestDouyinAlertCountingAndReadOnlyAdmin(t *testing.T) {
	s, a, input := douyinFixture(t)
	for n := 0; n < 3; n++ {
		input.RequestKey = id()
		record := createdDouyin(t, s, a, input)
		record.State = "failed"
		record.ErrorCode = "EXECUTION_FAILED"
		mustDouyin(t, s, a, "records/report", record)
		mustDouyin(t, s, a, "records/report", record)
	}
	var mails int
	if err := s.db.QueryRow(`SELECT count(*) FROM keagent_douyin_mail`).Scan(&mails); err != nil || mails != 1 {
		t.Fatal("duplicate failure alert", mails, err)
	}
	input.RequestKey = id()
	record := createdDouyin(t, s, a, input)
	record.State = "failed"
	record.ErrorCode = "LOGIN_REQUIRED"
	mustDouyin(t, s, a, "records/report", record)
	input.RequestKey = id()
	record = createdDouyin(t, s, a, input)
	record.State = "submitting"
	mustDouyin(t, s, a, "records/report", record)
	record.State = "accepted"
	record.ExternalID = "123456789"
	record.URL = "https://www.douyin.com/video/123456789"
	record.ResultSource = "platform"
	mustDouyin(t, s, a, "records/report", record)
	if err := s.db.QueryRow(`SELECT count(*) FROM keagent_douyin_mail`).Scan(&mails); err != nil || mails != 2 {
		t.Fatal("recovery alert missing", mails, err)
	}
	request := httptest.NewRequest("POST", "/v1/admin/douyin/records", nil)
	_, err := s.adminDouyin(request, a, nil)
	expectExchangeStatus(t, err, 405)
	request = httptest.NewRequest("GET", "/v1/admin/douyin/records?limit=0", nil)
	_, err = s.adminDouyin(request, a, nil)
	expectExchangeStatus(t, err, 422)
}

func TestDouyinMailQueueFailureAndRetry(t *testing.T) {
	s, a, input := douyinFixture(t)
	for n := 0; n < 3; n++ {
		input.RequestKey = id()
		v := createdDouyin(t, s, a, input)
		v.State = "failed"
		v.ErrorCode = "EXECUTION_FAILED"
		mustDouyin(t, s, a, "records/report", v)
	}
	if _, err := s.db.Exec(`INSERT INTO keagent_setting(id,payload) VALUES('douyin-alerts','{"operationsEmail":"ops@example.test"}')`); err != nil {
		t.Fatal(err)
	}
	broken, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer broken.Close()
	go func() {
		connection, err := broken.Accept()
		if err == nil {
			connection.Close()
		}
	}()
	t.Setenv("DOUYIN_SMTP_HOST", "127.0.0.1")
	t.Setenv("DOUYIN_SMTP_PORT", strconv.Itoa(broken.Addr().(*net.TCPAddr).Port))
	t.Setenv("DOUYIN_SMTP_FROM", "test@example.test")
	t.Setenv("DOUYIN_SMTP_TLS", "none")
	t.Setenv("DOUYIN_SMTP_USERNAME", "")
	t.Setenv("DOUYIN_SMTP_PASSWORD", "")
	if err = s.deliverDouyinMail(t.Context()); err == nil {
		t.Fatal("SMTP failure not surfaced")
	}
	var attempts int
	var delayed bool
	if err = s.db.QueryRow(`SELECT attempts,next_at>now() FROM keagent_douyin_mail`).Scan(&attempts, &delayed); err != nil || attempts != 1 || !delayed {
		t.Fatal("retry delay missing", attempts, delayed, err)
	}
	if err = s.deliverDouyinMail(t.Context()); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	messages := make(chan string, 1)
	mailErrors := make(chan error, 1)
	go serveDouyinTestSMTP(listener, messages, mailErrors)
	t.Setenv("DOUYIN_SMTP_PORT", strconv.Itoa(listener.Addr().(*net.TCPAddr).Port))
	if _, err = s.db.Exec(`UPDATE keagent_douyin_mail SET next_at=now()-interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	if err = s.deliverDouyinMail(t.Context()); err != nil {
		t.Fatal(err)
	}
	select {
	case <-messages:
	case err := <-mailErrors:
		t.Fatal(err)
	case <-time.After(2 * time.Second):
		t.Fatal("mail not delivered to local SMTP fixture")
	}
	var sent bool
	if err = s.db.QueryRow(`SELECT attempts,sent_at IS NOT NULL FROM keagent_douyin_mail`).Scan(&attempts, &sent); err != nil || attempts != 2 || !sent {
		t.Fatal("delivery acknowledgment missing", attempts, sent, err)
	}
	if err = s.deliverDouyinMail(t.Context()); err != nil {
		t.Fatal(err)
	}
}

func TestPublishWorkspaceAndBatchDuplicateGuard(t *testing.T) {
	s, a, input := douyinFixture(t)
	first := mustDouyin(t, s, a, "workspace", object{"status": "unpublished", "limit": 1}).(object)
	if first["total"] != float64(1) || len(rows(first["items"])) != 1 {
		t.Fatal("approved artifact missing from workspace", first)
	}
	row := obj(rows(first["items"])[0])
	if row["deviceReady"] != true || row["title"] == "" || row["script"] != nil {
		t.Fatal("incorrect or excessive workspace fields", row)
	}
	record := createdDouyin(t, s, a, input)
	record.State = "submitting"
	mustDouyin(t, s, a, "records/report", record)
	record.State, record.ResultSource, record.ExternalID = "accepted", "platform", "123456789"
	record.URL, record.Progress = "https://www.douyin.com/video/123456789", 100
	mustDouyin(t, s, a, "records/report", record)
	empty := mustDouyin(t, s, a, "workspace", object{"status": "unpublished"}).(object)
	if empty["total"] != float64(0) || obj(empty["counts"])["accepted"] != float64(1) {
		t.Fatal("status buckets should count beyond the current filter", empty)
	}
	other := a
	other.UserID = "different-owner"
	if list := mustDouyin(t, s, other, "workspace", object{}).(object); list["total"] != float64(0) {
		t.Fatal("other owner should not see this artifact", list)
	}
	input.Batch, input.RequestKey = true, id()
	_, err := douyinCall(s, a, "records/create", input)
	if fault, ok := err.(exchangeFault); !ok || fault.ErrorCode() != "ARTIFACT_ALREADY_SUBMITTED" {
		t.Fatal("batch may repeat an accepted submission", err)
	}
}
