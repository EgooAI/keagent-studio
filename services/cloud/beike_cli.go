package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
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
	beikeCLISlotsOnce        sync.Once
	beikeCLISlotsChan        chan struct{}
)

// beikeCLIConcurrency 返回允许并发的 CLI 子进程数量，通过 BEIKE_CLI_CONCURRENCY 配置，默认 2。
// 放宽前先小步验证贝壳服务端的容忍度，避免一次放开把 Key 打挂。
func beikeCLIConcurrency() int {
	if v := strings.TrimSpace(os.Getenv("BEIKE_CLI_CONCURRENCY")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 1 && n <= 64 {
			return n
		}
	}
	return 2
}

func beikeCLISlots() chan struct{} {
	beikeCLISlotsOnce.Do(func() {
		beikeCLISlotsChan = make(chan struct{}, beikeCLIConcurrency())
	})
	return beikeCLISlotsChan
}

// beikeCLISessionID 返回注入 CLI 子进程的 WORKBUDDY_SESSION_ID 值。
// 贝壳服务端按 User-Agent 宿主标识放行，仅 workbuddy 身份可通过（claude-code、unknown
// 等会被拒为 invalid cli request）；CLI 检测到 WORKBUDDY_SESSION_ID 非空即以上报 workbuddy。
// 默认使用稳定标识 keagent-studio-cloud，可用 BEIKE_CLI_SESSION_ID 覆盖以便多环境审计。
func beikeCLISessionID() string {
	if v := strings.TrimSpace(os.Getenv("BEIKE_CLI_SESSION_ID")); v != "" {
		return v
	}
	return "keagent-studio-cloud"
}

func runBeikeCLI(ctx context.Context, executable, key, operation, city, value string) ([]byte, error) {
	args, err := beikeCLIArgs(operation, city, value)
	if err != nil {
		return nil, err
	}
	return runBeikeCLIArgs(ctx, executable, key, args, true)
}

// runBeikeCLIArgs 以任意参数运行贝壳 CLI 子进程，并复用缓存与并发闸门。
// strict 为 true 时要求输出是 {ok,data} 封套（search/detail 用）；为 false 时接受非封套输出（如 contact 的人读文本）。
func runBeikeCLIArgs(ctx context.Context, executable, key string, args []string, strict bool) ([]byte, error) {
	if !filepath.IsAbs(executable) {
		return nil, errors.New("请配置贝壳 CLI 可执行文件的绝对路径")
	}
	key = strings.TrimSpace(key)
	if key == "" || strings.ContainsAny(key, "\x00\r\n") {
		return nil, errors.New("贝壳 CLI API Key 未配置或无效")
	}
	if len(args) == 0 {
		return nil, errors.New("贝壳 CLI 参数为空")
	}
	cacheKey := executable + "\x00" + strings.Join(args, "\x00")
	if cached, ok := beikeCacheStore.get(cacheKey); ok {
		return cached, nil
	}

	ctx, cancel := context.WithTimeout(ctx, beikeCLITimeout)
	defer cancel()
	slots := beikeCLISlots()
	select {
	case slots <- struct{}{}:
		defer func() { <-slots }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	cmd := exec.CommandContext(ctx, executable, args...)
	cmd.Dir = filepath.Dir(executable)
	cmd.Env = []string{
		"BEIKE_MCP_API_KEY=" + key,
		"WORKBUDDY_SESSION_ID=" + beikeCLISessionID(),
	}
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
	if strict {
		if err := validateBeikeCLIOutput(output); err != nil {
			return nil, err
		}
	} else if err := validateBeikeCLIOutputLenient(output); err != nil {
		return nil, err
	}
	if bytes.Contains(output, []byte(key)) {
		return nil, errBeikeCLIInvalidOutput
	}
	beikeCacheStore.put(cacheKey, output)
	return output, nil
}

// validateBeikeCLIOutputLenient 用于 contact/appoint 等不返回 {ok,data} 封套的命令：
// 只拦截「客户端身份被拒」；其余 ok:false（如 Unknown tool、service temporarily unavailable）
// 交给调用方（beikeCall）把真实错误信息透出。
func validateBeikeCLIOutputLenient(stdout []byte) error {
	if !utf8.Valid(stdout) {
		return errBeikeCLIInvalidOutput
	}
	var envelope struct {
		OK    *bool  `json:"ok"`
		Error string `json:"error"`
	}
	if json.Unmarshal(stdout, &envelope) == nil && envelope.OK != nil && !*envelope.OK && envelope.Error == "invalid cli request" {
		return errBeikeCLIRejected
	}
	return nil
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
		ids := beikeSplitIDs(value)
		if len(ids) == 0 || len(ids) > 20 {
			return nil, errors.New("请填写 1-20 个有效的房源实体 ID")
		}
		for _, id := range ids {
			args = append(args, "--id", id)
		}
		args = append(args, "--entity-type", "house")
	default:
		return nil, errors.New("不支持的贝壳 CLI 操作")
	}
	return append(args, "--json"), nil
}

// beikeSplitIDs 把逗号/空白分隔的房源 ID 列表拆成单个 ID，并丢弃空项。
func beikeSplitIDs(value string) []string {
	fields := strings.FieldsFunc(value, func(r rune) bool {
		return r == ',' || r == '，' || r == ' ' || r == '\t'
	})
	ids := make([]string, 0, len(fields))
	for _, field := range fields {
		if field != "" {
			ids = append(ids, field)
		}
	}
	return ids
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
