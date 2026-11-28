package main

import (
	"reflect"
	"testing"
)

func TestNormalizePropertyDetails(t *testing.T) {
	got, err := normalizePropertyDetails(object{"floor": " 中层 ", "orientation": " ", "elevator": "无", "vrUrl": "https://example.com/vr", "other": "ignored", "sourceFacts": "交易信息\n房屋年限：满五年", "sourceUnitPrice": "8,387元/平", "floorPlanUrl": "https://ke-image.ljcdn.com/plan.jpg"})
	want := object{"floor": "中层", "elevator": "无", "vrUrl": "https://example.com/vr", "sourceFacts": "交易信息\n房屋年限：满五年", "sourceUnitPrice": "8,387元/平", "floorPlanUrl": "https://ke-image.ljcdn.com/plan.jpg"}
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, %v; want %v", got, err, want)
	}
	for _, bad := range []any{nil, []any{}, object{"floor": 18}, object{"elevator": "未知"}, object{"listingStatus": "下架了"}, object{"vrUrl": "javascript:alert(1)"}, object{"listingUrl": "https://user@example.com"}, object{"floorPlanUrl": "https://ke-image.ljcdn.com.invalid/plan.jpg"}} {
		if _, err := normalizePropertyDetails(bad); err == nil {
			t.Fatalf("accepted invalid details %v", bad)
		}
	}
}
