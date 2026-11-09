package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"os"
	"slices"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

func seedTemplate(t *testing.T) object {
	t.Helper()
	var list []object
	if err := json.Unmarshal(videoTemplateSeeds, &list); err != nil {
		t.Fatal(err)
	}
	return list[0]
}

func TestProductionTemplateValidation(t *testing.T) {
	for _, mutate := range []func(object){
		func(r object) { obj(obj(r["production"])["config"])["voice"] = "private-voice" },
		func(r object) { obj(obj(r["production"])["config"])["speed"] = float64(13) },
		func(r object) { obj(obj(r["production"])["config"])["direction"] = float64(0) },
		func(r object) { obj(obj(r["production"])["config"])["openingTemplate"] = "{room}" },
		func(r object) { obj(obj(r["production"])["config"])["sceneTemplate"] = "{unknown}" },
		func(r object) { obj(obj(r["production"])["config"])["sceneTemplate"] = "只有固定文字" },
		func(r object) { obj(obj(r["production"])["config"])["sceneTemplate"] = "{room} {broken" },
		func(r object) { obj(obj(r["production"])["config"])["brandColor"] = "red" },
		func(r object) { obj(obj(r["production"])["config"])["subtitles"] = "true" },
		func(r object) { delete(obj(obj(r["production"])["config"]), "rate") },
		func(r object) { r["version"] = "next" },
		func(r object) { r["compatibleModes"] = []any{"avatar"} },
		func(r object) { r["type"] = "style" },
	} {
		r := seedTemplate(t)
		mutate(r)
		if err := validateResource(r); err == nil {
			t.Fatalf("invalid production accepted: %#v", r)
		}
	}
	r := seedTemplate(t)
	if err := validateResource(r); err != nil {
		t.Fatal(err)
	}
	if publicResource(r)["previewed"] != false {
		t.Fatal("unverified preview reported passed")
	}
	r["previewDigest"] = productionDigest(r)
	if publicResource(r)["previewed"] != true {
		t.Fatal("verified preview not reported")
	}
	obj(obj(r["production"])["config"])["brandColor"] = "#111111"
	if publicResource(r)["previewed"] != false {
		t.Fatal("changed recipe retained preview")
	}
}

func productionTestDB(t *testing.T) *sql.DB {
	t.Helper()
	connection := os.Getenv("ADMIN_TEST_DATABASE_URL")
	if connection == "" {
		t.Skip("set ADMIN_TEST_DATABASE_URL for isolated catalog checks")
	}
	base, err := sql.Open("pgx", connection)
	if err != nil {
		t.Fatal(err)
	}
	name := "keagent_template_test_" + id()
	if _, err = base.ExecContext(t.Context(), `CREATE SCHEMA `+name); err != nil {
		t.Fatal(err)
	}
	config, err := pgx.ParseConfig(connection)
	if err != nil {
		t.Fatal(err)
	}
	config.RuntimeParams["search_path"] = name
	db := stdlib.OpenDB(*config)
	t.Cleanup(func() {
		db.Close()
		if _, err := base.ExecContext(context.Background(), `DROP SCHEMA `+name+` CASCADE`); err != nil {
			t.Error(err)
		}
		base.Close()
	})
	if _, err = db.ExecContext(t.Context(), schema); err != nil {
		t.Fatal(err)
	}
	return db
}

