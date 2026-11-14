package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

type commentTransport func(*http.Request) (*http.Response, error)

func (f commentTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func openCommentResponse(body string) *http.Response {
	return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}
}

func TestOfficialCommentFieldsAndReplyAssociation(t *testing.T) {
	g := &commentGrant{ItemID: "@id+/==", OpenID: "open-a", Fields: []string{"comment_id", "parent_comment_id", "comment_text", "comment_time", "reply_count", "like_count"}, ExpiresAt: time.Now().Add(time.Hour)}
	var calls int
	transport := commentTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		q := r.URL.Query()
		if r.Method != "GET" || r.URL.Host != "open.douyin.com" || q.Get("item_id") != g.ItemID || q.Get("open_id") != "open-a" || r.Header.Get("access-token") != "fixture-token" || q.Has("access-token") {
			t.Fatalf("wrong request metadata")
		}
		list := "[]"
		more := false
		switch calls {
		case 1:
			if !strings.HasSuffix(r.URL.Path, "/list_comment/") || q.Get("cursor") != "0" {
				t.Fatal("wrong root URL")
			}
			list = `[{"comment_id":"@p+/==","content":"first","reply_comment_total":1,"nick_name":"outside grant","create_time":1700000000}]`
			more = true
		case 2:
			if q.Get("cursor") != "19" {
				t.Fatal("cursor lost")
			}
			list = `[{"comment_id":"p2","reply_comment_total":0}]`
		case 3:
			if !strings.HasSuffix(r.URL.Path, "/list_comment_reply/") || q.Get("comment_id") != "@p+/==" || q.Get("cursor") != "0" {
				t.Fatal("wrong reply association")
			}
			list = `[{"comment_id":"r1","content":"reply","digg_count":0}]`
		default:
			t.Fatal("unexpected additional request")
		}
		return openCommentResponse(fmt.Sprintf(`{"err_no":0,"data":{"extra":{"error_code":0},"data":{"has_more":%t,"cursor":19,"list":%s}}}`, more, list)), nil
	})
	b, err := fetchOpenComments(t.Context(), g, "fixture-token", transport)
	if err != nil || b.Coverage != "complete" || len(b.Items) != 3 || calls != 3 {
		t.Fatalf("unexpected page counts: %d, %s, %v", calls, b.Coverage, err)
	}
	root, reply := b.Items[0], b.Items[2]
	if *root.CommentText != "first" || root.CommenterName != nil || root.LikeCount != nil || *root.CommentTime != "2023-11-14T22:13:20Z" || *reply.ParentCommentID != *root.CommentID || *reply.LikeCount != 0 || reply.CommentTime != nil || reply.CommenterProfile != nil {
		t.Fatal("missing fields or parent linkage changed")
	}
}
func TestOfficialCommentSourceLimitsAndFailures(t *testing.T) {
	g := &commentGrant{Fields: allowedCommentFields, ExpiresAt: time.Now().Add(time.Hour)}
	for _, tc := range []struct {
		name, body, code string
		status           int
	}{
		{"missing status", `{"data":{"data":{"list":[],"has_more":false}}}`, "COMMENT_SOURCE_UNAVAILABLE", 200},
		{"missing list", `{"err_no":0,"data":{"data":{"has_more":false}}}`, "COMMENT_SOURCE_UNAVAILABLE", 200},
		{"inner scope denial", `{"err_no":0,"data":{"extra":{"error_code":28001018},"data":{"has_more":false,"list":[]}}}`, "COMMENT_SCOPE_DENIED", 200},
		{"nested subcode failure", `{"err_no":0,"data":{"extra":{"error_code":0,"sub_error_code":28001005},"data":{"has_more":false,"list":[]}}}`, "COMMENT_SOURCE_UNAVAILABLE", 200},
		{"error with empty result", `{"err_no":0,"error_code":28001008,"data":{"data":{"has_more":false,"list":[]}}}`, "COMMENT_REAUTHORIZE", 200},
		{"expired token", `{"err_no":28001008,"err_msg":"secret-response"}`, "COMMENT_REAUTHORIZE", 200},
		{"server outage", `{"err_no":28001005}`, "COMMENT_SOURCE_UNAVAILABLE", 200},
		{"bad cursor", `{"err_no":0,"data":{"data":{"list":[],"has_more":true,"cursor":0}}}`, "COMMENT_SOURCE_UNAVAILABLE", 200},
		{"redirect to external host", "", "COMMENT_SOURCE_UNAVAILABLE", 302},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			_, err := fetchOpenComments(t.Context(), g, "secret-token", commentTransport(func(r *http.Request) (*http.Response, error) {
				calls++
				resp := openCommentResponse(tc.body)
				resp.StatusCode = tc.status
				resp.Header.Set("Location", "https://other.example/")
				return resp, nil
			}))
			var fault interface{ ErrorCode() string }
			if !errors.As(err, &fault) || fault.ErrorCode() != tc.code || calls != 1 || strings.Contains(err.Error(), "secret") {
				t.Fatalf("calls=%d error=%v", calls, err)
			}
		})
	}
	t.Run("request cap is partial", func(t *testing.T) {
		calls := 0
		b, err := fetchOpenComments(t.Context(), g, "token", commentTransport(func(r *http.Request) (*http.Response, error) {
			calls++
			c, _ := strconv.Atoi(r.URL.Query().Get("cursor"))
			return openCommentResponse(fmt.Sprintf(`{"err_no":0,"data":{"data":{"list":[{"comment_id":"%d","reply_comment_total":0}],"has_more":true,"cursor":%d}}}`, calls, c+1)), nil
		}))
		if err != nil || calls != 12 || len(b.Items) != 12 || b.Coverage != "partial" {
			t.Fatalf("cap: %v calls=%d coverage=%s", err, calls, b.Coverage)
		}
	})
}

