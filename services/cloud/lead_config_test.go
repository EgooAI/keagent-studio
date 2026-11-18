package main

import (
	"strings"
	"testing"
)

func leadSettingsInput() object {
	return object{
		"criteria": "只找上海购房客户", "maxComments": 80, "concurrency": 2,
		"creatorhubBaseUrl": "http://127.0.0.1:8000", "creatorhubAccountId": "",
	}
}

func TestLeadSettingsDefaultsAndValidation(t *testing.T) {
	f := commentFixture(t)
	if _, err := f.db.Exec(leadSchema); err != nil {
		t.Fatal(err)
	}
	got := mustCollection(t, f.server, f.actor, "lead/settings/get", object{})
	if got["maxComments"] != float64(200) || got["criteria"] != defaultLeadCriteria ||
		got["defaultCriteria"] != defaultLeadCriteria {
		t.Fatal(got)
	}
	hash, _ := got["criteriaHash"].(string)
	if hash != criteriaHash("v1", defaultLeadCriteria) || len(hash) != 64 || strings.Trim(hash, "0123456789abcdef") != "" {
		t.Fatalf("criteriaHash = %q", hash)
	}
	if got["updatedAt"] != nil {
		t.Fatalf("default settings should not have updatedAt: %v", got)
	}

	accountID := id()
	input := leadSettingsInput()
	input["creatorhubAccountId"] = accountID
	saved := mustCollection(t, f.server, f.actor, "lead/settings/save", input)
	if saved["maxComments"] != float64(80) || saved["criteria"] != "只找上海购房客户" ||
		saved["defaultCriteria"] != defaultLeadCriteria {
		t.Fatal(saved)
	}
	if saved["concurrency"] != float64(2) || saved["creatorhubBaseUrl"] != "http://127.0.0.1:8000" || saved["creatorhubAccountId"] != accountID {
		t.Fatal(saved)
	}
	if updated, _ := saved["updatedAt"].(string); updated == "" || strings.HasPrefix(updated, "0001-01-01") {
		t.Fatalf("updatedAt = %v", saved["updatedAt"])
	}
	if saved["criteriaHash"] != criteriaHash(customLeadCriteriaVersion, "只找上海购房客户") {
		t.Fatal(saved)
	}

	other := actor{UserID: f.actor.UserID, DeviceID: id(), SessionID: f.actor.SessionID}
	isolation := mustCollection(t, f.server, other, "lead/settings/get", object{})
	if isolation["maxComments"] != float64(200) || isolation["criteria"] != defaultLeadCriteria {
		t.Fatalf("device isolation broken: %v", isolation)
	}

	for name, mutate := range map[string]func(object){
		"maxComments too small": func(in object) { in["maxComments"] = 0 },
		"maxComments too large": func(in object) { in["maxComments"] = 501 },
		"concurrency too large": func(in object) { in["concurrency"] = 5 },
		"criteria too long":     func(in object) { in["criteria"] = strings.Repeat("词", 8001) },
		"non-loopback base url": func(in object) { in["creatorhubBaseUrl"] = "http://evil.test:8000" },
		"unknown extra field":   func(in object) { in["unexpected"] = "x" },
		"criteria with NUL":     func(in object) { in["criteria"] = "a\u0000b" },
	} {
		in := leadSettingsInput()
		mutate(in)
		_, err := collectionCall(f.server, f.actor, "lead/settings/save", in)
		t.Run(name, func(t *testing.T) { expectExchangeStatus(t, err, 422) })
	}

	blank := leadSettingsInput()
	blank["criteria"] = "   "
	fallback := mustCollection(t, f.server, f.actor, "lead/settings/save", blank)
	if fallback["criteria"] != defaultLeadCriteria || fallback["criteriaHash"] != criteriaHash("v1", defaultLeadCriteria) {
		t.Fatalf("whitespace criteria should fall back to the default: %v", fallback)
	}
}
