package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"maps"
	"strings"
)

var partKinds = []string{"edit", "cover", "script"}
var catalogTypes = map[string]string{"bundle": "video", "edit": "style", "cover": "cover", "script": "prompt"}
var partLabels = map[string]string{"edit": "剪辑模板", "cover": "封面模板", "script": "文案模板"}

func splitProduction(recipe object) map[string]object {
	config := obj(recipe["config"])
	editConfig := pickFields(config, recipeKeys...)
	delete(editConfig, "language")
	if mode := config["cameraMode"]; mode != nil {
		editConfig["cameraMode"] = mode
	}
	edit := object{"kind": "edit", "config": editConfig}
	if opening := recipe["opening"]; opening != nil {
		edit["opening"] = opening
	}
	script := object{"kind": "script", "language": config["language"]}
	if number(recipe["schemaVersion"]) == 1 {
		script["phrases"] = pickFields(config, legacyScriptKeys...)
	} else {
		script["scriptRules"] = recipe["scriptRules"]
	}
	cover := object{"kind": "cover", "design": config["design"], "brandColor": config["brandColor"], "imageSource": "first", "titleSource": "property", "showFacts": true}
	switch config["design"] {
	case "short-tour":
		cover["titleSource"] = "opening"
	case "classic":
		// This renderer takes a frame from the finished movie, including its overlays.
		cover["imageSource"], cover["showFacts"] = "frame", false
	}
	return map[string]object{"edit": edit, "script": script, "cover": cover}
}

// Standalone part previews use the same reference settings as a standard property tour.
var previewDefaults = splitProduction(object{
	"schemaVersion": float64(2),
	"config":        object{"language": "zh-CN", "videoMode": "voiceover", "rate": 1.0, "speed": 4.0, "direction": 1.0, "maxSweep": 100.0, "aspectRatio": "9:16", "resolution": "720p", "subtitles": true, "design": "standard", "brandColor": "#167D8D", "subtitleSize": "standard"},
	"scriptRules":   object{"overall": "按素材顺序带看房源。", "opening": "介绍本次带看重点。", "scene": "讲解画面中可见的空间。", "closing": "邀请预约看房。"},
})

func composeProduction(edit, script object) object {
	config := maps.Clone(obj(edit["config"]))
	if config == nil {
		config = object{}
	}
	config["language"] = script["language"]
	result := object{"schemaVersion": float64(2), "config": config, "scriptRules": script["scriptRules"]}
	if opening := edit["opening"]; opening != nil {
		result["opening"] = opening
	}
	if phrases := obj(script["phrases"]); phrases != nil {
		if edit["opening"] == nil && config["cameraMode"] != "spatial" {
			maps.Copy(config, pickFields(phrases, legacyScriptKeys...))
			return object{"schemaVersion": float64(1), "config": config}
		}
		result["scriptRules"] = object{"overall": "按素材顺序带看房源。", "opening": phrases["openingTemplate"], "scene": phrases["sceneTemplate"], "closing": phrases["closingTemplate"]}
	}
	return result
}

func validateCatalogTemplate(resource object) error {
	d := obj(resource["definition"])
	kind := str(d["kind"])
	typ, ok := catalogTypes[kind]
	if !ok || resource["type"] != typ || resource["production"] != nil || !templateVersion.MatchString(str(resource["version"])) {
		return fail(422, "公共模板类型、版本或内容无效")
	}
	edit, script := previewDefaults["edit"], previewDefaults["script"]
	switch kind {
	case "bundle":
		refs := obj(d["parts"])
		if len(d) != 2 || len(refs) != len(partKinds) {
			return fail(422, "推荐搭配需要各选一个剪辑、封面和文案版本")
		}
		for _, key := range partKinds {
			ref := obj(refs[key])
			if str(ref["id"]) == "" || !templateVersion.MatchString(str(ref["version"])) {
				return fail(422, "请选择有效的"+partLabels[key]+"版本")
			}
		}
		return nil
	case "cover":
		if len(d) != 6 || (d["design"] != "classic" && d["design"] != "standard" && d["design"] != "short-tour") ||
			!templateColor.MatchString(str(d["brandColor"])) || (d["imageSource"] != "first" && d["imageSource"] != "last" && d["imageSource"] != "frame" && d["imageSource"] != "listing-frame") ||
			(d["titleSource"] != "opening" && d["titleSource"] != "property") {
			return fail(422, "封面版式、品牌色或图文来源无效")
		}
		if _, ok := d["showFacts"].(bool); !ok {
			return fail(422, "请选择是否展示房源参数")
		}
		return nil
	case "edit":
		if len(d) != len(pickFields(d, "kind", "config", "opening")) || obj(d["config"]) == nil {
			return fail(422, "剪辑模板参数无效")
		}
		if _, exists := obj(d["config"])["language"]; exists {
			return fail(422, "文案语言应保存在文案模板中")
		}
		edit = d
	case "script":
		if len(d) != 3 || (obj(d["scriptRules"]) == nil) == (obj(d["phrases"]) == nil) {
			return fail(422, "请填写完整文案规则")
		}
		if phrases := obj(d["phrases"]); phrases != nil && len(phrases) != len(legacyScriptKeys) {
			return fail(422, "旧版文案只支持开场、逐图和结尾句式")
		}
		script = d
	}
	return validateProduction(object{"type": "video", "version": resource["version"], "compatibleModes": []any{obj(edit["config"])["videoMode"]}, "production": composeProduction(edit, script)})
}

