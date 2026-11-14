package main

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
)

func TestCollectionTargetCanonicalization(t *testing.T) {
	account := id()
	for _, test := range []struct{ kind, value, want string }{
		{"video", "https://www.douyin.com/user/someone?vid=99999&modal_id=12345", "https://www.douyin.com/video/12345"},
		{"video", "https://www.douyin.com/video/12345?utm=a", "https://www.douyin.com/video/12345"},
		{"creator", "https://www.douyin.com/user/someone/?modal_id=12345", "https://www.douyin.com/user/someone"},
		{"keyword", "  房产  ", "房产"},
		{"video", "https://www.douyin.com/video/12345?modal_id=99876", ""},
		{"video", "https://www.douyin.com/user/x?modal_id=12345&modal_id=12345", ""},
		{"video", "https://broker:secret@www.douyin.com/video/12345", ""},
		{"video", "https://www.douyin.com.evil.test/video/12345", ""},
		{"video", "https://www.douyin.com/user/someone?vid=12345", ""},
		{"keyword", strings.Repeat("词", 101), ""},
	} {
		fields := targetFields{Kind: test.kind, Name: "测试", Value: test.value, AccountID: account}
		err := cleanTarget(&fields)
		if (err != nil) != (test.want == "") || (err == nil && fields.Value != test.want) {
			t.Errorf("kind=%s got=%q err=%v", test.kind, fields.Value, err)
		}
	}
}

