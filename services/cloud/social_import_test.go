package main

import (
	"testing"
	"time"
)

func TestDesktopMonitorSourceAndContact(t *testing.T) {
	f := commentFixture(t)
	disableFileGrant(t)
	enableTestAI(t)
	const note = "xhs-507f1f77bcf86cd799439011"
	grant := object{"workId": note, "accountId": f.scope.AccountID, "label": "小红书评论", "retentionDays": 7, "expiresAt": time.Now().UTC().Add(time.Hour)}
	if _, err := collectionCall(f.server, f.actor, "lead/consent/save", grant); err == nil {
		t.Fatal("Douyin account bound to XHS note")
	}
	if _, err := f.db.Exec(`UPDATE keagent_douyin_account SET payload=payload||'{"platform":"xhs"}'::jsonb WHERE id=$1`, f.scope.AccountID); err != nil {
		t.Fatal(err)
	}
	mustCollection(t, f.server, f.actor, "lead/consent/save", grant)
	f.scope.WorkID = note
	profile := "https://www.xiaohongshu.com/user/profile/507f1f77bcf86cd799439012"
	batch := object{"requestKey": id(), "snapshotId": id(), "observedAt": time.Now().UTC(), "coverage": "partial", "items": []object{{"comment_id": "c1", "comment_text": "想看房", "commenter_profile": profile}}}
	if f.call(t, "import", batch)["addedCount"] != float64(1) {
		t.Fatal("missing imported comment")
	}
	batch["requestKey"], batch["snapshotId"] = id(), id()
	batch["observedAt"] = time.Now().UTC()
	if f.call(t, "import", batch)["addedCount"] != float64(0) {
		t.Fatal("duplicate comment on second scan")
	}
	page := f.call(t, "list", nil)
	comment := rows(page["items"])[0].(object)
	if f.call(t, "contact", object{"id": comment["id"]})["profileUrl"] != profile {
		t.Fatal("recipient changed")
	}
	mustCollection(t, f.server, f.actor, "lead/consent/revoke", f.request(nil))
	if _, err := collectionCall(f.server, f.actor, "comments/contact", f.request(object{"id": comment["id"]})); err == nil {
		t.Fatal("contact allowed after revocation")
	}
}
