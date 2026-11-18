package main

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

const voiceSchema = `CREATE TABLE IF NOT EXISTS keagent_voice (
 id text PRIMARY KEY, owner_id text NOT NULL, request_key text NOT NULL,
 fingerprint text NOT NULL, payload jsonb NOT NULL, archived boolean NOT NULL DEFAULT false,
 UNIQUE(owner_id,request_key));
 CREATE INDEX IF NOT EXISTS keagent_voice_owner_idx ON keagent_voice(owner_id) WHERE NOT archived;`
const maxVoiceAudio = 10 * 1024 * 1024

type userVoice struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Language  string `json:"language"`
	Status    string `json:"status"`
	Error     string `json:"error,omitempty"`
	CreatedAt string `json:"createdAt"`
}
type storedVoice struct {
	userVoice
	Speaker       string `json:"speaker"`
	Resource      string `json:"resource"`
	Workspace     string `json:"workspace"`
	AuthorizedAt  string `json:"authorizedAt"`
	Version       int64  `json:"version"`
	ConfigVersion int64  `json:"configVersion"`
}

func cloneConfigured(ctx context.Context) bool {
	return aiValue(ctx, "DASHSCOPE_VOICE_CLONE_ENABLED") == "true" && qwenSpeechConfigured(ctx)
}

const retiredVoiceMessage = "旧音色无法在阿里云百炼使用，请重新上传录音复刻"

func (v *storedVoice) markRetired() {
	if v.Resource != qwenAudioModel {
		v.Status = "failed"
		v.Error = retiredVoiceMessage
	}
}

func validateVoiceUpload(input object) ([]byte, error) {
	if str(input["provider"]) != "bailian" {
		return nil, fail(422, "请更新桌面端并确认将录音提交给阿里云百炼")
	}
	if input["authorized"] != true {
		return nil, fail(422, "请确认声音属于本人或已获得明确授权")
	}
	name, language, key := strings.TrimSpace(str(input["name"])), str(input["language"]), str(input["requestKey"])
	if name == "" || len([]rune(name)) > 40 || (language != "zh-CN" && language != "en-US") || len(key) < 16 || len(key) > 100 {
		return nil, fail(422, "音色名称、语言或请求标识无效")
	}
	return decodeVoiceSample(str(input["audio"]), str(input["format"]))
}

func decodeVoiceSample(encoded, format string) ([]byte, error) {
	if len(encoded) > base64.StdEncoding.EncodedLen(maxVoiceAudio) {
		return nil, fail(413, "声音样本不能超过10 MB")
	}
	data, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil || len(data) < 32 || len(data) > maxVoiceAudio {
		return nil, fail(422, "声音样本无效或超过10 MB")
	}
	valid := format == "wav" && string(data[:4]) == "RIFF" && string(data[8:12]) == "WAVE" || format == "mp3" && (string(data[:3]) == "ID3" || data[0] == 0xff && data[1]&0xe0 == 0xe0) || format == "m4a" && string(data[4:8]) == "ftyp"
	if !valid {
		return nil, fail(422, "请选择真实的 WAV、MP3 或 M4A 录音文件")
	}
	return data, nil
}

func (s *server) ownedVoice(ctx context.Context, owner, voiceID string) (storedVoice, error) {
	var v storedVoice
	var raw []byte
	err := s.db.QueryRowContext(ctx, `SELECT payload FROM keagent_voice WHERE id=$1 AND owner_id=$2 AND NOT archived`, voiceID, owner).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return v, fail(404, "音色不存在或无权访问")
	}
	if err != nil {
		return v, err
	}
	err = json.Unmarshal(raw, &v)
	v.markRetired()
	return v, err
}
func (s *server) saveVoiceStatus(ctx context.Context, owner string, v storedVoice) error {
	// A late query must not overwrite a newer provider checkpoint.
	patch, _ := json.Marshal(object{"status": v.Status, "error": v.Error, "speaker": v.Speaker, "version": v.Version + 1})
	_, err := s.db.ExecContext(ctx, `UPDATE keagent_voice SET payload=payload || $3::jsonb WHERE id=$1 AND owner_id=$2 AND NOT archived AND COALESCE((payload->>'version')::bigint,0)=$4`, v.ID, owner, patch, v.Version)
	return err
}
func voiceResult(v *storedVoice, status string) error {
	v.Error = ""
	switch status {
	case "OK":
		v.Status = "ready"
	case "DEPLOYING":
		v.Status = "processing"
	case "UNDEPLOYED":
		v.Status = "failed"
		v.Error = "声音复刻未通过百炼审核，请更换清晰的单人录音后重新创建"
	default:
		return fail(502, "百炼返回无效音色状态，请稍后刷新")
	}
	return nil
}
func (s *server) voiceProviderContext(ctx context.Context, v storedVoice) (context.Context, error) {
	if qwenSpeechConfigured(ctx) && aiValue(ctx, "DASHSCOPE_WORKSPACE_ID") == v.Workspace {
		return ctx, nil
	}
	pinned, err := s.pinnedAI(ctx, speechAIGroup, v.ConfigVersion)
	if err != nil {
		return ctx, err
	}
	if !qwenSpeechConfigured(pinned) || aiValue(pinned, "DASHSCOPE_WORKSPACE_ID") != v.Workspace {
		return ctx, fail(503, "该音色的百炼业务空间暂不可用，请联系管理员")
	}
	return pinned, nil
}

