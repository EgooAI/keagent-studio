package main

import "testing"

func TestLeadSettingsDefaultsAndValidation(t *testing.T) {
	f := commentFixture(t)
	if _, err := f.db.Exec(leadSchema); err != nil {
		t.Fatal(err)
	}
	got := mustCollection(t, f.server, f.actor, "lead/settings/get", object{})
	if got["maxComments"] != float64(200) || got["criteria"] != defaultLeadCriteria {
		t.Fatal(got)
	}
	saved := mustCollection(t, f.server, f.actor, "lead/settings/save", object{
		"criteria": "只找上海购房客户", "maxComments": 80, "concurrency": 2,
		"creatorhubBaseUrl": "http://127.0.0.1:8000", "creatorhubAccountId": id(),
	})
	if saved["maxComments"] != float64(80) || saved["criteria"] != "只找上海购房客户" {
		t.Fatal(saved)
	}
	if _, err := collectionCall(f.server, f.actor, "lead/settings/save", object{
		"criteria": "x", "maxComments": 0, "concurrency": 2,
		"creatorhubBaseUrl": "https://evil.test", "creatorhubAccountId": "",
	}); err == nil {
		t.Fatal("non-loopback base url accepted")
	}
}
