package main

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestDeletePropertyPreservesHistory(t *testing.T) {
	w := initial("test")
	w["properties"] = []any{object{"id": "keep"}, object{"id": "remove"}}
	obj(w["draft"])["propertyIds"] = []any{"keep", "remove"}
	obj(obj(w["profile"])["defaults"])["propertyIds"] = []any{"remove"}
	w["tasks"] = []any{object{"id": "task", "propertyId": "remove", "propertySnapshot": object{"id": "remove"}}}
	w["batches"] = []any{object{"id": "batch"}}
	w["publishTasks"] = []any{object{"id": "publish"}}
	before := jsonCopy(w).(object)
	if err := deleteProperty(w, "remove"); err != nil {
		t.Fatal(err)
	}
	if find(w["properties"], "remove") != nil || find(w["properties"], "keep") == nil ||
		!reflect.DeepEqual(obj(w["draft"])["propertyIds"], []any{"keep"}) || len(rows(obj(obj(w["profile"])["defaults"])["propertyIds"])) != 0 {
		t.Fatal("listing or selections not removed", w)
	}
	for _, key := range []string{"tasks", "batches", "publishTasks"} {
		if !reflect.DeepEqual(w[key], before[key]) {
			t.Fatal("history changed", key)
		}
	}
	if err, ok := deleteProperty(w, "missing").(fault); !ok || err.status != 404 {
		t.Fatal("missing property accepted")
	}
}

func TestDeletePropertyOwnerIsolation(t *testing.T) {
	s := &server{db: productionTestDB(t)}
	ctx := t.Context()
	a := actor{UserID: "listing-owner"}
	w := initial("owner")
	w["properties"] = []any{object{"id": "owned"}}
	encoded, _ := json.Marshal(w)
	if _, err := s.db.ExecContext(ctx, `INSERT INTO keagent_workspace(owner_id,payload) VALUES($1,$2)`, a.UserID, encoded); err != nil {
		t.Fatal(err)
	}
	if _, err := s.command(ctx, actor{UserID: "another-owner"}, "deleteProperty", []any{"owned"}); err == nil {
		t.Fatal("another owner deleted listing")
	}
	for _, args := range [][]any{nil, {nil}, {""}, {"owned", "extra"}} {
		if _, err := s.command(ctx, a, "deleteProperty", args); err == nil {
			t.Fatal("invalid delete accepted", args)
		}
	}
	if _, err := s.command(ctx, a, "deleteProperty", []any{"owned"}); err != nil {
		t.Fatal(err)
	}
	w, err := s.workspace(ctx, a)
	if err != nil || len(rows(w["properties"])) != 0 {
		t.Fatal("deleted property returned on reload", w, err)
	}
}