func qwenEnrollmentPrefix(voiceID string) string { return "k" + digestBytes([]byte(voiceID))[:9] }

func hasEnrollmentPrefix(speaker, prefix string) bool {
	return qwenVoiceID.MatchString(speaker) && strings.HasPrefix(speaker, qwenAudioModel+"-"+prefix+"-")
}

// Recover a submission by its unique prefix without sending another enrollment request.
func (s *server) recoverVoiceSpeaker(ctx context.Context, v storedVoice) (string, error) {
	prefix := qwenEnrollmentPrefix(v.ID)
	raw, err := s.qwenVoiceCall(ctx, "list_voice", object{"prefix": prefix, "page_index": 0, "page_size": 10})
	if err != nil {
		return "", err
	}
	result, err := parseQwenVoiceResponse(raw)
	if err != nil {
		return "", err
	}
	var speaker string
	for _, item := range result.VoiceList {
		if hasEnrollmentPrefix(item.VoiceID, prefix) {
			if speaker != "" && speaker != item.VoiceID {
				return "", fail(502, "百炼返回多个匹配音色，请联系管理员核对")
			}
			speaker = item.VoiceID
		}
	}
	return speaker, nil
}

func voiceSubmissionInFlight(v storedVoice) bool {
	created, err := time.Parse(time.RFC3339Nano, v.CreatedAt)
	return v.Status == "submitting" && err == nil && time.Since(created) < time.Minute
}

func (s *server) refreshVoice(ctx context.Context, owner string, v storedVoice) (storedVoice, error) {
	if v.Resource != qwenAudioModel || voiceSubmissionInFlight(v) {
		return v, nil
	}
	if v.Status == "failed" && v.Speaker == "" {
		return v, s.settleVoiceClone(ctx, owner, v.ID, false)
	}
	ctx, err := s.voiceProviderContext(ctx, v)
	if err != nil {
		return v, err
	}
	if v.Speaker == "" {
		v.Speaker, err = s.recoverVoiceSpeaker(ctx, v)
		if err != nil {
			return v, err
		}
	}
	if v.Speaker == "" {
		v.Status = "unknown"
		v.Error = "百炼尚未查到音色，请稍后刷新或联系管理员核对"
	} else {
		raw, err := s.qwenVoiceCall(ctx, "query_voice", object{"voice_id": v.Speaker})
		if err != nil {
			return v, err
		}
		result, err := parseQwenVoiceResponse(raw)
		if err != nil {
			return v, err
		}
		if result.TargetModel != qwenAudioModel {
			return v, fail(502, "百炼返回的音色模型不匹配")
		}
		if err = voiceResult(&v, result.Status); err != nil {
			return v, err
		}
	}
	if err = s.saveVoiceStatus(ctx, owner, v); err != nil {
		return v, err
	}
	v, err = s.ownedVoice(ctx, owner, v.ID)
	if err != nil {
		return v, err
	}
	// 复刻审核成功后扣款，明确失败时退款，待核对的请求保留冻结。
	switch v.Status {
	case "ready":
		if err = s.settleVoiceClone(ctx, owner, v.ID, true); err != nil {
			return storedVoice{}, err
		}
	case "failed":
		if err = s.settleVoiceClone(ctx, owner, v.ID, false); err != nil {
			return storedVoice{}, err
		}
	}
	return v, nil
}

func (s *server) settleVoiceClone(ctx context.Context, owner, voiceID string, capture bool) error {
	var requestKey string
	if err := s.db.QueryRowContext(ctx, `SELECT request_key FROM keagent_voice WHERE id=$1 AND owner_id=$2`, voiceID, owner).Scan(&requestKey); err != nil {
		return err
	}
	return s.settleHoldByKey(ctx, owner, "voice_clone", requestKey, capture)
}

