package main

import (
	"maps"
	"reflect"
	"testing"
)

func TestFactoryMixIsPersonalVersionedAndReproducible(t *testing.T) {
	ctx, db := t.Context(), productionTestDB(t)
	if err := seedVideoTemplates(ctx, db); err != nil {
		t.Fatal(err)
	}
	if err := migrateTemplateLibrary(ctx, db); err != nil {
		t.Fatal(err)
	}
	s, owner := &server{db: db}, actor{UserID: "mix-owner"}
	library, err := s.factoryLibrary(ctx, owner.UserID)
	if err != nil {
		t.Fatal(err)
	}
	recommended := library["recommended"].([]object)
	if len(recommended) == 0 {
		t.Fatal("published bundles missing")
	}
	base := recommended[0]
	refs := maps.Clone(obj(base["parts"]))
	expected := map[string]object{}
	for _, k := range partKinds {
		d := maps.Clone(previewDefaults[k])
		switch k {
		case "cover":
			d["imageSource"], d["showFacts"], d["brandColor"] = "last", false, "#325EFF"
		case "script":
			d["scriptRules"] = object{"overall": "自定义讲解", "opening": "开场", "scene": "逐图", "closing": "结尾"}
		}
		expected[k] = d
		id := "test-" + k
		r := object{"id": id, "name": id, "version": "2.0.0", "type": catalogTypes[k], "published": true, "publishedOnce": true, "definition": d}
		if _, err = db.ExecContext(ctx, `INSERT INTO keagent_resource VALUES($1,$2)`, id, mustJSON(r)); err != nil {
			t.Fatal(err)
		}
		refs[k] = pickFields(r, "id", "version")
	}
	input := object{"id": base["id"], "version": base["version"], "parts": refs, "name": "我的带看"}
	saved, err := s.factoryMix(ctx, owner, input, true)
	if err != nil {
		t.Fatal(err)
	}
	again, err := s.factoryMix(ctx, owner, input, true)
	if err != nil || again["id"] != saved["id"] {
		t.Fatalf("save retry: %v %v", again, err)
	}
	otherRefs := maps.Clone(refs)
	otherRefs["edit"] = obj(base["parts"])["edit"]
	collision := maps.Clone(input)
	collision["parts"] = otherRefs
	if _, err = s.factoryMix(ctx, owner, collision, true); err == nil {
		t.Fatal("silently overwrote a named mix")
	}
	other := actor{UserID: "different-owner"}
	otherLibrary, err := s.factoryLibrary(ctx, other.UserID)
	if err != nil || len(otherLibrary["personal"].([]object)) != 0 {
		t.Fatalf("private catalog: %v", err)
	}
	if _, err = s.factoryMix(ctx, other, saved, false); err == nil {
		t.Fatal("used another owner's mix")
	}
	snapshot, err := s.factoryMix(ctx, owner, saved, false)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(snapshot["production"], composeProduction(expected["edit"], expected["script"])) || !reflect.DeepEqual(snapshot["cover"], expected["cover"]) {
		t.Fatal("snapshot did not resolve all three independently chosen parts")
	}
	if _, err = db.ExecContext(ctx, `UPDATE keagent_resource SET payload=payload||'{"published":false,"deletedAt":"today"}'::jsonb WHERE id='test-cover'`); err != nil {
		t.Fatal(err)
	}
	if _, err = s.factoryMix(ctx, owner, input, false); err == nil {
		t.Fatal("selected a newly retired replacement")
	}
	if _, err = s.factoryMix(ctx, owner, saved, false); err != nil {
		t.Fatal("saved pin became unusable:", err)
	}
	library, err = s.factoryLibrary(ctx, owner.UserID)
	if err != nil || len(library["personal"].([]object)) != 1 {
		t.Fatalf("reload lost saved mix: %v", err)
	}
	found := false
	for _, option := range library["parts"].([]object) {
		if option["id"] == "test-cover" {
			found = true
			if option["available"] != false {
				t.Fatal("retired part offered as new")
			}
		}
	}
	if !found {
		t.Fatal("pinned cover missing from preview")
	}
	jobRef := object{"templateId": snapshot["id"], "templateVersion": snapshot["version"]}
	loaded, err := s.jobProductionTemplate(ctx, owner, jobRef, false)
	if err != nil || !reflect.DeepEqual(loaded, snapshot) {
		t.Fatalf("job changed on retry: %v", err)
	}
	if _, err = s.jobProductionTemplate(ctx, other, jobRef, false); err == nil {
		t.Fatal("read another account's job recipe")
	}
}
