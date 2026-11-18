package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"
)

const qwenAudioModel = "qwen-audio-3.1-tts-plus"
const qwenSynthesis = "SpeechSynthesizer"
const maxSpeechResponse = 16 << 20

var qwenWorkspaceID = regexp.MustCompile(`^(?:llm-|ws-)[a-z0-9]{1,59}$`)
var qwenVoiceID = regexp.MustCompile(`^[a-zA-Z0-9_.-]{1,150}$`)

func qwenSpeechConfigured(ctx context.Context) bool {
	return !aiSnapshotFrom(ctx).locked[speechAIGroup] &&
		strings.TrimSpace(aiValue(ctx, "DASHSCOPE_API_KEY")) != "" &&
		qwenWorkspaceID.MatchString(aiValue(ctx, "DASHSCOPE_WORKSPACE_ID"))
}

func qwenSpeechEndpoint(workspace, operation string) string {
	if !qwenWorkspaceID.MatchString(workspace) || (operation != "customization" && operation != qwenSynthesis) {
		return ""
	}
	return "https://" + workspace + ".cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/" + operation
}

func (s *server) qwenSpeechRequest(ctx context.Context, operation, model string, input object, stream bool) ([]byte, error) {
	if !qwenSpeechConfigured(ctx) {
		return nil, fail(503, "云端未配置可用的阿里云百炼语音密钥和业务空间")
	}
	endpoint := qwenSpeechEndpoint(aiValue(ctx, "DASHSCOPE_WORKSPACE_ID"), operation)
	headers := http.Header{"Content-Type": {"application/json"}}
	headers.Set("Authorization", "Bearer "+strings.TrimSpace(aiValue(ctx, "DASHSCOPE_API_KEY")))
	if stream {
		headers.Set("X-DashScope-SSE", "enable")
		headers.Set("Accept", "text/event-stream")
	}
	body, err := json.Marshal(object{"model": model, "input": input})
	if err != nil {
		return nil, fail(422, "百炼语音请求参数无效")
	}
	return providerBody(ctx, http.MethodPost, endpoint, headers, body, maxSpeechResponse)
}

func (s *server) qwenVoiceCall(ctx context.Context, operation string, input object) ([]byte, error) {
	switch operation {
	case "create_voice", "list_voice", "query_voice", "delete_voice":
	default:
		return nil, fail(400, "无效的音色管理操作")
	}
	if s.speech != nil {
		return s.speech(ctx, operation, input, "")
	}
	input["action"] = operation
	return s.qwenSpeechRequest(ctx, "customization", "voice-enrollment", input, false)
}

func qwenEnrollmentInput(prefix, audio, format, language string) object {
	mime := map[string]string{"wav": "audio/wav", "mp3": "audio/mpeg", "m4a": "audio/mp4"}[format]
	hint := "zh"
	if language == "en-US" {
		hint = "en"
	}
	return object{
		"target_model": qwenAudioModel, "prefix": prefix,
		"audio": "data:" + mime + ";base64," + audio, "language_hints": []string{hint},
		"max_prompt_audio_length": 15,
	}
}

type qwenVoiceItem struct {
	VoiceID string `json:"voice_id"`
	Status  string `json:"status"`
}

type qwenVoiceOutput struct {
	qwenVoiceItem
	TargetModel string          `json:"target_model"`
	VoiceList   []qwenVoiceItem `json:"voice_list"`
}

func parseQwenVoiceResponse(raw []byte) (qwenVoiceOutput, error) {
	var response struct {
		Code   string           `json:"code"`
		Output *qwenVoiceOutput `json:"output"`
	}
	if json.Unmarshal(raw, &response) != nil || response.Code != "" || response.Output == nil {
		return qwenVoiceOutput{}, fail(502, "百炼返回的音色结果无效，请刷新核对")
	}
	return *response.Output, nil
}

func qwenEnrollmentRejected(err error) bool {
	var upstream providerHTTPError
	if !errors.As(err, &upstream) {
		return false
	}
	switch upstream.httpStatus {
	case 400, 401, 403, 413, 422, 429:
		return true
	}
	return false
}

func qwenVoiceNotFound(err error) bool {
	var upstream providerHTTPError
	return errors.As(err, &upstream) && (upstream.name == "BadRequest.VoiceNotFound" || upstream.httpStatus == http.StatusNotFound)
}

func (s *server) deleteQwenVoice(ctx context.Context, speaker string) error {
	raw, err := s.qwenVoiceCall(ctx, "delete_voice", object{"voice_id": speaker})
	if err != nil {
		if qwenVoiceNotFound(err) {
			return nil
		}
		return err
	}
	_, err = parseQwenVoiceResponse(raw)
	return err
}

