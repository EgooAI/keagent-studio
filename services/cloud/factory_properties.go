package main

import (
	"context"
	"encoding/json"
	"slices"
	"sort"
	"strings"
)

type factoryPropertyQuery struct {
	IDs                                   []string
	ReadyIDs                              []string
	SelectedIDs                           []string
	Search, District, Community, Material string
	ExactNumber                           *string
	Layouts                               []string
	MinPrice, MaxPrice, MinArea, MaxArea  *float64
	Page                                  int
	All                                   bool
}

func (s *server) factoryProperties(ctx context.Context, a actor, body []byte) (object, error) {
	var input factoryPropertyQuery
	if json.Unmarshal(body, &input) != nil || len(input.IDs) > 200 || len(input.ReadyIDs) > 10000 || len(input.SelectedIDs) > 10000 ||
		len(input.Search) > 512 || len(input.District) > 512 || len(input.Community) > 512 || len(input.Material) > 20 ||
		(input.ExactNumber != nil && len(*input.ExactNumber) > 512) {
		return nil, fail(422, "房源查询参数无效")
	}
	w, err := s.workspacePayload(ctx, a)
	if err != nil {
		return nil, err
	}
	return factoryPropertyPage(w, input), nil
}

func inPropertyRange(value float64, low, high *float64) bool {
	return (low == nil || value >= *low) && (high == nil || value <= *high)
}

func factoryPropertyPage(w object, input factoryPropertyQuery) object {
	properties := rows(w["properties"])
	ids := make(map[string]bool, len(input.IDs))
	for _, id := range input.IDs {
		ids[id] = true
	}
	ready := make(map[string]bool, len(input.ReadyIDs))
	for _, id := range input.ReadyIDs {
		ready[id] = true
	}
	selected := make(map[string]bool, len(input.SelectedIDs))
	for _, id := range input.SelectedIDs {
		selected[id] = true
	}
	search := strings.ToLower(strings.TrimSpace(input.Search))
	seen := map[string]bool{}
	districts := map[string]bool{}
	matched := []any{}
	for _, value := range properties {
		p := obj(value)
		id := str(p["id"])
		if seen[id] || id == "panorama-cc0-sample" {
			continue
		}
		seen[id] = true
		if input.IDs != nil {
			if ids[id] {
				matched = append(matched, p)
			}
			continue
		}
		district := str(p["district"])
		if district != "" {
			districts[district] = true
		}
		if input.SelectedIDs != nil && !selected[id] {
			continue
		}
		if input.ExactNumber != nil {
			number := strings.TrimSpace(*input.ExactNumber)
			if number == "" || number != strings.TrimSpace(str(p["propertyNumber"])) {
				continue
			}
		}
		if (input.District != "" && input.District != district) ||
			(input.Community != "" && input.Community != str(p["community"])) ||
			(input.Layouts != nil && !slices.Contains(input.Layouts, str(p["layout"]))) ||
			!inPropertyRange(number(p["priceCents"])/1_000_000, input.MinPrice, input.MaxPrice) ||
			!inPropertyRange(number(p["areaSqm"]), input.MinArea, input.MaxArea) {
			continue
		}
		status := "incomplete"
		hasMedia := len(rows(p["panoramas"])) > 0
		if (p["importStatus"] == "ready" && hasMedia) || ready[id] {
			status = "ready"
		}
		if input.Material != "" && input.Material != status {
			continue
		}
		haystack := strings.ToLower(strings.Join([]string{str(p["title"]), str(p["community"]), str(p["propertyNumber"]), str(p["city"]), district}, " "))
		if !strings.Contains(haystack, search) {
			continue
		}
		if input.All {
			if status == "ready" {
				matched = append(matched, pickFields(p, "id", "title", "propertyNumber"))
			}
			continue
		}
		item := pickFields(p, "id", "title", "community", "propertyNumber", "district", "layout", "areaSqm", "priceCents", "image", "sample")
		item["importStatus"] = status
		matched = append(matched, item)
	}
	defaults := obj(obj(w["profile"])["defaults"])
	if input.IDs != nil {
		return object{"rows": matched, "defaults": defaults}
	}
	if input.All {
		return object{"rows": matched}
	}
	options := make([]string, 0, len(districts))
	for district := range districts {
		options = append(options, district)
	}
	sort.Strings(options)
	const pageSize = 20
	page := min(max(input.Page, 1), max((len(matched)+pageSize-1)/pageSize, 1))
	start := (page - 1) * pageSize
	return object{"rows": matched[start:min(start+pageSize, len(matched))], "total": len(matched), "page": page, "districts": options, "defaults": defaults}
}
