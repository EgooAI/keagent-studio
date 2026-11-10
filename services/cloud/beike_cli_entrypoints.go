package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func beikeCLIConfig() (path, key string, configured bool) {
	path = strings.TrimSpace(os.Getenv("BEIKE_CLI_PATH"))
	key = strings.TrimSpace(os.Getenv("BEIKE_MCP_API_KEY"))
	if key == "" || !filepath.IsAbs(path) {
		return path, key, false
	}
	info, err := os.Stat(path)
	return path, key, err == nil && info.Mode().IsRegular()
}

func beikeCLIEndpoint(method, path string) (object, error) {
	if method != http.MethodPost {
		return nil, fail(http.StatusMethodNotAllowed, "贝壳 CLI 接口仅支持 POST")
	}
	switch path {
	case "/v1/beike-cli/status":
		_, _, configured := beikeCLIConfig()
		reason := "not_configured"
		if configured {
			reason = "contract_unverified"
		}
		return object{"available": false, "configured": configured, "reason": reason}, nil
	case "/v1/beike-cli/search", "/v1/beike-cli/preview", "/v1/beike-cli/import":
		// shortcut: hold business routes closed until real CLI responses define the field mapping.
		return nil, fail(http.StatusServiceUnavailable, "贝壳 CLI 尚未通过真实回包验证")
	default:
		return nil, fail(http.StatusNotFound, "接口不存在")
	}
}

func beikeCLIProbe(ctx context.Context, args []string, stdout io.Writer) error {
	if len(args) != 3 {
		return errors.New("用法：beike-cli-probe search|detail|material <城市> <搜索条件或实体 ID>")
	}
	path, key, configured := beikeCLIConfig()
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
