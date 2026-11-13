package main

import (
	"fmt"
	"testing"
)

func TestFactoryPropertyPage(t *testing.T) {
	properties := make([]any, 0, 1000)
	for i := range 1000 {
		id := fmt.Sprintf("SH%04d", i)
		status := "ready"
		if i == 0 {
			status = "incomplete"
		}
		properties = append(properties, object{"id": id, "propertyNumber": id, "district": "浦东", "importStatus": status, "images": []any{"image.jpg"}, "panoramas": []any{"panorama.jpg"}})
	}
	w := object{"properties": properties}
	page := factoryPropertyPage(w, factoryPropertyQuery{Search: "sh", District: "浦东", Material: "ready", Page: 50})
	items := rows(page["rows"])
	if page["total"] != 999 || len(items) != 19 || obj(items[18])["id"] != "SH0999" || obj(items[18])["images"] != nil {
		t.Fatalf("unexpected page: %v", page)
	}
	all := factoryPropertyPage(w, factoryPropertyQuery{District: "浦东", ReadyIDs: []string{"SH0000"}, All: true})
	if len(rows(all["rows"])) != 1000 {
		t.Fatal("filter selection must include all available properties across pages")
	}
	selected := factoryPropertyPage(w, factoryPropertyQuery{SelectedIDs: []string{"SH0000", "SH0999"}})
	if selected["total"] != 2 {
		t.Fatal("selected view must retain rows from different pages")
	}
	full := factoryPropertyPage(w, factoryPropertyQuery{IDs: []string{"SH0999", "missing"}})
	if items := rows(full["rows"]); len(items) != 1 || len(rows(obj(items[0])["images"])) != 1 {
		t.Fatal("only existing selected properties should return full snapshots")
	}
}

func TestFactoryRejectsPhotoOnlyMaterials(t *testing.T) {
	w := object{"properties": []any{object{"id": "photo-only", "importStatus": "ready", "images": []any{"photo.jpg"}}}}
	page := factoryPropertyPage(w, factoryPropertyQuery{SelectedIDs: []string{"photo-only"}})
	if obj(rows(page["rows"])[0])["importStatus"] != "incomplete" {
		t.Fatal("photo-only property was ready")
	}
	page = factoryPropertyPage(w, factoryPropertyQuery{SelectedIDs: []string{"photo-only"}, ReadyIDs: []string{"photo-only"}})
	if obj(rows(page["rows"])[0])["importStatus"] != "ready" {
		t.Fatal("local VR materials were ignored")
	}
}

func TestFactoryExcludesRemovedSample(t *testing.T) {
	for _, properties := range [][]any{{}, {object{"id": "panorama-cc0-sample", "sample": true}}} {
		w := object{"properties": properties}
		for _, query := range []factoryPropertyQuery{{}, {IDs: []string{"panorama-cc0-sample"}}, {All: true}} {
			if page := factoryPropertyPage(w, query); len(rows(page["rows"])) != 0 {
				t.Fatal("removed test property returned", page)
			}
		}
	}
}