func (s *server) voices(ctx context.Context, a actor, operation string, body []byte) (any, error) {
	var input object
	if json.Unmarshal(body, &input) != nil {
		return nil, fail(400, "请求格式错误")
	}
	if operation == "list" {
		result := []userVoice{}
		records, err := s.db.QueryContext(ctx, `SELECT payload FROM keagent_voice WHERE owner_id=$1 AND NOT archived ORDER BY payload->>'createdAt' DESC`, a.UserID)
		if err != nil {
			return nil, err
		}
		defer records.Close()
		for records.Next() {
			var raw []byte
			var v storedVoice
			if err = records.Scan(&raw); err != nil {
				return nil, err
			}
			if err = json.Unmarshal(raw, &v); err != nil {
				return nil, err
			}
			v.markRetired()
			result = append(result, v.userVoice)
		}
		if err = records.Err(); err != nil {
			return nil, err
		}
		records.Close()
		catalog, err := s.publicVoices(ctx, false)
		if err != nil {
			return nil, err
		}
		public := []publicVoice{}
		for _, v := range catalog {
			public = append(public, v.publicVoice)
		}
		return object{"voices": result, "cloneEnabled": cloneConfigured(ctx), "publicVoices": public, "cloudEnabled": qwenSpeechConfigured(ctx)}, nil
	}
	if operation == "preview-public" {
		return s.previewPublicVoice(ctx, a, str(input["id"]))
	}
	if operation == "create" {
		data, err := validateVoiceUpload(input)
		if err != nil {
			return nil, err
		}
		if !cloneConfigured(ctx) {
			return nil, fail(503, "管理员尚未开通声音复刻；仍可使用系统音色")
		}
		fingerprint := digestBytes(append([]byte(strings.TrimSpace(str(input["name"]))+"|"+str(input["language"])+"|"+str(input["format"])+"|"), data...))
		voiceID := id()
		requestKey := str(input["requestKey"])
		v := storedVoice{
			userVoice: userVoice{ID: voiceID, Name: strings.TrimSpace(str(input["name"])), Language: str(input["language"]), Status: "submitting", CreatedAt: now()},
			Resource:  qwenAudioModel, Workspace: aiValue(ctx, "DASHSCOPE_WORKSPACE_ID"),
			AuthorizedAt: now(), ConfigVersion: aiSnapshotFrom(ctx).versions[speechAIGroup],
		}
		raw, _ := json.Marshal(v)
		// 先查重：重放请求不做任何扣费动作。
		var savedFingerprint string
		var archived bool
		replayErr := s.db.QueryRowContext(ctx, `SELECT fingerprint,payload,archived FROM keagent_voice WHERE owner_id=$1 AND request_key=$2`, a.UserID, requestKey).Scan(&savedFingerprint, &raw, &archived)
		if replayErr == nil {
			if savedFingerprint != fingerprint || archived {
				return nil, fail(409, "该请求已提交，请刷新音色列表后处理")
			}
			if err = json.Unmarshal(raw, &v); err != nil {
				return nil, err
			}
			v.markRetired()
			return v.userVoice, nil
		}
		if !errors.Is(replayErr, sql.ErrNoRows) {
			return nil, replayErr
		}
		// 新提交：先冻结再落库，余额不足时干净地 402。
		prices, priceVersion, err := readCreditPricing(ctx, s.db)
		if err != nil {
			return nil, err
		}
		if clonePrice := prices["voice_clone"]; clonePrice > 0 {
			if _, err = s.holdCredits(ctx, a.UserID, "voice_clone", requestKey, clonePrice, requestKey, priceVersion, nil); err != nil {
				return nil, err
			}
		}
		inserted, err := s.db.ExecContext(ctx, `INSERT INTO keagent_voice(id,owner_id,request_key,fingerprint,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner_id,request_key) DO NOTHING`, voiceID, a.UserID, requestKey, fingerprint, raw)
		if err != nil {
			return nil, err
		}
		count, _ := inserted.RowsAffected()
		if count == 0 {
			// 并发同 requestKey：读取先提交的音色；本次创建的冻结由后续 refresh 收尾。
			if err = s.db.QueryRowContext(ctx, `SELECT fingerprint,payload,archived FROM keagent_voice WHERE owner_id=$1 AND request_key=$2`, a.UserID, requestKey).Scan(&savedFingerprint, &raw, &archived); err != nil {
				return nil, err
			}
			if savedFingerprint != fingerprint || archived {
				return nil, fail(409, "该请求已提交，请刷新音色列表后处理")
			}
			if err = json.Unmarshal(raw, &v); err != nil {
				return nil, err
			}
			v.markRetired()
			return v.userVoice, nil
		}
		prefix := qwenEnrollmentPrefix(v.ID)
		raw, err = s.qwenVoiceCall(ctx, "create_voice", qwenEnrollmentInput(prefix, str(input["audio"]), str(input["format"]), v.Language))
		v.Status = "unknown"
		v.Error = "提交结果待核对，请刷新状态，勿重复上传"
		if err == nil {
			enrolled, parseErr := parseQwenVoiceResponse(raw)
			if parseErr == nil && hasEnrollmentPrefix(enrolled.VoiceID, prefix) {
				v.Speaker = enrolled.VoiceID
				v.Status, v.Error = "processing", ""
			}
		} else if qwenEnrollmentRejected(err) {
			v.Status = "failed"
			v.Error = "百炼拒绝了声音复刻，请检查录音或联系管理员"
		}
		// Save the provider checkpoint even if the browser disconnected.
		checkpoint, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		if err = s.saveVoiceStatus(checkpoint, a.UserID, v); err != nil {
			return nil, err
		}
		if v.Status == "failed" {
			if err = s.settleVoiceClone(checkpoint, a.UserID, v.ID, false); err != nil {
				return nil, err
			}
		}
		return v.userVoice, nil
	}
	v, err := s.ownedVoice(ctx, a.UserID, str(input["id"]))
	if err != nil {
		return nil, err
	}
	switch operation {
	case "refresh":
		v, err = s.refreshVoice(ctx, a.UserID, v)
		return v.userVoice, err
	case "preview":
		if v.Resource != qwenAudioModel {
			return nil, fail(409, retiredVoiceMessage)
		}
		if !cloneConfigured(ctx) {
			return nil, fail(503, "管理员尚未启用本人音色合成")
		}
		v, err = s.refreshVoice(ctx, a.UserID, v)
		if err != nil {
			return nil, err
		}
		if v.Status != "ready" {
			return nil, fail(409, "音色尚未就绪，请稍后刷新")
		}
		return s.previewSynthesizedVoice(ctx, a, "personal", v.ID, v.Language)
	case "remove":
		if voiceSubmissionInFlight(v) {
			return nil, fail(409, "正在提交，请先刷新状态再移除")
		}
		if v.Resource == qwenAudioModel && (v.Speaker != "" || v.Status != "failed") {
			if err = s.deleteEnrolledVoice(ctx, v); err != nil {
				return nil, err
			}
		}
		if err = s.settleVoiceClone(ctx, a.UserID, v.ID, false); err != nil {
			return nil, err
		}
		_, err = s.db.ExecContext(ctx, `UPDATE keagent_voice SET archived=true WHERE id=$1 AND owner_id=$2`, v.ID, a.UserID)
		return object{"removed": err == nil}, err
	}
	return nil, fail(404, "音色操作不存在")
}

