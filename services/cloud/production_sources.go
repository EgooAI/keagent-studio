package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"unicode/utf8"
)

func decodeBeike(data []byte) (object, error) {
	var response struct {
		Code *int   `json:"code"`
		Msg  string `json:"msg"`
		Data object `json:"data"`
	}
	if json.Unmarshal(data, &response) != nil {
		snippet := strings.TrimSpace(string(data))
		if len(snippet) > 200 {
			snippet = snippet[:200]
		}
		return nil, fail(502, "贝壳图片验真返回无法解析："+snippet)
	}
	if response.Code == nil || *response.Code != 0 || response.Data == nil {
		message := strings.TrimSpace(response.Msg)
		if message == "" {
			message = "未返回数据"
		}
		return nil, fail(502, "贝壳图片验真失败："+message)
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
