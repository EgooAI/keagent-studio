package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"unicode/utf8"
)

// Public and personal entry points both carry immutable part references.
// The renderer only receives the full production recipe when creating a job.
const factorySourcesSQL = `SELECT id, payload->>'name' AS name, payload->>'version' AS version,
	COALESCE(payload->>'description','') AS description, COALESCE(payload->>'thumbnail','') AS thumbnail,
	payload->'definition'->'parts' AS parts, false AS personal, NULL::timestamptz AS saved_at
	FROM keagent_resource WHERE payload->'definition'->>'kind'='bundle'
	AND payload->>'published'='true' AND ` + undeletedResourceSQL + `
	UNION ALL SELECT id,name,version,'','',parts,true,created_at FROM keagent_factory_mix WHERE owner_id=$1 AND saved`

func (s *server) factoryLibrary(ctx context.Context, owner string) (object, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	rr, err := tx.QueryContext(ctx, `SELECT id,name,version,description,thumbnail,parts,personal FROM (`+factorySourcesSQL+`) s
		ORDER BY personal, saved_at DESC NULLS LAST, name, id`, owner)
	if err != nil {
		return nil, err
	}
	recommended, personal, options := []object{}, []object{}, []object{}
	pinned := map[string]bool{}
	for rr.Next() {
		var id, name, version, description, thumbnail string
		var raw []byte
		var mine bool
		if err = rr.Scan(&id, &name, &version, &description, &thumbnail, &raw, &mine); err != nil {
			rr.Close()
			return nil, err
		}
		var refs object
		if err = json.Unmarshal(raw, &refs); err != nil {
			rr.Close()
			return nil, err
		}
		row := object{"id": id, "name": name, "version": version, "description": description, "thumbnail": thumbnail, "parts": refs}
		if mine {
			personal = append(personal, row)
		} else {
			recommended = append(recommended, row)
		}
		for _, kind := range partKinds {
			pinned[str(obj(refs[kind])["id"])] = true
		}
	}
	rr.Close()
	if err = rr.Err(); err != nil {
		return nil, err
	}
	rr, err = tx.QueryContext(ctx, `WITH parts AS (
		SELECT id,payload,payload->'definition' d, (payload->>'published'='true' AND `+undeletedResourceSQL+`) available
		FROM keagent_resource WHERE payload->'definition'->>'kind' IN ('edit','cover','script'))
		SELECT jsonb_strip_nulls(jsonb_build_object('id',id,'version',payload->>'version','name',payload->>'name','description',payload->>'description',
		'kind',d->>'kind','available',available,'config',d->'config','language',d->'language',
		'opening',CASE WHEN d ? 'opening' THEN 'minimax' END,'cover',CASE WHEN d->>'kind'='cover' THEN d END))
		FROM parts WHERE available OR (payload->>'publishedOnce'='true' AND $1::jsonb ? id)
		ORDER BY payload->>'name', id`, mustJSON(pinned))
	if err != nil {
		return nil, err
	}
	defer rr.Close()
	for rr.Next() {
		var raw []byte
		var option object
		if err = rr.Scan(&raw); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(raw, &option); err != nil {
			return nil, err
		}
		options = append(options, option)
	}
	if err = rr.Err(); err != nil {
		return nil, err
	}
	return object{"recommended": recommended, "personal": personal, "parts": options}, tx.Commit()
}

func (s *server) factoryMix(ctx context.Context, a actor, input object, save bool) (object, error) {
	refs := obj(input["parts"])
	if len(refs) != len(partKinds) {
		return nil, fail(422, "请各选一个剪辑、封面和文案版本")
	}
	name := strings.TrimSpace(str(input["name"]))
	if save && (name == "" || utf8.RuneCountInString(name) > 60) {
		return nil, fail(422, "请填写 1 至 60 字的搭配名称")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var pinned object
	baseName, version := "自由搭配", "1.0.0"
	if input["id"] != "free-mix" || input["version"] != version {
		var raw []byte
		err = tx.QueryRowContext(ctx, `SELECT name,version,parts FROM (`+factorySourcesSQL+`) s WHERE id=$2 AND version=$3`,
			a.UserID, str(input["id"]), str(input["version"])).Scan(&baseName, &version, &raw)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, fail(409, "搭配已下架或版本已变化，请刷新后重新选择")
		}
		if err != nil {
			return nil, err
		}
		if err = json.Unmarshal(raw, &pinned); err != nil {
			return nil, err
		}
	}
	parts, err := resolveBundleParts(ctx, tx, refs, true, nil)
	if err != nil {
		return nil, err
	}
	if parts["edit"]["opening"] != nil {
		return nil, fail(409, "生成式开场已停用，请选择使用本机视频的经纪人开场剪辑")
	}
	if !save {
		name = baseName
		for _, k := range partKinds {
			if pinned != nil && !samePartVersion(obj(refs[k]), obj(pinned[k])) {
				name += " · 自定义"
				break
			}
		}
	}
	id := "mix:" + digestBytes(mustJSON(object{"name": name, "version": version, "parts": refs}))
	if save {
		// A retried save with the same name and parts returns the original entry.
		id, version = "mine:"+digestBytes([]byte(name)), "1.0.0"
	}
	var stored string
	err = tx.QueryRowContext(ctx, `INSERT INTO keagent_factory_mix(owner_id,id,name,version,parts,saved) VALUES($1,$2,$3,$4,$5,$6)
		ON CONFLICT(owner_id,id) DO UPDATE SET name=EXCLUDED.name WHERE keagent_factory_mix.parts=EXCLUDED.parts RETURNING id`,
		a.UserID, id, name, version, mustJSON(refs), save).Scan(&stored)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fail(409, "已有同名搭配，请换一个名称")
	}
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	row := object{"id": stored, "name": name, "version": version, "parts": refs}
	if !save {
		row["production"], row["cover"] = composeProduction(parts["edit"], parts["script"]), parts["cover"]
	}
	return row, nil
}

// A queued task can finish or retry after a recommendation or one of its parts is retired.
func (s *server) jobProductionTemplate(ctx context.Context, a actor, input object, retiredOpening bool) (object, error) {
	id, version := str(input["templateId"]), str(input["templateVersion"])
	if !strings.HasPrefix(id, "mix:") {
		return s.loadProductionTemplate(ctx, object{"id": id, "version": version}, retiredOpening)
	}
	var raw []byte
	var name string
	err := s.db.QueryRowContext(ctx, `SELECT name,parts FROM keagent_factory_mix WHERE owner_id=$1 AND id=$2 AND version=$3 AND NOT saved`,
		a.UserID, id, version).Scan(&name, &raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fail(409, "任务搭配不存在或不属于当前账号")
	}
	if err != nil {
		return nil, err
	}
	var refs object
	if err = json.Unmarshal(raw, &refs); err != nil {
		return nil, err
	}
	parts, err := resolveBundleParts(ctx, s.db, refs, false, nil)
	if err != nil {
		return nil, err
	}
	return object{"id": id, "version": version, "name": name, "parts": refs,
		"production": composeProduction(parts["edit"], parts["script"]), "cover": parts["cover"]}, nil
}
