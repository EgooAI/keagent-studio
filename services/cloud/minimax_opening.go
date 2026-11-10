package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const minimaxBase = "https://api.minimax.cn"
const minimaxModel = "MiniMax-H3"
const minimaxPrompt = `A realistic single shot of the real-estate agent from <Picture 1>. Use <Video 1> only for body movement, shot framing and camera movement. Keep the face and appearance from <Picture 1> throughout. Synchronize the agent's mouth with the exact speech and timing of <Audio 1> from the start. Fully copy <Audio 1>; add no speech, music, titles or subtitles.`
const minimaxLocationPrompt = "参考图 1 为经纪人，参考图 2 为地点，参考音频为开场解说。"
const minimaxOpeningSchema = `CREATE TABLE IF NOT EXISTS keagent_minimax_opening (
 owner_id text NOT NULL, input_hash text NOT NULL, config_version bigint NOT NULL,
 task_id text NOT NULL DEFAULT '', PRIMARY KEY (owner_id,input_hash));`

var minimaxHash = regexp.MustCompile(`^[a-f0-9]{64}$`)

func minimaxConfigured(ctx context.Context) bool {
	return !aiSnapshotFrom(ctx).locked["opening"] && aiValue(ctx, "MINIMAX_API_KEY") != ""
}

func mp4Box(data []byte, name string) []byte {
	for len(data) >= 8 {
		size, header := uint64(binary.BigEndian.Uint32(data)), 8
		switch size {
		case 0:
			size = uint64(len(data))
		case 1:
			if len(data) < 16 {
				return nil
			}
			size, header = binary.BigEndian.Uint64(data[8:]), 16
		}
		if size < uint64(header) || size > uint64(len(data)) {
			return nil
		}
		if string(data[4:8]) == name {
			return data[header:size]
		}
		data = data[size:]
	}
	return nil
}

func validMiniMaxReferenceDuration(data []byte) bool {
	mvhd := mp4Box(mp4Box(data, "moov"), "mvhd")
	var scale, duration uint64
	if len(mvhd) >= 20 && mvhd[0] == 0 {
		scale, duration = uint64(binary.BigEndian.Uint32(mvhd[12:])), uint64(binary.BigEndian.Uint32(mvhd[16:]))
	} else if len(mvhd) >= 32 && mvhd[0] == 1 {
		scale, duration = uint64(binary.BigEndian.Uint32(mvhd[20:])), binary.BigEndian.Uint64(mvhd[24:])
	}
	return scale > 0 && duration >= 2*scale && duration <= 5*scale
}

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

func minimaxPayload(input object) ([]byte, error) {
	if input["authorized"] != true {
		return nil, fail(422, "请确认已获得经纪人照片和开场素材的使用授权")
	}
	ratio := str(input["ratio"])
	if ratio != "9:16" && ratio != "16:9" {
		return nil, fail(422, "开场视频画幅无效")
	}
	photo, err := minimaxImage(input["photo"], "经纪人照片", 3<<20)
	if err != nil {
		return nil, err
	}
	var content []object
	if input["location"] != nil {
		prompt := strings.TrimSpace(str(input["prompt"]))
		if input["video"] != nil || !validScriptRule(prompt) {
			return nil, fail(422, "地点图开场需要有效的画面提示词")
		}
		location, err := minimaxImage(input["location"], "开场地点图", 512<<10)
		if err != nil {
			return nil, err
		}
		content = []object{{"type": "text", "text": minimaxLocationPrompt + "\n" + prompt}, photo, location}
	} else {
		video, err := base64.StdEncoding.Strict().DecodeString(str(input["video"]))
		if err != nil || len(video) < 12 || len(video) > 8<<20 || string(video[4:8]) != "ftyp" {
			return nil, fail(422, "请选择 8 MB 以内的参考 MP4 视频")
		}
		if !validMiniMaxReferenceDuration(video) {
			return nil, fail(422, "MiniMax 参考视频时长须为 2–5 秒")
		}
		content = []object{{"type": "text", "text": minimaxPrompt},
			{"type": "video_url", "role": "reference_video", "video_url": object{"url": "data:video/mp4;base64," + base64.StdEncoding.EncodeToString(video)}}, photo}
	}
	audio := str(input["audio"])
	raw, err := base64.StdEncoding.Strict().DecodeString(audio)
	size := openingWAVBytes(raw)
	if err != nil || size < 2*48000 || size > 15*48000 {
		return nil, fail(422, "开场解说须为 2–15 秒的 24 kHz 单声道 WAV，请调整开场文案")
	}
	audio = base64.StdEncoding.EncodeToString(raw)
	seconds := max(4, (size+47999)/48000)
	content = append(content, object{"type": "audio_url", "role": "reference_audio", "audio_url": object{"url": "data:audio/wav;base64," + audio}})
	return json.Marshal(object{"model": minimaxModel, "resolution": "768P", "duration": seconds, "ratio": ratio, "content": content})
}

