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
	voice := adminVoice{publicVoice: publicVoice{Name: "经纪人女声", Language: "zh-CN"}, Speaker: "zh_female_example", Resource: "seed-tts-2.0"}
	private := voice
	private.Speaker = "keagent-private-user-voice"
	if validatePublicVoice(private) == nil {
		t.Fatal("user-owned cloned voice accepted as public")
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
		if operation != "unidirectional" || resource != saved.Resource || obj(payload["req_params"])["speaker"] != saved.Speaker {
			t.Fatal("catalog was not resolved server-side")
		}
		return []byte(`{"code":0,"data":"AQIDBA=="}`), nil
	}
	if _, err = s.synthesizeVoice(t.Context(), actor{UserID: "user"}, object{"text": "测试文案", "voice": saved.ID, "kind": "builtin", "rate": float64(1)}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.previewPublicVoice(t.Context(), actor{UserID: "user"}, saved.ID); err != nil {
		t.Fatal(err)
	}
	changed := saved
	changed.Speaker = "different-speaker"
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
