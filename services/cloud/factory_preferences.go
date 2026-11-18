package main

import (
	"context"
	"strings"
)

func (s *server) factoryPreferences(ctx context.Context, a actor, input object) (object, error) {
	delete(input, "avatarId")
	if len(input) != 3 {
		return nil, fail(422, "请提供默认模板、版本和音色")
	}
	for _, key := range []string{"templateId", "templateVersion", "voiceId"} {
		value, ok := input[key].(string)
		if !ok || len(value) > 150 || strings.TrimSpace(value) != value {
			return nil, fail(422, "默认制作配置字段无效："+key)
		}
	}
	voiceID := currentPublicVoiceID(str(input["voiceId"]))
	result := object{"videoTemplate": object{"id": "", "version": ""}, "voiceId": voiceID, "propertyIds": []any{}, "requireScriptReview": true}
	var template object
	if str(input["templateId"]) != "" {
		if str(input["templateVersion"]) == "" {
			return nil, fail(422, "请选择默认模板的已上架版本")
		}
		var err error
		template, err = s.productionTemplate(ctx, object{"id": input["templateId"], "version": input["templateVersion"]})
		if err != nil {
			return nil, err
		}
		c := obj(obj(template["production"])["config"])
		result["videoTemplate"] = object{"id": template["id"], "version": template["version"]}
		result["videoMode"], result["aspectRatio"], result["outputResolution"] = c["videoMode"], c["aspectRatio"], c["resolution"]
	} else if input["templateVersion"] != "" {
		return nil, fail(422, "未选择模板时版本必须为空")
	}
	if voiceID != "" {
		language := ""
		public, err := s.publicVoices(ctx, false)
		if err != nil {
			return nil, err
		}
		for _, voice := range public {
			if voice.ID == voiceID {
				language = voice.Language
			}
		}
		if language == "" {
			voice, err := s.ownedVoice(ctx, a.UserID, voiceID)
			if err != nil || voice.Status != "ready" {
				return nil, fail(422, "默认音色已下架、尚未就绪或不属于本人，请重新选择")
			}
			language = voice.Language
		}
		if template != nil && language != str(obj(obj(template["production"])["config"])["language"]) {
			return nil, fail(422, "默认音色的语言与默认模板不一致")
		}
	}
	return result, nil
}
