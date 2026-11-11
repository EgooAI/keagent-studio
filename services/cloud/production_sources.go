package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"unicode/utf8"
)

const productionImageSchema = `CREATE TABLE IF NOT EXISTS keagent_production_image (owner_id text NOT NULL, request_key text NOT NULL, input_hash text NOT NULL, payload jsonb NOT NULL, PRIMARY KEY(owner_id,request_key));`

// Fixed provider origins keep service credentials away from caller-supplied URLs.
func dashscopeBase() (string, error) {
	return validateDashscopeBase(aiValue(context.Background(), "DASHSCOPE_BASE_URL"))
}
func validateDashscopeBase(raw string) (string, error) {
	base := strings.TrimRight(raw, "/")
	if base == "" {
		return "https://dashscope.aliyuncs.com", nil
	}
	u, err := url.Parse(base)
	if err != nil || u.Scheme != "https" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" || u.Port() != "" {
		return "", fail(503, "百炼地址配置无效")
	}
	if u.Hostname() != "dashscope.aliyuncs.com" && !(strings.HasSuffix(u.Hostname(), ".cn-beijing.maas.aliyuncs.com") && !strings.Contains(strings.TrimSuffix(u.Hostname(), ".cn-beijing.maas.aliyuncs.com"), ".")) {
		return "", fail(503, "仅支持百炼北京地域官方地址")
	}
	return base, nil
}

func expansionPayload(input object) (object, error) {
	encoded := str(input["image"])
	if len(encoded) > 14<<20 {
		return nil, fail(422, "扩图原图不能超过10MB")
	}
	data, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil || len(data) == 0 || len(data) > 10<<20 {
		return nil, fail(422, "扩图原图编码无效或超过10MB")
	}
	info, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || (format != "jpeg" && format != "png") || info.Width < 512 || info.Height < 512 || info.Width > 4096 || info.Height > 4096 {
		return nil, fail(422, "扩图原图需为512–4096像素的JPEG/PNG")
	}
	prompt := strings.TrimSpace(str(input["prompt"]))
	if prompt == "" || utf8.RuneCountInString(prompt) > 600 {
		return nil, fail(422, "请填写不超过600字的扩图说明")
	}
	parameters := object{"n": 1, "watermark": true}
	changed := false
	for _, name := range []string{"top_scale", "bottom_scale", "left_scale", "right_scale"} {
		value := 1.0
		if raw, exists := input[name]; exists {
			value, _ = raw.(float64)
		}
		if value < 1 || value > 2 {
			return nil, fail(422, "四方向扩展比例须在1至2之间")
		}
		if value > 1 {
			changed = true
		}
		parameters[name] = value
	}
	if !changed {
		return nil, fail(422, "至少扩展一个方向")
	}
	mime := "image/jpeg"
	if format == "png" {
		mime = "image/png"
	}
	return object{"model": "wanx2.1-imageedit", "input": object{"function": "expand", "prompt": prompt, "base_image_url": "data:" + mime + ";base64," + encoded}, "parameters": parameters}, nil
}

func decodeBeike(data []byte) (object, error) {
	var response struct {
		Code *int   `json:"code"`
		Data object `json:"data"`
	}
	if json.Unmarshal(data, &response) != nil || response.Code == nil || *response.Code != 0 || response.Data == nil {
		return nil, fail(502, "贝壳未返回成功数据，请检查接口授权与地址")
	}
	return response.Data, nil
}

