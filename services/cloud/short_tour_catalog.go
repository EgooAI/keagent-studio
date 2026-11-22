package main

import (
	"context"
	"database/sql"
	"encoding/json"
)

const shortTourDefaultID = "short-tour-vision-v1-1"
const shortTourLocalOpeningID = "short-tour-avatar-local"

// Keep historical recipes addressable by exact version. This one-time change
// trims the supplied catalog without filtering out future admin publications.
func simplifyShortTourCatalog(ctx context.Context, db *sql.DB) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	marker, err := tx.ExecContext(ctx, `INSERT INTO keagent_setting(id,payload) VALUES('template-library-short-tour-v3','{}') ON CONFLICT(id) DO NOTHING`)
	if err != nil {
		return err
	}
	count, err := marker.RowsAffected()
	if err != nil || count == 0 {
		return err
	}

	load := func(id string) (object, error) {
		var raw []byte
		if err := tx.QueryRowContext(ctx, `SELECT payload || jsonb_build_object('familyId', `+resourceFamilySQL+`) FROM keagent_resource WHERE id=$1`, id).Scan(&raw); err != nil {
			return nil, err
		}
		var resource object
		err := json.Unmarshal(raw, &resource)
		return resource, err
	}
	normal, err := load("bundle:" + shortTourDefaultID)
	if err != nil {
		return err
	}
	oldID := "short-tour-avatar-v1-1"
	legacy, err := load(oldID)
	if err != nil {
		return err
	}
	bundle, err := load("bundle:" + oldID)
	if err != nil {
		return err
	}
	editID := str(obj(obj(obj(bundle["definition"])["parts"])["edit"])["id"])
	edit, err := load(editID)
	if err != nil {
		return err
	}

	recipe := obj(legacy["production"])
	delete(recipe, "opening")
	legacy["id"] = shortTourLocalOpeningID
	edit["id"] = "part:edit:" + shortTourLocalOpeningID
	edit["definition"] = splitProduction(recipe)["edit"]
	bundle["id"] = "bundle:" + shortTourLocalOpeningID
	normalRefs := obj(obj(normal["definition"])["parts"])
	refs := pickFields(normalRefs, "cover", "script")
	refs["edit"] = object{"id": edit["id"], "name": edit["name"], "version": "1.2.0"}
	bundle["definition"] = object{"kind": "bundle", "parts": refs}
	for _, item := range []object{legacy, edit, bundle} {
		item["version"] = "1.2.0"
		item["description"] = "手动选择一段本机经纪人开场视频，保留原声，再接竖屏房源带看。"
		item["published"], item["publishedOnce"] = true, true
		delete(item, "deletedAt")
		delete(item, "previewSegments")
		item["previewDigest"] = productionDigest(item)
		if err := validateResource(item); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO keagent_resource(id,payload) VALUES($1,$2)`, item["id"], mustJSON(item)); err != nil {
			return err
		}
	}

	var seeds []object
	if err := json.Unmarshal(videoTemplateSeeds, &seeds); err != nil {
		return err
	}
	var retired []string
	for _, seed := range seeds {
		id := str(seed["id"])
		retired = append(retired, id, "bundle:"+id)
		for kind, definition := range splitProduction(obj(seed["production"])) {
			partID := "part:" + kind + ":" + digestBytes(mustJSON(definition))
			retired = append(retired, partID, partID+":"+id)
		}
	}
	keep := []string{shortTourDefaultID, "bundle:" + shortTourDefaultID}
	for _, kind := range partKinds {
		keep = append(keep, str(obj(normalRefs[kind])["id"]))
	}
	_, err = tx.ExecContext(ctx, `UPDATE keagent_resource SET payload=payload || jsonb_build_object(
		'deletedAt', now(), 'published', false,
		'publishedOnce', COALESCE(payload->>'published'='true', false) OR COALESCE(payload->>'publishedOnce'='true', false)
	) WHERE `+undeletedResourceSQL+` AND NOT (id = ANY($2::text[]))
	AND (id = ANY($1::text[]) OR payload->'production' ? 'opening' OR payload->'definition' ? 'opening'
		OR payload#>>'{definition,parts,edit,id}' IN (
			SELECT id FROM keagent_resource WHERE payload->'definition' ? 'opening'
		)
	)`, retired, keep)
	if err != nil {
		return err
	}
	return tx.Commit()
}
