package main

import (
	"context"
	"database/sql"
	_ "embed"
	"encoding/json"
	"errors"
	"math"
	"regexp"
	"slices"
	"strings"
)

//go:embed video_templates.json
var videoTemplateSeeds []byte

var recipeKeys = []string{"language", "videoMode", "rate", "speed", "direction", "maxSweep", "aspectRatio", "resolution", "subtitles", "design", "brandColor", "subtitleSize"}
var legacyScriptKeys = []string{"openingTemplate", "sceneTemplate", "closingTemplate"}
var templateVariable = regexp.MustCompile(`\{([^{}]*)\}`)
var templateColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)
var templateVersion = regexp.MustCompile(`^[1-9][0-9]{0,3}\.[0-9]{1,4}\.[0-9]{1,4}$`)

func validateProduction(resource object) error {
	recipe := obj(resource["production"])
	schema := number(recipe["schemaVersion"])
	_, hasOpening := recipe["opening"]
	expectedFields := int(schema) + 1
	if schema == 2 && hasOpening {
		expectedFields++
	}
	if recipe == nil || resource["type"] != "video" || (schema != 1 && schema != 2) || len(recipe) != expectedFields {
		return fail(422, "视频制作模板缺少完整制作规则")
	}
	if !templateVersion.MatchString(str(resource["version"])) {
		return fail(422, "制作模板版本号请使用 1.0.0 格式")
	}
	c := obj(recipe["config"])
	keys := recipeKeys
	if schema == 1 {
		keys = append(slices.Clone(keys), legacyScriptKeys...)
	}
	if mode, exists := c["cameraMode"]; exists {
		if mode != "panorama" && (mode != "spatial" || schema != 2) {
			return fail(422, "空间走动仅支持新版制作模板，请选择有效的镜头模式")
		}
		keys = append(slices.Clone(keys), "cameraMode")
	}
	if len(c) != len(keys) {
		return fail(422, "制作规则字段不完整或包含不支持的字段")
	}
	for key := range c {
		if !slices.Contains(keys, key) {
			return fail(422, "制作规则不支持字段："+key)
		}
	}
	for key, options := range map[string][]string{
		"language": {"zh-CN", "en-US"}, "videoMode": {"voiceover", "avatar"},
		"aspectRatio": {"9:16", "16:9"}, "resolution": {"720p", "1080p"},
		"design": {"standard", "classic", "short-tour"}, "subtitleSize": {"standard", "large"},
	} {
		if !slices.Contains(options, str(c[key])) {
			return fail(422, "制作规则选项无效："+key)
		}
	}
	if _, ok := c["subtitles"].(bool); !ok || !templateColor.MatchString(str(c["brandColor"])) {
		return fail(422, "字幕开关或品牌色无效")
	}
	for key, bounds := range map[string][2]float64{"rate": {0.5, 2}, "speed": {0.5, 45}, "maxSweep": {1, 180}, "direction": {-1, 1}} {
		value, ok := c[key].(float64)
		if !ok || math.IsNaN(value) || math.IsInf(value, 0) || value < bounds[0] || value > bounds[1] || (key == "direction" && value != -1 && value != 1) {
			return fail(422, "镜头或配音参数超出范围："+key)
		}
	}
	if !slices.ContainsFunc(rows(resource["compatibleModes"]), func(v any) bool { return v == c["videoMode"] }) {
		return fail(422, "适用模式必须包含模板使用的视频模式")
	}
	if schema == 2 {
		if hasOpening {
			opening := obj(recipe["opening"])
			location := obj(opening["location"])
			if c["videoMode"] != "avatar" || len(opening) != 2 || !validScriptRule(str(opening["prompt"])) {
				return fail(422, "MiniMax 开场需要露脸模式和 1–1500 字的画面提示词")
			}
			switch {
			case location["source"] == "property" && len(location) == 1:
			case location["source"] == "fixed" && len(location) == 2:
				if _, err := minimaxImage(location["image"], "模板固定地点图", 512<<10); err != nil {
					return err
				}
			default:
				return fail(422, "请选择有效的地点图片来源")
			}
		}
		rules := obj(recipe["scriptRules"])
		if len(rules) != 4 {
			return fail(422, "请填写整片、开场、逐图和结尾文案规则")
		}
		for _, key := range []string{"overall", "opening", "scene", "closing"} {
			if !validScriptRule(str(rules[key])) {
				return fail(422, "文案规则需为 1–1500 字纯文本")
			}
		}
		return nil
	}
	for _, key := range legacyScriptKeys {
		text := str(c[key])
		if !validScriptRule(text) {
			return fail(422, "开场、空间和结尾文案需为 1–1500 字纯文本")
		}
		allowed := []string{"title", "facts", "sellingPoints"}
		if key == "sceneTemplate" {
			allowed = append(allowed, "room", "description")
		}
		for _, match := range templateVariable.FindAllStringSubmatch(text, -1) {
			if !slices.Contains(allowed, match[1]) {
				return fail(422, "文案变量无效："+match[0])
			}
		}
		if strings.ContainsAny(templateVariable.ReplaceAllString(text, ""), "{}") {
			return fail(422, "文案变量的大括号不完整")
		}
	}
	if !strings.Contains(str(c["sceneTemplate"]), "{room}") {
		return fail(422, "空间文案必须包含 {room}，以保持图片与文案对应")
	}
	return nil
}