func TestProductionTemplateLifecycle(t *testing.T) {
	db := productionTestDB(t)
	s := &server{db: db}
	admin := actor{UserID: "catalog-admin"}
	write := func(kind string, value object) (any, error) {
		body, _ := json.Marshal(value)
		return s.admin(httptest.NewRequest("POST", "/v1/admin/"+kind, nil).WithContext(t.Context()), admin, body)
	}
	read := func(path string) (any, error) {
		return s.admin(httptest.NewRequest("GET", "/v1/admin/"+path, nil).WithContext(t.Context()), admin, nil)
	}
	assertCatalog := func(standard string) {
		t.Helper()
		capabilities, err := s.panorama(t.Context(), admin, "capabilities", []byte("{}"))
		ids := []string{}
		for _, template := range rows(obj(capabilities)["templates"]) {
			ids = append(ids, str(obj(template)["id"]))
		}
		want := []string{"concise-vision", "highlights-vision", standard}
		slices.Sort(ids)
		slices.Sort(want)
		if err != nil || !slices.Equal(ids, want) {
			t.Fatalf("catalog IDs: got %v, want %v, error %v", ids, want, err)
		}
	}
	if err := seedVideoTemplates(t.Context(), db); err != nil {
		t.Fatal(err)
	}
	assertCatalog("standard-tour-vision")
	resource := seedTemplate(t)
	resource["id"] = "admin-template"
	resource["name"] = "门店模板"
	resource["published"] = false
	resource["publishedOnce"] = false
	if _, err := write("resources", resource); err != nil {
		t.Fatal(err)
	}
	resource["published"] = true
	if _, err := write("resources", resource); err == nil {
		t.Fatal("published without preview")
	}
	value, err := write("resources/preview", object{"id": resource["id"]})
	segments, _ := obj(value)["segments"].([]object)
	if err != nil || len(segments) != 3 {
		t.Fatalf("preview: %v %v", value, err)
	}
	cached, err := read("resources/preview?id=admin-template")
	got, _ := json.Marshal(cached)
	want, _ := json.Marshal(value)
	if err != nil || string(got) != string(want) {
		t.Fatalf("stored preview: %s %v", got, err)
	}
	resource["published"] = false
	if _, err = write("resources", resource); err != nil {
		t.Fatal(err)
	}
	cached, err = read("resources/preview?id=admin-template")
	got, _ = json.Marshal(cached)
	if err != nil || string(got) != string(want) {
		t.Fatalf("unchanged save lost preview: %s %v", got, err)
	}
	// An edit after preview invalidates its proof.
	obj(obj(resource["production"])["config"])["brandColor"] = "#123456"
	if _, err = write("resources", resource); err != nil {
		t.Fatal(err)
	}
	if cached, err = read("resources/preview?id=admin-template"); err != nil || cached != nil {
		t.Fatalf("edited template kept prior preview: %v %v", cached, err)
	}
	resource["published"] = true
	if _, err = write("resources", resource); err == nil {
		t.Fatal("stale preview accepted")
	}
	if _, err = write("resources/preview", object{"id": resource["id"]}); err != nil {
		t.Fatal(err)
	}
	if _, err = write("resources", resource); err != nil {
		t.Fatal(err)
	}
	resolved, err := s.productionTemplate(t.Context(), object{"id": resource["id"], "version": "1.0.0"})
	if err != nil || obj(obj(resolved["production"])["config"])["brandColor"] != "#123456" {
		t.Fatalf("resolver lost recipe: %v %v", resolved, err)
	}
	if _, err = s.productionTemplate(t.Context(), object{"id": resource["id"], "version": "2.0.0"}); err == nil {
		t.Fatal("stale version accepted")
	}
	obj(obj(resource["production"])["config"])["brandColor"] = "#FFFFFF"
	if _, err = write("resources", resource); err == nil {
		t.Fatal("published recipe modified")
	}
	obj(obj(resource["production"])["config"])["brandColor"] = "#123456"
	resource["published"] = false
	if _, err = write("resources", resource); err != nil {
		t.Fatal(err)
	}
	if _, err = s.productionTemplate(t.Context(), object{"id": resource["id"]}); err == nil {
		t.Fatal("unlisted template resolved")
	}
	if _, err = write("resources", object{"name": "旧版目录", "version": "1", "type": "prompt", "published": true}); err != nil {
		t.Fatal(err)
	}
	assertCatalog("standard-tour-vision")
	// Unlisting the latest seed reveals the earlier enabled version, even after a restart.
	if _, err = write("resources", object{"id": "standard-tour-vision", "published": false}); err != nil {
		t.Fatal(err)
	}
	if err = seedVideoTemplates(t.Context(), db); err != nil {
		t.Fatal(err)
	}
	assertCatalog("standard-tour")
	if _, err = write("resources", object{"id": "standard-tour-vision", "published": true}); err != nil {
		t.Fatal(err)
	}
	// Duplicate visible identity/version is rejected, including copies of unlisted versions.
	resource["id"] = "duplicate"
	if _, err = write("resources", resource); err == nil {
		t.Fatal("duplicate name/version accepted")
	}
	resource["version"] = "1.0.1"
	if _, err = write("resources", resource); err != nil {
		t.Fatal("new version rejected", err)
	}

	// The preexisting seed pair is grouped without changing its stored IDs.
	history, err := queryResourceVersions(t.Context(), db, "standard-tour")
	if err != nil || len(history) != 2 || obj(history[0])["version"] != "2.0.0" {
		t.Fatalf("legacy version history: %v %v", history, err)
	}
	previous := "standard-tour-vision"
	if _, err = db.ExecContext(t.Context(), `UPDATE keagent_resource SET payload=jsonb_set(payload,'{previewSegments}','[{"id":"opening","text":"Cached vision preview"}]') WHERE id=$1`, previous); err != nil {
		t.Fatal(err)
	}
	value, err = write("resources/preview", object{"id": previous})
	if segments := rows(obj(value)["segments"]); err != nil || len(segments) != 1 || obj(segments[0])["text"] != "Cached vision preview" {
		t.Fatalf("stored vision preview should bypass image and provider calls: %v %v", value, err)
	}
	next := seedTemplate(t)
	delete(next, "id")
	next["versionOf"] = previous
	next["name"] = "新版标准带看"
	next["version"] = "2.0.0"
	next["published"] = false
	if _, err = write("resources", next); err == nil {
		t.Fatal("duplicate version accepted after renaming")
	}
	next["version"] = "10.0.0"
	created, err := write("resources", next)
	if err != nil {
		t.Fatal(err)
	}
	nextID := str(obj(created)["id"])
	history, err = queryResourceVersions(t.Context(), db, nextID)
	if err != nil || len(history) != 3 || obj(history[0])["id"] != nextID {
		t.Fatalf("new version lost its family: %v %v", history, err)
	}
	assertCurrent := func(search, id string) {
		t.Helper()
		result, err := queryAdminList(t.Context(), db, "resources", url.Values{"q": {search}})
		if items := rows(result["items"]); err != nil || len(items) != 1 || obj(items[0])["id"] != id {
			t.Fatalf("current version for %s: %v %v", search, result, err)
		}
	}
	assertCurrent("标准房源带看", previous)
	assertCatalog(previous)
	if _, err = write("resources", object{"id": nextID, "published": true}); err == nil {
		t.Fatal("unverified version activated")
	}
	if _, err = write("resources/preview", object{"id": nextID}); err != nil {
		t.Fatal(err)
	}
	if _, err = write("resources", object{"id": nextID, "published": true}); err != nil {
		t.Fatal(err)
	}
	assertCurrent("新版标准带看", nextID)
	if _, err = s.productionTemplate(t.Context(), object{"id": previous}); err == nil {
		t.Fatal("replaced version remained active")
	}
	// A renamed version still belongs to its original family and wins numerically.
	if _, err = db.ExecContext(t.Context(), `UPDATE keagent_resource SET payload=jsonb_set(payload,'{published}','true') WHERE id=$1`, previous); err != nil {
		t.Fatal(err)
	}
	assertCatalog(nextID)
	if _, err = write("resources", object{"id": previous, "published": true}); err != nil {
		t.Fatal(err)
	}
	assertCurrent("标准房源带看", previous)
	assertCatalog(previous)
	if _, err = s.productionTemplate(t.Context(), object{"id": nextID}); err == nil {
		t.Fatal("rollback left the new version active")
	}
}
