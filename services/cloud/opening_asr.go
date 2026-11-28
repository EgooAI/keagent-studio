package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"
)

const openingASRModel = "qwen-audio-3.1-asr-flash"

type openingCue struct {
	Text  string  `json:"text"`
	Start float64 `json:"start"`
	End   float64 `json:"end"`
}

// Only the mono 24 kHz PCM file produced by the desktop extractor is accepted.
func openingWAVDuration(wav []byte) int {
	if len(wav) < 44 || string(wav[:4]) != "RIFF" || string(wav[8:12]) != "WAVE" {
		return 0
	}
	pcm := false
	for p := 12; p+8 <= len(wav); {
		size := int(binary.LittleEndian.Uint32(wav[p+4:]))
		chunk := wav[p : p+4]
		p += 8
		if size > len(wav)-p {
			return 0
		}
		switch string(chunk) {
		case "fmt ":
			pcm = size >= 16 && binary.LittleEndian.Uint16(wav[p:]) == 1 && binary.LittleEndian.Uint16(wav[p+2:]) == 1 && binary.LittleEndian.Uint32(wav[p+4:]) == 24000 && binary.LittleEndian.Uint16(wav[p+14:]) == 16
		case "data":
			if pcm && size > 0 && size%2 == 0 && p+size == len(wav) && size <= 30*48000 {
				return (size + 47) / 48
			}
			return 0
		}
		p += size + size%2
	}
	return 0
}

func (s *server) openingASR(ctx context.Context, input object) (any, error) {
	encoded, _ := input["audio"].(string)
	wav, err := base64.StdEncoding.Strict().DecodeString(encoded)
	duration := openingWAVDuration(wav)
	if err != nil || duration == 0 {
		return nil, fail(422, "请使用 30 秒以内的开场原声音轨")
	}
	if !qwenSpeechConfigured(ctx) {
		return nil, fail(503, "请在管理后台的 AI 服务配置中启用百炼语音，并填写北京地域 API Key 和业务空间 ID")
	}
	content := object{"type": "input_audio", "input_audio": object{"data": "data:audio/wav;base64," + encoded}}
	payload := object{"model": openingASRModel, "input": object{"messages": []object{{"role": "user", "content": []object{content}}}}, "parameters": object{"format": "wav", "sample_rate": "24000", "keep_dialect": true}}
	endpoint := "https://" + aiValue(ctx, "DASHSCOPE_WORKSPACE_ID") + ".cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
	headers := http.Header{"Content-Type": {"application/json"}, "Authorization": {"Bearer " + strings.TrimSpace(aiValue(ctx, "DASHSCOPE_API_KEY"))}, "X-DashScope-Sse": {"enable"}}
	raw, err := providerBody(ctx, http.MethodPost, endpoint, headers, mustJSON(payload), 2<<20)
	if err != nil {
		return nil, err
	}
	phrases, err := openingASRPhrases(raw, duration)
	if err != nil {
		return nil, err
	}
	if wantWords, _ := input["wordTiming"].(bool); wantWords {
		return object{"phrases": phrases}, nil
	}
	// Older desktop clients consume one timed cue per screen.
	cues := []openingCue{}
	for _, phrase := range phrases {
		cues = append(cues, openingCaptionPages(phrase)...)
	}
	return cues, nil
}

type openingWord struct {
	Text        string `json:"text"`
	Punctuation string `json:"punctuation"`
	Start       *int   `json:"begin_time"`
	End         *int   `json:"end_time"`
}
type openingSentence struct {
	ID    int           `json:"sentence_id"`
	Done  bool          `json:"sentence_end"`
	Words []openingWord `json:"words"`
	Text  string        `json:"text"`
}

func openingASRPhrases(raw []byte, duration int) ([][]openingCue, error) {
	invalid := fail(502, "百炼未返回完整的开场字幕时间轴，请重试")
	sentences := map[int]openingSentence{}
	var fullText string
	var received bool
	parse := func(data []byte) bool {
		var e struct {
			Code   string
			Output *struct {
				Text     *string
				Sentence *openingSentence
			}
		}
		if json.Unmarshal(data, &e) != nil || e.Code != "" || e.Output == nil {
			return false
		}
		if e.Output.Text != nil {
			fullText = *e.Output.Text
			received = true
		}
		if v := e.Output.Sentence; v != nil && v.Done {
			sentences[v.ID] = *v
		}
		return true
	}
	if bytes.HasPrefix(bytes.TrimSpace(raw), []byte("{")) {
		if !parse(raw) {
			return nil, invalid
		}
	} else {
		for line := range bytes.SplitSeq(raw, []byte("\n")) {
			if data, ok := bytes.CutPrefix(line, []byte("data:")); ok {
				data = bytes.TrimSpace(data)
				if string(data) != "[DONE]" && !parse(data) {
					return nil, invalid
				}
			}
		}
	}
	ids := []int{}
	for id := range sentences {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	phrases := [][]openingCue{}
	previousEnd := 0
	var transcript strings.Builder
	for _, id := range ids {
		sentence := sentences[id]
		transcript.WriteString(sentence.Text)
		if strings.TrimSpace(sentence.Text) != "" && len(sentence.Words) == 0 {
			return nil, invalid
		}
		var phrase []openingCue
		flush := func() {
			if len(phrase) > 0 {
				phrases = append(phrases, phrase)
			}
			phrase = nil
		}
		remaining := sentence.Text
		for _, word := range sentence.Words {
			if word.Start == nil || word.End == nil || *word.Start < previousEnd || *word.End <= *word.Start || *word.Start >= duration || *word.End > duration+100 || strings.TrimSpace(word.Text) == "" {
				return nil, invalid
			}
			if *word.Start-previousEnd >= 350 {
				flush()
			}
			cue := openingCue{Start: float64(*word.Start) / 1000}
			trimmed := strings.TrimLeftFunc(remaining, unicode.IsSpace)
			if len(trimmed) < len(remaining) {
				cue.Text += " "
			}
			token := word.Text + word.Punctuation
			remaining = strings.TrimPrefix(trimmed, strings.TrimSpace(token))
			cue.Text += token
			previousEnd = min(*word.End, duration)
			cue.End = float64(previousEnd) / 1000
			phrase = append(phrase, cue)
			if strings.ContainsAny(word.Punctuation, "。？！.!?；;") {
				flush()
			}
		}
		flush()
	}
	if !received || strings.Join(strings.Fields(transcript.String()), "") != strings.Join(strings.Fields(fullText), "") {
		return nil, invalid
	}
	return phrases, nil
}

// Balance consecutive pages so a few trailing words never need a page of their own.
func openingCaptionPages(words []openingCue) []openingCue {
	const capacity = 24
	width := 0
	for _, w := range words {
		width += utf8.RuneCountInString(w.Text)
	}
	var pages []openingCue
	for len(words) > 0 {
		pageCount := max(1, (width+capacity-1)/capacity)
		target := (width + pageCount - 1) / pageCount
		used := utf8.RuneCountInString(words[0].Text)
		cue := words[0]
		words = words[1:]
		for len(words) > 0 {
			next := utf8.RuneCountInString(words[0].Text)
			if used+next > capacity || (pageCount > 1 && used+next-target > target-used) {
				break
			}
			used += next
			cue.Text += words[0].Text
			cue.End = words[0].End
			words = words[1:]
		}
		width -= used
		cue.Text = strings.TrimSpace(cue.Text)
		pages = append(pages, cue)
	}
	return pages
}
