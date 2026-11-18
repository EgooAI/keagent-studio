package main

import (
	"encoding/base64"
	"encoding/binary"
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
	s := &server{}
	value, err := s.panorama(t.Context(), actor{UserID: "a"}, "capabilities", []byte(`{}`))
	if err != nil || value.(object)["minimaxOpening"] != false || value.(object)["bailianTts"] != false {
		t.Fatal("invalid capabilities")
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
func TestOpeningWAV(t *testing.T) {
	data := make([]byte, 48)
	copy(data, "RIFF")
	copy(data[8:], "WAVEfmt ")
	binary.LittleEndian.PutUint32(data[16:], 16)
	binary.LittleEndian.PutUint16(data[20:], 1)
	binary.LittleEndian.PutUint16(data[22:], 1)
	binary.LittleEndian.PutUint32(data[24:], 24000)
	binary.LittleEndian.PutUint32(data[28:], 48000)
	binary.LittleEndian.PutUint16(data[32:], 2)
	binary.LittleEndian.PutUint16(data[34:], 16)
	copy(data[36:], "data")
	binary.LittleEndian.PutUint32(data[40:], 4)
	if !validOpeningWAV(data) {
		t.Fatal("valid PCM rejected")
	}
	binary.LittleEndian.PutUint16(data[22:], 2)
	if validOpeningWAV(data) {
		t.Fatal("stereo accepted")
	}
	binary.LittleEndian.PutUint16(data[22:], 1)
	binary.LittleEndian.PutUint32(data[40:], 100000)
	if validOpeningWAV(data) {
		t.Fatal("truncated data accepted")
	}
}
