package main

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"
)

var aiSampleHashes = []string{
	"13f64b98c131b910983c34d7fa54d29ae428472274c9229e0f76614b53733b8a",
	"3fc52cef201709baa151aea666cfcd20fa142043749c1046c9f48868e9308637",
}

func validateAIProbeInput(service, mode string, input object) error {
	if mode == "connection" {
		return nil
	}
	switch service {
	case "script":
		count := 2
		images := rows(input["images"])
		if len(images) != count {
			return fail(422, "测试示例图片数量无效")
		}
		for i, raw := range images {
			data, err := base64.StdEncoding.Strict().DecodeString(str(raw))
			if err != nil || len(data) > 512<<10 || digestBytes(data) != aiSampleHashes[i] {
				return fail(422, "请使用随后台提供的测试图片")
			}
		}
	case "tts":
		if !resourceID.MatchString(str(input["voiceId"])) {
			return fail(422, "请选择测试用公共音色")
		}
	case "voice-clone":
		if mode == "training" {
			if input["authorized"] != true {
				return fail(422, "请确认已获得这份测试录音的使用授权")
			}
			_, err := decodeVoiceSample(str(input["audio"]), str(input["format"]))
			return err
		}
		if speaker := str(input["speaker"]); !qwenVoiceID.MatchString(speaker) || !strings.HasPrefix(speaker, qwenAudioModel+"-") {
			return fail(422, "请填写千问 3.1 Plus 的专用测试音色 ID")
		}
	case "beike":
		if input["authorized"] != true {
			return fail(422, "请确认此地址已授权用于测试")
		}
		for _, key := range []string{"cityName", "district", "address"} {
			value := strings.TrimSpace(str(input[key]))
			if value == "" || utf8.RuneCountInString(value) > 300 {
				return fail(422, "请填写授权地址的城市、区县和详细地址")
			}
		}
	}
	return nil
}
func (s *server) performAIProbe(ctx context.Context, p *aiProbe) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	spec, ok := specFor(p.Service)
	if !ok || p.Group != spec.Group {
		return fail(422, "测试服务无效")
	}
	values, err := readAIValues(ctx, s.db, p.Group, p.Version)
	if err != nil {
		return err
	}
	ctx = withAIGroup(ctx, p.Group, p.Version, values)
	if p.Progress.Task == "" {
		if err = s.aiStep(ctx, p, "检查已保存的配置"); err != nil {
			return err
		}
		missing, issues := aiConfigIssues(spec, values)
		needsCredentials := p.Mode != "connection" || spec.ID == "beike-cli"
		if len(issues) > 0 && (needsCredentials || spec.ID == "script" || spec.Group == speechAIGroup) {
			return fail(422, issues[0])
		}
		if len(missing) > 0 && needsCredentials {
			return fail(422, "缺少配置："+strings.Join(missing, "、"))
		}
	}
	if p.Service == "beike-cli" {
		return s.probeBeikeCLI(ctx, p)
	}
	if p.Mode == "connection" {
		return s.probeAIConnection(ctx, p)
	}
	var input object
	if err = openAI("ai-probe:"+p.ID, p.Input, &input); err != nil {
		return err
	}
	switch p.Service {
	case "script":
		if err = s.aiStep(ctx, p, "验证两张原图的逐图文案"); err != nil {
			return err
		}
		images := []any{}
		for i, value := range rows(input["images"]) {
			images = append(images, object{"id": []string{"probe-photo-1", "probe-photo-2"}[i], "kind": "photo", "jpeg": value})
		}
		template := object{"production": object{"config": object{"language": "zh-CN"}, "scriptRules": object{"overall": "简洁介绍示例房源", "opening": "简短开场", "scene": "按图片可见内容写一段", "closing": "简短结尾"}}}
		_, err = generateVisionScript(ctx, template, object{"title": "服务连通性验证示例房源"}, images, false)
		return err
	case "tts":
		voice, err := s.activePublicVoice(ctx, str(input["voiceId"]))
		if err != nil {
			return err
		}
		if err = s.aiStep(ctx, p, "合成并校验音频："+voice.Name+"（"+voice.Resource+"）"); err != nil {
			return err
		}
		sentence := "您好，这是配音服务测试。"
		if voice.Language == "en-US" {
			sentence = "This is a voice service test."
		}
		_, err = s.synthesizePCM(ctx, voice.Language, sentence, voice.Speaker, voice.Resource, 1)
		if err == nil {
			p.Progress.SpeechConfigFingerprint = speechConfigFingerprint(values)
		}
		return err
	case "voice-clone":
		if err = s.probeAIClone(ctx, p, input); err != nil {
			return err
		}
		p.Progress.SpeechConfigFingerprint = speechConfigFingerprint(values)
		return nil
	case "beike":
		_, err = s.lookupBeike(ctx, input, func(step string) error { return s.aiStep(ctx, p, step) })
		return err

	}
	return fail(422, "测试服务无效")
}
func (s *server) probeAIConnection(ctx context.Context, p *aiProbe) error {
	if err := s.aiStep(ctx, p, "连接供应商（仅验证网络与 TLS）"); err != nil {
		return err
	}
	endpoint := ""
	for _, service := range aiServicesFor(ctx) {
		if service.ID == p.Service {
			endpoint = service.Endpoint
		}
	}
	if endpoint == "" {
		return fail(422, "请先配置服务地址")
	}
	targets := []string{endpoint}
	client, transport := providerClient()
	defer transport.CloseIdleConnections()
	client.Timeout = 12 * time.Second
	for _, target := range targets {
		req, err := http.NewRequestWithContext(ctx, http.MethodHead, target, nil)
		if err != nil {
			return fail(422, "服务地址无效")
		}
		response, err := client.Do(req)
		if err != nil {
			return fail(422, "无法连接供应商，请检查 DNS、网络或 TLS")
		}
		response.Body.Close()
		if response.StatusCode >= 500 {
			return fail(422, "供应商服务暂不可用")
		}
	}
	p.Progress.Message = "网络连通，尚未验证凭证或生成能力"
	return nil
}
func (s *server) probeBeikeCLI(ctx context.Context, p *aiProbe) error {
	if err := s.aiStep(ctx, p, "验证贝壳 CLI 与 API Key"); err != nil {
		return err
	}
	ctx = context.WithValue(ctx, beikeSkipCacheKey{}, true)
	if _, err := beikeSearch(ctx, "北京", "望京"); err != nil {
		return err
	}
	p.Progress.Message = "贝壳 CLI 连通，已返回房源数据"
	return nil
}
func (s *server) probeAIClone(ctx context.Context, p *aiProbe, input object) (err error) {
	if !cloneConfigured(ctx) {
		return fail(422, "请先打开声音复刻并保存配置")
	}
	speaker := str(input["speaker"])
	if p.Mode == "training" {
		speaker, err = s.prepareAICloneProbe(ctx, p, input)
		if speaker != "" {
			defer func() {
				cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
				defer cancel()
				deleteErr := s.deleteQwenVoice(cleanup, speaker)
				if err == nil && deleteErr != nil {
					err = fail(502, "试听合成通过，临时音色删除未确认，请在百炼控制台核对")
				}
			}()
		}
		if err != nil {
			return err
		}
	}
	for {
		if err := s.aiStep(ctx, p, "查询专用测试音色状态"); err != nil {
			return err
		}
		raw, err := s.qwenVoiceCall(ctx, "query_voice", object{"voice_id": speaker})
		if err != nil {
			return err
		}
		voice, err := parseQwenVoiceResponse(raw)
		if err != nil {
			return err
		}
		if voice.TargetModel != qwenAudioModel {
			return fail(502, "测试音色与千问 3.1 Plus 模型不匹配")
		}
		if voice.Status == "OK" {
			break
		}
		if p.Mode != "training" || voice.Status != "DEPLOYING" {
			return fail(422, "专用测试音色未就绪，请在百炼控制台核对")
		}
		if err = waitAIProbe(ctx); err != nil {
			return err
		}
	}
	if err = s.aiStep(ctx, p, "用复刻音色合成并校验音频"); err != nil {
		return err
	}
	_, err = s.synthesizePCM(ctx, "zh-CN", "您好，这是本人音色合成测试。", speaker, qwenAudioModel, 1)
	return err
}

