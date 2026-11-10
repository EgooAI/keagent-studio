package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"image"
	"image/png"
	"net/http"
	"strings"
	"testing"
)

func minimaxTestInput(t *testing.T, millis uint32) object {
	t.Helper()
	box := func(name string, payload []byte) []byte {
		result := binary.BigEndian.AppendUint32(nil, uint32(8+len(payload)))
		return append(append(result, name...), payload...)
	}
	mvhd := make([]byte, 20)
	binary.BigEndian.PutUint32(mvhd[12:], 1000)
	binary.BigEndian.PutUint32(mvhd[16:], millis)
	video := append(box("ftyp", []byte("isom")), box("moov", box("mvhd", mvhd))...)
	var photo bytes.Buffer
	if err := png.Encode(&photo, image.NewRGBA(image.Rect(0, 0, 256, 256))); err != nil {
		t.Fatal(err)
	}
	return object{"authorized": true, "ratio": "9:16", "video": base64.StdEncoding.EncodeToString(video), "photo": base64.StdEncoding.EncodeToString(photo.Bytes()), "audio": base64.StdEncoding.EncodeToString(aiProbeSpeech)}
}

func TestMiniMaxOpeningPayload(t *testing.T) {
	input := minimaxTestInput(t, 3000)
	body, err := minimaxPayload(input)
	if err != nil {
		t.Fatal(err)
	}
	var payload object
	if json.Unmarshal(body, &payload) != nil || payload["model"] != "MiniMax-H3" || payload["resolution"] != "768P" || payload["duration"] != float64(4) {
		t.Fatalf("unexpected MiniMax payload settings: %v", err)
	}
	content := rows(payload["content"])
	if len(content) != 4 || obj(content[1])["role"] != "reference_video" || obj(content[2])["role"] != "reference_image" || obj(content[3])["role"] != "reference_audio" ||
		obj(obj(content[3])["audio_url"])["url"] != "data:audio/wav;base64,"+str(input["audio"]) {
		t.Fatal("MiniMax payload must include the original WAV as an audio reference")
	}
	if _, err = minimaxPayload(minimaxTestInput(t, 5001)); err == nil {
		t.Fatal("over-budget reference accepted")
	}
	input["authorized"] = false
	if _, err = minimaxPayload(input); err == nil {
		t.Fatal("unauthorized reference accepted")
	}
}

