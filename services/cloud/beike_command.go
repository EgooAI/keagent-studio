package main

import (
	"context"
	"encoding/json"
	"slices"
	"sort"
	"strings"
)

// beikeCommandAllowlist 是允许透传给贝壳 CLI 的命名空间与子命令白名单。
// 通用调用层只放行这里登记的命令，避免把任意参数变成 CLI 参数。
var beikeCommandAllowlist = map[string][]string{
	"buy":    {"search", "detail", "material", "sold", "contact", "agent", "resblock", "market", "plate", "school", "district", "rank", "store", "land", "unready", "resolve"},
	"rent":   {"search", "detail", "material", "appoint", "contact", "agent", "agent-detail", "resblock", "market", "plate", "store"},
	"sell":   {"list", "dynamic", "agent", "contact"},
	"decor":  {"stores", "price", "agent", "contact"},
	"policy": {"search"},
	"map":    {"geo", "driving", "transit"},
}

// beikeFlagAllowlist 是允许透传的 CLI 参数名白名单（长选项，不含 -- 前缀）。
var beikeFlagAllowlist = map[string]bool{
	"city": true, "query": true, "id": true, "entity-type": true, "house-type": true,
	"rank-type": true, "biz": true, "agent-ucid": true, "unix-id": true, "reason": true,
	"resblock-id": true, "house-code": true, "house-id": true, "date": true, "start": true,
	"end": true, "address": true, "origin": true, "destination": true, "cityd": true,
	"area": true, "rooms": true, "parlors": true, "cookrooms": true, "toilets": true,
}

// beikeFlagValues 兼容 JSON 里的单个字符串或字符串数组，便于一次传多个 --id。
type beikeFlagValues []string

func (v *beikeFlagValues) UnmarshalJSON(data []byte) error {
	var single string
	if json.Unmarshal(data, &single) == nil {
		*v = []string{single}
		return nil
	}
	var list []string
	if err := json.Unmarshal(data, &list); err != nil {
		return err
	}
	*v = list
	return nil
}

type beikeCallRequest struct {
	Namespace string                     `json:"namespace"`
	Command   string                     `json:"command"`
	Args      map[string]beikeFlagValues `json:"args"`
}

func beikeCallArgs(req beikeCallRequest) ([]string, error) {
	commands, ok := beikeCommandAllowlist[req.Namespace]
	if !ok {
		return nil, fail(422, "不支持的贝壳命名空间: "+req.Namespace)
	}
	if !slices.Contains(commands, req.Command) {
		return nil, fail(422, "不支持的贝壳命令: "+req.Namespace+" "+req.Command)
	}
	args := []string{req.Namespace, req.Command}
	names := make([]string, 0, len(req.Args))
	for name := range req.Args {
		if !beikeFlagAllowlist[name] {
			return nil, fail(422, "不支持的贝壳参数: "+name)
		}
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		for _, value := range req.Args[name] {
			value = strings.TrimSpace(value)
			if value == "" || strings.HasPrefix(value, "-") || strings.ContainsAny(value, "\x00\r\n") || len(value) > 300 {
				return nil, fail(422, "无效的贝壳参数值: "+name)
			}
			args = append(args, "--"+name, value)
		}
	}
	return args, nil
}

// beikeCall 是通用调用层：透传任意白名单内的贝壳命令，返回其原始结果。
// 能解析成 {ok,data} 封套时返回封套内的 data；否则（contact/appoint 等人读文本）原样返回。
func beikeCall(ctx context.Context, req beikeCallRequest) (object, error) {
	args, err := beikeCallArgs(req)
	if err != nil {
		return nil, err
	}
	path, key, configured := beikeCLIConfig(ctx)
	if !configured {
		return nil, fail(503, "服务端未配置贝壳 CLI（BEIKE_CLI_PATH / BEIKE_MCP_API_KEY）")
	}
	raw, err := runBeikeCLIArgs(ctx, path, key, args, false)
	if err != nil {
		return nil, beikeCLIError(err)
	}
	var envelope struct {
		Data  string `json:"data"`
		OK    *bool  `json:"ok"`
		Error string `json:"error"`
	}
	if json.Unmarshal(raw, &envelope) == nil && envelope.OK != nil {
		if !*envelope.OK {
			return nil, fail(502, "贝壳命令失败: "+envelope.Error)
		}
		if envelope.Data != "" {
			return object{"namespace": req.Namespace, "command": req.Command, "data": envelope.Data, "ok": true}, nil
		}
	}
	return object{"namespace": req.Namespace, "command": req.Command, "data": strings.TrimSpace(string(raw)), "ok": true}, nil
}