func (s *server) prepareAICloneProbe(ctx context.Context, p *aiProbe, input object) (string, error) {
	prefix := "p" + digestBytes([]byte(p.ID))[:9]
	voicePrefix := qwenAudioModel + "-" + prefix + "-"
	validSpeaker := func(voiceID string) bool {
		return strings.HasPrefix(voiceID, voicePrefix) && qwenVoiceID.MatchString(voiceID)
	}
	if validSpeaker(p.Progress.Task) {
		return p.Progress.Task, nil
	}
	if p.Progress.Task == "" {
		// Save the prefix before submitting so a resumed probe can only look up the existing attempt.
		p.Progress.Task = prefix
		if err := s.aiStep(ctx, p, "提交测试录音并创建临时音色"); err != nil {
			return "", err
		}
		raw, submitErr := s.qwenVoiceCall(ctx, "create_voice",
			qwenEnrollmentInput(prefix, str(input["audio"]), str(input["format"]), "zh-CN"))
		if submitErr == nil {
			voice, parseErr := parseQwenVoiceResponse(raw)
			if parseErr == nil && validSpeaker(voice.VoiceID) {
				p.Progress.Task = voice.VoiceID
				return voice.VoiceID, s.saveAIProgress(ctx, p)
			}
		} else {
			var upstream providerHTTPError
			if ctx.Err() != nil || errors.As(submitErr, &upstream) {
				return "", submitErr
			}
		}
	}
	if err := s.aiStep(ctx, p, "核对临时音色创建结果"); err != nil {
		return "", err
	}
	raw, err := s.qwenVoiceCall(ctx, "list_voice", object{"prefix": prefix, "page_index": 0, "page_size": 2})
	if err != nil {
		return "", err
	}
	result, err := parseQwenVoiceResponse(raw)
	if err != nil {
		return "", err
	}
	if len(result.VoiceList) != 1 || !validSpeaker(result.VoiceList[0].VoiceID) {
		return "", fail(502, "测试音色创建结果未知，请在百炼控制台核对")
	}
	speaker := result.VoiceList[0].VoiceID
	p.Progress.Task = speaker
	return speaker, s.saveAIProgress(ctx, p)
}
func waitAIProbe(ctx context.Context) error {
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
