package main

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
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
	PreviewURL    string `json:"previewURL,omitempty"`
	AuthorizedAt  string `json:"authorizedAt"`
	Version       int64  `json:"version"`
	ConfigVersion int64  `json:"configVersion"`
}

func cloneConfigured(ctx context.Context) bool {
	return aiValue(ctx, "VOLC_VOICE_CLONE_ENABLED") == "true" && aiValue(ctx, "VOLC_TTS_API_KEY") != "" && speechResourceID.MatchString(cloneResource(ctx))
}
func cloneResource(ctx context.Context) string { return aiValue(ctx, "VOLC_VOICE_CLONE_RESOURCE_ID") }

// Only fixed speech operations are exposed; clients never supply provider URLs or speaker IDs.
func (s *server) speechCall(ctx context.Context, operation string, payload object, resource string) ([]byte, error) {
	if s.speech != nil {
		return s.speech(ctx, operation, payload, resource)
	}
	if operation != "voice_clone" && operation != "get_voice" && operation != "unidirectional" {
		return nil, fail(400, "无效的语音操作")
	}
	if aiSnapshotFrom(ctx).locked["speech"] {
		return nil, fail(503, "火山语音生效配置无法解密")
	}
	key := aiValue(ctx, "VOLC_TTS_API_KEY")
	if key == "" {
		return nil, fail(503, "云端未配置火山语音密钥")
	}
	headers := http.Header{"Content-Type": {"application/json"}, "X-Api-Key": {key}, "X-Api-Request-Id": {id()}}
	if resource != "" {
		headers.Set("X-Api-Resource-Id", resource)
	}
	body, _ := json.Marshal(payload)
	return providerBody(ctx, "POST", "https://openspeech.bytedance.com/api/v3/tts/"+operation, headers, body, 16<<20)
}

func validateVoiceUpload(input object) ([]byte, error) {
	if input["authorized"] != true {
		return nil, fail(422, "请确认声音属于本人或已获得明确授权")
	}
	name, language, key := strings.TrimSpace(str(input["name"])), str(input["language"]), str(input["requestKey"])
	if name == "" || len([]rune(name)) > 40 || (language != "zh-CN" && language != "en-US") || len(key) < 16 || len(key) > 100 {
		return nil, fail(422, "音色名称、语言或请求标识无效")
	}
	encoded := str(input["audio"])
	if len(encoded) > base64.StdEncoding.EncodedLen(maxVoiceAudio) {
		return nil, fail(413, "声音样本不能超过10 MB")
	}
	data, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil || len(data) < 32 || len(data) > maxVoiceAudio {
		return nil, fail(422, "声音样本无效或超过10 MB")
	}
	format := str(input["format"])
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
	return v, err
}
func (s *server) saveVoiceStatus(ctx context.Context, owner string, v storedVoice) error {
	// Ignore late queries, but allow a fresh query to report expiration of an unused voice.
	patch, _ := json.Marshal(object{"status": v.Status, "error": v.Error, "previewURL": v.PreviewURL, "version": v.Version + 1})
	_, err := s.db.ExecContext(ctx, `UPDATE keagent_voice SET payload=payload || $3::jsonb WHERE id=$1 AND owner_id=$2 AND NOT archived AND COALESCE((payload->>'version')::bigint,0)=$4`, v.ID, owner, patch, v.Version)
	return err
}
func voiceResult(v *storedVoice, raw []byte) error {
	var result struct {
		Code     int  `json:"code"`
		Status   *int `json:"status"`
		Speakers []struct {
			Model int    `json:"model_type"`
			URL   string `json:"demo_audio"`
		} `json:"speaker_status"`
	}
	if json.Unmarshal(raw, &result) != nil || result.Status == nil && result.Code == 0 {
		return fail(502, "声音复刻返回无效状态，请刷新核对，勿重复提交")
	}
	if result.Code != 0 {
		v.Status = "failed"
		v.Error = fmt.Sprintf("声音复刻失败（code=%d），请检查录音或联系管理员", result.Code)
		return nil
	}
	v.Error = ""
	switch *result.Status {
	case 2, 4:
		v.Status = "ready"
	case 1:
		v.Status = "processing"
	case 3:
		v.Status = "failed"
		v.Error = "声音复刻失败，请更换清晰的单人录音后重新创建"
	default:
		v.Status = "unknown"
		v.Error = "供应商尚未查到音色，请稍后刷新或联系管理员核对"
	}
	for _, sample := range result.Speakers {
		if sample.URL != "" && (sample.Model == 4 || sample.Model == 5 && v.PreviewURL == "") {
			v.PreviewURL = sample.URL
		}
	}
	return nil
}
func (s *server) refreshVoice(ctx context.Context, owner string, v storedVoice) (storedVoice, error) {
	if v.Status != "ready" {
		pinned, err := s.pinnedAI(ctx, "speech", v.ConfigVersion)
		if err != nil {
			return v, err
		}
		ctx = pinned
	}
	raw, err := s.speechCall(ctx, "get_voice", object{"speaker_id": "custom_speaker_id", "custom_speaker_id": v.Speaker}, "")
	if err != nil {
		return v, err
	}
	if err = voiceResult(&v, raw); err != nil {
		return v, err
	}
	if err = s.saveVoiceStatus(ctx, owner, v); err != nil {
		return v, err
	}
	return s.ownedVoice(ctx, owner, v.ID)
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
		return object{"voices": result, "cloneEnabled": cloneConfigured(ctx), "publicVoices": public, "cloudEnabled": aiServicesFor(ctx)[1].State == "configured"}, nil
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
		v := storedVoice{userVoice: userVoice{ID: voiceID, Name: strings.TrimSpace(str(input["name"])), Language: str(input["language"]), Status: "submitting", CreatedAt: now()}, Speaker: "keagent" + voiceID, Resource: cloneResource(ctx), AuthorizedAt: now(), ConfigVersion: aiSnapshotFrom(ctx).versions["speech"]}
		raw, _ := json.Marshal(v)
		inserted, err := s.db.ExecContext(ctx, `INSERT INTO keagent_voice(id,owner_id,request_key,fingerprint,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner_id,request_key) DO NOTHING`, voiceID, a.UserID, str(input["requestKey"]), fingerprint, raw)
		if err != nil {
			return nil, err
		}
		count, _ := inserted.RowsAffected()
		if count == 0 {
			var savedFingerprint string
			var archived bool
			if err = s.db.QueryRowContext(ctx, `SELECT fingerprint,payload,archived FROM keagent_voice WHERE owner_id=$1 AND request_key=$2`, a.UserID, str(input["requestKey"])).Scan(&savedFingerprint, &raw, &archived); err != nil {
				return nil, err
			}
			if savedFingerprint != fingerprint || archived {
				return nil, fail(409, "该请求已提交，请刷新音色列表后处理")
			}
			if err = json.Unmarshal(raw, &v); err != nil {
				return nil, err
			}
			return v.userVoice, nil
		}
		language := 0
		if v.Language == "en-US" {
			language = 1
		}
		raw, err = s.speechCall(ctx, "voice_clone", object{"speaker_id": "custom_speaker_id", "custom_speaker_id": v.Speaker, "audio": object{"data": str(input["audio"]), "format": str(input["format"])}, "language": language}, "")
		v.Status = "unknown"
		v.Error = "提交结果待核对，请刷新状态，勿重复上传"
		if err == nil {
			if parseErr := voiceResult(&v, raw); parseErr != nil {
				v.Status = "unknown"
				v.Error = parseErr.Error()
			}
		}
		// Save the external checkpoint even if the browser disconnected during the paid request.
		checkpoint, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		if err = s.saveVoiceStatus(checkpoint, a.UserID, v); err != nil {
			return nil, err
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
		v, err = s.refreshVoice(ctx, a.UserID, v)
		if err != nil {
			return nil, err
		}
		if v.Status != "ready" {
			return nil, fail(409, "音色尚未就绪，请稍后刷新")
		}
		u, parseErr := url.Parse(v.PreviewURL)
		if parseErr != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil {
			return nil, fail(409, "供应商暂未提供试听，请稍后刷新状态")
		}
		// The URL is obtained from the provider, never from a client; public-only dialing and no redirects.
		audio, fetchErr := providerBody(ctx, "GET", u.String(), http.Header{}, nil, 5<<20)
		if fetchErr != nil {
			return nil, fetchErr
		}
		mime := http.DetectContentType(audio)
		if !strings.HasPrefix(mime, "audio/") && mime != "application/ogg" {
			return nil, fail(502, "供应商试听音频格式无效")
		}
		return object{"audio": base64.StdEncoding.EncodeToString(audio), "mime": mime}, nil
	case "remove":
		if v.Status == "submitting" {
			return nil, fail(409, "正在提交，请先刷新状态再移除")
		}
		_, err = s.db.ExecContext(ctx, `UPDATE keagent_voice SET archived=true WHERE id=$1 AND owner_id=$2`, v.ID, a.UserID)
		return object{"removed": err == nil}, err
	}
	return nil, fail(404, "音色操作不存在")
}

