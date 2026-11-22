package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/png"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

const minimaxBase = "https://api.minimax.cn"
const minimaxOpeningSchema = `CREATE TABLE IF NOT EXISTS keagent_minimax_opening (
 owner_id text NOT NULL, input_hash text NOT NULL, config_version bigint NOT NULL,
 task_id text NOT NULL DEFAULT '', PRIMARY KEY (owner_id,input_hash));`

var minimaxHash = regexp.MustCompile(`^[a-f0-9]{64}$`)

func minimaxImage(value any, label string, limit int) (object, error) {
	raw, err := base64.StdEncoding.Strict().DecodeString(str(value))
	if err != nil || len(raw) > limit {
		return nil, fail(422, label+"编码无效或超过大小限制")
	}
	info, format, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil || (format != "jpeg" && format != "png") || info.Width < 256 || info.Height < 256 || info.Width > 4096 || info.Height > 4096 || info.Width*5 < info.Height*2 || info.Height*5 < info.Width*2 {
		return nil, fail(422, label+"须为宽高 256–4096 像素、宽高比 0.4–2.5 的 JPEG 或 PNG")
	}
	return object{"type": "image_url", "role": "reference_image", "image_url": object{"url": "data:image/" + format + ";base64," + base64.StdEncoding.EncodeToString(raw)}}, nil
}

func (s *server) minimaxResult(ctx context.Context, id, key string) ([]byte, error) {
	if key == "" {
		return nil, fail(503, "旧版开场任务的查询凭证不可用")
	}
	headers := http.Header{"Content-Type": {"application/json"}, "Authorization": {"Bearer " + key}}
	raw, err := s.productionBody(ctx, http.MethodGet, minimaxBase+"/v2/query/video_generation/"+id, headers, nil, 1<<20)
	var upstream providerHTTPError
	if errors.As(err, &upstream) {
		message := "MiniMax 开场结果查询失败"
		switch upstream.httpStatus {
		case http.StatusUnauthorized, http.StatusForbidden:
			message = "旧版开场查询凭证已失效"
		case http.StatusPaymentRequired:
			message = "MiniMax 余额或额度不足"
		case http.StatusTooManyRequests:
			message = "MiniMax 查询限流，请稍后重试"
		}
		message += fmt.Sprintf("（HTTP %d", upstream.httpStatus)
		if upstream.logID != "" {
			message += "，请求 ID " + upstream.logID
		}
		upstream.fault = fault{http.StatusBadGateway, message + "）"}
		return nil, upstream
	}
	return raw, err
}

func minimaxVideoURL(value string) bool {
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" || u.Fragment != "" {
		return false
	}
	host := strings.ToLower(u.Hostname())
	return host == "cdn.hailuoai.com" || host == "video-product.cdn.minimax.io" || host == "video-product.cdn.minimax.cn" || host == "algeng-video-infer.oss-cn-shanghai.aliyuncs.com"
}

func (s *server) minimaxQuery(ctx context.Context, id, apiKey string) (object, error) {
	raw, err := s.minimaxResult(ctx, id, apiKey)
	if err != nil {
		return nil, err
	}
	var result struct {
		Task struct {
			ID      string `json:"id"`
			Status  string `json:"status"`
			Content struct {
				URL string `json:"url"`
			} `json:"content"`
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		} `json:"task"`
	}
	if json.Unmarshal(raw, &result) != nil || result.Task.ID != id {
		return nil, fail(502, "MiniMax 返回了无效的任务响应")
	}
	task := result.Task
	switch task.Status {
	case "queued", "running":
		return object{"status": task.Status}, nil
	case "succeeded":
		if !minimaxVideoURL(task.Content.URL) {
			return nil, fail(502, "MiniMax 开场结果的视频地址无效")
		}
		return object{"status": task.Status, "videoUrl": task.Content.URL}, nil
	case "failed", "cancelled":
		message := "MiniMax 开场生成" + map[string]string{"failed": "失败", "cancelled": "已取消"}[task.Status]
		if resourceID.MatchString(task.Error.Code) && len(task.Error.Code) <= 12 {
			message += fmt.Sprintf("（错误码 %s）", task.Error.Code)
		}
		return object{"status": task.Status, "message": message}, nil
	default:
		return nil, fail(502, "MiniMax 返回了未知的任务状态")
	}
}

func (s *server) queryProductionOpening(ctx context.Context, a actor, input object) (object, error) {
	key := str(input["requestKey"])
	if !minimaxHash.MatchString(key) {
		return nil, fail(422, "开场任务标识无效")
	}
	var id string
	var version int64
	err := s.db.QueryRowContext(ctx, `SELECT task_id,config_version FROM keagent_minimax_opening WHERE owner_id=$1 AND input_hash=$2`, a.UserID, key).Scan(&id, &version)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fail(404, "MiniMax 开场任务不存在")
	}
	if err != nil {
		return nil, err
	}
	if !resourceID.MatchString(id) {
		return nil, fail(409, "MiniMax 提交结果待核对，请检查控制台")
	}
	values, err := readAIValues(ctx, s.db, "opening", version)
	if err != nil {
		return nil, err
	}
	result, err := s.minimaxQuery(ctx, id, values["MINIMAX_API_KEY"])
	if err != nil {
		return nil, err
	}
	switch status := str(result["status"]); status {
	case "succeeded", "failed", "cancelled":
		s.finishProviderUsage(ctx, a.UserID, "opening", key, id, status)
	}
	// 结算在途冻结单：成功扣款，明确失败退款；结果未知保持冻结。
	switch str(result["status"]) {
	case "succeeded":
		if err = s.settleHoldByKey(ctx, a.UserID, "opening", key, true, ""); err != nil {
			return nil, err
		}
	case "failed", "cancelled":
		reason := "operation_failed"
		if result["status"] == "cancelled" {
			reason = "provider_cancelled"
		}
		if err = s.settleHoldByKey(ctx, a.UserID, "opening", key, false, reason); err != nil {
			return nil, err
		}
	}
	return result, nil
}
