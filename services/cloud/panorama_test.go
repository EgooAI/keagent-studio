package main

import (
	"encoding/base64"
	"encoding/binary"
	"testing"
)

func TestSpeechChunks(t *testing.T) {
	first := base64.StdEncoding.EncodeToString([]byte{1, 2})
	second := base64.StdEncoding.EncodeToString([]byte{3, 4})
	for _, payload := range []string{`{"code":0,"data":"` + first + `"}` + "\n" + `{"code":0,"data":"` + second + `"}`, "{\n\"code\":0,\n\"data\":\"" + first + "\"\n}"} {
		pcm, err := decodeSpeech([]byte(payload))
		if err != nil || len(pcm) < 2 {
			t.Fatal("valid speech rejected", err)
		}
	}
	for _, payload := range []string{`{}`, `{"code":1}`, `{"code":0,"data":"%%%"}`, `{"code":0,"data":"` + first + `"}` + "\n" + `{"code":42}`, `{"code":0`} {
		if _, err := decodeSpeech([]byte(payload)); err == nil {
			t.Fatal("invalid or incomplete speech accepted")
		}
	}
}
func TestPanoramaValidationAndCapabilities(t *testing.T) {
	for _, key := range []string{"AI_API_KEY", "VOLC_TTS_API_KEY", "MINIMAX_API_KEY"} {
		t.Setenv(key, "")
	}
	s := &server{}
	value, err := s.panorama(t.Context(), actor{UserID: "a"}, "capabilities", []byte(`{}`))
	if err != nil || value.(object)["minimaxOpening"] != false || value.(object)["volcAvatar"] != nil {
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