func validScriptRule(text string) bool {
	return strings.TrimSpace(text) != "" && len([]rune(text)) <= 1500 && !strings.ContainsAny(text, "\x00\x01\x02\x03\x04\x05\x06\x07\x08\x0b\x0c\x0e\x0f\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1a\x1b\x1c\x1d\x1e\x1f")
}

func productionDigest(resource object) string {
	b, _ := json.Marshal(pickFields(resource, "name", "description", "category", "version", "type", "compatibleModes", "production", "definition"))
	return digestBytes(b)
}

func seedVideoTemplates(ctx context.Context, db *sql.DB) error {
	var templates []object
	if err := json.Unmarshal(videoTemplateSeeds, &templates); err != nil {
		return err
	}
	for _, resource := range templates {
		if err := validateResource(resource); err != nil {
			return err
		}
		resource["previewDigest"] = productionDigest(resource)
		b, _ := json.Marshal(resource)
		// Seeds never overwrite an administrator's draft, published content or unlisting.
		if _, err := db.ExecContext(ctx, `INSERT INTO keagent_resource(id,payload) VALUES($1,$2) ON CONFLICT(id) DO NOTHING`, resource["id"], b); err != nil {
			return err
		}
	}
	return nil
}

func publicProduction(resource object) object {
	return pickFields(resource, "id", "name", "version", "description", "production")
}

func (s *server) productionTemplates(ctx context.Context, supportsOpening bool) ([]any, error) {
	result := []any{}
	if s.db == nil {
		return result, nil
	} // Provider-only unit fixtures have no catalog.
	rr, err := s.db.QueryContext(ctx, `SELECT payload FROM (
		SELECT DISTINCT ON (`+resourceFamilySQL+`) id, payload FROM keagent_resource
		WHERE payload->>'published'='true' AND `+productionResourceSQL+` AND ($1 OR NOT (payload->'production' ? 'opening'))
		ORDER BY `+resourceFamilySQL+`, `+resourceVersionOrderSQL+`
	) current_versions ORDER BY payload->'production'->>'schemaVersion' DESC, payload->>'name', id`, supportsOpening)
	if err != nil {
		return nil, err
	}
	defer rr.Close()
	for rr.Next() {
		var b []byte
		var resource object
		if err = rr.Scan(&b); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(b, &resource); err != nil {
			return nil, err
		}
		if err = validateProduction(resource); err != nil {
			return nil, err
		}
		result = append(result, publicProduction(resource))
	}
	return result, rr.Err()
}

func (s *server) productionTemplate(ctx context.Context, input object) (object, error) {
	return s.loadProductionTemplate(ctx, input, false)
}

func (s *server) loadProductionTemplate(ctx context.Context, input object, allowRetired bool) (object, error) {
	var b []byte
	err := s.db.QueryRowContext(ctx, `SELECT payload FROM keagent_resource WHERE id=$1 AND payload ? 'production'
		AND (payload->>'published'='true' OR ($2 AND payload->>'publishedOnce'='true'
		AND payload->>'version'=$3))`,
		str(input["id"]), allowRetired, str(input["version"])).Scan(&b)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fail(409, "模板已下架或不存在，请刷新后重新选择")
	}
	if err != nil {
		return nil, err
	}
	var resource object
	if err = json.Unmarshal(b, &resource); err != nil {
		return nil, err
	}
	if str(input["version"]) != "" && input["version"] != resource["version"] {
		return nil, fail(409, "模板版本已变化，请刷新后重新选择")
	}
	if err = validateProduction(resource); err != nil {
		return nil, err
	}
	return publicProduction(resource), nil
}

