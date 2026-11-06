package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/png"
	"net/url"
	"strings"
	"testing"
)

func photoFixture() object {
	var data bytes.Buffer
	_ = png.Encode(&data, image.NewRGBA(image.Rect(0, 0, 32, 32)))
	return object{"name": "本人照片测试", "authorized": true, "photo": base64.StdEncoding.EncodeToString(data.Bytes()), "requestKey": id()}
}
func TestAvatarPhotoValidation(t *testing.T) {
	if _, _, err := validateAvatarPhoto(photoFixture()); err != nil {
		t.Fatal(err)
	}
	for key, value := range (object{"authorized": false, "photo": "%%%%", "requestKey": "bad", "name": ""}) {
		v := photoFixture()
		v[key] = value
		if _, _, err := validateAvatarPhoto(v); err == nil {
			t.Fatal("invalid photo accepted", key)
		}
	}
	var data bytes.Buffer
	_ = png.Encode(&data, image.NewRGBA(image.Rect(0, 0, 4097, 1)))
	v := photoFixture()
	v["photo"] = base64.StdEncoding.EncodeToString(data.Bytes())
	if _, _, err := validateAvatarPhoto(v); err == nil {
		t.Fatal("oversized dimensions accepted")
	}
}
func avatarTestServer(t *testing.T) *server {
	s := voiceTestServer(t)
	t.Setenv("VOLC_ACCESS_KEY_ID", "test-ak")
	t.Setenv("VOLC_SECRET_ACCESS_KEY", "test-sk")
	t.Setenv("VOLC_TOS_BUCKET", "test-photos")
	t.Setenv("VOLC_TOS_REGION", "cn-beijing")
	return s
}
func TestUploadedAvatarOwnershipAndVideoSubmission(t *testing.T) {
	s := avatarTestServer(t)
	objects := map[string][]byte{}
	puts, calls := 0, 0
	s.storage = func(_ context.Context, method, key string, data []byte, _ string) ([]byte, error) {
		if method == "PUT" {
			puts++
			objects[key] = bytes.Clone(data)
			return nil, nil
		}
		return objects[key], nil
	}
	a, b := actor{UserID: "a"}, actor{UserID: "b"}
	input := photoFixture()
	body, _ := json.Marshal(input)
	result, err := s.avatars(t.Context(), a, "create", body)
	if err != nil {
		t.Fatal(err)
	}
	created := result.(userAvatar)
	if created.Status != "ready" {
		t.Fatal(created)
	}
	repeated, err := s.avatars(t.Context(), a, "create", body)
	if err != nil || puts != 1 || repeated.(userAvatar).ID != created.ID {
		t.Fatal("photo replayed", err)
	}
	identity, _ := json.Marshal(object{"id": created.ID})
	for _, operation := range []string{"preview", "refresh", "remove"} {
		if _, err = s.avatars(t.Context(), b, operation, identity); err == nil {
			t.Fatal("cross-user photo access", operation)
		}
	}
	preview, err := s.avatars(t.Context(), a, "preview", identity)
	if err != nil || preview.(object)["photo"] != input["photo"] {
		t.Fatal("own photo preview failed", err)
	}
	s.vision = func(_ context.Context, action string, payload object) (object, error) {
		calls++
		if payload["req_key"] != photoAvatarProvider || payload["resource_id"] != nil {
			t.Fatal("global resource identity used")
		}
		if action == "CVSubmitTask" {
			u, _ := url.Parse(str(payload["image_url"]))
			if !strings.Contains(u.Path, "/avatars/"+created.ID+".png") || u.Query().Get("X-Tos-Signature") == "" {
				t.Fatal("uploaded photo not signed")
			}
			return object{"task_id": "test-task"}, nil
		}
		return object{"status": "done", "video_url": "https://example.test/test.mp4"}, nil
	}
	audioURL := "https://test-photos.tos-cn-beijing.volces.com/keagent/" + digestBytes([]byte(a.UserID)) + "/" + strings.Repeat("a", 64) + ".wav"
	submit, _ := json.Marshal(object{"avatarId": created.ID, "audioUrl": audioURL})
	if _, err = s.panorama(t.Context(), b, "avatar-submit", submit); err == nil || calls != 0 {
		t.Fatal("cross-user video submission accepted")
	}
	arbitrary, _ := json.Marshal(object{"resourceId": "arbitrary-provider-avatar", "audioUrl": audioURL})
	if _, err = s.panorama(t.Context(), a, "avatar-submit", arbitrary); err == nil || calls != 0 {
		t.Fatal("manual provider ID bypassed photo upload")
	}
	for range 2 {
		if _, err = s.panorama(t.Context(), a, "avatar-submit", submit); err != nil {
			t.Fatal(err)
		}
	}
	if calls != 1 {
		t.Fatal("video submitted twice")
	}
	query, _ := json.Marshal(object{"taskId": "test-task"})
	if _, err = s.panorama(t.Context(), a, "avatar-query", query); err != nil {
		t.Fatal(err)
	}
	if _, err = s.panorama(t.Context(), b, "avatar-query", query); err == nil {
		t.Fatal("cross-user video query")
	}
	if _, err = s.avatars(t.Context(), a, "remove", identity); err != nil {
		t.Fatal(err)
	}
	if _, err = s.panorama(t.Context(), a, "avatar-submit", submit); err == nil {
		t.Fatal("removed avatar used for a new submission")
	}
}
func TestPhotoUnknownUploadRecovery(t *testing.T) {
	s := avatarTestServer(t)
	var saved []byte
	puts := 0
	s.storage = func(_ context.Context, method, _ string, data []byte, _ string) ([]byte, error) {
		if method == "PUT" {
			puts++
			saved = bytes.Clone(data)
			return nil, context.DeadlineExceeded
		}
		return saved, nil
	}
	body, _ := json.Marshal(photoFixture())
	a := actor{UserID: "a"}
	result, err := s.avatars(t.Context(), a, "create", body)
	if err != nil || result.(userAvatar).Status != "unknown" {
		t.Fatal(result, err)
	}
	if _, err = s.avatars(t.Context(), a, "create", body); err != nil || puts != 1 {
		t.Fatal("unknown upload resubmitted")
	}
	identity, _ := json.Marshal(object{"id": result.(userAvatar).ID})
	refreshed, err := s.avatars(t.Context(), a, "refresh", identity)
	if err != nil || refreshed.(userAvatar).Status != "ready" {
		t.Fatal("uploaded object not recovered", err)
	}
	s.storage = func(context.Context, string, string, []byte, string) ([]byte, error) {
		return nil, context.DeadlineExceeded
	}
	missing, err := s.avatars(t.Context(), a, "refresh", identity)
	if err != nil || missing.(userAvatar).Status != "unknown" {
		t.Fatal("unavailable photo not marked for recovery", err)
	}
	if _, err = s.activeAvatar(t.Context(), a.UserID, result.(userAvatar).ID); err == nil {
		t.Fatal("unavailable photo still selectable")
	}
	if _, err = s.avatars(t.Context(), a, "remove", identity); err != nil {
		t.Fatal("unavailable photo cannot be removed", err)
	}
}