// Each ID identifies one immutable, published version. Existing bundles may still preview
// a retired or soft-deleted part. Selecting a part for a new publication requires it to be live.
func bundleParts(ctx context.Context, db adminQuerier, definition object, requireLive bool) (map[string]object, error) {
	return resolveBundleParts(ctx, db, obj(definition["parts"]), requireLive, nil)
}

func samePartVersion(a, b object) bool {
	return str(a["id"]) != "" && a["id"] == b["id"] && a["version"] == b["version"]
}

func resolveBundleParts(ctx context.Context, db adminQuerier, refs object, requireLive bool, pinned object) (map[string]object, error) {
	parts := map[string]object{}
	for _, kind := range partKinds {
		ref := obj(refs[kind])
		if str(ref["id"]) == "" || !templateVersion.MatchString(str(ref["version"])) {
			return nil, fail(422, "请选择有效的"+partLabels[kind]+"版本")
		}
		var raw []byte
		var name string
		err := db.QueryRowContext(ctx, `SELECT payload->'definition', payload->>'name' FROM keagent_resource
			WHERE id=$1 AND payload->>'version'=$2 AND payload->'definition'->>'kind'=$3 AND
			((payload->>'published'='true' AND `+undeletedResourceSQL+`) OR (NOT $4 AND payload->>'publishedOnce'='true')) FOR SHARE`,
			str(ref["id"]), str(ref["version"]), kind, requireLive && !samePartVersion(ref, obj(pinned[kind]))).Scan(&raw, &name)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, fail(409, partLabels[kind]+"版本不可选，请选择已上架版本")
		}
		if err != nil {
			return nil, err
		}
		var part object
		if err = json.Unmarshal(raw, &part); err != nil {
			return nil, err
		}
		parts[kind] = part
		refs[kind] = object{"id": ref["id"], "version": ref["version"], "name": name}
	}
	return parts, nil
}

func templateOptions(ctx context.Context, db adminQuerier) ([]object, error) {
	rr, err := db.QueryContext(ctx, `SELECT id, payload->>'name', payload->>'version', payload->'definition'->>'kind' FROM keagent_resource
		WHERE payload->'definition'->>'kind' IN ('edit','cover','script') AND payload->>'published'='true' AND `+undeletedResourceSQL+` ORDER BY payload->>'name', id`)
	if err != nil {
		return nil, err
	}
	defer rr.Close()
	items := []object{}
	for rr.Next() {
		var id, name, version, kind string
		if err = rr.Scan(&id, &name, &version, &kind); err != nil {
			return nil, err
		}
		items = append(items, object{"id": id, "name": name, "version": version, "kind": kind})
	}
	return items, rr.Err()
}

func libraryPartName(kind string, definition, source object) string {
	name := str(source["name"])
	switch kind {
	case "cover":
		if definition["imageSource"] == "listing-frame" {
			return "成片首帧 · 三行房源封面"
		}
		if definition["imageSource"] == "frame" {
			return "成片首秒截帧"
		}
		return map[string]string{"standard": "品牌信息栏", "classic": "简洁标题", "short-tour": "醒目大标题"}[str(definition["design"])] + " · " + str(definition["brandColor"])
	case "script":
		return strings.TrimSuffix(name, " · 经纪人开场")
	}
	return name
}