func (s *server) synthesizeVoice(ctx context.Context, a actor, input object) (any, error) {
	text, voice, kind := str(input["text"]), str(input["voice"]), str(input["kind"])
	rate := number(input["rate"])
	if len([]rune(text)) == 0 || len([]rune(text)) > 2000 || rate < .5 || rate > 2 {
		return nil, fail(422, "配音参数无效")
	}
	var resource string
	if kind == "personal" {
		if !cloneConfigured(ctx) {
			return nil, fail(503, "管理员尚未启用本人音色合成，请选择系统音色")
		}
		v, err := s.ownedVoice(ctx, a.UserID, voice)
		if err != nil {
			return nil, err
		}
		if v.Status != "ready" {
			return nil, fail(409, "本人音色尚未就绪")
		}
		voice, resource = v.Speaker, v.Resource
	} else if kind == "" || kind == "builtin" {
		preset, err := s.activePublicVoice(ctx, voice)
		if err != nil {
			return nil, err
		}
		voice, resource = preset.Speaker, preset.Resource
	} else {
		return nil, fail(422, "音色类型无效")
	}
	return s.synthesizePCM(ctx, a.UserID, text, voice, resource, rate)
}

func (s *server) synthesizePCM(ctx context.Context, userID, text, voice, resource string, rate float64) (any, error) {
	if !speechResourceID.MatchString(resource) {
		return nil, fail(503, "云端配音资源未配置")
	}
	raw, err := s.speechCall(ctx, "unidirectional", object{"user": object{"uid": userID}, "req_params": object{"text": text, "speaker": voice, "audio_params": object{"format": "pcm", "sample_rate": 24000, "speech_rate": int((rate - 1) * 100)}}}, resource)
	if err != nil {
		return nil, err
	}
	pcm, err := decodeSpeech(raw)
	if err != nil {
		return nil, err
	}
	return object{"pcm": base64.StdEncoding.EncodeToString(pcm)}, nil
}
