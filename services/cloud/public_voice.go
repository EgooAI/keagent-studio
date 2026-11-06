package main

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

const publicVoiceSchema = `CREATE TABLE IF NOT EXISTS keagent_public_voice (id text PRIMARY KEY,payload jsonb NOT NULL);`

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
}

func validatePublicVoice(v adminVoice) error {
	if strings.TrimSpace(v.Name) == "" || len([]rune(v.Name)) > 80 || (v.Language != "zh-CN" && v.Language != "en-US") || !resourceID.MatchString(v.Speaker) || strings.HasPrefix(v.Speaker, "keagent") || strings.HasPrefix(v.Speaker, "S_") || !speechResourceID.MatchString(v.Resource) || !strings.HasPrefix(v.Resource, "seed-tts-") {
		return fail(422, "请填写音色名称、语言、有效的公共音色编号及语音合成资源编号")
	}
	return nil
}

// Official TTS 2.0 example voice. Insert once; administrator unlisting survives restarts.
func seedDefaultPublicVoice(ctx context.Context, db *sql.DB) error {
	v := adminVoice{publicVoice: publicVoice{ID: "builtin-public-zh-vv-v2", Name: "公共讲解女声 · VV 2.0", Language: "zh-CN"}, Speaker: "zh_female_vv_uranus_bigtts", Resource: "seed-tts-2.0", Enabled: true, PublishedOnce: true}
	if err := validatePublicVoice(v); err != nil {
		return err
	}
	b, _ := json.Marshal(v)
	_, err := db.ExecContext(ctx, `INSERT INTO keagent_public_voice(id,payload) VALUES($1,$2) ON CONFLICT(id) DO NOTHING`, v.ID, b)
	return err
}
func (s *server) publicVoices(ctx context.Context, all bool) ([]adminVoice, error) {
	query := `SELECT payload FROM keagent_public_voice`
	if !all {
		query += ` WHERE payload->>'enabled'='true'`
	}
	query += ` ORDER BY payload->>'name',id`
	records, err := s.db.QueryContext(ctx, query)
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
		result = append(result, v)
	}
	return result, records.Err()
}
func (s *server) activePublicVoice(ctx context.Context, voiceID string) (adminVoice, error) {
	var raw []byte
	var v adminVoice
	err := s.db.QueryRowContext(ctx, `SELECT payload FROM keagent_public_voice WHERE id=$1 AND payload->>'enabled'='true'`, voiceID).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return v, fail(404, "公共音色未上架或已下架，请重新选择")
	}
	if err != nil {
		return v, err
	}
	err = json.Unmarshal(raw, &v)
	return v, err
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
	text := "您好，我是您的房产顾问，欢迎一起了解这套房源。"
	if v.Language == "en-US" {
		text = "Hello, let me introduce this property to you."
	}
	result, err := s.synthesizeVoice(ctx, a, object{"voice": v.ID, "kind": "builtin", "text": text, "rate": float64(1)})
	if err != nil {
		return nil, err
	}
	pcm, err := base64.StdEncoding.DecodeString(str(result.(object)["pcm"]))
	if err != nil {
		return nil, err
	}
	return object{"audio": base64.StdEncoding.EncodeToString(pcmWAV(pcm)), "mime": "audio/wav"}, nil
}