func (s *server) minimaxCall(ctx context.Context, method, path string, body []byte) ([]byte, error) {
	if !minimaxConfigured(ctx) {
		return nil, fail(503, "请在管理后台启用 MiniMax 开场服务")
	}
	headers := http.Header{"Content-Type": {"application/json"}, "Authorization": {"Bearer " + aiValue(ctx, "MINIMAX_API_KEY")}}
	raw, err := s.productionBody(ctx, method, minimaxBase+path, headers, body, 1<<20)
	var upstream providerHTTPError
	if errors.As(err, &upstream) {
		message := "MiniMax 开场请求失败"
		switch upstream.httpStatus {
		case http.StatusUnauthorized, http.StatusForbidden:
			message = "MiniMax 鉴权失败，请核对 API Key 和视频模型权限"
		case http.StatusPaymentRequired:
			message = "MiniMax 余额或额度不足"
		case http.StatusBadRequest, http.StatusUnprocessableEntity:
			message = "MiniMax 拒绝请求，请核对参考素材和账户可用模型"
		case http.StatusTooManyRequests:
			message = "MiniMax 请求限流，请稍后重试"
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

func (s *server) minimaxSubmit(ctx context.Context, body []byte) (string, error) {
	raw, err := s.minimaxCall(ctx, "POST", "/v2/video_generation", body)
	if err != nil {
		return "", err
	}
	var result struct {
		ID string `json:"task_id"`
	}
	if json.Unmarshal(raw, &result) != nil || !resourceID.MatchString(result.ID) {
		return "", fail(502, "MiniMax 提交结果未知，请在 MiniMax 控制台核对")
	}
	return result.ID, nil
}

func minimaxVideoURL(value string) bool {
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" || u.Fragment != "" {
		return false
	}
	host := strings.ToLower(u.Hostname())
	return host == "cdn.hailuoai.com" || host == "video-product.cdn.minimax.io" || host == "video-product.cdn.minimax.cn" || host == "algeng-video-infer.oss-cn-shanghai.aliyuncs.com"
}

func (s *server) minimaxQuery(ctx context.Context, id string) (object, error) {
	raw, err := s.minimaxCall(ctx, "GET", "/v2/query/video_generation/"+id, nil)
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

func (s *server) productionOpening(ctx context.Context, a actor, operation string, input object) (object, error) {
	key := str(input["requestKey"])
	if operation == "opening-submit" {
		if input["templateId"] != nil || input["location"] != nil || input["prompt"] != nil {
			if !resourceID.MatchString(str(input["templateId"])) || !templateVersion.MatchString(str(input["templateVersion"])) || input["video"] != nil {
				return nil, fail(422, "开场模板版本无效")
			}
			template, err := s.loadProductionTemplate(ctx, object{"id": input["templateId"], "version": input["templateVersion"]}, true)
			if err != nil {
				return nil, err
			}
			recipe := obj(template["production"])
			opening := obj(recipe["opening"])
			if opening == nil {
				return nil, fail(422, "所选模板未配置 MiniMax 开场")
			}
			input = pickFields(input, "authorized", "photo", "audio", "location")
			input["ratio"] = obj(recipe["config"])["aspectRatio"]
			input["prompt"] = opening["prompt"]
			location := obj(opening["location"])
			if location["source"] == "fixed" {
				input["location"] = location["image"]
			} else if str(input["location"]) == "" {
				return nil, fail(422, "请选择当前房源的开场地点图")
			}
		}
		body, err := minimaxPayload(input)
		if err != nil {
			return nil, err
		}
		if !minimaxConfigured(ctx) {
			return nil, fail(503, "请在管理后台启用 MiniMax 开场服务")
		}
		key = digestBytes(body)
		version := aiSnapshotFrom(ctx).versions["opening"]
		result, err := s.db.ExecContext(ctx, `INSERT INTO keagent_minimax_opening(owner_id,input_hash,config_version) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, a.UserID, key, version)
		if err != nil {
			return nil, err
		}
		if inserted, _ := result.RowsAffected(); inserted == 1 {
			id, submitErr := s.minimaxSubmit(ctx, body)
			finish, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
			defer cancel()
			if submitErr != nil {
				// Release explicit rejections; keep ambiguous requests reserved against double charges.
				var rejection providerHTTPError
				if errors.As(submitErr, &rejection) {
					switch rejection.httpStatus {
					case http.StatusBadRequest, http.StatusUnauthorized, http.StatusPaymentRequired, http.StatusForbidden, http.StatusUnprocessableEntity, http.StatusTooManyRequests:
						_, _ = s.db.ExecContext(finish, `DELETE FROM keagent_minimax_opening WHERE owner_id=$1 AND input_hash=$2 AND task_id=''`, a.UserID, key)
					}
				}
				return nil, submitErr
			}
			if _, err = s.db.ExecContext(finish, `UPDATE keagent_minimax_opening SET task_id=$3 WHERE owner_id=$1 AND input_hash=$2`, a.UserID, key, id); err != nil {
				return nil, fail(502, "MiniMax 已接受任务，但保存任务 ID 失败，请核对控制台")
			}
			return object{"requestKey": key}, nil
		}
	}
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
		return nil, fail(409, "MiniMax 提交结果待核对，请检查控制台；相同素材重试只会读取原任务")
	}
	if operation == "opening-submit" {
		return object{"requestKey": key}, nil
	}
	ctx, err = s.pinnedAI(ctx, "opening", version)
	if err != nil {
		return nil, err
	}
	return s.minimaxQuery(ctx, id)
}
