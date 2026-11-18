package main

import (
	"encoding/json"
	"maps"
	"net/http/httptest"
	"net/url"
	"reflect"
	"testing"
)

func TestCatalogMigrationPreservesProduction(t *testing.T) {
	ctx, db := t.Context(), productionTestDB(t)
	if err := seedVideoTemplates(ctx, db); err != nil {
		t.Fatal(err)
	}
	// A store's unpublished draft and a removed family must survive the rollout.
	custom := seedTemplate(t)
	custom["id"], custom["name"], custom["published"], custom["publishedOnce"] = "custom", "门店内部草稿", false, false
	raw, _ := json.Marshal(custom)
	if _, err := db.ExecContext(ctx, `INSERT INTO keagent_resource VALUES('custom',$1),('removed',$1::jsonb || '{"id":"removed","deletedAt":"yesterday"}'::jsonb)`, raw); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := migrateTemplateLibrary(ctx, db); err != nil {
			t.Fatal(err)
		}
	}
	var seeds []object
	if err := json.Unmarshal(videoTemplateSeeds, &seeds); err != nil {
		t.Fatal(err)
	}
	byID := map[string]object{}
	for _, seed := range seeds {
		versions, err := queryResourceVersions(ctx, db, "bundle:"+str(seed["id"]))
		if err != nil {
			t.Fatal(err)
		}
		entry := find(versions, "bundle:"+str(seed["id"]))
		if entry == nil {
			t.Fatalf("missing version %v", seed["id"])
		}
		definition := obj(entry["definition"])
		parts, err := bundleParts(ctx, db, definition, false)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(composeProduction(parts["edit"], parts["script"]), seed["production"]) ||
			!reflect.DeepEqual(parts["cover"], splitProduction(obj(seed["production"]))["cover"]) {
			t.Fatalf("migration changed rendering or writing rules for %v", seed["id"])
		}
		byID[str(seed["id"])] = obj(definition["parts"])
	}
	for _, kind := range []string{"edit", "cover"} {
		if !reflect.DeepEqual(byID["standard-tour-vision"][kind], byID["highlights-vision"][kind]) {
			t.Fatal("identical published parts were duplicated", kind)
		}
	}
	if !reflect.DeepEqual(byID["short-tour-vision-v1-1"]["script"], byID["short-tour-avatar-v1-1"]["script"]) {
		t.Fatal("matching writing rules should share a version")
	}
	drafts, err := queryAdminList(ctx, db, "resources", url.Values{"catalog": {"bundle"}, "state": {"draft"}})
	if err != nil || drafts["total"] != 1 || obj(rows(drafts["items"])[0])["name"] != custom["name"] {
		t.Fatalf("draft import: %v %v", drafts, err)
	}
	if _, err = queryResourceVersions(ctx, db, "bundle:removed"); err == nil {
		t.Fatal("removed source imported")
	}
	desktop, err := (&server{db: db}).productionTemplates(ctx, true)
	if err != nil || len(desktop) != 6 {
		t.Fatalf("desktop catalog changed: %d, %v", len(desktop), err)
	}
}

func TestCatalogBundlePublication(t *testing.T) {
	ctx, db := t.Context(), productionTestDB(t)
	s := &server{db: db}
	if err := seedVideoTemplates(ctx, db); err != nil {
		t.Fatal(err)
	}
	if err := migrateTemplateLibrary(ctx, db); err != nil {
		t.Fatal(err)
	}
	call := func(method, route string, input object) (any, error) {
		body, _ := json.Marshal(input)
		return s.admin(httptest.NewRequest(method, "/v1/admin/resources"+route, nil).WithContext(ctx), actor{UserID: "catalog-test"}, body)
	}
	write := func(route string, input object) object {
		t.Helper()
		v, err := call("POST", route, input)
		if err != nil {
			t.Fatalf("%s %v: %v", route, input["id"], err)
		}
		return obj(v)
	}
	reject := func(route string, input object) {
		t.Helper()
		if _, err := call("POST", route, input); err == nil {
			t.Fatalf("invalid write succeeded: %s %v", route, input["id"])
		}
	}
	legacy, err := queryResourceVersions(ctx, db, "bundle:standard-tour")
	if err != nil {
		t.Fatal(err)
	}
	// Use the deterministic phrase-based version to exercise publication without a provider.
	refs := maps.Clone(obj(obj(find(legacy, "bundle:standard-tour")["definition"])["parts"]))
	if refs == nil {
		t.Fatal("legacy phrases missing")
	}
	write("", object{"id": obj(refs["script"])["id"], "published": true})

	cover := maps.Clone(previewDefaults["cover"])
	cover["brandColor"], cover["imageSource"] = "#145FAC", "last"
	cover["titleSource"] = "opening"
	draft := object{"type": "cover", "name": "门店封面", "version": "1.0.0", "definition": cover}
	id := write("", draft)["id"]
	draft["id"] = id
	reject("", object{"id": id, "published": true})
	preview := write("/preview", object{"id": id})
	if !reflect.DeepEqual(preview["cover"], cover) || len(rows(preview["segments"])) != 0 {
		t.Fatal("wrong independent cover preview", preview)
	}
	cover["titleSource"] = "property"
	write("", draft)
	if cached, err := call("GET", "/preview?id="+str(id), nil); err != nil || cached != nil {
		t.Fatal("preview proof survived a cover edit")
	}
	reject("", object{"id": id, "published": true})
	write("/preview", object{"id": id})
	write("", object{"id": id, "published": true})
	refs["cover"] = object{"id": id, "version": "1.0.0", "name": "untrusted display name"}
	newBundle := object{"type": "video", "name": "搭配验证", "version": "1.0.0", "definition": object{"kind": "bundle", "parts": refs}}
	bundleID := write("", newBundle)["id"]
	preview = write("/preview", object{"id": bundleID})
	previewRefs := obj(obj(preview["definition"])["parts"])
	if obj(previewRefs["cover"])["name"] != draft["name"] || obj(preview["cover"])["titleSource"] != "property" ||
		obj(obj(obj(preview["template"])["production"])["config"])["brandColor"] == cover["brandColor"] {
		t.Fatal("cover changed edit style or client supplied the reference metadata", preview)
	}
	write("", object{"id": id, "published": false})
	reject("", object{"id": bundleID, "published": true})
	write("", object{"id": id, "published": true})
	write("", object{"id": bundleID, "published": true})
	write("/delete", object{"id": id})
	if _, err := s.productionTemplate(ctx, object{"id": bundleID}); err == nil {
		t.Fatal("admin-only combination leaked to desktop")
	}
	reject("", newBundle)
	preview = write("/preview", object{"id": bundleID})
	if !reflect.DeepEqual(preview["cover"], cover) {
		t.Fatal("deleted part broke pinned combination")
	}
	options, err := templateOptions(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	for _, o := range options {
		if o["id"] == id {
			t.Fatal("deleted cover was selectable")
		}
	}
	write("/delete", object{"id": "bundle:short-tour-vision-v1-1"})
	if err = migrateTemplateLibrary(ctx, db); err != nil {
		t.Fatal(err)
	}
	if _, err = queryResourceVersions(ctx, db, "bundle:short-tour-vision-v1-1"); err == nil {
		t.Fatal("restart recreated deleted bundle")
	}
}
