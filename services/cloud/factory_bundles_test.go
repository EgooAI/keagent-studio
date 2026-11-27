package main

import (
	"context"
	"database/sql"
	"encoding/json"
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
	if _, err = s.factoryMix(ctx, owner, saved, false); err == nil {
		t.Fatal("saved mix can start a new task with a retired part")
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

func TestFactoryCatalogVersionTracksRecommendationChanges(t *testing.T) {
	ctx, db := t.Context(), productionTestDB(t)
	for _, setup := range []func(context.Context, *sql.DB) error{seedVideoTemplates, migrateTemplateLibrary} {
		if err := setup(ctx, db); err != nil {
			t.Fatal(err)
		}
	}
	// An earlier cleanup removed the desired agent recommendation while leaving its edit visible.
	if _, err := db.ExecContext(ctx, `UPDATE keagent_resource SET payload=payload||'{"published":false,"deletedAt":"yesterday"}'::jsonb WHERE id LIKE 'bundle:short-tour-avatar%'`); err != nil {
		t.Fatal(err)
	}
	if err := simplifyShortTourCatalog(ctx, db); err != nil {
		t.Fatal(err)
	}
	s := &server{db: db}
	catalog := func(version any) object {
		t.Helper()
		v, err := s.panorama(ctx, actor{UserID: "catalog-reader"}, "capabilities", mustJSON(object{
			"bundleCatalog": true, "catalogVersion": version,
		}))
		if err != nil {
			t.Fatal(err)
		}
		return obj(v)
	}
	names := func(caps object) map[string]bool {
		t.Helper()
		result := map[string]bool{}
		for _, entry := range obj(caps["library"])["recommended"].([]object) {
			result[str(entry["name"])] = true
		}
		return result
	}
	initial := catalog(nil)
	version := initial["catalogVersion"]
	if len(str(version)) != 64 || !reflect.DeepEqual(names(initial), map[string]bool{"短视频带看": true, "短视频带看 · 经纪人开场": true}) {
		t.Fatal("catalog did not keep the two short-tour recommendations")
	}
	library := obj(initial["library"])
	partCount := map[string]int{}
	for _, part := range library["parts"].([]object) {
		if part["available"] != true || part["opening"] != nil {
			t.Fatalf("retired part exposed through the catalog: %v", part["name"])
		}
		partCount[str(part["kind"])]++
	}
	if !reflect.DeepEqual(partCount, map[string]int{"edit": 2, "cover": 1, "script": 1}) {
		t.Fatalf("unexpected part counts: %v", partCount)
	}
	byID := map[string]object{}
	for _, bundle := range library["recommended"].([]object) {
		byID[str(bundle["id"])] = bundle
	}
	normalRefs := obj(byID["bundle:"+shortTourDefaultID]["parts"])
	local := byID["bundle:"+shortTourLocalOpeningID]
	localRefs := obj(local["parts"])
	if !reflect.DeepEqual(normalRefs["cover"], localRefs["cover"]) || !reflect.DeepEqual(normalRefs["script"], localRefs["script"]) {
		t.Fatal("the two recommendations do not share the cover and script")
	}
	resolved, err := s.factoryMix(ctx, actor{UserID: "catalog-reader"}, local, false)
	if err != nil {
		t.Fatal(err)
	}
	recipe := obj(resolved["production"])
	if obj(recipe["config"])["videoMode"] != "avatar" || recipe["opening"] != nil {
		t.Fatal("agent recommendation is not configured for local video")
	}
	legacy, err := s.productionTemplates(ctx, false)
	if err != nil || len(legacy) != 2 {
		t.Fatalf("legacy catalog did not converge: %v (%v)", legacy, err)
	}
	if _, err := s.jobProductionTemplate(ctx, actor{UserID: "catalog-reader"}, object{
		"templateId": "standard-tour-vision", "templateVersion": "2.0.0",
	}, true); err != nil {
		t.Fatal("historical recipe became inaccessible:", err)
	}
	if unchanged := catalog(version); unchanged["catalogVersion"] != version || unchanged["library"] != nil {
		t.Fatal("matching catalog version returned the full library")
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO keagent_resource(id,payload) SELECT 'new-recommendation', payload||'{"id":"new-recommendation","familyId":"new-recommendation","name":"门店新搭配"}'::jsonb FROM keagent_resource WHERE id='bundle:short-tour-vision-v1-1'`); err != nil {
		t.Fatal(err)
	}
	if err := simplifyShortTourCatalog(ctx, db); err != nil {
		t.Fatal(err)
	}
	published := catalog(version)
	if published["catalogVersion"] == version || !names(published)["门店新搭配"] {
		t.Fatal("new recommendation did not change the catalog")
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err := deleteResourceFamily(ctx, tx, "new-recommendation"); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if deleted := catalog(published["catalogVersion"]); deleted["catalogVersion"] != version || names(deleted)["门店新搭配"] {
		t.Fatal("removed recommendation did not disappear from the catalog")
	}
}

func TestAgentTemplatePreviewOmitsCachedOpening(t *testing.T) {
	ctx, db := t.Context(), productionTestDB(t)
	for _, setup := range []func(context.Context, *sql.DB) error{seedVideoTemplates, migrateTemplateLibrary, simplifyShortTourCatalog} {
		if err := setup(ctx, db); err != nil {
			t.Fatal(err)
		}
	}
	const sample = `{"previewSegments":[{"id":"opening","text":"旧开场"},{"id":"preview-1","text":"房源讲解"}]}`
	const target = "bundle:" + shortTourLocalOpeningID
	if _, err := db.ExecContext(ctx, `UPDATE keagent_resource SET payload=payload||$2::jsonb WHERE id=$1`, target, sample); err != nil {
		t.Fatal(err)
	}
	s := &server{db: db}
	got, err := s.previewProduction(ctx, actor{UserID: "admin"}, object{"id": target}, false)
	if err != nil {
		t.Fatal(err)
	}
	segments := rows(obj(got)["segments"])
	if len(segments) != 1 || obj(segments[0])["id"] != "preview-1" {
		t.Fatalf("unexpected agent preview: %v", segments)
	}
}

func TestListingFrameRecommendedBundles(t *testing.T) {
	ctx, db := t.Context(), productionTestDB(t)
	for _, setup := range []func(context.Context, *sql.DB) error{seedVideoTemplates, migrateTemplateLibrary, simplifyShortTourCatalog, publishListingFrameCover, publishListingFrameCover} {
		if err := setup(ctx, db); err != nil {
			t.Fatal(err)
		}
	}
	library, err := (&server{db: db}).factoryLibrary(ctx, "cover-test")
	if err != nil {
		t.Fatal(err)
	}
	recommended := library["recommended"].([]object)
	if len(recommended) != 2 {
		t.Fatalf("unexpected bundles: %v", recommended)
	}
	var remaining int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM keagent_resource WHERE payload#>>'{definition,kind}'='cover' AND `+undeletedResourceSQL).Scan(&remaining); err != nil || remaining != 1 {
		t.Fatalf("expected only the listing cover in the catalog: %d, %v", remaining, err)
	}
	var old object
	var raw []byte
	if err := db.QueryRowContext(ctx, `SELECT payload->'definition' FROM keagent_resource WHERE id=$1`, "bundle:"+shortTourDefaultID).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &old); err != nil {
		t.Fatal(err)
	}
	if _, err := bundleParts(ctx, db, old, false); err != nil {
		t.Fatalf("historical bundle: %v", err)
	}
	for _, bundle := range recommended {
		ref := obj(obj(bundle["parts"])["cover"])
		var source string
		if err := db.QueryRowContext(ctx, `SELECT payload#>>'{definition,imageSource}' FROM keagent_resource WHERE id=$1 AND payload->>'published'='true'`, ref["id"]).Scan(&source); err != nil || source != "listing-frame" {
			t.Fatalf("missing first-frame cover: %v %s", err, source)
		}
	}
}
