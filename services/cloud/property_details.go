package main

import (
	"net/url"
	"strings"
	"unicode/utf8"
)

var propertyDetailFacts = []string{"floor", "orientation", "elevator", "buildingAge", "transactionAttributes", "listingStatus"}

func normalizePropertyDetails(raw any) (object, error) {
	input := obj(raw)
	if input == nil {
		return nil, fail(422, "房源补充资料无效")
	}
	details := object{}
	for _, key := range propertyDetailFacts {
		value, exists := input[key]
		if !exists {
			continue
		}
		text, ok := value.(string)
		text = strings.TrimSpace(text)
		limit := 160
		if key == "transactionAttributes" {
			limit = 800
		}
		if !ok || utf8.RuneCountInString(text) > limit {
			return nil, fail(422, "房源补充资料格式或长度无效")
		}
		if text == "" {
			continue
		}
		if key == "elevator" && text != "有" && text != "无" ||
			key == "listingStatus" && text != "在售" && text != "已成交" && text != "已下架" {
			return nil, fail(422, "电梯或挂牌状态无效")
		}
		details[key] = text
	}
	for _, key := range []string{"listingUrl", "vrUrl"} {
		value, exists := input[key]
		if !exists {
			continue
		}
		text, ok := value.(string)
		text = strings.TrimSpace(text)
		if ok && text == "" {
			continue
		}
		link, err := url.Parse(text)
		if !ok || len(text) > 2048 || err != nil || link.Scheme != "https" || link.Hostname() == "" || link.User != nil {
			return nil, fail(422, "房源详情和 VR 看房链接必须为有效的 HTTPS 链接")
		}
		details[key] = text
	}
	return details, nil
}
