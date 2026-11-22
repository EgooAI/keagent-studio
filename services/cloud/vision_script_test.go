package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/jpeg"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
)

func TestVisionScriptProviderPayload(t *testing.T) {
	var catalog []object
	if err := json.Unmarshal(videoTemplateSeeds, &catalog); err != nil {
		t.Fatal(err)
	}
	template := catalog[slices.IndexFunc(catalog, func(item object) bool { return item["id"] == "concise-vision" })]
	if err := validateProduction(template); err != nil {
		t.Fatal(err)
	}
	var jpg bytes.Buffer
	if err := jpeg.Encode(&jpg, image.NewRGBA(image.Rect(0, 0, 16, 16)), nil); err != nil {
		t.Fatal(err)
	}
	imageData := base64.StdEncoding.EncodeToString(jpg.Bytes())
	images := []any{
		object{"id": "room-photo", "kind": "photo", "jpeg": imageData},
		object{"id": "floor-plan", "kind": "reference", "jpeg": imageData},
		object{"id": "room-pano", "kind": "panorama", "jpeg": imageData},
	}
	parts, ids, err := visionContent(template, object{"title": "测试房源", "areaSqm": 80, "details": object{"orientation": "南北", "vrUrl": "https://example.com/vr"}}, images, false)
	if err != nil || !slices.Equal(ids, []string{"opening", "room-photo", "room-pano", "closing"}) {
		t.Fatalf("invalid segment plan: %v, %v", ids, err)
	}
	response := `[{"id":"opening","text":"开场"},{"id":"room-photo","text":"普通图"},{"id":"room-pano","text":"全景图"},{"id":"closing","text":"结尾"}]`
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload struct {
			Messages []struct{ Content json.RawMessage }
		}
		var content []object
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil || len(payload.Messages) != 2 {
			t.Error("missing provider messages")
			return
		}
		if err := json.Unmarshal(payload.Messages[1].Content, &content); err != nil || len(content) != 7 {
			t.Error("provider did not receive three visual inputs")
			return
		}
		if text := str(content[0]["text"]); !strings.Contains(text, "测试房源") || !strings.Contains(text, "overall") || !strings.Contains(text, "南北") || strings.Contains(text, "vrUrl") {
			t.Error("missing property facts or template rules")
		}
		for i := range images {
			if !strings.Contains(str(content[1+i*2]["text"]), str(obj(images[i])["id"])) ||
				str(obj(content[2+i*2]["image_url"])["url"]) != "data:image/jpeg;base64,"+imageData {
				t.Error("image ID or original image bytes missing")
			}
		}
		_ = json.NewEncoder(w).Encode(object{"choices": []object{{"message": object{"content": response}}}})
	}))
	defer provider.Close()
	value, err := completionWithContent(t.Context(), provider.Client(), provider.URL, "vision-model", "test-key", parts, visionInstruction)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := validateVisionSegments(value, ids); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{
		strings.Replace(value, "room-photo", "floor-plan", 1),
		strings.Replace(value, "room-pano", "room-photo", 1),
		`[{"id":"opening","text":"开场"},{"id":"closing","text":"结尾"}]`,
	} {
		if _, err := validateVisionSegments(bad, ids); err == nil {
			t.Fatal("accepted incomplete or misaligned image script")
		}
	}
	recipe := obj(template["production"])
	recipe["opening"] = object{"prompt": "边走边介绍"}
	originalRule := str(obj(recipe["scriptRules"])["opening"])
	openingParts, _, err := visionContent(template, object{"title": "测试房源"}, images, false)
	if err != nil {
		t.Fatal(err)
	}
	var openingInput object
	if json.Unmarshal([]byte(str(openingParts[0]["text"])), &openingInput) != nil {
		t.Fatal("invalid opening instructions")
	}
	openingRule := str(obj(openingInput["rules"])["opening"])
	if !strings.Contains(openingRule, "6–10 秒") || !strings.Contains(openingRule, "不描述第一张室内图片") || str(obj(recipe["scriptRules"])["opening"]) != originalRule {
		t.Fatal("opening guidance missing or persisted template mutated")
	}
	parts, ids, err = visionContent(template, object{"title": "测试房源"}, images, true)
	if err != nil || !slices.Equal(ids, []string{"room-photo", "room-pano", "closing"}) {
		t.Fatalf("uploaded opening requested an opening script: %v, %v", ids, err)
	}
	var tourInput object
	if json.Unmarshal([]byte(str(parts[0]["text"])), &tourInput) != nil ||
		obj(tourInput["rules"])["opening"] != nil ||
		!strings.Contains(str(obj(tourInput["rules"])["overall"]), "只写逐图带看和结尾") {
		t.Fatal("uploaded opening rules should only request the walkthrough")
	}
	if _, err := validateVisionSegments(response, ids); err == nil {
		t.Fatal("accepted an unexpected opening script")
	}
	delete(recipe, "opening")
	obj(images[0])["jpeg"] = "not-an-image"
	if _, _, err := visionContent(template, object{"title": "测试房源"}, images, false); err == nil {
		t.Fatal("accepted invalid image data")
	}
	delete(obj(obj(template["production"])["scriptRules"]), "overall")
	if err := validateProduction(template); err == nil {
		t.Fatal("accepted a v2 template without overall instructions")
	}
}

