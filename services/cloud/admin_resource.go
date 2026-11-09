package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"net/url"
	"slices"
	"strings"
)

// Old copies have no link. Use their catalog type and name until a version is saved.
const resourceFamilySQL = `COALESCE(payload->>'familyId', 'legacy:' || jsonb_build_array(payload->>'type', lower(trim(payload->>'name')))::text)`
const resourceVersionOrderSQL = `CASE WHEN payload->>'version' ~ '^[0-9]+(\.[0-9]+)*$' THEN string_to_array(payload->>'version', '.')::numeric[] END DESC NULLS LAST, payload->>'version' DESC, id`
const productionResourceSQL = `payload->>'type'='video' AND payload->'production'->>'schemaVersion' IN ('1','2')`

func resourceFamily(ctx context.Context, tx *sql.Tx, target, source string, input object) (string, error) {
	anchor := target
	if source != "" {
		anchor = source
	}
	var family, kind string
	err := tx.QueryRowContext(ctx, `SELECT `+resourceFamilySQL+`, COALESCE(payload->>'type','') FROM keagent_resource WHERE id=$1`, anchor).Scan(&family, &kind)
	if errors.Is(err, sql.ErrNoRows) {
		if source != "" {
			return "", fail(404, "来源模板版本不存在")
		}
		family = "id:" + target
	} else if err != nil {
		return "", err
	}
	if source != "" && (input["type"] != kind || input["published"] == true) {
		return "", fail(422, "更新版本须使用原模板类型并先保存草稿")
	}
	// Every write locks the family before any row, including switches across two versions.
	_, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('keagent-resource-family:' || $1, 0))`, family)
	return family, err
}

func queryResourceVersions(ctx context.Context, db adminQuerier, id string) ([]any, error) {
	rr, err := db.QueryContext(ctx, `SELECT payload FROM keagent_resource WHERE `+productionResourceSQL+` AND `+resourceFamilySQL+
		`=(SELECT `+resourceFamilySQL+` FROM keagent_resource WHERE id=$1 AND `+productionResourceSQL+`) ORDER BY `+resourceVersionOrderSQL, id)
	if err != nil {
		return nil, err
	}
	defer rr.Close()
	result := []any{}
	for rr.Next() {
		var b []byte
		var item object
		if err = rr.Scan(&b); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(b, &item); err != nil {
			return nil, err
		}
		result = append(result, publicResource(item))
	}
	if err = rr.Err(); err != nil {
		return nil, err
	}
	if len(result) == 0 {
		return nil, fail(404, "模板不存在")
	}
	return result, nil
}

func validateResource(input object) error {
	for _, field := range []struct {
		name     string
		maximum  int
		required bool
	}{
		{"name", 120, true}, {"version", 40, true}, {"description", 4000, false}, {"category", 80, false}, {"thumbnail", 2048, false},
	} {
		value, ok := input[field.name].(string)
		if (!ok && input[field.name] != nil) || len([]rune(value)) > field.maximum || (field.required && strings.TrimSpace(value) == "") {
			return fail(422, "资源字段无效："+field.name)
		}
	}
	if !slices.Contains([]string{"video", "style", "prompt", "cover", "subtitle"}, str(input["type"])) {
		return fail(422, "资源类型无效")
	}
	if input["published"] != nil {
		if _, ok := input["published"].(bool); !ok {
			return fail(422, "上下架状态必须为布尔值")
		}
	}
	if input["sizeMb"] != nil {
		size, ok := input["sizeMb"].(float64)
		if !ok || math.IsNaN(size) || math.IsInf(size, 0) || size < 0 || size > 100000 {
			return fail(422, "资源大小无效")
		}
	}
	if modes, ok := input["compatibleModes"].([]any); ok {
		if len(modes) < 1 || len(modes) > 2 {
			return fail(422, "请选择适用的视频模式")
		}
		seen := map[string]bool{}
		for _, mode := range modes {
			value := str(mode)
			if (value != "voiceover" && value != "avatar") || seen[value] {
				return fail(422, "适用视频模式无效或重复")
			}
			seen[value] = true
		}
	} else if input["compatibleModes"] != nil {
		return fail(422, "适用视频模式无效")
	}
	thumbnail := str(input["thumbnail"])
	if thumbnail != "" {
		u, err := url.Parse(thumbnail)
		local := strings.HasPrefix(thumbnail, "/media/") && !strings.Contains(thumbnail, "..") && !strings.ContainsAny(thumbnail, "\\?#")
		remote := err == nil && (u.Scheme == "https" || u.Scheme == "http") && u.Hostname() != "" && u.User == nil && u.RawQuery == "" && u.Fragment == ""
		if !local && !remote {
			return fail(422, "缩略图请填写公共图片地址或 /media/ 本地资源路径")
		}
	}
	if input["production"] != nil {
		return validateProduction(input)
	}
	return nil
}
