package main

import (
	"encoding/base64"
	"encoding/binary"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestTOSOfficialSignature(t *testing.T) {
	u, _ := url.Parse("https://examplebucket.tos-cn-beijing.volces.com/exampleobject")
	now := time.Date(2022, 1, 1, 0, 0, 0, 0, time.UTC)
	headers := providerHeaders("GET", u, nil, "testAK", "testSK", "cn-beijing", "tos", now, true)
	if !strings.HasSuffix(headers.Get("Authorization"), "Signature=d40b66cf0054d1642843670d10fa095e1609c7896f25df217770b0abe717693b") {
		t.Fatal("official signature mismatch")
	}
	signed, _ := url.Parse(tosReadURL(u, "testAK", "testSK", "cn-beijing", now))
	if signed.Query().Get("X-Tos-Expires") != "3600" || signed.Query().Get("X-Tos-Signature") == "" {
		t.Fatal("missing presigned URL fields")
	}
}
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
	for _, key := range []string{"AI_API_KEY", "VOLC_TTS_API_KEY", "VOLC_ACCESS_KEY_ID", "VOLC_SECRET_ACCESS_KEY", "VOLC_TOS_BUCKET"} {
		t.Setenv(key, "")
	}
	s := &server{}
	value, err := s.panorama(t.Context(), actor{UserID: "a"}, "capabilities", []byte(`{}`))
	if err != nil || value.(object)["volcAvatar"] != false {
		t.Fatal("invalid capabilities")
	}
	for _, operation := range []string{"script", "tts", "audio", "avatar-submit", "avatar-query", "other"} {
		if _, err = s.panorama(t.Context(), actor{UserID: "a"}, operation, []byte(`{}`)); err == nil {
			t.Fatal("invalid request accepted", operation)
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
