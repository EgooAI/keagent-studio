package main

import "testing"

func TestCommentAnalysisEvidence(t *testing.T) {
	const original = "想租地铁附近的一居室"
	for _, raw := range []string{
		`{"intent":"rent","evidence":"想买房","draft":"您好"}`,
		`{"intent":"invest","evidence":"一居室","draft":"您好"}`,
		`{"intent":"question","evidence":"","draft":"您好"}`,
		`{"intent":"rent","evidence":"想租","draft":""}`,
		`{"intent":"rent","evidence":"想租","draft":"您好","profile":"other"}`,
	} {
		if _, err := parseCommentAnalysis(original, raw, true); err == nil {
			t.Fatal("accepted invalid model response", raw)
		}
	}
	const response = `{"intent":"rent","evidence":"想租","draft":"您想了解哪一站附近的房源？"}`
	result, err := parseCommentAnalysis(original, response, true)
	if err != nil || result.Intent != "rent" || result.Evidence != "想租" {
		t.Fatalf("expected grounded intent: %+v %v", result, err)
	}
	if result, err = parseCommentAnalysis(original, response, false); err != nil || result.Draft != "" {
		t.Fatal("analysis-only permission must not return an outreach draft")
	}
}
