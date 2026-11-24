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

func TestFactoryPropertyExactAndCombinedFilters(t *testing.T) {
	properties := []any{}
	for _, n := range []string{"A-001", "A-0010", "001"} {
		properties = append(properties, object{"id": n, "propertyNumber": n, "title": "A-001", "community": "望京西园", "district": "朝阳", "layout": "3室1厅", "priceCents": 500_000_000.0, "areaSqm": 90.0})
	}
	obj(properties[1])["layout"] = "2室1厅"
	obj(properties[2])["areaSqm"] = 89.9
	w := object{"properties": properties}
	for number, count := range map[string]int{" A-001 ": 1, "A-00": 0, "01": 0, "001": 1, "": 0} {
		page := factoryPropertyPage(w, factoryPropertyQuery{ExactNumber: &number})
		if page["total"] != count {
			t.Fatalf("%q: %v", number, page)
		}
	}
	price, area := 500.0, 90.0
	query := factoryPropertyQuery{District: "朝阳", Community: "望京西园", Layouts: []string{"3室1厅", "4室2厅"}, MinPrice: &price, MaxPrice: &price, MinArea: &area, MaxArea: &area, ReadyIDs: []string{"A-001", "A-0010", "001"}}
	page := factoryPropertyPage(w, query)
	if page["total"] != 1 || obj(rows(page["rows"])[0])["priceCents"] != 500_000_000.0 {
		t.Fatal(page)
	}
	query.All = true
	all := rows(factoryPropertyPage(w, query)["rows"])
	if len(all) != 1 || obj(all[0])["propertyNumber"] != "A-001" {
		t.Fatal(all)
	}
	query.Community = "望京东园"
	if len(rows(factoryPropertyPage(w, query)["rows"])) != 0 {
		t.Fatal("community filter ignored")
	}
}
