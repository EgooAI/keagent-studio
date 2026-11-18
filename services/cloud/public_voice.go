package main

import (
	"context"
	"database/sql"
	"encoding/binary"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

const publicVoiceSchema = `CREATE TABLE IF NOT EXISTS keagent_public_voice (id text PRIMARY KEY,payload jsonb NOT NULL);`
const defaultPublicVoiceID = "builtin-public-zh-qwen-lingxin"
const retiredDefaultPublicVoiceID = "builtin-public-zh-vv-v2"
const retiredBailianPublicVoiceID = "builtin-public-zh-qwen-plus"

// System voices documented for Qwen-Audio 3.1 TTS Plus.
var defaultPublicVoices = [...]struct {
	id, name, speaker string
}{
	{defaultPublicVoiceID, "公共讲解女声 · 龙安灵心", "longanlingxin_v3.1"},
	{"builtin-public-zh-qwen-nanchuan", "沉稳男声 · 许南川", "xunanchuan_v3.1"},
	{"builtin-public-zh-qwen-huan", "活泼女声 · 龙安欢", "longanhuan_v3.1"},
	{"builtin-public-zh-qwen-fengyue", "清晰女声 · 龙安风悦", "longanfengyue_v3.1"},
}

func currentPublicVoiceID(voiceID string) string {
	if voiceID == retiredDefaultPublicVoiceID || voiceID == retiredBailianPublicVoiceID {
		return defaultPublicVoiceID
	}
	return voiceID
}

type publicVoice struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Language string `json:"language"`
}
type adminVoice struct {
	publicVoice
	Speaker       string `json:"speakerId"`
	Resource      string `json:"resourceId"`
	Enabled       bool   `json:"enabled"`
	PublishedOnce bool   `json:"publishedOnce"`
	Retired       bool   `json:"retired,omitempty"`
}

func supportedPublicVoice(v adminVoice) bool {
	if v.Resource == qwenAudioModel {
		for _, voice := range defaultPublicVoices {
			if v.Speaker == voice.speaker {
				return true
			}
		}
	}
	return false
}

func validatePublicVoice(v adminVoice) error {
	if strings.TrimSpace(v.Name) == "" || len([]rune(v.Name)) > 80 || (v.Language != "zh-CN" && v.Language != "en-US") || !supportedPublicVoice(v) {
		return fail(422, "请填写音色名称、语言及千问 3.1 Plus 支持的系统音色编号")
	}
	return nil
}