func TestCommentExportGrantAndScope(t *testing.T) {
	dir := t.TempDir()
	g := commentGrant{OwnerID: "o", DeviceID: "d", AccountID: "a", WorkID: "10013", Kind: "export", Ref: "grant-1", Label: "test", Fields: []string{"comment_id", "comment_text", "like_count", "commenter_profile"}, ExpiresAt: time.Now().Add(time.Hour), RetentionDays: 1, ExportFile: "export.json"}
	write := func(name string, input any) {
		t.Helper()
		b, err := json.Marshal(input)
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(dir, name), b, 0600); err != nil {
			t.Fatal(err)
		}
	}
	config := filepath.Join(dir, "grants.json")
	t.Setenv("KEAGENT_COMMENT_GRANTS_FILE", config)
	write("grants.json", []commentGrant{g})
	grant, err := loadCommentGrant("o", "d", "a", "10013")
	if err != nil || grant == nil {
		t.Fatal(err)
	}
	wrong, err := loadCommentGrant("o", "other", "a", "10013")
	if err != nil || wrong != nil {
		t.Fatal("grant crossed device")
	}
	item := object{"sourceRef": "grant-1", "ownerId": "o", "deviceId": "d", "accountId": "a", "workId": "10013", "snapshotId": "fixture-1", "observedAt": time.Now().UTC(), "coverage": "unknown", "items": []object{{"comment_text": "synthetic", "like_count": 0}}}
	write("export.json", item)
	b, err := readCommentSource(t.Context(), grant)
	if err != nil || len(b.Items) != 1 || b.Items[0].CommentID != nil || *b.Items[0].LikeCount != 0 || b.Coverage != "unknown" {
		t.Fatalf("bad exported batch: %v", err)
	}
	for _, row := range []object{{"access_token": "ignored?"}, {"commenter_name": "out of scope"}, {"like_count": -1}, {"commenter_profile": "https://other.example/user/123"}} {
		item["items"] = []object{row}
		write("export.json", item)
		if _, err = readCommentSource(t.Context(), grant); err == nil {
			t.Fatalf("invalid row accepted")
		}
	}
	item["items"] = []object{}
	item["workId"] = "10014"
	write("export.json", item)
	if _, err = readCommentSource(t.Context(), grant); err == nil {
		t.Fatal("wrong work accepted")
	}
	g.ExportFile = "../input.json"
	write("grants.json", []commentGrant{g})
	if _, err = loadCommentGrant("o", "d", "a", "10013"); err == nil {
		t.Fatal("traversal path accepted")
	}
	g.Revoked = true
	write("grants.json", []commentGrant{g})
	revoked, err := loadCommentGrant("o", "d", "a", "10013")
	if err != nil || revoked == nil {
		t.Fatal("cannot revoke")
	}
	if _, err = readCommentSource(context.Background(), revoked); err == nil {
		t.Fatal("revoked source read")
	}
}
