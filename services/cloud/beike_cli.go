package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"
)

const beikeCLITimeout = 30 * time.Second

var (
	errBeikeCLIRejected      = errors.New("贝壳拒绝当前客户端请求（invalid cli request）")
	errBeikeCLIExecution     = errors.New("贝壳 CLI 执行失败")
	errBeikeCLIBusiness      = errors.New("贝壳 CLI 返回业务错误")
	errBeikeCLIInvalidOutput = errors.New("贝壳 CLI 返回格式不受支持")
	errBeikeCLIOutputLimit   = errors.New("贝壳 CLI 输出超过上限")
	beikeCLISlots            = make(chan struct{}, 2)
)

func runBeikeCLI(ctx context.Context, executable, key, operation, city, value string) ([]byte, error) {
	if !filepath.IsAbs(executable) {
		return nil, errors.New("请配置贝壳 CLI 可执行文件的绝对路径")
	}
	key = strings.TrimSpace(key)
	if key == "" || strings.ContainsAny(key, "\x00\r\n") {
		return nil, errors.New("贝壳 CLI API Key 未配置或无效")
	}
	args, err := beikeCLIArgs(operation, city, value)
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithTimeout(ctx, beikeCLITimeout)
	defer cancel()
	select {
	case beikeCLISlots <- struct{}{}:
		defer func() { <-beikeCLISlots }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	cmd := exec.CommandContext(ctx, executable, args...)
	cmd.Dir = filepath.Dir(executable)
	cmd.Env = []string{"BEIKE_MCP_API_KEY=" + key}
	for _, name := range []string{"SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR"} {
		if value, exists := os.LookupEnv(name); exists {
			cmd.Env = append(cmd.Env, name+"="+value)
		}
	}
	cmd.WaitDelay = time.Second
	stdout := &beikeCLIOutput{limit: 4 << 20}
	stderr := &beikeCLIOutput{limit: 64 << 10}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	runErr := cmd.Run()
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if stdout.exceeded || stderr.exceeded {
		return nil, errBeikeCLIOutputLimit
	}
	if runErr != nil {
		if bytes.Contains(stderr.buffer.Bytes(), []byte("invalid cli request")) || errors.Is(validateBeikeCLIOutput(stdout.buffer.Bytes()), errBeikeCLIRejected) {
			return nil, errBeikeCLIRejected
		}
		if errors.Is(runErr, os.ErrNotExist) {
			return nil, errors.New("未找到配置的贝壳 CLI 可执行文件")
		}
		return nil, errBeikeCLIExecution
	}
	output := stdout.buffer.Bytes()
	if err = validateBeikeCLIOutput(output); err != nil {
		return nil, err
	}
	if bytes.Contains(output, []byte(key)) {
		return nil, errBeikeCLIInvalidOutput
	}
	return output, nil
}

func beikeCLIArgs(operation, city, value string) ([]string, error) {
	city, value = strings.TrimSpace(city), strings.TrimSpace(value)
	if city == "" || !utf8.ValidString(city) || len(city) > 300 || strings.HasPrefix(city, "-") || strings.ContainsAny(city, "\x00\r\n") {
		return nil, errors.New("请填写有效城市")
	}
	if value == "" || !utf8.ValidString(value) || len(value) > 3000 || strings.HasPrefix(value, "-") || strings.ContainsAny(value, "\x00\r\n") {
		return nil, errors.New("请填写有效查询条件或实体 ID")
	}
	args := []string{"buy", operation, "--city", city}
	switch operation {
	case "search":
		if !strings.Contains(value, "在售二手房") {
			value = "在售二手房，" + value
		}
		args = append(args, "--query", value, "--house-type", "second")
	case "detail", "material":
		if strings.ContainsAny(value, ", \t") {
			return nil, errors.New("请填写一个有效的房源实体 ID")
		}
		args = append(args, "--id", value, "--entity-type", "house")
	default:
		return nil, errors.New("不支持的贝壳 CLI 操作")
	}
	return append(args, "--json"), nil
}

func validateBeikeCLIOutput(stdout []byte) error {
	if !utf8.Valid(stdout) {
		return errBeikeCLIInvalidOutput
	}
	decoder := json.NewDecoder(bytes.NewReader(stdout))
	var frame json.RawMessage
	if err := decoder.Decode(&frame); err != nil {
		return errBeikeCLIInvalidOutput
	}
	remainder := stdout[decoder.InputOffset():]
	if extra := bytes.Trim(remainder, " \t\r\n"); len(extra) > 0 {
		// v0.2.28 can print the same JSON document twice, separated by an empty line.
		if !(bytes.HasPrefix(remainder, []byte("\n\n")) || bytes.HasPrefix(remainder, []byte("\r\n\r\n"))) || !bytes.Equal(frame, extra) {
			return errBeikeCLIInvalidOutput
		}
	}
	fields := json.NewDecoder(bytes.NewReader(frame))
	start, err := fields.Token()
	if err != nil || start != json.Delim('{') {
		return errBeikeCLIInvalidOutput
	}
	envelope := make(map[string]json.RawMessage)
	for fields.More() {
		name, err := fields.Token()
		key, ok := name.(string)
		var value json.RawMessage
		if err != nil || !ok || envelope[key] != nil || fields.Decode(&value) != nil {
			return errBeikeCLIInvalidOutput
		}
		envelope[key] = value
	}
	switch string(envelope["ok"]) {
	case "false":
		var message string
		if json.Unmarshal(envelope["error"], &message) == nil && message == "invalid cli request" {
			return errBeikeCLIRejected
		}
		return errBeikeCLIBusiness
	case "true":
		if envelope["data"] != nil && envelope["error"] == nil {
			return nil
		}
	}
	return errBeikeCLIInvalidOutput
}

type beikeCLIOutput struct {
	buffer   bytes.Buffer
	limit    int
	exceeded bool
}

func (output *beikeCLIOutput) Write(p []byte) (int, error) {
	if len(p) > output.limit-output.buffer.Len() {
		output.exceeded = true
		return 0, errBeikeCLIOutputLimit
	}
	return output.buffer.Write(p)
}