func (s *server) deleteEnrolledVoice(ctx context.Context, v storedVoice) error {
	ctx, err := s.voiceProviderContext(ctx, v)
	if err != nil {
		return err
	}
	if v.Speaker == "" {
		v.Speaker, err = s.recoverVoiceSpeaker(ctx, v)
		if err != nil || v.Speaker == "" {
			return err
		}
	}
	return s.deleteQwenVoice(ctx, v.Speaker)
}

func validateVoiceSynthesis(input object) error {
	text, rate := str(input["text"]), number(input["rate"])
	if len([]rune(text)) == 0 || len([]rune(text)) > 2000 || rate < .5 || rate > 2 {
		return fail(422, "配音参数无效")
	}
	return nil
}

func (s *server) synthesizeVoice(ctx context.Context, a actor, input object) (any, error) {
	text, voice, kind := str(input["text"]), str(input["voice"]), str(input["kind"])
	if err := validateVoiceSynthesis(input); err != nil {
		return nil, err
	}
	if kind == "personal" {
		if !cloneConfigured(ctx) {
			return nil, fail(503, "管理员尚未启用本人音色合成，请选择系统音色")
		}
		v, err := s.ownedVoice(ctx, a.UserID, voice)
		if err != nil {
			return nil, err
		}
		if v.Resource != qwenAudioModel {
			return nil, fail(409, retiredVoiceMessage)
		}
		if v.Status != "ready" || v.Speaker == "" {
			return nil, fail(409, "本人音色尚未就绪")
		}
		ctx, err = s.voiceProviderContext(ctx, v)
		if err != nil {
			return nil, err
		}
		return s.synthesizePCM(ctx, v.Language, text, v.Speaker, v.Resource, number(input["rate"]))
	}
	if kind != "" && kind != "builtin" {
		return nil, fail(422, "音色类型无效")
	}
	preset, err := s.activePublicVoice(ctx, voice)
	if err != nil {
		return nil, err
	}
	return s.synthesizePCM(ctx, preset.Language, text, preset.Speaker, preset.Resource, number(input["rate"]))
}
