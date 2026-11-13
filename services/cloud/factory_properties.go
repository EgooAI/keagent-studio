package main

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
)

type factoryPropertyQuery struct {
	IDs                        []string
	ReadyIDs                   []string
	SelectedIDs                []string
	Search, District, Material string
	Page                       int
	All                        bool
}

func (s *server) factoryProperties(ctx context.Context, a actor, body []byte) (object, error) {
	var input factoryPropertyQuery
	if json.Unmarshal(body, &input) != nil || len(input.IDs) > 200 || len(input.ReadyIDs) > 10000 || len(input.SelectedIDs) > 10000 ||
		len(input.Search) > 512 || len(input.District) > 512 || len(input.Material) > 20 {
		return nil, fail(422, "房源查询参数无效")
	}
	w, err := s.workspacePayload(ctx, a)
	if err != nil {
		return nil, err
	}
	return factoryPropertyPage(w, input), nil
}

func factoryPropertyPage(w object, input factoryPropertyQuery) object {
	properties := append([]any{builtinTestProperty()}, rows(w["properties"])...)
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
		if seen[id] {
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
		if input.District != "" && input.District != district {
			continue
		}
		status := "incomplete"
		hasMedia := len(rows(p["panoramas"])) > 0 || id == "panorama-cc0-sample"
		if (p["importStatus"] == "ready" && hasMedia) || ready[id] {
			status = "ready"
		}
		if input.Material != "" && input.Material != status {
			continue
		}
		haystack := strings.ToLower(strings.Join([]string{str(p["title"]), str(p["community"]), str(p["propertyNumber"]), district}, " "))
		if !strings.Contains(haystack, search) {
			continue
		}
		if input.All {
			if status == "ready" {
				matched = append(matched, pickFields(p, "id", "title"))
			}
			continue
		}
		item := pickFields(p, "id", "title", "community", "propertyNumber", "district", "layout", "areaSqm", "image", "sample")
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
