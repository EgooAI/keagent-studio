package main

import (
	"encoding/binary"
	"strings"
	"testing"
)

func TestOpeningASRTiming(t *testing.T) {
	first := `{"output":{"text":"今天，","sentence":{"sentence_id":1,"sentence_end":true,"text":"今天，","words":[{"text":"今天","punctuation":"，","begin_time":800,"end_time":1200}]}}}`
	last := `{"output":{"text":"今天，看房","sentence":{"sentence_id":2,"sentence_end":true,"text":"看房","words":[{"text":"看","begin_time":2000,"end_time":2140},{"text":"房","begin_time":2150,"end_time":2500}]}}}`
	raw := []byte("data: " + first + "\n\ndata: " + last + "\n\n")
	cues, err := openingASRPhrases(raw, 3000)
	if err != nil || len(cues) != 2 || len(cues[0]) != 1 || len(cues[1]) != 2 || cues[0][0].Text != "今天，" || cues[0][0].Start != .8 || cues[0][0].End != 1.2 || cues[1][0].End != 2.14 || cues[1][1].Start != 2.15 || cues[1][1].Text != "房" {
		t.Fatalf("%v %v", cues, err)
	}
	for _, bad := range []string{last, strings.Replace(string(raw), "2140", "3101", 1), strings.Replace(string(raw), "2150", "1130", 1), `{"output":{"text":"missing timing"}}`} {
		if _, err := openingASRPhrases([]byte(bad), 3000); err == nil {
			t.Fatal("accepted incomplete timing")
		}
	}
	if cues, err := openingASRPhrases([]byte(`{"output":{"text":""}}`), 3000); err != nil || len(cues) != 0 {
		t.Fatal(err, cues)
	}
}
func TestOpeningASRWaveLimit(t *testing.T) {
	wav := make([]byte, 44+48000*30)
	copy(wav, "RIFF")
	copy(wav[8:], "WAVEfmt ")
	binary.LittleEndian.PutUint32(wav[16:], 16)
	wav[20] = 1
	wav[22] = 1
	binary.LittleEndian.PutUint32(wav[24:], 24000)
	wav[34] = 16
	copy(wav[36:], "data")
	binary.LittleEndian.PutUint32(wav[40:], 48000*30)
	if openingWAVDuration(wav) != 30000 || openingWAVDuration(wav[:50]) != 0 {
		t.Fatal("invalid WAV bounds")
	}
}

func TestOpeningTwoLinePages(t *testing.T) {
	text := "今天带大家看一套朝南的三居室。"
	var words []openingCue
	for i, ch := range []rune(text) {
		words = append(words, openingCue{string(ch), float64(i) / 10, float64(i+1) / 10})
	}
	pages := openingCaptionPages(words)
	if len(pages) != 1 || pages[0].Text != text || pages[0].End != words[len(words)-1].End {
		t.Fatal(pages)
	}
	long := append(words, words...)
	pages = openingCaptionPages(long)
	if len(pages) != 2 || pages[0].Text+pages[1].Text != text+text || len([]rune(pages[1].Text)) < 10 {
		t.Fatal(pages)
	}
}
