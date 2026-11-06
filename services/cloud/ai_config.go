package main

import (
	"net"
	"net/url"
	"os"
	"regexp"
	"strings"
)

var speechResourceID = regexp.MustCompile(`^[a-zA-Z0-9_.-]{1,150}$`)

type aiService struct {
	ID       string   `json:"id"`
	Label    string   `json:"label"`
	Purpose  string   `json:"purpose"`
	Provider string   `json:"provider"`
	Model    string   `json:"model"`
	Endpoint string   `json:"endpoint"`
	State    string   `json:"state"`
	Missing  []string `json:"missing"`
	Issues   []string `json:"issues"`
	Note     string   `json:"note"`
}

func (s *aiService) checkRequired(keys ...string) {
	for _, key := range keys {
		if strings.TrimSpace(os.Getenv(key)) == "" {
			s.Missing = append(s.Missing, key)
		}
	}
}

func (s *aiService) setState(credentialMissing bool) {
	s.State = "configured"
	if len(s.Missing) != 0 || len(s.Issues) != 0 {
		s.State = "incomplete"
	}
	if credentialMissing {
		s.State = "missing"
	}
}

func aiServices() []aiService {
	note := "仅检查服务端配置；未发送供应商请求，不代表已通过真实生成验证。"
	script := aiService{ID: "script", Label: "AI 文案", Purpose: "云端批次文案与全景分段文案", Provider: "OpenAI 兼容接口", Model: os.Getenv("AI_MODEL"), Missing: []string{}, Issues: []string{}, Note: note}
	script.checkRequired("AI_API_KEY", "AI_MODEL", "AI_BASE_URL", "AI_ALLOWED_HOSTS")
	u, err := url.Parse(os.Getenv("AI_BASE_URL"))
	validURL := err == nil && u.Scheme == "https" && u.Hostname() != "" && u.User == nil && u.RawQuery == "" && u.Fragment == ""
	if validURL {
		ip := net.ParseIP(u.Hostname())
		if strings.EqualFold(u.Hostname(), "localhost") || (ip != nil && (ip.IsPrivate() || ip.IsLoopback() || ip.IsUnspecified() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast())) {
			validURL = false
		}
	}
	if validURL {
		script.Endpoint = strings.TrimRight(u.String(), "/")
		allowed := false
		for _, host := range strings.Split(os.Getenv("AI_ALLOWED_HOSTS"), ",") {
			if strings.EqualFold(strings.TrimSpace(host), u.Hostname()) {
				allowed = true
			}
		}
		if !allowed {
			script.Issues = append(script.Issues, "AI 服务域名未加入服务端允许列表")
		}
	} else if os.Getenv("AI_BASE_URL") != "" {
		script.Issues = append(script.Issues, "AI_BASE_URL 必须是无凭据、查询参数及片段的公共 HTTPS 地址")
	}
	script.setState(strings.TrimSpace(os.Getenv("AI_API_KEY")) == "")
	tts := aiService{ID: "tts", Label: "火山配音", Purpose: "全景讲解的云端语音合成", Provider: "火山引擎", Model: os.Getenv("VOLC_TTS_RESOURCE_ID"), Endpoint: "https://openspeech.bytedance.com/api/v3/tts/unidirectional", Missing: []string{}, Issues: []string{}, Note: note}
	tts.checkRequired("VOLC_TTS_API_KEY", "VOLC_TTS_RESOURCE_ID", "VOLC_TTS_SPEAKER")
	if value := os.Getenv("VOLC_TTS_SPEAKER"); value != "" && !resourceID.MatchString(value) {
		tts.Issues = append(tts.Issues, "VOLC_TTS_SPEAKER 格式无效")
	}
	if value := os.Getenv("VOLC_TTS_RESOURCE_ID"); value != "" && !speechResourceID.MatchString(value) {
		tts.Issues = append(tts.Issues, "VOLC_TTS_RESOURCE_ID 格式无效")
	}
	tts.setState(strings.TrimSpace(os.Getenv("VOLC_TTS_API_KEY")) == "")
	avatar := aiService{ID: "avatar", Label: "火山数字人", Purpose: "全景讲解的数字人开场", Provider: "火山引擎", Model: os.Getenv("VOLC_AVATAR_RESOURCE_ID"), Endpoint: "https://visual.volcengineapi.com", Missing: []string{}, Issues: []string{}, Note: note}
	avatar.checkRequired("VOLC_ACCESS_KEY_ID", "VOLC_SECRET_ACCESS_KEY", "VOLC_AVATAR_RESOURCE_ID", "VOLC_TOS_BUCKET")
	if value := os.Getenv("VOLC_AVATAR_RESOURCE_ID"); value != "" && !resourceID.MatchString(value) {
		avatar.Issues = append(avatar.Issues, "VOLC_AVATAR_RESOURCE_ID 格式无效")
	}
	if os.Getenv("VOLC_TOS_BUCKET") != "" {
		if _, _, err := tosEndpoint(); err != nil {
			avatar.Issues = append(avatar.Issues, "TOS 私有桶或地域格式无效")
		}
	}
	avatar.setState(strings.TrimSpace(os.Getenv("VOLC_ACCESS_KEY_ID")) == "" && strings.TrimSpace(os.Getenv("VOLC_SECRET_ACCESS_KEY")) == "")
	clone := aiService{ID: "voice-clone", Label: "声音复刻", Purpose: "用户上传录音创建个人音色，供全景讲解使用", Provider: "火山引擎", Model: cloneResource(), Endpoint: "https://openspeech.bytedance.com/api/v3/tts/voice_clone", Missing: []string{}, Issues: []string{}, Note: note}
	clone.checkRequired("VOLC_TTS_API_KEY")
	if os.Getenv("VOLC_VOICE_CLONE_ENABLED") != "true" {
		clone.Missing = append(clone.Missing, "VOLC_VOICE_CLONE_ENABLED")
	}
	if !speechResourceID.MatchString(cloneResource()) {
		clone.Issues = append(clone.Issues, "声音复刻资源编号格式无效")
	}
	clone.setState(strings.TrimSpace(os.Getenv("VOLC_TTS_API_KEY")) == "")
	return []aiService{script, tts, avatar, clone}
}

func adminAIConfig() object {
	services := aiServices()
	script := services[0]
	return object{"configured": script.State == "configured", "model": script.Model, "baseURL": script.Endpoint, "note": "密钥仅通过服务端环境配置；本页不展示密钥。", "checkedAt": now(), "services": services}
}
