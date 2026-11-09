package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http/httptest"
	"os"
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
	if err := seedVideoTemplates(t.Context(), db); err != nil {
		t.Fatal(err)
	}
	list, err := s.productionTemplates(t.Context())
	if err != nil || len(list) != 6 || number(obj(obj(list[0])["production"])["schemaVersion"]) != 2 {
		t.Fatalf("seed catalog: %v %v", list, err)
	}
	resource := seedTemplate(t)
	resource["id"] = "admin-template"
	resource["name"] = "门店模板"
	resource["published"] = false
	resource["publishedOnce"] = false
	if _, err = write("resources", resource); err != nil {
		t.Fatal(err)
	}
	resource["published"] = true
	if _, err = write("resources", resource); err == nil {
		t.Fatal("published without preview")
	}
	value, err := write("resources/preview", object{"id": resource["id"]})
	segments, _ := obj(value)["segments"].([]object)
	if err != nil || len(segments) != 3 {
		t.Fatalf("preview: %v %v", value, err)
	}
	// An edit after preview invalidates its proof.
	resource["published"] = false
	obj(obj(resource["production"])["config"])["brandColor"] = "#123456"
	if _, err = write("resources", resource); err != nil {
		t.Fatal(err)
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
	if err = seedVideoTemplates(t.Context(), db); err != nil {
		t.Fatal(err)
	}
	list, err = s.productionTemplates(t.Context())
	if err != nil || len(list) != 6 {
		t.Fatalf("legacy or unlisted templates leaked: %v %v", list, err)
	}
	// Repeating the seed must also preserve an administrator's unlisting of a seed.
	if _, err = db.ExecContext(t.Context(), `UPDATE keagent_resource SET payload=jsonb_set(payload,'{published}','false') WHERE id='standard-tour'`); err != nil {
		t.Fatal(err)
	}
	if err = seedVideoTemplates(t.Context(), db); err != nil {
		t.Fatal(err)
	}
	list, err = s.productionTemplates(t.Context())
	if err != nil || len(list) != 5 {
		t.Fatal("restart republished a seed", err)
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
}
