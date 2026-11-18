package main

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
)

func TestPublicVoicesManagedCatalog(t *testing.T) {
	s := voiceTestServer(t)
	admin := actor{UserID: "admin"}
	save := func(v adminVoice) (adminVoice, error) {
		raw, _ := json.Marshal(v)
		r := httptest.NewRequest("POST", "/v1/admin/voices", nil)
		result, err := s.adminVoices(r, admin, raw)
		if err != nil {
			return adminVoice{}, err
		}
		return result.(adminVoice), nil
	}
	voice := adminVoice{publicVoice: publicVoice{Name: "经纪人女声", Language: "zh-CN"}, Speaker: "longanlingxin_v3.1", Resource: qwenAudioModel}
	private := voice
	private.Speaker = qwenAudioModel + "-private-user-voice"
	if validatePublicVoice(private) == nil {
		t.Fatal("user-owned cloned voice accepted as public")
	}
	flash := voice
	flash.Speaker = "wenhuaiqing_v3.1"
	if _, err := save(flash); err == nil {
		t.Fatal("Flash-only voice was accepted for Plus")
	}
	saved, err := save(voice)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.activePublicVoice(t.Context(), saved.ID); err == nil {
		t.Fatal("unpublished voice accessible")
	}
	saved.Enabled = true
	saved, err = save(saved)
	if err != nil {
		t.Fatal(err)
	}
	catalog, err := s.voices(t.Context(), actor{UserID: "user"}, "list", []byte(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(catalog.(object)["publicVoices"].([]publicVoice)) != 1 {
		t.Fatal("published voice missing")
	}
	s.speech = func(_ context.Context, operation string, payload object, resource string) ([]byte, error) {
		if operation != qwenSynthesis || resource != saved.Resource || payload["voice"] != saved.Speaker {
			t.Fatal("catalog was not resolved server-side")
		}
		return []byte(qwenSpeechFixture), nil
	}
	if _, err = s.synthesizeVoice(t.Context(), actor{UserID: "user"}, object{"text": "测试文案", "voice": saved.ID, "kind": "builtin", "rate": float64(1)}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.previewPublicVoice(t.Context(), actor{UserID: "user"}, saved.ID); err != nil {
		t.Fatal(err)
	}
	changed := saved
	changed.Speaker = "xunanchuan_v3.1"
	if _, err = save(changed); err == nil {
		t.Fatal("published provider identity overwritten")
	}
	saved.Enabled = false
	if _, err = save(saved); err != nil {
		t.Fatal(err)
	}
	if _, err = s.previewPublicVoice(t.Context(), actor{UserID: "user"}, saved.ID); err == nil {
		t.Fatal("unpublished voice preview accepted")
	}
	var count int
	if err = s.db.QueryRow(`SELECT count(*) FROM keagent_audit WHERE target_id=$1`, saved.ID).Scan(&count); err != nil || count != 3 {
		t.Fatal("catalog changes not audited", count, err)
	}
}

func TestPublicVoiceProviderCutover(t *testing.T) {
	s := voiceTestServer(t)
	_, err := s.db.Exec(`INSERT INTO keagent_public_voice(id,payload) VALUES
		($1,'{"id":"builtin-public-zh-vv-v2","resourceId":"seed-tts-2.0","enabled":true,"publishedOnce":true}'),
		($2,jsonb_build_object('id',$2::text,'speakerId','wenhuaiqing_v3.1','resourceId',$3::text,'enabled',true,'publishedOnce',true)),
		('old-custom','{"id":"old-custom","resourceId":"seed-tts-2.0","enabled":true,"publishedOnce":true}')`,
		retiredDefaultPublicVoiceID, retiredBailianPublicVoiceID, qwenAudioModel)
	if err != nil {
		t.Fatal(err)
	}
	if err = seedDefaultPublicVoice(t.Context(), s.db); err != nil {
		t.Fatal(err)
	}
	for _, oldID := range []string{retiredDefaultPublicVoiceID, retiredBailianPublicVoiceID} {
		v, err := s.activePublicVoice(t.Context(), oldID)
		if err != nil || v.ID != defaultPublicVoiceID || v.Speaker != "longanlingxin_v3.1" {
			t.Fatalf("historic default did not resolve to new voice: %+v %v", v, err)
		}
	}
	catalog, err := s.publicVoices(t.Context(), true)
	if err != nil || len(catalog) != 7 {
		t.Fatalf("historical entries were lost: %+v %v", catalog, err)
	}
	var active int
	for _, item := range catalog {
		if item.ID == retiredDefaultPublicVoiceID || item.ID == retiredBailianPublicVoiceID || item.ID == "old-custom" {
			if item.Enabled || !item.Retired {
				t.Fatalf("retired voice remained usable: %+v", item)
			}
		} else if item.Enabled && !item.Retired {
			active++
		}
	}
	if active != 4 {
		t.Fatalf("expected four published Plus voices, got %d", active)
	}
	if _, err = s.activePublicVoice(t.Context(), "old-custom"); err == nil {
		t.Fatal("active lookup accepted a retired custom voice")
	}
}
