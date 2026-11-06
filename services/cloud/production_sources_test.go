package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

func expansionFixture() object {
	var data bytes.Buffer
	_ = png.Encode(&data, image.NewRGBA(image.Rect(0, 0, 512, 512)))
	return object{"requestKey": id(), "image": base64.StdEncoding.EncodeToString(data.Bytes()), "prompt": "保留房屋主体，仅向左右延展墙面", "left_scale": 1.5, "right_scale": 1.5}
}
func TestExpansionPayloadAndOfficialOrigin(t *testing.T) {
	input := expansionFixture()
	payload, err := expansionPayload(input)
	if err != nil || payload["model"] != "wanx2.1-imageedit" || obj(payload["input"])["function"] != "expand" || obj(payload["parameters"])["watermark"] != true {
		t.Fatal(payload, err)
	}
	for key, value := range (object{"image": "%%%", "left_scale": 3.0, "prompt": ""}) {
		bad := expansionFixture()
		bad[key] = value
		if _, err = expansionPayload(bad); err == nil {
			t.Fatal("invalid expansion accepted", key)
		}
	}
	for _, base := range []string{"https://evil.example", "http://dashscope.aliyuncs.com", "https://dashscope.aliyuncs.com@evil.example", "https://dashscope.aliyuncs.com/path"} {
		t.Setenv("DASHSCOPE_BASE_URL", base)
		if _, err = dashscopeBase(); err == nil {
			t.Fatal("credential target accepted", base)
		}
	}
	t.Setenv("DASHSCOPE_BASE_URL", "https://workspace.cn-beijing.maas.aliyuncs.com")
	if _, err = dashscopeBase(); err != nil {
		t.Fatal(err)
	}
}
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
func TestExpansionOwnershipIdempotencyAndUnknownSubmission(t *testing.T) {
	s := voiceTestServer(t)
	if _, err := s.db.Exec(productionImageSchema); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DASHSCOPE_API_KEY", "test-dashscope-key")
	t.Setenv("DASHSCOPE_BASE_URL", "")
	calls := 0
	s.sourceHTTP = func(_ context.Context, method, endpoint string, headers http.Header, body []byte, _ int64) ([]byte, error) {
		if headers.Get("Authorization") != "Bearer test-dashscope-key" {
			t.Fatal("missing provider credential")
		}
		if method == "POST" {
			calls++
			if headers.Get("X-DashScope-Async") != "enable" {
				t.Fatal("not asynchronous")
			}
			return []byte(`{"output":{"task_id":"vendor-task-12345678","task_status":"PENDING"}}`), nil
		}
		return []byte(`{"output":{"task_status":"SUCCEEDED","results":[{"url":"https://sample.oss-cn-beijing.aliyuncs.com/result.png"}]}}`), nil
	}
	a, b := actor{UserID: "a"}, actor{UserID: "b"}
	input := expansionFixture()
	first, err := s.productionImage(t.Context(), a, "image-submit", input)
	if err != nil {
		t.Fatal(err)
	}
	repeated, err := s.productionImage(t.Context(), a, "image-submit", input)
	if err != nil || calls != 1 || obj(first)["taskId"] != obj(repeated)["taskId"] {
		t.Fatal("paid request duplicated", err, calls)
	}
	query := object{"requestKey": input["requestKey"]}
	if _, err = s.productionImage(t.Context(), b, "image-query", query); err == nil {
		t.Fatal("cross-owner task read")
	}
	done, err := s.productionImage(t.Context(), a, "image-query", query)
	if err != nil || obj(done)["status"] != "SUCCEEDED" {
		t.Fatal(done, err)
	}
	input["prompt"] = "changed"
	if _, err = s.productionImage(t.Context(), a, "image-submit", input); err == nil {
		t.Fatal("request key rebound")
	}
	unknown := expansionFixture()
	s.sourceHTTP = func(context.Context, string, string, http.Header, []byte, int64) ([]byte, error) {
		calls++
		return nil, errors.New("network outcome unknown")
	}
	_, _ = s.productionImage(t.Context(), a, "image-submit", unknown)
	after := calls
	_, err = s.productionImage(t.Context(), a, "image-submit", unknown)
	if err != nil || calls != after {
		t.Fatal("unknown paid submission repeated", err)
	}
	encoded, _ := json.Marshal([]any{first, done})
	if bytes.Contains(encoded, []byte("test-dashscope-key")) {
		t.Fatal("credential exposed")
	}
}