func TestShortTourScriptPacing(t *testing.T) {
	var catalog []object
	if err := json.Unmarshal(videoTemplateSeeds, &catalog); err != nil {
		t.Fatal(err)
	}
	var jpg bytes.Buffer
	if err := jpeg.Encode(&jpg, image.NewRGBA(image.Rect(0, 0, 16, 16)), nil); err != nil {
		t.Fatal(err)
	}
	images := []any{object{"id": "room", "kind": "panorama", "jpeg": base64.StdEncoding.EncodeToString(jpg.Bytes())}}
	mixed := object{"parts": object{"script": object{"id": "chosen"}}, "production": object{
		"config": object{"design": "short-tour", "language": "zh-CN"}, "scriptRules": object{"overall": "按我的讲解节奏逐室介绍。"},
	}}
	mixedParts, _, err := visionContent(mixed, object{"title": "测试房源"}, images, false)
	if err != nil {
		t.Fatal(err)
	}
	var mixedInput object
	if err = json.Unmarshal([]byte(str(mixedParts[0]["text"])), &mixedInput); err != nil || obj(mixedInput["rules"])["overall"] != "按我的讲解节奏逐室介绍。" {
		t.Fatal("edit replaced the selected script's voice or pacing")
	}
	for _, id := range []string{"short-tour-vision", "short-tour-avatar"} {
		t.Run(id, func(t *testing.T) {
			index := slices.IndexFunc(catalog, func(item object) bool { return item["id"] == id })
			if index < 0 {
				t.Fatal("short-tour template missing")
			}
			template := catalog[index]
			if err := validateProduction(template); err != nil {
				t.Fatal(err)
			}
			before, _ := json.Marshal(template)
			parts, _, err := visionContent(template, object{"title": "测试房源"}, images, false)
			if err != nil {
				t.Fatal(err)
			}
			var input object
			if err = json.Unmarshal([]byte(str(parts[0]["text"])), &input); err != nil {
				t.Fatal(err)
			}
			rules := obj(input["rules"])
			if !strings.Contains(str(rules["overall"]), "24–30 秒") ||
				!strings.Contains(str(rules["opening"]), "2–3 秒") ||
				strings.Contains(str(rules["opening"]), "6–10 秒") ||
				!strings.Contains(str(rules["closing"]), "最后一个房间画面") {
				t.Fatal("short-tour pacing was lost or overridden")
			}
			after, _ := json.Marshal(template)
			if !bytes.Equal(before, after) {
				t.Fatal("request guidance changed the saved template")
			}
		})
	}
}