func normalizeBeike(city, address string, facts, pictures object) (object, error) {
	house := obj(facts["houseInfo"])
	if house == nil || str(facts["resblockName"]) == "" {
		return nil, fail(502, "贝壳房屋档案缺少小区或房屋信息")
	}
	title := str(facts["resblockName"]) + " · " + str(house["frame"])
	descriptions := map[string]string{}
	for _, field := range []string{"parlorList", "roomList"} {
		for _, item := range rows(house[field]) {
			room := obj(item)
			text := str(room["name"])
			if area, err := strconv.ParseFloat(str(room["area"]), 64); err == nil && area > 0 {
				text += "，图示面积" + str(room["area"]) + "平方米"
			}
			if direction := str(room["direction"]); direction != "" {
				text += "，朝向" + direction
			}
			descriptions[str(room["name"])] = text
		}
	}
	assets := []object{}
	prospect := obj(pictures["prospect"])
	for _, group := range []struct{ key, name string }{{"parlor", "客厅"}, {"room", "卧室"}, {"kitchen", "厨房"}, {"toliet", "卫生间"}} {
		for i, value := range rows(prospect[group.key]) {
			raw := str(value)
			u, err := url.Parse(raw)
			if err != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" || !strings.HasSuffix(u.Hostname(), ".ljcdn.com") {
				return nil, fail(502, "贝壳图片地址不符合已支持的官方素材格式")
			}
			// Array order does not prove bedroom A/B/C mapping; never attach those facts by index.
			name := group.name
			description := ""
			if group.key == "parlor" && len(rows(prospect[group.key])) == 1 {
				description = descriptions[name]
			}
			assets = append(assets, object{"url": raw, "room": name + strconv.Itoa(i+1), "description": description})
		}
	}
	if len(assets) == 0 || len(assets) > 20 {
		return nil, fail(502, "贝壳未返回1–20张可用室内图片")
	}
	property := object{"id": "beike-" + digestBytes([]byte(city+"|"+address)), "title": title, "description": "贝壳开放平台房屋档案；价格及建筑面积未提供，空间对应关系需人工核对。", "areaSqm": 0, "priceCents": 0, "layout": str(house["frame"]), "sellingPoints": []string{}, "source": object{"provider": "beike", "fetchedAt": now(), "city": city, "floorplanAreaSqm": house["frameArea"]}}
	references := []object{}
	for i, value := range rows(pictures["frame"]) {
		raw := str(value)
		u, err := url.Parse(raw)
		if err != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" || !strings.HasSuffix(u.Hostname(), ".ljcdn.com") {
			return nil, fail(502, "贝壳户型图地址不符合已支持的官方素材格式")
		}
		references = append(references, object{"url": raw, "room": "户型图" + strconv.Itoa(i+1)})
	}
	return object{"property": property, "images": assets, "panoramas": []object{}, "referenceImages": references, "panoramaAvailability": "not_exposed_by_this_interface"}, nil
}

func (s *server) productionBody(ctx context.Context, method, endpoint string, headers http.Header, body []byte, limit int64) ([]byte, error) {
	if s.sourceHTTP != nil {
		return s.sourceHTTP(ctx, method, endpoint, headers, body, limit)
	}
	return providerBody(ctx, method, endpoint, headers, body, limit)
}
func (s *server) fetchBeike(ctx context.Context, input object) (object, error) {
	return s.lookupBeike(ctx, input, func(string) error { return nil })
}
func (s *server) lookupBeike(ctx context.Context, input object, step func(string) error) (object, error) {
	token := strings.TrimSpace(aiValue(ctx, "BEIKE_ACCESS_TOKEN"))
	if aiSnapshotFrom(ctx).locked["beike"] {
		return nil, fail(503, "贝壳生效配置无法解密")
	}
	if token == "" {
		return nil, fail(503, "服务端未配置 BEIKE_ACCESS_TOKEN")
	}
	values := url.Values{}
	for _, key := range []string{"cityName", "district", "address"} {
		value := strings.TrimSpace(str(input[key]))
		if value == "" || utf8.RuneCountInString(value) > 300 {
			return nil, fail(422, "请填写城市、区县和详细地址")
		}
		values.Set(key, value)
	}
	headers := http.Header{"Content-Type": {"application/x-www-form-urlencoded"}}
	headers.Set("access_token", token)
	if err := step("查询房屋档案"); err != nil {
		return nil, err
	}
	factsData, err := s.productionBody(ctx, "POST", "https://gw-open.ke.com/api/images-distinguish/houseInfo", headers, []byte(values.Encode()), 2<<20)
	if err != nil {
		return nil, err
	}
	facts, err := decodeBeike(factsData)
	if err != nil {
		return nil, err
	}
	if err = step("查询室内图片"); err != nil {
		return nil, err
	}
	values.Set("type", "2")
	pictureData, err := s.productionBody(ctx, "POST", "https://gw-open.ke.com/api/images-distinguish/distinguish", headers, []byte(values.Encode()), 2<<20)
	if err != nil {
		return nil, err
	}
	pictures, err := decodeBeike(pictureData)
	if err != nil {
		return nil, err
	}
	return normalizeBeike(values.Get("cityName"), values.Get("address"), facts, pictures)
}

