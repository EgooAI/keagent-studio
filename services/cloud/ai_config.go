package main

import (
	"context"
	"net/url"
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

func publicAIURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return ""
	}
	return raw
}

func aiServicesFor(ctx context.Context) []aiService {
	snapshot := aiSnapshotFrom(ctx)
	services := make([]aiService, 0, len(aiSpecs))
	for _, spec := range aiSpecs {
		values := snapshot.values
		missing, issues := aiConfigIssues(spec, values)
		service := aiService{ID: spec.ID, Label: spec.Name, Provider: spec.Vendor, State: "configured", Missing: missing, Issues: issues, Note: "配置状态仅表示字段完整性，实际能力以测试记录为准。"}
		switch spec.ID {
		case "script":
			service.Purpose = "批次与逐图文案"
			service.Model = values["AI_MODEL"]
			service.Endpoint = strings.TrimRight(publicAIURL(values["AI_BASE_URL"]), "/")
		case "tts":
			service.Purpose = "公共音色语音合成"
			service.Model = "由公共音色指定"
			service.Endpoint = "https://openspeech.bytedance.com/api/v3/tts/unidirectional"
		case "avatar":
			service.Purpose = "本人照片与开场音频生成数字人"
			service.Model = photoAvatarProvider
			service.Endpoint = "https://visual.volcengineapi.com"
		case "voice-clone":
			service.Purpose = "本人音色训练和查询"
			service.Model = values["VOLC_VOICE_CLONE_RESOURCE_ID"]
			service.Endpoint = "https://openspeech.bytedance.com/api/v3/tts/get_voice"
			if values["VOLC_VOICE_CLONE_ENABLED"] != "true" {
				service.Missing = append(service.Missing, "VOLC_VOICE_CLONE_ENABLED")
			}
		case "expansion":
			service.Purpose = "普通房源照片扩图"
			service.Model = "wanx2.1-imageedit"
			service.Endpoint = publicAIURL(values["DASHSCOPE_BASE_URL"])
		case "beike":
			service.Purpose = "查询房屋档案与室内照片"
			service.Endpoint = "https://gw-open.ke.com"
		}
		if len(service.Missing)+len(service.Issues) > 0 {
			service.State = "incomplete"
		}
		if spec.Fields[len(spec.Fields)-1].Kind == "secret" && values[spec.Fields[len(spec.Fields)-1].Key] == "" ||
			spec.Group == "speech" && values["VOLC_TTS_API_KEY"] == "" ||
			spec.ID == "avatar" && values["VOLC_ACCESS_KEY_ID"] == "" && values["VOLC_SECRET_ACCESS_KEY"] == "" {
			service.State = "missing"
		}
		if snapshot.locked[spec.Group] {
			service.State = "incomplete"
			service.Issues = []string{"生效配置无法解密，请检查服务端加密密钥"}
		}
		services = append(services, service)
	}
	return services
}

func aiServices() []aiService { return aiServicesFor(context.Background()) }
func adminAIConfig() object {
	services := aiServices()
	script := services[0]
	return object{"configured": script.State == "configured", "model": script.Model, "baseURL": script.Endpoint, "services": services, "checkedAt": now()}
}
