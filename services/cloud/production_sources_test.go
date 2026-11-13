package main

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

func TestBeikeAdapterUsesDocumentedInterfacesAndPreservesUnknownFacts(t *testing.T) {
	t.Setenv("BEIKE_ACCESS_TOKEN", "test-beike-token")
	s := &server{}
	calls := 0
	s.sourceHTTP = func(_ context.Context, method, endpoint string, headers http.Header, body []byte, _ int64) ([]byte, error) {
		calls++
		values, _ := url.ParseQuery(string(body))
		if method != "POST" || headers.Get("access_token") != "test-beike-token" || values.Get("cityName") != "北京市" {
			t.Fatal("incorrect Beike request")
		}
		if strings.HasSuffix(endpoint, "/houseInfo") {
			return []byte(`{"code":0,"data":{"resblockName":"测试小区","houseInfo":{"frame":"3室1厅","frameArea":"55.771","roomList":[{"name":"卧室A","area":"11.51","direction":"南"}]}}}`), nil
		}
		if endpoint != "https://gw-open.ke.com/api/images-distinguish/distinguish" || values.Get("type") != "2" {
			t.Fatal("undocumented image endpoint")
		}
		return []byte(`{"code":0,"data":{"prospect":{"room":["https://p.ljcdn.com/a.jpg"],"parlor":["https://p.ljcdn.com/b.jpg"]}}}`), nil
	}
	result, err := s.fetchBeike(t.Context(), object{"cityName": "北京市", "district": "测试区", "address": "已授权地址"})
	if err != nil || calls != 2 {
		t.Fatal(result, err)
	}
	property := obj(result["property"])
	if property["areaSqm"] != 0 || property["priceCents"] != 0 {
		t.Fatal("invented gross area or asking price", property)
	}
	images := result["images"].([]object)
	for _, asset := range images {
		if asset["description"] != "" {
			t.Fatal("bedroom facts assigned by photo order", asset)
		}
	}
	if result["panoramaAvailability"] != "not_exposed_by_this_interface" {
		t.Fatal("invented panorama availability")
	}
	if _, err = decodeBeike([]byte(`{"data":{}}`)); err == nil {
		t.Fatal("missing provider success code accepted")
	}
}
func TestExpansionRemoved(t *testing.T) {
	s := &server{sourceHTTP: func(context.Context, string, string, http.Header, []byte, int64) ([]byte, error) {
		t.Fatal("removed expansion called a provider")
		return nil, nil
	}}
	for _, operation := range []string{"image-submit", "image-query"} {
		_, err := s.panorama(t.Context(), actor{UserID: "a"}, operation, []byte(`{}`))
		if err == nil || !strings.Contains(err.Error(), "已移除") {
			t.Fatalf("%s: %v", operation, err)
		}
	}
	if _, ok := specFor("expansion"); ok {
		t.Fatal("removed expansion is still configurable")
	}
}