func expansionConnection(ctx context.Context) (string, http.Header, error) {
	if aiSnapshotFrom(ctx).locked["expansion"] {
		return "", nil, fail(503, "百炼生效配置无法解密")
	}
	apiKey := aiValue(ctx, "DASHSCOPE_API_KEY")
	if apiKey == "" {
		return "", nil, fail(503, "百炼扩图服务尚未配置")
	}
	base, err := validateDashscopeBase(aiValue(ctx, "DASHSCOPE_BASE_URL"))
	return base, http.Header{"Authorization": {"Bearer " + apiKey}, "Content-Type": {"application/json"}}, err
}

func (s *server) productionImage(ctx context.Context, a actor, operation string, input object) (any, error) {
	if operation == "beike-import" {
		return s.fetchBeike(ctx, input)
	}
	key := str(input["requestKey"])
	if len(key) < 16 || len(key) > 100 || !resourceID.MatchString(key) {
		return nil, fail(422, "扩图请求标识无效")
	}
	var saved []byte
	var hashKey string
	if operation == "image-submit" {
		base, headers, err := expansionConnection(ctx)
		if err != nil {
			return nil, err
		}
		payload, err := expansionPayload(input)
		if err != nil {
			return nil, err
		}
		body, _ := json.Marshal(payload)
		hash := digestBytes(body)
		prices, priceVersion, err := readCreditPricing(ctx, s.db)
		if err != nil {
			return nil, err
		}
		// 先冻结再落库；单价为 0（当前默认）时跳过扣费。
		var holdID string
		if expandPrice := prices["image_expand"]; expandPrice > 0 {
			hold, holdErr := s.holdCredits(ctx, a.UserID, "image_expand", key, expandPrice, hash, priceVersion, nil)
			if holdErr != nil {
				return nil, holdErr
			}
			holdID = hold.ID
		}
		// Reserve before submitting. Unknown results never cause an automatic paid resubmission.
		version := aiSnapshotFrom(ctx).versions["expansion"]
		pending, _ := json.Marshal(object{"status": "submitting", "configVersion": version})
		result, err := s.db.ExecContext(ctx, `INSERT INTO keagent_production_image(owner_id,request_key,input_hash,payload) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, a.UserID, key, hash, pending)
		if err != nil {
			return nil, fail(500, "无法保存扩图提交检查点")
		}
		inserted, _ := result.RowsAffected()
		if inserted == 0 {
			var previousHash string
			if err = s.db.QueryRowContext(ctx, `SELECT input_hash,payload FROM keagent_production_image WHERE owner_id=$1 AND request_key=$2`, a.UserID, key).Scan(&previousHash, &saved); err != nil {
				return nil, err
			}
			if previousHash != hash {
				return nil, fail(409, "相同扩图请求标识不能更改输入")
			}
			var record object
			_ = json.Unmarshal(saved, &record)
			return record, nil
		}
		headers.Set("X-DashScope-Async", "enable")
		data, err := s.productionBody(ctx, "POST", base+"/api/v1/services/aigc/image2image/image-synthesis", headers, body, 2<<20)
		if err != nil {
			var rejection providerHTTPError
			if errors.As(err, &rejection) && rejection.httpStatus >= 400 && rejection.httpStatus < 500 && holdID != "" {
				_ = s.releaseHold(context.WithoutCancel(ctx), holdID)
			}
			return nil, err
		}
		var vendor struct {
			Output struct {
				TaskID string `json:"task_id"`
			} `json:"output"`
		}
		if json.Unmarshal(data, &vendor) != nil || !resourceID.MatchString(vendor.Output.TaskID) {
			return nil, fail(502, "扩图未返回任务ID，请核对百炼控制台后处理")
		}
		record := object{"status": "PENDING", "taskId": vendor.Output.TaskID, "configVersion": version}
		saved, _ = json.Marshal(record)
		if _, err = s.db.ExecContext(ctx, `UPDATE keagent_production_image SET payload=$3 WHERE owner_id=$1 AND request_key=$2`, a.UserID, key, saved); err != nil {
			return nil, fail(500, "扩图提交已发送但检查点保存失败，请核对控制台")
		}
		return record, nil
	}
	err := s.db.QueryRowContext(ctx, `SELECT payload, input_hash FROM keagent_production_image WHERE owner_id=$1 AND request_key=$2`, a.UserID, key).Scan(&saved, &hashKey)
	if err == sql.ErrNoRows {
		return nil, fail(404, "扩图任务不存在")
	}
	if err != nil {
		return nil, err
	}
	var record object
	if json.Unmarshal(saved, &record) != nil {
		return nil, fail(500, "扩图检查点损坏")
	}
	taskID := str(record["taskId"])
	if !resourceID.MatchString(taskID) {
		return nil, fail(409, "扩图提交结果未知，请核对百炼控制台；不会自动重新提交")
	}
	if str(record["status"]) == "SUCCEEDED" {
		if err = s.settleHoldByKey(ctx, a.UserID, "image_expand", hashKey, true); err != nil {
			return nil, err
		}
		return record, nil
	}
	version := number(record["configVersion"])
	ctx, err = s.pinnedAI(ctx, "expansion", int64(version))
	if err != nil {
		return nil, err
	}
	base, headers, err := expansionConnection(ctx)
	if err != nil {
		return nil, err
	}
	data, err := s.productionBody(ctx, "GET", base+"/api/v1/tasks/"+taskID, headers, nil, 2<<20)
	if err != nil {
		return nil, err
	}
	var vendor struct {
		Output struct {
			Status  string `json:"task_status"`
			Results []struct {
				URL string `json:"url"`
			} `json:"results"`
		} `json:"output"`
	}
	if json.Unmarshal(data, &vendor) != nil {
		return nil, fail(502, "扩图查询响应无效")
	}
	switch vendor.Output.Status {
	case "PENDING", "RUNNING", "SUCCEEDED", "FAILED", "CANCELED", "UNKNOWN":
	default:
		return nil, fail(502, "扩图状态无效")
	}
	record = object{"status": vendor.Output.Status, "taskId": taskID, "configVersion": version}
	if vendor.Output.Status == "SUCCEEDED" {
		if len(vendor.Output.Results) != 1 {
			return nil, fail(502, "扩图结果缺少图片")
		}
		record["imageUrl"] = vendor.Output.Results[0].URL
	}
	saved, _ = json.Marshal(record)
	if _, err = s.db.ExecContext(ctx, `UPDATE keagent_production_image SET payload=$3 WHERE owner_id=$1 AND request_key=$2`, a.UserID, key, saved); err != nil {
		return nil, err
	}
	switch vendor.Output.Status {
	case "SUCCEEDED":
		if err = s.settleHoldByKey(ctx, a.UserID, "image_expand", hashKey, true); err != nil {
			return nil, err
		}
	case "FAILED", "CANCELED":
		if err = s.settleHoldByKey(ctx, a.UserID, "image_expand", hashKey, false); err != nil {
			return nil, err
		}
	}
	return record, nil
}