func qwenSpeechEvent(data []byte) ([]byte, bool, error) {
	var event struct {
		Code   string `json:"code"`
		Output *struct {
			FinishReason string `json:"finish_reason"`
			Audio        struct {
				Data string `json:"data"`
			} `json:"audio"`
		} `json:"output"`
	}
	if json.Unmarshal(data, &event) != nil || event.Code != "" || event.Output == nil {
		return nil, false, fail(502, "百炼配音返回错误，请检查音色或服务配置")
	}
	pcm, err := base64.StdEncoding.Strict().DecodeString(event.Output.Audio.Data)
	if err != nil {
		return nil, false, fail(502, "百炼配音音频编码无效")
	}
	return pcm, event.Output.FinishReason == "stop", nil
}

func decodeQwenSpeech(data []byte) ([]byte, error) {
	return decodeQwenSpeechWithUsage(data, nil)
}

func decodeQwenSpeechWithUsage(data []byte, usage *providerUsage) ([]byte, error) {
	scanner := bufio.NewScanner(bytes.NewReader(data))
	scanner.Buffer(make([]byte, 4096), maxSpeechResponse)
	var audio, event bytes.Buffer
	var finished bool
	for scanner.Scan() {
		line := scanner.Bytes()
		if value, ok := bytes.CutPrefix(line, []byte("data:")); ok {
			event.Write(bytes.TrimPrefix(value, []byte(" ")))
			event.WriteByte('\n')
		}
		if len(line) != 0 || event.Len() == 0 {
			continue
		}
		if usage != nil {
			speechEventUsage(event.Bytes(), usage)
		}
		pcm, stop, err := qwenSpeechEvent(event.Bytes())
		if err != nil {
			return nil, err
		}
		audio.Write(pcm)
		finished = finished || stop
		event.Reset()
	}
	if scanner.Err() != nil || event.Len() != 0 || !finished || audio.Len() == 0 || audio.Len()%2 != 0 {
		return nil, fail(502, "百炼配音响应不完整或返回无效 PCM")
	}
	return audio.Bytes(), nil
}

func speechEventUsage(data []byte, usage *providerUsage) {
	var event struct {
		RequestID string `json:"request_id"`
		Usage     struct {
			Characters *int64 `json:"characters"`
			Input      *int64 `json:"input_tokens"`
			Output     *int64 `json:"output_tokens"`
		}
	}
	if json.Unmarshal(data, &event) != nil {
		return
	}
	if event.RequestID != "" {
		usage.ProviderRef = event.RequestID
	}
	if n := validUsageCount(event.Usage.Characters); n != nil && (usage.Characters == nil || *n >= *usage.Characters) {
		usage.Characters = n
		usage.Source = "provider"
	}
	if event.Usage.Input != nil {
		usage.InputTokens = event.Usage.Input
	}
	if event.Usage.Output != nil {
		usage.OutputTokens = event.Usage.Output
	}
}

func (s *server) synthesizePCM(ctx context.Context, language, text, voice, resource string, rate float64) (any, error) {
	if resource != qwenAudioModel || !qwenVoiceID.MatchString(voice) {
		return nil, fail(503, "百炼配音模型或音色无效")
	}
	input := object{"text": text, "voice": voice, "format": "pcm", "sample_rate": 24000, "rate": rate}
	switch language {
	case "zh-CN":
		input["language_hints"] = []string{"zh"}
	case "en-US":
		input["language_hints"] = []string{"en"}
	}
	var raw []byte
	var err error
	usage := providerUsage{Provider: "bailian", Model: resource, Unit: "characters", Status: "unknown"}
	if usageScope(ctx).owner != "" && (s.speech != nil || qwenSpeechConfigured(ctx)) {
		defer func() { s.recordProviderUsage(ctx, usage) }()
	}
	if s.speech != nil {
		raw, err = s.speech(ctx, qwenSynthesis, input, resource)
	} else {
		raw, err = s.qwenSpeechRequest(ctx, qwenSynthesis, resource, input, true)
	}
	if err != nil {
		usage.Status = providerUsageFailure(err)
		return nil, err
	}
	pcm, err := decodeQwenSpeechWithUsage(raw, &usage)
	if err != nil {
		if usage.Source == "provider" {
			usage.Source = "partial"
		}
		return nil, err
	}
	usage.Status = "succeeded"
	if usage.Characters == nil {
		characters := int64(utf8.RuneCountInString(text))
		usage.Characters, usage.Source = &characters, "request"
	}
	return object{"pcm": base64.StdEncoding.EncodeToString(pcm)}, nil
}
