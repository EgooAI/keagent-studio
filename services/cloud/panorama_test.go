package main

import (
	"encoding/base64"
	"testing"
)

func TestSpeechChunks(t *testing.T) {
	first := base64.StdEncoding.EncodeToString([]byte{1, 2})
	second := base64.StdEncoding.EncodeToString([]byte{3, 4})
	event := func(audio string) string {
		return "event: result\r\ndata: " + `{"output":{"finish_reason":"null","audio":{"data":"` + audio + `"}}}` + "\r\n\r\n"
	}
	end := "data: {\"output\":\ndata: {\"finish_reason\":\"stop\"}}\n\n"
	pcm, err := decodeQwenSpeech([]byte(": heartbeat\n\n" + event(first) + event(second) + end))
	if err != nil || string(pcm) != "\x01\x02\x03\x04" {
		t.Fatalf("valid PCM stream rejected: %x %v", pcm, err)
	}
	for _, payload := range []string{`{}`, end, event("%%%") + end, event(first), event("AQ==") + end, event(first) + "data: {\"code\":\"InternalError\"}\n\n", event(first) + "data: {\"output\":"} {
		if _, err := decodeQwenSpeech([]byte(payload)); err == nil {
			t.Fatalf("invalid or incomplete stream accepted: %q", payload)
		}
	}
}
func TestPanoramaValidationAndCapabilities(t *testing.T) {
	for _, key := range []string{"AI_API_KEY", "DASHSCOPE_API_KEY", "DASHSCOPE_WORKSPACE_ID", "MINIMAX_API_KEY"} {
		t.Setenv(key, "")
	}
	t.Setenv("MINIMAX_API_KEY", "historical-key")
	s := &server{}
	value, err := s.panorama(t.Context(), actor{UserID: "a"}, "capabilities", []byte(`{}`))
	if err != nil || value.(object)["minimaxOpening"] != false || value.(object)["bailianTts"] != false {
		t.Fatal("invalid capabilities")
	}
	_, err = s.panorama(t.Context(), actor{UserID: "a"}, "opening-submit", []byte(`{"authorized":true}`))
	if retired, ok := err.(fault); !ok || retired.status != 410 {
		t.Fatalf("retired opening submitted: %v", err)
	}
	for _, operation := range []string{"script", "tts", "other"} {
		if _, err = s.panorama(t.Context(), actor{UserID: "a"}, operation, []byte(`{}`)); err == nil {
			t.Fatal("invalid request accepted", operation)
		}
	}
	for _, operation := range []string{"audio", "avatar-submit", "avatar-query"} {
		_, err := s.panorama(t.Context(), actor{UserID: "a"}, operation, []byte(`{}`))
		if f, ok := err.(fault); !ok || f.status != 404 {
			t.Fatalf("retired operation %q is still available: %v", operation, err)
		}
	}
}
