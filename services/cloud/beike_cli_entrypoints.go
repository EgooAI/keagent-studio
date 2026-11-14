package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func beikeCLIConfig(ctx context.Context) (path, key string, configured bool) {
	path = strings.TrimSpace(aiValue(ctx, "BEIKE_CLI_PATH"))
	key = strings.TrimSpace(aiValue(ctx, "BEIKE_MCP_API_KEY"))
	if key == "" || !filepath.IsAbs(path) {
		return path, key, false
	}
	info, err := os.Stat(path)
	return path, key, err == nil && info.Mode().IsRegular()
}

func beikeCLIEndpoint(ctx context.Context, method, path string, body []byte) (object, error) {
	if method != http.MethodPost {
		return nil, fail(http.StatusMethodNotAllowed, "贝壳 CLI 接口仅支持 POST")
	}
	switch path {
	case "/v1/beike-cli/status":
		_, _, configured := beikeCLIConfig(ctx)
		if !configured {
			return object{"available": false, "configured": false, "reason": "not_configured"}, nil
		}
		return object{"available": true, "configured": true, "reason": "ready"}, nil
	case "/v1/beike-cli/search":
		var input struct {
			City  string `json:"city"`
			Query string `json:"query"`
		}
		if err := json.Unmarshal(body, &input); err != nil {
			return nil, fail(http.StatusBadRequest, "请求格式错误")
		}
		return beikeSearch(ctx, input.City, input.Query)
	case "/v1/beike-cli/detail":
		var input struct {
			City string   `json:"city"`
			ID   string   `json:"id"`
			IDs  []string `json:"ids"`
		}
		if err := json.Unmarshal(body, &input); err != nil {
			return nil, fail(http.StatusBadRequest, "请求格式错误")
		}
		if len(input.IDs) == 0 && input.ID != "" {
			input.IDs = []string{input.ID}
		}
		return beikeDetail(ctx, input.City, input.IDs)
	case "/v1/beike-cli/call":
		var req beikeCallRequest
		if err := json.Unmarshal(body, &req); err != nil {
			return nil, fail(http.StatusBadRequest, "请求格式错误")
		}
		return beikeCall(ctx, req)
	case "/v1/beike-cli/commands":
		return object{"commands": beikeCommandAllowlist}, nil
	case "/v1/beike-cli/preview", "/v1/beike-cli/import":
		return nil, fail(http.StatusServiceUnavailable, "该接口尚未开放")
	default:
		return nil, fail(http.StatusNotFound, "接口不存在")
	}
}

func beikeCLIProbe(ctx context.Context, args []string, stdout io.Writer) error {
	if len(args) != 3 {
		return errors.New("用法：beike-cli-probe search|detail|material <城市> <搜索条件或实体 ID>")
	}
	path, key, configured := beikeCLIConfig(ctx)
	if !configured {
		return errors.New("请配置官方 CLI 的有效绝对路径 BEIKE_CLI_PATH 和团队 BEIKE_MCP_API_KEY")
	}
	result, err := runBeikeCLI(ctx, path, key, args[0], args[1], args[2])
	if err != nil {
		return err
	}
	_, err = stdout.Write(result)
	return err
}
