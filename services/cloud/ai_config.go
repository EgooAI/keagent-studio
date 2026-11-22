package main

import (
	"context"
	"net/url"
	"strings"
)

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
			service.Purpose = "公共音色与本人音色语音合成"
			service.Model = qwenAudioModel
			service.Endpoint = qwenSpeechEndpoint(values["DASHSCOPE_WORKSPACE_ID"], qwenSynthesis)
		case "voice-clone":
			service.Purpose = "本人音色复刻和查询"
			service.Model = qwenAudioModel
			service.Endpoint = qwenSpeechEndpoint(values["DASHSCOPE_WORKSPACE_ID"], "customization")
			if values["DASHSCOPE_VOICE_CLONE_ENABLED"] != "true" {
				service.Missing = append(service.Missing, "DASHSCOPE_VOICE_CLONE_ENABLED")
			}
		case "beike":
			service.Purpose = "查询房屋档案与室内照片"
			service.Endpoint = "https://gw-open.ke.com"

		}
		if len(service.Missing)+len(service.Issues) > 0 {
			service.State = "incomplete"
		}
		if spec.Fields[len(spec.Fields)-1].Kind == "secret" && values[spec.Fields[len(spec.Fields)-1].Key] == "" ||
			spec.Group == speechAIGroup && values["DASHSCOPE_API_KEY"] == "" {
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
