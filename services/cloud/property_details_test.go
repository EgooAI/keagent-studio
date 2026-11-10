package main

import (
	"reflect"
	"testing"
)

func TestNormalizePropertyDetails(t *testing.T) {
	got, err := normalizePropertyDetails(object{"floor": " 中层 ", "orientation": " ", "elevator": "无", "vrUrl": "https://example.com/vr", "other": "ignored"})
	want := object{"floor": "中层", "elevator": "无", "vrUrl": "https://example.com/vr"}
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, %v; want %v", got, err, want)
	}
	for _, bad := range []any{nil, []any{}, object{"floor": 18}, object{"elevator": "未知"}, object{"listingStatus": "下架了"}, object{"vrUrl": "javascript:alert(1)"}, object{"listingUrl": "https://user@example.com"}} {
		if _, err := normalizePropertyDetails(bad); err == nil {
			t.Fatalf("accepted invalid details %v", bad)
		}
	}
}