func collectionCall(s *server, a actor, op string, input object) (object, error) {
	b, _ := json.Marshal(input)
	v, err := s.collection(context.Background(), a, op, b)
	if err != nil {
		return nil, err
	}
	raw, err := json.Marshal(v)
	var result object
	if err == nil {
		err = json.Unmarshal(raw, &result)
	}
	return result, err
}
func mustCollection(t *testing.T, s *server, a actor, op string, input object) object {
	t.Helper()
	v, err := collectionCall(s, a, op, input)
	if err != nil {
		t.Fatalf("%s: %v", op, err)
	}
	return v
}
func TestCollectionRunDataAndOwnership(t *testing.T) {
	s, a, p := douyinFixture(t)
	if _, err := s.db.Exec(collectionSchema); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(collectionSchema); err != nil {
		t.Fatal(err)
	}
	newDevice := func(who actor) {
		t.Helper()
		_, err := s.db.Exec(`INSERT INTO keagent_device(id,owner_id,session_id,name,platform) VALUES($1,$2,$3,'观察测试','test') ON CONFLICT DO NOTHING`, who.DeviceID, who.UserID, who.SessionID)
		if err != nil {
			t.Fatal(err)
		}
	}
	newDevice(a)
	call := func(op string, input object) object { t.Helper(); return mustCollection(t, s, a, op, input) }
	bad := func(who actor, op string, input object, status int) {
		t.Helper()
		_, err := collectionCall(s, who, op, input)
		expectExchangeStatus(t, err, status)
	}
	targetIn := object{"requestKey": id(), "kind": "video", "value": "https://www.douyin.com/user/creator?modal_id=12345&from=tag", "name": "A", "accountId": p.AccountID}
	target := call("targets/create", targetIn)
	quick := object{"value": targetIn["value"], "accountId": p.AccountID}
	if found := call("targets/resolve-video", quick); found["id"] != target["id"] || found["name"] != target["name"] {
		t.Fatal("quick entry must reuse named target", found)
	}
	if target["value"] != "https://www.douyin.com/video/12345" || target["id"] != call("targets/create", targetIn)["id"] {
		t.Fatal("canonical/idempotent target", target)
	}
	targetIn["name"] = "changed"
	bad(a, "targets/create", targetIn, 409)
	targetIn["requestKey"] = id()
	bad(a, "targets/create", targetIn, 409)
	targetIn["kind"], targetIn["value"] = "keyword", "房产"
	kw := call("targets/create", targetIn)
	bad(a, "runs/create", object{"requestKey": id(), "targetId": kw["id"], "expectedVersion": 1}, 409)
	page := call("targets/list", object{"limit": 1})
	if page["nextCursor"] == nil || rows(call("targets/list", object{"limit": 1, "cursor": page["nextCursor"]})["items"])[0].(map[string]any)["id"] != target["id"] {
		t.Fatal("keyset pagination", page)
	}
	start := object{"targetId": target["id"], "expectedVersion": 1, "requestKey": id()}
	concurrent := func(n int, fn func(int) (object, error)) []object {
		results := make([]object, n)
		var wg sync.WaitGroup
		for i := range n {
			wg.Add(1)
			go func() {
				defer wg.Done()
				v, err := fn(i)
				if err == nil {
					results[i] = v
				}
			}()
		}
		wg.Wait()
		return results
	}
	created := concurrent(4, func(i int) (object, error) { return collectionCall(s, a, "runs/create", start) })
	quickNew := object{"value": videoBase + "55555", "accountId": p.AccountID}
	resolved := concurrent(4, func(i int) (object, error) { return collectionCall(s, a, "targets/resolve-video", quickNew) })
	for _, r := range resolved {
		if r["id"] == nil || r["id"] != resolved[0]["id"] || r["name"] != "作品 55555" {
			t.Fatal("concurrent quick target resolution", resolved)
		}
	}
	call("targets/pause", object{"id": resolved[0]["id"], "expectedVersion": 1})
	if call("targets/resolve-video", quickNew)["state"] != "paused" {
		t.Fatal("quick entry must respect paused target")
	}
	first := created[0]["id"]
	for _, r := range created {
		if first == nil || r["id"] != first || r["state"] != "queued" {
			t.Fatal("duplicate or failed create", created)
		}
	}
	tokens := [2]string{id(), id()}
	claims := concurrent(2, func(i int) (object, error) {
		return collectionCall(s, a, "runs/claim", object{"id": first, "leaseToken": tokens[i]})
	})
	if (claims[0] == nil) == (claims[1] == nil) {
		t.Fatal("expected precisely one valid lease", claims)
	}
	winner := 0
	if claims[0] == nil {
		winner = 1
	}
	bad(a, "runs/heartbeat", object{"id": first, "leaseToken": tokens[1-winner]}, 409)
	token := tokens[winner]
	ctrl := object{"id": first, "leaseToken": token}
	call("runs/claim", ctrl)
	call("runs/heartbeat", ctrl)
	bad(a, "runs/create", object{"targetId": target["id"], "expectedVersion": 1, "requestKey": id()}, 409)
	wrongDevice := a
	wrongDevice.DeviceID = "other-device"
	newDevice(wrongDevice)
	wrongOwner := actor{UserID: "other", DeviceID: "other-owner-device", SessionID: "s"}
	newDevice(wrongOwner)
	for _, other := range []actor{wrongOwner, wrongDevice} {
		bad(other, "targets/get", object{"id": target["id"]}, 404)
		bad(other, "targets/resolve-video", quick, 409)
		bad(other, "runs/get", object{"id": first}, 404)
		bad(other, "runs/cancel", object{"id": first}, 404)
		bad(other, "runs/claim", ctrl, 404)
		bad(other, "targets/create", targetIn, 409)
	}
	if vs := rows(call("videos/list", object{})["items"]); len(vs) != 0 {
		t.Fatal("unverified work listed")
	}
	finish := object{"id": first, "leaseToken": token, "state": "succeeded", "panelStatus": "visible", "verifiedWorkId": "12345", "title": "测试作品", "author": object{"name": "某博主", "url": "https://www.douyin.com/user/creator"}}
	finish["verifiedWorkId"] = "12346"
	bad(a, "runs/finish", finish, 422)
	finish["verifiedWorkId"] = "12345"
	finish["commentText"] = "字段不允许"
	bad(a, "runs/finish", finish, 422)
	delete(finish, "commentText")
	if call("runs/finish", finish)["state"] != "succeeded" || call("runs/finish", finish)["id"] != first {
		t.Fatal("finish was not idempotent")
	}
	if len(rows(call("videos/list", object{})["items"])) != 1 || call("videos/get", object{"id": "12345"})["lastRunId"] != first {
		t.Fatal("verified result/upload inconsistent")
	}
	bad(wrongDevice, "videos/get", object{"id": "12345"}, 404)
	bad(wrongOwner, "videos/get", object{"id": "12345"}, 404)
	start["requestKey"] = id()
	second := call("runs/create", start)["id"]
	ctrl["id"] = second
	call("runs/claim", ctrl)
	pause := object{"id": target["id"], "expectedVersion": 1}
	if call("targets/pause", pause)["canceledRunId"] != second || call("targets/pause", pause)["canceledRunId"] != nil || call("targets/get", object{"id": target["id"]})["canceledRunId"] != nil {
		t.Fatal("pause must notify only for the run canceled by that transaction")
	}
	finish["id"] = second
	if call("runs/finish", finish)["state"] != "canceled" || call("videos/get", object{"id": "12345"})["lastRunId"] != first {
		t.Fatal("late result overwrote cancellation")
	}
	call("targets/resume", object{"id": target["id"], "expectedVersion": 2})
	start["requestKey"], start["expectedVersion"] = id(), 3
	third := call("runs/create", start)["id"]
	ctrl["id"] = third
	call("runs/claim", ctrl)
	if _, err := s.db.Exec(`UPDATE keagent_collection_runs SET expires_at=now()-interval '1 second' WHERE id=$1`, third); err != nil {
		t.Fatal(err)
	}
	if call("runs/heartbeat", ctrl)["state"] != "interrupted" {
		t.Fatal("expired run revived")
	}
	start["requestKey"] = id()
	fourth := call("runs/create", start)["id"]
	ctrl["id"] = fourth
	mustDouyin(t, s, a, "accounts/update", object{"id": p.AccountID, "loginStatus": "expired", "name": "测试"})
	if v := call("runs/claim", ctrl); v["state"] != "blocked" || v["errorCode"] != "LOGIN_REQUIRED" {
		t.Fatal(v)
	}
	call("targets/archive", object{"id": target["id"], "expectedVersion": 3})
	if call("runs/get", object{"id": first})["targetArchived"] != true {
		t.Fatal("archived source missing from history")
	}
	if call("targets/get", object{"id": target["id"]})["state"] != "archived" || len(rows(call("runs/list", object{"targetId": target["id"]})["items"])) < 4 {
		t.Fatal("source history lost")
	}
	bad(a, "targets/resume", object{"id": target["id"], "expectedVersion": 4}, 409)
	if _, err := s.db.Exec(`UPDATE keagent_device SET revoked=TRUE WHERE id=$1`, a.DeviceID); err != nil {
		t.Fatal(err)
	}
	bad(a, "runs/get", object{"id": first}, 403)
}