func (s *server) previewProduction(ctx context.Context, a actor, input object, generate bool) (any, error) {
	var b []byte
	err := s.db.QueryRowContext(ctx, `SELECT payload FROM keagent_resource WHERE id=$1 AND `+undeletedResourceSQL, str(input["id"])).Scan(&b)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fail(404, "模板不存在，请先保存草稿")
	}
	if err != nil {
		return nil, err
	}
	var resource object
	if err = json.Unmarshal(b, &resource); err != nil {
		return nil, err
	}
	definition := obj(resource["definition"])
	if definition != nil {
		err = validateCatalogTemplate(resource)
	} else {
		err = validateProduction(resource)
	}
	if err != nil {
		return nil, err
	}
	digest := productionDigest(resource)
	cached := resource["previewDigest"] == digest && resource["previewSegments"] != nil
	if !generate && !cached {
		return nil, nil
	}
	preview := object{}
	sample := publicProduction(resource)
	kind := str(definition["kind"])
	if definition != nil {
		parts := map[string]object{"edit": previewDefaults["edit"], "script": previewDefaults["script"]}
		if kind == "bundle" {
			parts, err = bundleParts(ctx, s.db, definition, resource["publishedOnce"] != true)
			if err != nil {
				return nil, err
			}
			sample["parts"] = definition["parts"]
		} else {
			parts[kind] = definition
		}
		preview["definition"] = definition
		if cover := parts["cover"]; cover != nil {
			preview["cover"] = cover
		}
		sample["production"] = composeProduction(parts["edit"], parts["script"])
	}
	preview["template"] = sample
	recipe := obj(sample["production"])
	c := obj(recipe["config"])
	omitOpening := c["videoMode"] == "avatar"
	previewSegments := func(saved any) any {
		if !omitOpening {
			return saved
		}
		return slices.DeleteFunc(slices.Clone(rows(saved)), func(segment any) bool {
			return obj(segment)["id"] == "opening"
		})
	}
	if cached {
		preview["segments"] = previewSegments(resource["previewSegments"])
		return preview, nil
	}
	segments := []object{}
	needsScript := kind != "cover" && kind != "edit"
	if needsScript && number(recipe["schemaVersion"]) == 2 {
		images := rows(input["images"])
		if len(images) != 2 || obj(images[0])["id"] != "preview-1" || obj(images[1])["id"] != "preview-2" ||
			obj(images[0])["kind"] != "photo" || obj(images[1])["kind"] != "photo" {
			return nil, fail(422, "新版模板预览需要两张示例图片")
		}
		aiCtx, err := s.activeAI(ctx)
		if err != nil {
			return nil, err
		}
		segments, err = generateVisionScript(aiCtx, sample, object{"title": "示例房源", "description": "两张图片仅供模板预览，房源事实未提供。"}, images, omitOpening)
		if err != nil {
			return nil, err
		}
	} else if needsScript {
		values := strings.NewReplacer("{title}", "示例小区两居室", "{facts}", "建筑面积约80平方米，2室1厅。", "{sellingPoints}", "已核实的空间布局", "{room}", "客厅", "{description}", "原图展示客厅的空间布局。")
		if c["language"] == "en-US" {
			values = strings.NewReplacer("{title}", "Sample two-bedroom home", "{facts}", "Approximately 80 square meters, two bedrooms.", "{sellingPoints}", "Verified room layout", "{room}", "Living room", "{description}", "The original photo shows the living room layout.")
		}
		for _, item := range []struct{ id, key string }{{"opening", "openingTemplate"}, {"scene", "sceneTemplate"}, {"closing", "closingTemplate"}} {
			if item.id != "opening" || !omitOpening {
				segments = append(segments, object{"id": item.id, "text": values.Replace(str(c[item.key]))})
			}
		}
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	err = tx.QueryRowContext(ctx, `SELECT payload FROM keagent_resource WHERE id=$1 AND `+undeletedResourceSQL+` FOR UPDATE`, str(input["id"])).Scan(&b)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fail(404, "模板已删除")
	}
	if err != nil {
		return nil, err
	}
	var current object
	if err = json.Unmarshal(b, &current); err != nil {
		return nil, err
	}
	if productionDigest(current) != digest {
		return nil, fail(409, "预览期间模板已修改，请重新预览")
	}
	if current["previewDigest"] == digest && current["previewSegments"] != nil {
		preview["segments"] = previewSegments(current["previewSegments"])
		return preview, nil
	}
	current["previewDigest"] = digest
	current["previewSegments"] = segments
	resource = current
	b, _ = json.Marshal(resource)
	if _, err = tx.ExecContext(ctx, `UPDATE keagent_resource SET payload=$2 WHERE id=$1`, resource["id"], b); err != nil {
		return nil, err
	}
	metadata, _ := json.Marshal(resourceAuditFields(resource))
	if _, err = tx.ExecContext(ctx, `INSERT INTO keagent_audit(id,actor_id,action,target_id,metadata) VALUES($1,$2,'resource.preview',$3,$4)`, id(), a.UserID, resource["id"], metadata); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	preview["segments"] = segments
	return preview, nil
}
