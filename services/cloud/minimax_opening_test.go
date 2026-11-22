package main

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

func TestMiniMaxResultDownloadHosts(t *testing.T) {
	for _, test := range []struct {
		url   string
		valid bool
	}{
		{"https://algeng-video-infer.oss-cn-shanghai.aliyuncs.com/output.mp4?signature=test", true},
		{"https://cdn.hailuoai.com/output.mp4", true},
		{"https://other-bucket.oss-cn-shanghai.aliyuncs.com/output.mp4", false},
		{"https://algeng-video-infer.oss-cn-shanghai.aliyuncs.com.evil.example/output.mp4", false},
		{"http://algeng-video-infer.oss-cn-shanghai.aliyuncs.com/output.mp4", false},
		{"https://user@algeng-video-infer.oss-cn-shanghai.aliyuncs.com/output.mp4", false},
		{"https://127.0.0.1/output.mp4", false},
	} {
		t.Run(test.url, func(t *testing.T) {
			s := &server{sourceHTTP: func(context.Context, string, string, http.Header, []byte, int64) ([]byte, error) {
				return json.Marshal(object{"task": object{"id": "123", "status": "succeeded", "content": object{"url": test.url}}})
			}}
			result, err := s.minimaxQuery(t.Context(), "123", "test-key")
			if (err == nil) != test.valid {
				t.Fatalf("query acceptance = %v, want %v", err, test.valid)
			}
			if test.valid && result["videoUrl"] != test.url {
				t.Fatal("signed download URL was changed")
			}
		})
	}
}
