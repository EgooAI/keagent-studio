package main

import (
	"encoding/json"
	"testing"
)

func TestFactoryPreferencesWithoutBuiltinProperty(t *testing.T) {
	db := productionTestDB(t)
	if _, err := db.ExecContext(t.Context(), voiceSchema+publicVoiceSchema); err != nil {
		t.Fatal(err)
	}
	if err := seedVideoTemplates(t.Context(), db); err != nil {
		t.Fatal(err)
	}
	s := &server{db: db}
	a := actor{UserID: "preference-owner", Name: "测试用户"}
	for range 2 {
		w, err := s.workspace(t.Context(), a)
		if err != nil || len(rows(w["properties"])) != 0 {
			t.Fatal("builtin sample must not reappear", w, err)
		}
	}
	if _, err := db.ExecContext(t.Context(), `INSERT INTO keagent_public_voice(id,payload) VALUES
		('public-zh',jsonb_build_object('id','public-zh','name','中文公共音色','language','zh-CN','enabled',true,'speakerId','longanlingxin_v3.1','resourceId',$1::text)),
		('public-en',jsonb_build_object('id','public-en','language','en-US','enabled',true,'speakerId','xunanchuan_v3.1','resourceId',$1::text))`, qwenAudioModel); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(t.Context(), `INSERT INTO keagent_voice(id,owner_id,request_key,fingerprint,payload) VALUES
		('own','preference-owner','own','test',jsonb_build_object('id','own','language','zh-CN','status','ready','resource',$1::text)),
		('other','different-owner','other','test',jsonb_build_object('id','other','language','zh-CN','status','ready','resource',$1::text))`, qwenAudioModel); err != nil {
		t.Fatal(err)
	}
	input := object{"templateId": "standard-tour", "templateVersion": "1.0.0", "voiceId": "public-zh"}
	if _, err := s.command(t.Context(), a, "updateFactoryPreferences", []any{input}); err != nil {
		t.Fatal(err)
	}
	w, err := s.workspace(t.Context(), a)
	if err != nil {
		t.Fatal(err)
	}
	d := obj(obj(w["profile"])["defaults"])
	if obj(d["videoTemplate"])["id"] != "standard-tour" || d["voiceId"] != "public-zh" || d["requireScriptReview"] != true || obj(d["promptTemplate"])["id"] != "builtin-prompt" {
		t.Fatal("default preferences lost or erased legacy fields", d)
	}
	for key, value := range map[string]any{"voiceId": "other", "templateVersion": "2.0.0"} {
		bad := jsonCopy(input).(object)
		bad[key] = value
		if _, err := s.command(t.Context(), a, "updateFactoryPreferences", []any{bad}); err == nil {
			t.Fatal("invalid preference accepted", key)
		}
	}
	input["voiceId"] = "public-en"
	if _, err := s.factoryPreferences(t.Context(), a, input); err == nil {
		t.Fatal("language mismatch accepted")
	}
	input["voiceId"] = "own"
	if _, err := s.factoryPreferences(t.Context(), a, input); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(t.Context(), `UPDATE keagent_public_voice SET payload=jsonb_set(payload,'{enabled}','false') WHERE id='public-zh'`); err != nil {
		t.Fatal(err)
	}
	input["voiceId"] = "public-zh"
	if _, err := s.factoryPreferences(t.Context(), a, input); err == nil {
		t.Fatal("unlisted voice accepted")
	}
	if _, err := s.command(t.Context(), a, "updateFactoryPreferences", []any{object{"templateId": "", "templateVersion": "", "voiceId": ""}}); err != nil {
		t.Fatal("clearing defaults rejected", err)
	}
	if _, err := s.command(t.Context(), a, "updateProperty", []any{"panorama-cc0-sample", object{"title": "伪装真实房源"}}); err == nil {
		t.Fatal("builtin sample editable")
	}
	var raw []byte
	if err := db.QueryRowContext(t.Context(), `SELECT payload FROM keagent_workspace WHERE owner_id=$1`, a.UserID).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var stored object
	if err := json.Unmarshal(raw, &stored); err != nil {
		t.Fatal(err)
	}
	if len(rows(stored["properties"])) != 0 {
		t.Fatal("builtin test data altered user's property storage")
	}
	for range 2 {
		if err := seedDefaultPublicVoice(t.Context(), db); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.activePublicVoice(t.Context(), defaultPublicVoiceID); err != nil {
		t.Fatal("default public voice missing", err)
	}
	if _, err := db.ExecContext(t.Context(), `UPDATE keagent_public_voice SET payload=jsonb_set(payload,'{enabled}','false') WHERE id=$1`, defaultPublicVoiceID); err != nil {
		t.Fatal(err)
	}
	if err := seedDefaultPublicVoice(t.Context(), db); err != nil {
		t.Fatal(err)
	}
	if _, err := s.activePublicVoice(t.Context(), defaultPublicVoiceID); err == nil {
		t.Fatal("restart republished administrator's unlisted voice")
	}
}