// Keep the catalog in sync with the selected model and preserve administrator edits.
func seedDefaultPublicVoice(ctx context.Context, db *sql.DB) error {
	voices := make([]adminVoice, 0, len(defaultPublicVoices))
	speakers := make([]string, 0, len(defaultPublicVoices))
	for _, voice := range defaultPublicVoices {
		voices = append(voices, adminVoice{
			publicVoice: publicVoice{ID: voice.id, Name: voice.name, Language: "zh-CN"},
			Speaker:     voice.speaker, Resource: qwenAudioModel, Enabled: true, PublishedOnce: true,
		})
		speakers = append(speakers, voice.speaker)
	}
	b, _ := json.Marshal(voices)
	_, err := db.ExecContext(ctx, `WITH retired AS (
		UPDATE keagent_public_voice SET payload=jsonb_set(payload,'{enabled}','false')
		WHERE payload->>'enabled'='true' AND (payload->>'resourceId' IS DISTINCT FROM $2
			OR NOT COALESCE((payload->>'speakerId')=ANY($3::text[]),false))
	) INSERT INTO keagent_public_voice(id,payload)
	SELECT voice->>'id', CASE WHEN voice->>'id'=$4 THEN
		jsonb_set(voice,'{enabled}',COALESCE((SELECT payload->'enabled' FROM keagent_public_voice WHERE id=$5),'true'::jsonb))
		ELSE voice END
	FROM jsonb_array_elements($1::jsonb) AS voices(voice)
	ON CONFLICT(id) DO NOTHING`, b, qwenAudioModel, speakers, defaultPublicVoiceID, retiredBailianPublicVoiceID)
	return err
}
func (s *server) publicVoices(ctx context.Context, all bool) ([]adminVoice, error) {
	query := `SELECT payload FROM keagent_public_voice`
	var args []any
	if !all {
		query += ` WHERE payload->>'enabled'='true' AND payload->>'resourceId'=$1`
		args = append(args, qwenAudioModel)
	}
	query += ` ORDER BY payload->>'name',id`
	records, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer records.Close()
	result := []adminVoice{}
	for records.Next() {
		var raw []byte
		var v adminVoice
		if err = records.Scan(&raw); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(raw, &v); err != nil {
			return nil, err
		}
		v.Retired = !supportedPublicVoice(v)
		if v.Retired && !all {
			continue
		}
		result = append(result, v)
	}
	return result, records.Err()
}
func (s *server) activePublicVoice(ctx context.Context, voiceID string) (adminVoice, error) {
	var raw []byte
	var v adminVoice
	err := s.db.QueryRowContext(ctx, `SELECT payload FROM keagent_public_voice WHERE id=$1 AND payload->>'enabled'='true' AND payload->>'resourceId'=$2`, currentPublicVoiceID(voiceID), qwenAudioModel).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return v, fail(404, "公共音色未上架或已下架，请重新选择")
	}
	if err != nil {
		return v, err
	}
	if err = json.Unmarshal(raw, &v); err != nil {
		return v, err
	}
	if !supportedPublicVoice(v) {
		return v, fail(404, "该公共音色不适用于千问 3.1 Plus，请重新选择")
	}
	return v, nil
}
func (s *server) adminVoices(r *http.Request, a actor, body []byte) (any, error) {
	if r.Method == "GET" {
		return s.publicVoices(r.Context(), true)
	}
	if r.Method != "POST" {
		return nil, fail(405, "方法不支持")
	}
	var v adminVoice
	if json.Unmarshal(body, &v) != nil {
		return nil, fail(422, "音色参数无效")
	}
	v.Name = strings.TrimSpace(v.Name)
	v.Retired = false
	if err := validatePublicVoice(v); err != nil {
		return nil, err
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if v.ID == "" {
		v.ID = id()
	}
	if _, err = tx.ExecContext(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended('public-voice:' || $1,0))`, v.ID); err != nil {
		return nil, err
	}
	var raw []byte
	var old adminVoice
	err = tx.QueryRowContext(r.Context(), `SELECT payload FROM keagent_public_voice WHERE id=$1 FOR UPDATE`, v.ID).Scan(&raw)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	action := "public-voice.create"
	if len(raw) > 0 {
		if err = json.Unmarshal(raw, &old); err != nil {
			return nil, err
		}
		if old.PublishedOnce && (old.Speaker != v.Speaker || old.Resource != v.Resource || old.Language != v.Language) {
			return nil, fail(409, "已上架过的音色不能更换音色编号、模型或语言，请创建新音色")
		}
		action = "public-voice.update"
	}
	v.PublishedOnce = old.PublishedOnce || v.Enabled
	if v.Enabled && !old.Enabled {
		action = "public-voice.publish"
	}
	if !v.Enabled && old.Enabled {
		action = "public-voice.unpublish"
	}
	raw, _ = json.Marshal(v)
	if _, err = tx.ExecContext(r.Context(), `INSERT INTO keagent_public_voice(id,payload) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload`, v.ID, raw); err != nil {
		return nil, err
	}
	details, _ := json.Marshal(object{"name": v.Name, "enabled": v.Enabled})
	if _, err = tx.ExecContext(r.Context(), `INSERT INTO keagent_audit(id,actor_id,action,target_id,metadata) VALUES($1,$2,$3,$4,$5)`, id(), a.UserID, action, v.ID, details); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return v, nil
}
func pcmWAV(pcm []byte) []byte {
	data := make([]byte, 44+len(pcm))
	copy(data, "RIFF")
	binary.LittleEndian.PutUint32(data[4:], uint32(36+len(pcm)))
	copy(data[8:], "WAVEfmt ")
	binary.LittleEndian.PutUint32(data[16:], 16)
	binary.LittleEndian.PutUint16(data[20:], 1)
	binary.LittleEndian.PutUint16(data[22:], 1)
	binary.LittleEndian.PutUint32(data[24:], 24000)
	binary.LittleEndian.PutUint32(data[28:], 48000)
	binary.LittleEndian.PutUint16(data[32:], 2)
	binary.LittleEndian.PutUint16(data[34:], 16)
	copy(data[36:], "data")
	binary.LittleEndian.PutUint32(data[40:], uint32(len(pcm)))
	copy(data[44:], pcm)
	return data
}
func (s *server) previewPublicVoice(ctx context.Context, a actor, voiceID string) (any, error) {
	v, err := s.activePublicVoice(ctx, voiceID)
	if err != nil {
		return nil, err
	}
	return s.previewSynthesizedVoice(ctx, a, "", v.ID, v.Language, v.Speaker, v.Resource)
}
