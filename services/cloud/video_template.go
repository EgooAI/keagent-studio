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

var recipeKeys = []string{"language", "openingTemplate", "sceneTemplate", "closingTemplate", "videoMode", "rate", "speed", "direction", "maxSweep", "aspectRatio", "resolution", "subtitles", "design", "brandColor", "subtitleSize"}
var templateVariable = regexp.MustCompile(`\{([^{}]*)\}`)
var templateColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)
var templateVersion = regexp.MustCompile(`^[1-9][0-9]{0,3}\.[0-9]{1,4}\.[0-9]{1,4}$`)

func validateProduction(resource object) error {
	recipe := obj(resource["production"])
	if recipe == nil || resource["type"] != "video" || len(recipe) != 2 || number(recipe["schemaVersion"]) != 1 {
		return fail(422, "视频制作模板需要 schemaVersion=1 的完整制作规则")
	}
	if !templateVersion.MatchString(str(resource["version"])) {
		return fail(422, "制作模板版本号请使用 1.0.0 格式")
	}
	c := obj(recipe["config"])
	if len(c) != len(recipeKeys) {
		return fail(422, "制作规则字段不完整或包含不支持的字段")
	}
	for key := range c {
		if !slices.Contains(recipeKeys, key) {
			return fail(422, "制作规则不支持字段："+key)
		}
	}
	for key, options := range map[string][]string{
		"language": {"zh-CN", "en-US"}, "videoMode": {"voiceover", "avatar"},
		"aspectRatio": {"9:16", "16:9"}, "resolution": {"720p", "1080p"},
		"design": {"standard", "classic"}, "subtitleSize": {"standard", "large"},
	} {
		if !slices.Contains(options, str(c[key])) {
			return fail(422, "制作规则选项无效："+key)
		}
	}
	if _, ok := c["subtitles"].(bool); !ok || !templateColor.MatchString(str(c["brandColor"])) {
		return fail(422, "字幕开关或品牌色无效")
	}
	for key, bounds := range map[string][2]float64{"rate": {0.5, 2}, "speed": {0.5, 12}, "maxSweep": {1, 180}, "direction": {-1, 1}} {
		value, ok := c[key].(float64)
		if !ok || math.IsNaN(value) || math.IsInf(value, 0) || value < bounds[0] || value > bounds[1] || (key == "direction" && value != -1 && value != 1) {
			return fail(422, "镜头或配音参数超出范围："+key)
		}
	}
	if !slices.ContainsFunc(rows(resource["compatibleModes"]), func(v any) bool { return v == c["videoMode"] }) {
		return fail(422, "适用模式必须包含模板使用的视频模式")
	}
	for _, key := range []string{"openingTemplate", "sceneTemplate", "closingTemplate"} {
		text := str(c[key])
		if strings.TrimSpace(text) == "" || len([]rune(text)) > 1500 || strings.ContainsAny(text, "\x00\x01\x02\x03\x04\x05\x06\x07\x08\x0b\x0c\x0e\x0f\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1a\x1b\x1c\x1d\x1e\x1f") {
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

func productionDigest(resource object) string {
	b, _ := json.Marshal(pickFields(resource, "name", "description", "category", "version", "type", "compatibleModes", "production"))
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

func (s *server) productionTemplates(ctx context.Context) ([]any, error) {
	result := []any{}
	if s.db == nil {
		return result, nil
	} // Provider-only unit fixtures have no catalog.
	rr, err := s.db.QueryContext(ctx, `SELECT payload FROM keagent_resource WHERE payload->>'published'='true' AND payload->'production'->>'schemaVersion'='1' ORDER BY payload->>'name',id`)
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
	var b []byte
	err := s.db.QueryRowContext(ctx, `SELECT payload FROM keagent_resource WHERE id=$1 AND payload->>'published'='true' AND payload ? 'production'`, str(input["id"])).Scan(&b)
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

func (s *server) previewProduction(ctx context.Context, a actor, input object) (any, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var b []byte
	err = tx.QueryRowContext(ctx, `SELECT payload FROM keagent_resource WHERE id=$1 FOR UPDATE`, str(input["id"])).Scan(&b)
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
	if err = validateProduction(resource); err != nil {
		return nil, err
	}
	c := obj(obj(resource["production"])["config"])
	values := strings.NewReplacer("{title}", "示例小区两居室", "{facts}", "建筑面积约80平方米，2室1厅。", "{sellingPoints}", "已核实的空间布局", "{room}", "客厅", "{description}", "原图展示客厅的空间布局。")
	if c["language"] == "en-US" {
		values = strings.NewReplacer("{title}", "Sample two-bedroom home", "{facts}", "Approximately 80 square meters, two bedrooms.", "{sellingPoints}", "Verified room layout", "{room}", "Living room", "{description}", "The original photo shows the living room layout.")
	}
	segments := []any{}
	for _, item := range []struct{ id, key string }{{"opening", "openingTemplate"}, {"scene", "sceneTemplate"}, {"closing", "closingTemplate"}} {
		segments = append(segments, object{"id": item.id, "text": values.Replace(str(c[item.key]))})
	}
	resource["previewDigest"] = productionDigest(resource)
	b, _ = json.Marshal(resource)
	if _, err = tx.ExecContext(ctx, `UPDATE keagent_resource SET payload=$2 WHERE id=$1`, resource["id"], b); err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO keagent_audit(id,actor_id,action,target_id,metadata) VALUES($1,$2,'resource.preview',$3,$4)`, id(), a.UserID, resource["id"], `{"type":"video"}`); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return object{"template": publicProduction(resource), "segments": segments}, nil
}