func importTemplatePart(ctx context.Context, tx *sql.Tx, source, definition object, family string, active, locked bool) (object, error) {
	kind := str(definition["kind"])
	encoded, _ := json.Marshal(definition)
	partID := "part:" + kind + ":" + digestBytes(encoded)
	var name, version string
	err := tx.QueryRowContext(ctx, `SELECT payload->>'name',payload->>'version' FROM keagent_resource WHERE id=$1
		AND ($2 OR (payload->>'published'='true' AND `+undeletedResourceSQL+`))`, partID, locked).Scan(&name, &version)
	if err == nil {
		return object{"id": partID, "name": name, "version": version}, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if !locked {
		// Unpublished content stays private to its source draft until approved.
		partID += ":" + str(source["id"])
	}
	name = libraryPartName(kind, definition, source)
	version = str(source["version"])
	var duplicate bool
	if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM keagent_resource WHERE payload->'definition'->>'kind'=$1
		AND lower(trim(payload->>'name'))=lower(trim($2)) AND payload->>'version'=$3 AND `+undeletedResourceSQL+`)`, kind, name, version).Scan(&duplicate); err != nil {
		return nil, err
	}
	if duplicate {
		label := []rune(str(source["name"]) + " · " + partLabels[kind])
		name = string(label[:min(108, len(label))]) + " · " + digestBytes([]byte(partID))[:8]
	}
	item := pickFields(source, "category", "installed", "sizeMb", "thumbnail", "downloadStatus", "downloadProgress")
	item["id"], item["familyId"], item["type"] = partID, "part:"+kind+":"+family, catalogTypes[kind]
	item["name"], item["version"], item["definition"], item["description"] = name, version, definition, ""
	item["compatibleModes"] = []any{"voiceover", "avatar"}
	if kind == "edit" {
		item["compatibleModes"] = []any{obj(definition["config"])["videoMode"]}
	}
	item["published"], item["publishedOnce"] = active, locked
	if locked {
		item["previewDigest"] = productionDigest(item)
	}
	body, _ := json.Marshal(item)
	if _, err = tx.ExecContext(ctx, `INSERT INTO keagent_resource(id,payload) VALUES($1,$2)`, partID, body); err != nil {
		return nil, err
	}
	return object{"id": partID, "name": name, "version": version}, nil
}

// Take one atomic snapshot of the old catalog. Thereafter the two publication
// workflows are independent while installed desktop clients use the originals.
func migrateTemplateLibrary(ctx context.Context, db *sql.DB) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('keagent-template-library-import', 0))`); err != nil {
		return err
	}
	marker, err := tx.ExecContext(ctx, `INSERT INTO keagent_setting(id,payload) VALUES('template-library-import-v1','{}') ON CONFLICT(id) DO NOTHING`)
	if err != nil {
		return err
	}
	count, err := marker.RowsAffected()
	if err != nil || count == 0 {
		return err
	}
	rr, err := tx.QueryContext(ctx, `WITH originals AS (
		SELECT id,payload,`+resourceFamilySQL+` family,row_number() OVER (PARTITION BY `+resourceFamilySQL+` ORDER BY (payload->>'published'='true') DESC NULLS LAST, `+resourceVersionOrderSQL+`) ranking
		FROM keagent_resource WHERE `+productionResourceSQL+` AND `+undeletedResourceSQL+`)
		SELECT payload,family,ranking=1 AND COALESCE(payload->>'published'='true',false) active FROM originals o
		WHERE NOT EXISTS(SELECT 1 FROM keagent_resource WHERE id='bundle:' || o.id)
		ORDER BY active DESC, (COALESCE(payload->>'publishedOnce'='true',false) OR COALESCE(payload->>'published'='true',false)) DESC,
			CASE id WHEN 'standard-tour-vision' THEN 0 WHEN 'short-tour-vision-v1-1' THEN 1 ELSE 2 END, id`)
	if err != nil {
		return err
	}
	type original struct {
		resource object
		family   string
		active   bool
	}
	var originals []original
	for rr.Next() {
		var row original
		var raw []byte
		if err = rr.Scan(&raw, &row.family, &row.active); err == nil {
			err = json.Unmarshal(raw, &row.resource)
		}
		if err != nil {
			rr.Close()
			return err
		}
		originals = append(originals, row)
	}
	rr.Close()
	if err = rr.Err(); err != nil {
		return err
	}
	for _, row := range originals {
		source := row.resource
		parts := splitProduction(obj(source["production"]))
		refs := object{}
		locked := source["published"] == true || source["publishedOnce"] == true
		for _, kind := range partKinds {
			refs[kind], err = importTemplatePart(ctx, tx, source, parts[kind], row.family, row.active, locked)
			if err != nil {
				return err
			}
		}
		bundle := pickFields(source, "name", "version", "description", "category", "type", "thumbnail", "compatibleModes", "installed", "sizeMb", "downloadStatus", "downloadProgress")
		bundle["id"], bundle["familyId"], bundle["definition"] = "bundle:"+str(source["id"]), "bundle:"+row.family, object{"kind": "bundle", "parts": refs}
		bundle["compatibleModes"] = []any{obj(parts["edit"]["config"])["videoMode"]}
		bundle["published"], bundle["publishedOnce"] = row.active, locked
		if locked {
			bundle["previewDigest"] = productionDigest(bundle)
			if source["previewSegments"] != nil {
				bundle["previewSegments"] = source["previewSegments"]
			}
		}
		body, _ := json.Marshal(bundle)
		if _, err = tx.ExecContext(ctx, `INSERT INTO keagent_resource(id,payload) VALUES($1,$2)`, bundle["id"], body); err != nil {
			return err
		}
	}
	return tx.Commit()
}
