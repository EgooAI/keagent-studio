package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
)

var resourceID = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,150}$`)
var providerLogID = regexp.MustCompile(`^[a-fA-F0-9-]{16,64}$`)
var providerErrorName = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$`)

func digestBytes(b []byte) string { d := sha256.Sum256(b); return hex.EncodeToString(d[:]) }

type providerHTTPError struct {
	fault
	httpStatus, code int
	logID            string
	name             string
}

func (e providerHTTPError) Unwrap() error { return e.fault }

func providerResponseFailure(response *http.Response) providerHTTPError {
	status := response.StatusCode
	err := providerHTTPError{fault: fault{502, fmt.Sprintf("供应商 HTTP %d；请检查云端配置，提交结果请先核对", status)}, httpStatus: status}
	var payload struct {
		Code      json.RawMessage `json:"code"`
		RequestID string          `json:"request_id"`
		Header    struct {
			Code int `json:"code"`
		} `json:"header"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&payload) == nil {
		if err.logID == "" && providerLogID.MatchString(payload.RequestID) {
			err.logID = payload.RequestID
		}
		_ = json.Unmarshal(payload.Code, &err.code)
		_ = json.Unmarshal(payload.Code, &err.name)
		if !providerErrorName.MatchString(err.name) {
			err.name = ""
		}
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
func (s *server) panorama(ctx context.Context, a actor, operation string, body []byte) (any, error) {
	var input object
	if json.Unmarshal(body, &input) != nil {
		return nil, fail(400, "参数格式无效")
	}
	switch operation {
	case "script-vision", "script", "tts", "opening-query":
		var err error
		ctx, err = withBillingTask(ctx, input, operation)
		if err != nil {
			return nil, err
		}
	}
	switch operation {
	case "image-submit", "image-query":
		return nil, fail(410, "AI 扩图已移除，请使用原始 VR 全景图")
	case "beike-import":
		return s.fetchBeike(ctx, input)
	case "opening-submit":
		return nil, fail(410, "MiniMax 开场生成已停用，请使用本机开场视频")
	case "opening-query":
		return s.queryProductionOpening(ctx, a, input)
	case "mix-save", "mix-resolve":
		return s.factoryMix(ctx, a, input, operation == "mix-save")
	case "capabilities":
		templates := []any{}
		var library object
		if input["bundleCatalog"] == true {
			var err error
			library, err = s.factoryLibrary(ctx, a.UserID)
			if err != nil {
				return nil, err
			}
		} else if input["runtimeOnly"] != true {
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
		if input["summary"] == true {
			for i, template := range templates {
				item := obj(template)
				summary := pickFields(item, "id", "name", "version", "description")
				summary["config"] = pickFields(obj(obj(item["production"])["config"]), "language", "videoMode", "aspectRatio", "resolution", "rate", "speed", "maxSweep", "design", "cameraMode")
				if obj(obj(item["production"])["opening"]) != nil {
					summary["opening"] = "minimax"
				}
				templates[i] = summary
			}
		}
		caps := object{"templates": templates, "ai": services[0].State == "configured", "bailianTts": qwenSpeechConfigured(ctx), "managedVoices": true, "beike": aiValue(ctx, "BEIKE_ACCESS_TOKEN") != "", "minimaxOpening": false}
		if library != nil {
			version := digestBytes(mustJSON(library))
			caps["catalogVersion"] = version
			if input["catalogVersion"] != version {
				caps["library"] = library
			}
		}
		return caps, nil
	case "template":
		template, err := s.productionTemplate(ctx, input)
		if err == nil && obj(obj(template["production"])["opening"]) != nil && input["openingRecipe"] != true {
			return nil, fail(409, "此模板需要新版桌面端，请更新后重试")
		}
		return template, err
	case "script-vision":
		template, err := s.jobProductionTemplate(ctx, a, input, true)
		if err != nil {
			return nil, err
		}
		config := obj(obj(template["production"])["config"])
		omitOpening := input["omitOpening"] == true && config["videoMode"] == "avatar"
		return s.chargedScript(ctx, a, input, func(chargeCtx context.Context) (any, error) {
			chargeCtx = s.withProviderUsage(chargeCtx, a.UserID, "script_vision")
			return generateVisionScript(chargeCtx, template, obj(input["property"]), rows(input["images"]), omitOpening)
		})
	case "script":
		expected := rows(input["segments"])
		language := str(input["language"])
		if len(expected) < 3 || len(expected) > 22 || (language != "zh-CN" && language != "en-US") {
			return nil, fail(422, "文案段落或语言无效")
		}
		instruction := "你是房产视频编导。仅使用输入房源事实和人工标注的空间说明，不编造学区、产权、朝向、收益。按输入模板改写。输出语言 " + language + "。只输出 JSON 数组，每项包含 id 和 text，id和顺序与输入segments一致。"
		if obj(expected[0])["id"] == "opening" {
			instruction += "开场宜在15秒内读完。"
		} else {
			instruction += "从第一个房源空间开始讲解，不写开场介绍。"
		}
		return s.chargedScript(ctx, a, input, func(chargeCtx context.Context) (any, error) {
			chargeCtx = s.withProviderUsage(chargeCtx, a.UserID, "script")
			content, err := generateWithInstruction(chargeCtx, input, instruction)
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
		characters := int64(len([]rune(str(input["text"]))))
		quantity := (characters + 999) / 1000
		ref, metadata := creditChargeDetails(ctx, "", "kilo_char", quantity, perKilo)
		metadata["characters"] = characters
		return s.chargeSync(ctx, a.UserID, "tts", ref, perKilo*quantity, digestBytes(mustJSON(input)), priceVersion, metadata, func(chargeCtx context.Context) (any, error) {
			chargeCtx = s.withProviderUsage(chargeCtx, a.UserID, "tts")
			return s.synthesizeVoice(chargeCtx, a, input)
		})
	}
	return nil, fail(404, "全景供应商能力不存在")
}