func TestTemplateMiniMaxOpening(t *testing.T) {
	t.Setenv("MINIMAX_API_KEY", "test-key")
	s := &server{db: productionTestDB(t)}
	template := seedTemplate(t)
	recipe := obj(template["production"])
	recipe["schemaVersion"] = float64(2)
	recipe["scriptRules"] = object{"overall": "整体", "opening": "开场", "scene": "逐图", "closing": "结尾"}
	config := obj(recipe["config"])
	for _, key := range legacyScriptKeys {
		delete(config, key)
	}
	config["videoMode"] = "avatar"
	config["aspectRatio"] = "16:9"
	template["compatibleModes"] = []any{"avatar"}
	input := minimaxTestInput(t, 3000)
	delete(input, "video")
	photo := str(input["photo"])
	prompt := "站在小区入口"
	input["prompt"] = "客户端尝试改写模板"
	input["templateVersion"] = template["version"]
	for _, source := range []string{"property", "fixed"} {
		t.Run(source, func(t *testing.T) {
			location := object{"source": source}
			if source == "fixed" {
				location["image"] = photo
			}
			recipe["opening"] = object{"location": location, "prompt": prompt}
			template["id"] = source + "-opening"
			input["templateId"] = template["id"]
			if err := validateProduction(template); err != nil {
				t.Fatal(err)
			}
			raw, _ := json.Marshal(template)
			if _, err := s.db.ExecContext(t.Context(), `INSERT INTO keagent_resource(id,payload) VALUES($1,$2)`, template["id"], raw); err != nil {
				t.Fatal(err)
			}
			catalog, err := s.productionTemplates(t.Context(), false)
			if err != nil || len(catalog) != 0 {
				t.Fatalf("old client received incompatible template: %d, %v", len(catalog), err)
			}
			catalog, err = s.productionTemplates(t.Context(), true)
			if err != nil || len(catalog) != 1 {
				t.Fatalf("new client could not load opening template: %d, %v", len(catalog), err)
			}
			if _, err = s.db.ExecContext(t.Context(), `UPDATE keagent_resource SET payload=jsonb_set(payload,'{published}','false') WHERE id=$1`, template["id"]); err != nil {
				t.Fatal(err)
			}
			delete(input, "location")
			if source == "property" {
				if _, err = s.productionOpening(t.Context(), actor{UserID: source}, "opening-submit", input); err == nil {
					t.Fatal("missing property image accepted")
				}
				input["location"] = photo
			}
			submits := 0
			s.sourceHTTP = func(_ context.Context, _, endpoint string, _ http.Header, body []byte, _ int64) ([]byte, error) {
				submits++
				var payload object
				if endpoint != minimaxBase+"/v2/video_generation" || json.Unmarshal(body, &payload) != nil ||
					payload["ratio"] != "16:9" || payload["model"] != "MiniMax-H3" || payload["resolution"] != "768P" {
					t.Fatal("unexpected MiniMax request")
				}
				content := rows(payload["content"])
				if len(content) != 4 || !strings.HasSuffix(str(obj(content[0])["text"]), prompt) ||
					obj(content[1])["role"] != "reference_image" || obj(content[2])["role"] != "reference_image" ||
					obj(obj(content[2])["image_url"])["url"] != "data:image/png;base64,"+photo ||
					obj(obj(content[3])["audio_url"])["url"] != "data:audio/wav;base64,"+str(input["audio"]) {
					t.Fatal("MiniMax did not receive the template prompt, two images and original audio")
				}
				return []byte(`{"task_id":"123"}`), nil
			}
			for range 2 {
				if _, err = s.productionOpening(t.Context(), actor{UserID: source}, "opening-submit", input); err != nil {
					t.Fatal(err)
				}
			}
			if submits != 1 {
				t.Fatalf("identical inputs caused %d paid submissions", submits)
			}
		})
	}
}

func TestMiniMaxOpeningReusesTaskAndIsolatesOwners(t *testing.T) {
	t.Setenv("MINIMAX_API_KEY", "test-key")
	s := &server{db: productionTestDB(t)}
	submits := 0
	s.sourceHTTP = func(_ context.Context, method, endpoint string, headers http.Header, _ []byte, _ int64) ([]byte, error) {
		if headers.Get("Authorization") != "Bearer test-key" {
			t.Fatal("MiniMax key was not sent to its API")
		}
		switch endpoint {
		case minimaxBase + "/v2/video_generation":
			submits++
			if submits == 2 {
				return nil, fail(502, "提交结果未知")
			}
			return []byte(`{"task_id":"123"}`), nil
		case minimaxBase + "/v2/query/video_generation/123":
			return []byte(`{"task":{"id":"123","status":"succeeded","content":{"url":"https://cdn.hailuoai.com/test.mp4"}}}`), nil
		default:
			t.Fatalf("unexpected provider request: %s %s", method, endpoint)
			return nil, nil
		}
	}
	owner := actor{UserID: "opening-owner"}
	input := minimaxTestInput(t, 3000)
	first, err := s.productionOpening(t.Context(), owner, "opening-submit", input)
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.productionOpening(t.Context(), owner, "opening-submit", input)
	if err != nil || second["requestKey"] != first["requestKey"] || submits != 1 {
		t.Fatalf("same input must reuse the first submission, got %v and %d submissions", err, submits)
	}
	result, err := s.productionOpening(t.Context(), owner, "opening-query", first)
	if err != nil || result["status"] != "succeeded" || result["videoUrl"] == "" {
		t.Fatalf("query failed: %#v / %v", result, err)
	}
	if _, err = s.productionOpening(t.Context(), actor{UserID: "other"}, "opening-query", first); err == nil {
		t.Fatal("another owner could query the opening task")
	}
	input["ratio"] = "16:9"
	if _, err = s.productionOpening(t.Context(), owner, "opening-submit", input); err == nil {
		t.Fatal("expected ambiguous submit")
	}
	if _, err = s.productionOpening(t.Context(), owner, "opening-submit", input); err == nil || !strings.Contains(err.Error(), "待核对") || submits != 2 {
		t.Fatalf("ambiguous paid request was not preserved: %v / %d", err, submits)
	}
}
