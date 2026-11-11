package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
)

var resourceID = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,150}$`)
var providerLogID = regexp.MustCompile(`^[a-fA-F0-9]{16,64}$`)

func digestBytes(b []byte) string { d := sha256.Sum256(b); return hex.EncodeToString(d[:]) }

type providerHTTPError struct {
	fault
	httpStatus, code int
	logID            string
}

func (e providerHTTPError) Unwrap() error { return e.fault }

func providerResponseFailure(response *http.Response) providerHTTPError {
	status := response.StatusCode
	err := providerHTTPError{fault: fault{502, fmt.Sprintf("供应商 HTTP %d；请检查云端配置，提交结果请先核对", status)}, httpStatus: status}
	if logID := response.Header.Get("X-Tt-Logid"); providerLogID.MatchString(logID) {
		err.logID = logID
	}
	var payload struct {
		Code      int    `json:"code"`
		RequestID string `json:"request_id"`
		Header    struct {
			Code int `json:"code"`
		} `json:"header"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&payload) == nil {
		if err.logID == "" && providerLogID.MatchString(payload.RequestID) {
			err.logID = payload.RequestID
		}
		err.code = payload.Code
		if err.code == 0 {
			err.code = payload.Header.Code
		}
	}
	return err
}

func providerBody(ctx context.Context, method, endpoint string, headers http.Header, body []byte, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, method, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, fail(422, "供应商请求无效")
	}
	req.Header = headers
	client, transport := providerClient()
	defer transport.CloseIdleConnections()
	response, err := client.Do(req)
	if err != nil {
		return nil, fail(502, "供应商结果未知，请核对后处理")
	}
	defer response.Body.Close()
	if response.StatusCode/100 != 2 {
		if method == http.MethodPost && response.StatusCode >= 500 {
			return nil, fail(502, "供应商提交结果未知，请核对后处理")
		}
		return nil, providerResponseFailure(response)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil || int64(len(data)) > limit {
		if method == http.MethodPost {
			return nil, fail(502, "供应商提交结果未知，请核对后处理")
		}
		return nil, fail(502, "供应商响应不完整或过大")
	}
	return data, nil
}
func decodeSpeech(data []byte) ([]byte, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	var audio bytes.Buffer
	for {
		var chunk struct {
			Code int    `json:"code"`
			Data string `json:"data"`
		}
		err := decoder.Decode(&chunk)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fail(502, "火山 TTS 响应不完整")
		}
		if chunk.Code != 0 && chunk.Code != 20000000 {
			return nil, fail(502, fmt.Sprintf("火山 TTS code=%d", chunk.Code))
		}
		if chunk.Data != "" {
			part, err := base64.StdEncoding.DecodeString(chunk.Data)
			if err != nil {
				return nil, fail(502, "TTS 音频编码无效")
			}
			audio.Write(part)
		}
	}
	if audio.Len() == 0 || audio.Len()%2 != 0 {
		return nil, fail(502, "TTS 返回空音频或无效 PCM")
	}
	return audio.Bytes(), nil
}
func validOpeningWAV(data []byte) bool {
	return openingWAVBytes(data) > 0
}
func openingWAVBytes(data []byte) int {
	if len(data) < 44 || len(data) > 1500000 || string(data[:4]) != "RIFF" || string(data[8:12]) != "WAVE" {
		return 0
	}
	formatOK, audioBytes := false, 0
	for offset := 12; offset+8 <= len(data); {
		size := int(binary.LittleEndian.Uint32(data[offset+4 : offset+8]))
		start := offset + 8
		if size > len(data)-start {
			return 0
		}
		switch string(data[offset : offset+4]) {
		case "fmt ":
			if size < 16 {
				return 0
			}
			b := data[start : start+16]
			formatOK = binary.LittleEndian.Uint16(b[:2]) == 1 && binary.LittleEndian.Uint16(b[2:4]) == 1 && binary.LittleEndian.Uint32(b[4:8]) == 24000 && binary.LittleEndian.Uint32(b[8:12]) == 48000 && binary.LittleEndian.Uint16(b[12:14]) == 2 && binary.LittleEndian.Uint16(b[14:16]) == 16
		case "data":
			if audioBytes != 0 || size <= 0 || size > 30*48000 || size%2 != 0 {
				return 0
			}
			audioBytes = size
		}
		offset = start + size + size%2
	}
	if !formatOK {
		return 0
	}
	return audioBytes
}
func (s *server) panorama(ctx context.Context, a actor, operation string, body []byte) (any, error) {
	var input object
	if json.Unmarshal(body, &input) != nil {
		return nil, fail(400, "参数格式无效")
	}
	switch operation {
	case "beike-import", "image-submit", "image-query":
		return s.productionImage(ctx, a, operation, input)
	case "opening-submit", "opening-query":
		return s.productionOpening(ctx, a, operation, input)
	case "capabilities":
		templates := []any{}
		if input["runtimeOnly"] != true {
			var err error
			templates, err = s.productionTemplates(ctx, input["openingRecipe"] == true)
			if err != nil {
				return nil, err
			}
		}
		if refs, ok := input["templateIds"].([]any); ok {
			selected := map[string]bool{}
			for _, ref := range refs {
				selected[str(ref)] = true
			}
			filtered := templates[:0]
			for _, template := range templates {
				if selected[str(obj(template)["id"])] {
					filtered = append(filtered, template)
				}
			}
			templates = filtered
		}
		services := aiServicesFor(ctx)
		_, _, imageConfigErr := expansionConnection(ctx)
		if input["summary"] == true {
			for i, template := range templates {
				item := obj(template)
				summary := pickFields(item, "id", "name", "version", "description")
				summary["config"] = pickFields(obj(obj(item["production"])["config"]), "language", "videoMode", "aspectRatio", "resolution")
				if obj(obj(item["production"])["opening"]) != nil {
					summary["opening"] = "minimax"
				}
				templates[i] = summary
			}
		}
		return object{"templates": templates, "ai": services[0].State == "configured", "volcTts": services[1].State == "configured", "managedVoices": true, "beike": aiValue(ctx, "BEIKE_ACCESS_TOKEN") != "", "imageExpansion": imageConfigErr == nil, "minimaxOpening": minimaxConfigured(ctx)}, nil
	case "template":
		template, err := s.productionTemplate(ctx, input)
		if err == nil && obj(obj(template["production"])["opening"]) != nil && input["openingRecipe"] != true {
			return nil, fail(409, "此模板需要新版桌面端，请更新后重试")
		}
		return template, err
	case "script-vision":
		template, err := s.loadProductionTemplate(ctx, object{"id": input["templateId"], "version": input["templateVersion"]}, input["openingRecipe"] == true)
		if err != nil {
			return nil, err
		}
		return s.chargedScript(ctx, a, input, func(chargeCtx context.Context) (any, error) {
			return generateVisionScript(chargeCtx, template, obj(input["property"]), rows(input["images"]))
		})
	case "script":
		expected := rows(input["segments"])
		language := str(input["language"])
		if len(expected) < 3 || len(expected) > 22 || (language != "zh-CN" && language != "en-US") {
			return nil, fail(422, "文案段落或语言无效")
		}
		return s.chargedScript(ctx, a, input, func(chargeCtx context.Context) (any, error) {
			content, err := generateWithInstruction(chargeCtx, input, "你是房产视频编导。仅使用输入房源事实和人工标注的空间说明，不编造学区、产权、朝向、收益。按输入模板改写。输出语言 "+language+"。只输出 JSON 数组，每项包含 id 和 text，id和顺序与输入segments一致。开场宜在15秒内读完。")
			if err != nil {
				return nil, fail(502, err.Error())
			}
			content = strings.TrimSpace(content)
			content = strings.TrimPrefix(content, "```json")
			content = strings.TrimPrefix(content, "```")
			content = strings.TrimSuffix(strings.TrimSpace(content), "```")
			var segments []object
			if json.Unmarshal([]byte(content), &segments) != nil || len(segments) != len(expected) {
				return nil, fail(502, "AI 返回无效的分段文案")
			}
			for i, segment := range segments {
				if str(segment["id"]) != str(obj(expected[i])["id"]) || len([]rune(str(segment["text"]))) == 0 || len([]rune(str(segment["text"]))) > 2000 {
					return nil, fail(502, "AI 文案与空间不匹配")
				}
			}
			return segments, nil
		})
	case "tts":
		if err := validateVoiceSynthesis(input); err != nil {
			return nil, err
		}
		prices, priceVersion, err := readCreditPricing(ctx, s.db)
		if err != nil {
			return nil, err
		}
		perKilo := prices["tts_per_kilo_char"]
		amount := perKilo * int64((len([]rune(str(input["text"])))+999)/1000)
		return s.chargeSync(ctx, a.UserID, "tts", "", amount, digestBytes(mustJSON(input)), priceVersion, nil, func(chargeCtx context.Context) (any, error) {
			return s.synthesizeVoice(chargeCtx, a, input)
		})
	}
	return nil, fail(404, "全景供应商能力不存在")
}
