package main

import (
	"math"
	"net/url"
	"slices"
	"strings"
)

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
