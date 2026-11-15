package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// The grant file is managed outside the application by the operator who verified the authorization.
type commentGrant struct {
	OwnerID       string    `json:"ownerId"`
	DeviceID      string    `json:"deviceId"`
	AccountID     string    `json:"accountId"`
	WorkID        string    `json:"workId"`
	Ref           string    `json:"ref"`
	Label         string    `json:"label"`
	Kind          string    `json:"kind"`
	ExpiresAt     time.Time `json:"expiresAt"`
	RetentionDays int       `json:"retentionDays"`
	Revoked       bool      `json:"revoked"`
	Fields        []string  `json:"fields"`
	AnalyzeWithAI bool      `json:"analyzeWithAI,omitempty"`
	AIEndpoint    string    `json:"aiEndpoint,omitempty"`
	ManualContact bool      `json:"manualContact,omitempty"`
	ExportFile    string    `json:"exportFile,omitempty"`
	OpenID        string    `json:"openId,omitempty"`
	ItemID        string    `json:"itemId,omitempty"`
	TokenEnv      string    `json:"tokenEnv,omitempty"`
	// PolicyKey lets a consent-backed grant carry an identity-only key that survives
	// expiry refreshes. File grants leave it empty and keep their full-grant hash.
	PolicyKey string `json:"-"`
	directory string
}

var commentTokenEnv = regexp.MustCompile(`^KEAGENT_DOUYIN_COMMENT_TOKEN_[A-Z0-9_]{1,64}$`)
var allowedCommentFields = []string{"comment_text", "commenter_name", "commenter_profile", "comment_time", "like_count", "reply_count", "comment_id", "parent_comment_id"}

func (g *commentGrant) policyKey() string {
	if g.PolicyKey != "" {
		return g.PolicyKey
	}
	return exchangeFingerprint(g)
}

func sourceInvalid() error {
	return exchangeFail(422, "COMMENT_SOURCE_INVALID", "评论来源配置或数据与授权不匹配，请核对来源文件")
}
func sourceUnavailable() error {
	return exchangeFail(503, "COMMENT_SOURCE_UNAVAILABLE", "评论来源暂不可用，请检查服务配置后重试")
}

func strictCommentJSON(r io.Reader, out any, limit int64) error {
	data, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil || int64(len(data)) > limit || !utf8.Valid(data) {
		return sourceInvalid()
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if d.Decode(out) != nil || d.Decode(new(any)) != io.EOF {
		return sourceInvalid()
	}
	return nil
}

func loadCommentGrant(owner, device, account, work string) (*commentGrant, error) {
	config := os.Getenv("KEAGENT_COMMENT_GRANTS_FILE")
	if config == "" {
		return nil, nil
	}
	if !filepath.IsAbs(config) {
		return nil, sourceInvalid()
	}
	fi, e := os.Stat(config)
	if e != nil || !fi.Mode().IsRegular() {
		return nil, sourceUnavailable()
	}
	f, e := os.Open(config)
	if e != nil {
		return nil, sourceUnavailable()
	}
	defer f.Close()
	var grants []commentGrant
	if err := strictCommentJSON(f, &grants, 1<<20); err != nil || grants == nil {
		return nil, sourceInvalid()
	}
	var match *commentGrant
	for i := range grants {
		g := &grants[i]
		if owner != g.OwnerID || device != g.DeviceID || account != g.AccountID || work != g.WorkID {
			continue
		}
		if match != nil || !sourceTaskID.MatchString(g.Ref) || !validExchangeText(g.Label, 100) || g.ExpiresAt.IsZero() || g.RetentionDays <= 0 {
			return nil, sourceInvalid()
		}
		match = g
		g.directory = filepath.Dir(config)
		if g.Revoked || !g.ExpiresAt.After(time.Now()) {
			continue
		}
		if len(g.Fields) == 0 || len(g.Fields) > len(allowedCommentFields) {
			return nil, sourceInvalid()
		}
		slices.Sort(g.Fields)
		for j, field := range g.Fields {
			if !slices.Contains(allowedCommentFields, field) || (j > 0 && g.Fields[j-1] == field) {
				return nil, sourceInvalid()
			}
		}
		if g.AnalyzeWithAI {
			endpoint, err := url.Parse(g.AIEndpoint)
			if !slices.Contains(g.Fields, "comment_text") || err != nil || endpoint.Scheme != "https" || endpoint.Hostname() == "" || endpoint.User != nil || endpoint.ForceQuery || endpoint.RawQuery != "" || endpoint.Fragment != "" {
				return nil, sourceInvalid()
			}
		}
		switch g.Kind {
		case "export":
			if !filepath.IsLocal(g.ExportFile) || filepath.Base(g.ExportFile) != g.ExportFile || g.ExportFile == "." || g.OpenID != "" || g.ItemID != "" || g.TokenEnv != "" {
				return nil, sourceInvalid()
			}
		case "douyin_miniapp":
			if !validExchangeText(g.OpenID, 256) || !validExchangeText(g.ItemID, 1024) || !commentTokenEnv.MatchString(g.TokenEnv) || g.ExportFile != "" {
				return nil, sourceInvalid()
			}
		default:
			return nil, sourceInvalid()
		}
	}
	return match, nil
}

func readCommentSource(ctx context.Context, g *commentGrant) (commentBatch, error) {
	if g == nil {
		return commentBatch{}, exchangeFail(403, "COMMENT_GRANT_REQUIRED", "该作品尚未配置评论来源")
	}
	if g.Revoked {
		return commentBatch{}, exchangeFail(403, "COMMENT_GRANT_REVOKED", "该作品的评论授权已撤回")
	}
	if !g.ExpiresAt.After(time.Now()) {
		return commentBatch{}, exchangeFail(403, "COMMENT_GRANT_EXPIRED", "该作品的评论授权已到期")
	}
	if err := ctx.Err(); err != nil {
		return commentBatch{}, err
	}
	if g.Kind == "export" {
		return readCommentExport(g)
	}
	if g.Kind != "douyin_miniapp" {
		return commentBatch{}, sourceInvalid()
	}
	token := os.Getenv(g.TokenEnv)
	if strings.TrimSpace(token) == "" {
		return commentBatch{}, exchangeFail(409, "COMMENT_REAUTHORIZE", "请配置该来源的开放平台授权令牌")
	}
	ctx, cancel := context.WithTimeout(ctx, 40*time.Second)
	defer cancel()
	ctx, cancelExpiry := context.WithDeadline(ctx, g.ExpiresAt)
	defer cancelExpiry()
	return fetchOpenComments(ctx, g, token, http.DefaultTransport)
}

func readCommentExport(g *commentGrant) (commentBatch, error) {
	var batch commentBatch
	root, err := os.OpenRoot(g.directory)
	if err != nil {
		return batch, sourceUnavailable()
	}
	defer root.Close()
	fi, err := root.Stat(g.ExportFile)
	if err != nil || !fi.Mode().IsRegular() {
		return batch, sourceUnavailable()
	}
	f, err := root.Open(g.ExportFile)
	if err != nil {
		return batch, sourceUnavailable()
	}
	defer f.Close()
	var in struct {
		SourceRef  string          `json:"sourceRef"`
		OwnerID    string          `json:"ownerId"`
		DeviceID   string          `json:"deviceId"`
		AccountID  string          `json:"accountId"`
		WorkID     string          `json:"workId"`
		SnapshotID string          `json:"snapshotId"`
		ObservedAt time.Time       `json:"observedAt"`
		Coverage   string          `json:"coverage"`
		Items      []commentFields `json:"items"`
	}
	if err = strictCommentJSON(f, &in, 2<<20); err != nil {
		return batch, err
	}
	if in.SourceRef != g.Ref || in.OwnerID != g.OwnerID || in.DeviceID != g.DeviceID || in.AccountID != g.AccountID || in.WorkID != g.WorkID || !sourceTaskID.MatchString(in.SnapshotID) || in.ObservedAt.IsZero() || in.ObservedAt.After(time.Now().Add(time.Minute)) || in.Items == nil || len(in.Items) > 1000 || !slices.Contains([]string{"complete", "partial", "unknown"}, in.Coverage) {
		return batch, sourceInvalid()
	}
	for i := range in.Items {
		fields := &in.Items[i]
		if !validCommentFields(fields) {
			return batch, sourceInvalid()
		}
		// Exports must already have been minimized to the fields the grant permits.
		if projectCommentFields(*fields, g.Fields) != *fields {
			return batch, sourceInvalid()
		}
	}
	return commentBatch{SnapshotID: in.SnapshotID, ObservedAt: in.ObservedAt.UTC(), Coverage: in.Coverage, Items: in.Items}, nil
}

func projectCommentFields(f commentFields, fields []string) commentFields {
	if !slices.Contains(fields, "comment_id") {
		f.CommentID = nil
	}
	if !slices.Contains(fields, "parent_comment_id") {
		f.ParentCommentID = nil
	}
	if !slices.Contains(fields, "comment_text") {
		f.CommentText = nil
	}
	if !slices.Contains(fields, "commenter_name") {
		f.CommenterName = nil
	}
	if !slices.Contains(fields, "commenter_profile") {
		f.CommenterProfile = nil
	}
	if !slices.Contains(fields, "comment_time") {
		f.CommentTime = nil
	}
	if !slices.Contains(fields, "like_count") {
		f.LikeCount = nil
	}
	if !slices.Contains(fields, "reply_count") {
		f.ReplyCount = nil
	}
	return f
}

func validCommentFields(f *commentFields) bool { return validPlatformCommentFields(f, false) }

var xhsProfile = regexp.MustCompile(`^/user/profile/[0-9a-f]{24}$`)

func validPlatformCommentFields(f *commentFields, xhs bool) bool {
	for _, p := range []struct {
		v     *string
		limit int
	}{{f.CommentID, 1024}, {f.ParentCommentID, 1024}, {f.CommentText, 8192}, {f.CommenterName, 256}} {
		if p.v != nil && (utf8.RuneCountInString(*p.v) > p.limit || strings.ContainsRune(*p.v, 0)) {
			return false
		}
	}
	if (f.CommentID != nil && strings.TrimSpace(*f.CommentID) == "") || (f.ParentCommentID != nil && strings.TrimSpace(*f.ParentCommentID) == "") || (f.ParentCommentID != nil && f.CommentID != nil && *f.ParentCommentID == *f.CommentID) {
		return false
	}
	if f.CommenterProfile != nil {
		u, err := url.Parse(*f.CommenterProfile)
		if err != nil || u.Scheme != "https" || u.User != nil || u.RawPath != "" || u.RawQuery != "" || u.Fragment != "" || len(*f.CommenterProfile) > 2048 || (xhs && (u.Host != "www.xiaohongshu.com" || !xhsProfile.MatchString(u.Path))) || (!xhs && (u.Host != "www.douyin.com" || !collectionCreatorPath.MatchString(u.Path))) {
			return false
		}
	}
	if f.CommentTime != nil {
		if _, err := time.Parse(time.RFC3339Nano, *f.CommentTime); err != nil {
			return false
		}
	}
	const maxExactCount = 1<<53 - 1 // Counters are also consumed by JavaScript.
	return (f.LikeCount == nil || (*f.LikeCount >= 0 && *f.LikeCount <= maxExactCount)) &&
		(f.ReplyCount == nil || (*f.ReplyCount >= 0 && *f.ReplyCount <= maxExactCount))
}

type openComment struct {
	ID      *string `json:"comment_id"`
	Text    *string `json:"content"`
	Name    *string `json:"nick_name"`
	Time    *int64  `json:"create_time"`
	Likes   *int64  `json:"digg_count"`
	Replies *int64  `json:"reply_comment_total"`
}
type openCommentPage struct {
	List   *[]openComment `json:"list"`
	More   *bool          `json:"has_more"`
	Cursor *int64         `json:"cursor"`
	Code   *int           `json:"error_code"`
}

func officialCommentPage(ctx context.Context, client *http.Client, g *commentGrant, token string, parent *string, cursor int64, count int) (openCommentPage, error) {
	var page openCommentPage
	endpoint := "https://open.douyin.com/api/apps/v1/item/list_comment/"
	q := url.Values{"item_id": {g.ItemID}, "open_id": {g.OpenID}, "count": {strconv.Itoa(count)}, "cursor": {strconv.FormatInt(cursor, 10)}, "sort_type": {"time"}}
	if parent != nil {
		endpoint = "https://open.douyin.com/api/apps/v1/item/list_comment_reply/"
		q.Set("comment_id", *parent)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint+"?"+q.Encode(), nil)
	if err != nil {
		return page, sourceInvalid()
	}
	req.Header.Set("access-token", token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return page, sourceUnavailable()
	}
	defer resp.Body.Close()
	if resp.StatusCode == 401 {
		return page, exchangeFail(403, "COMMENT_REAUTHORIZE", "开放平台要求重新核对该账号的授权")
	}
	if resp.StatusCode == 403 {
		return page, exchangeFail(403, "COMMENT_SCOPE_DENIED", "开放平台未允许该应用读取此作品的评论")
	}
	if resp.StatusCode != http.StatusOK {
		return page, sourceUnavailable()
	}
	var envelope struct {
		ErrNo *int `json:"err_no"`
		Code  *int `json:"error_code"`
		Data  *struct {
			Data  *openCommentPage `json:"data"`
			Code  *int             `json:"error_code"`
			Extra *struct {
				Code    *int `json:"error_code"`
				SubCode *int `json:"sub_error_code"`
			} `json:"extra"`
		} `json:"data"`
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, (1<<20)+1))
	if err != nil || len(data) > 1<<20 || !utf8.Valid(data) || json.Unmarshal(data, &envelope) != nil || envelope.ErrNo == nil {
		return page, sourceUnavailable()
	}
	codes := []*int{envelope.ErrNo, envelope.Code}
	if nested := envelope.Data; nested != nil {
		codes = append(codes, nested.Code)
		if nested.Data != nil {
			codes = append(codes, nested.Data.Code)
		}
		if nested.Extra != nil {
			codes = append(codes, nested.Extra.Code, nested.Extra.SubCode)
		}
	}
	var failed bool
	for _, code := range codes {
		if code == nil || *code == 0 {
			continue
		}
		switch *code {
		case 28001003, 28001008:
			return page, exchangeFail(403, "COMMENT_REAUTHORIZE", "开放平台令牌无效或过期，请重新授权")
		case 28001014, 28001016, 28001018, 28001019:
			return page, exchangeFail(403, "COMMENT_SCOPE_DENIED", "开放平台未允许该应用读取此作品的评论")
		default:
			failed = true
		}
	}
	if failed || envelope.Data == nil || envelope.Data.Data == nil || envelope.Data.Data.List == nil || envelope.Data.Data.More == nil {
		return page, sourceUnavailable()
	}
	page = *envelope.Data.Data
	if len(*page.List) > count || (*page.More && (page.Cursor == nil || *page.Cursor < 0)) {
		return openCommentPage{}, sourceUnavailable()
	}
	return page, nil
}

func fetchOpenComments(ctx context.Context, g *commentGrant, token string, transport http.RoundTripper) (commentBatch, error) {
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect refused") }}
	batch := commentBatch{SnapshotID: id(), ObservedAt: time.Now().UTC(), Coverage: "complete", Items: []commentFields{}}
	const maxRequests, maxItems = 12, 200
	var roots []openComment
	requests := 0
	scan := func(parent *string) (int, error) {
		cursor := int64(0)
		seen := map[int64]bool{}
		count := 0
		for requests < maxRequests && len(batch.Items) < maxItems {
			seen[cursor] = true
			requests++
			page, err := officialCommentPage(ctx, client, g, token, parent, cursor, min(50, maxItems-len(batch.Items)))
			if err != nil {
				return 0, err
			}
			for _, raw := range *page.List {
				fields := commentFields{CommentID: raw.ID, ParentCommentID: parent, CommentText: raw.Text, CommenterName: raw.Name, LikeCount: raw.Likes, ReplyCount: raw.Replies}
				if fields.CommentID != nil && *fields.CommentID == "" {
					fields.CommentID = nil
				}
				if raw.Time != nil {
					if *raw.Time < 0 || *raw.Time > 253402300799 {
						return 0, sourceInvalid()
					}
					iso := time.Unix(*raw.Time, 0).UTC().Format(time.RFC3339)
					fields.CommentTime = &iso
				}
				if !validCommentFields(&fields) {
					return 0, sourceInvalid()
				}
				batch.Items = append(batch.Items, projectCommentFields(fields, g.Fields))
				count++
				if parent == nil {
					roots = append(roots, raw)
				} else if raw.Replies != nil && *raw.Replies > 0 {
					batch.Coverage = "partial"
				}
			}
			if !*page.More {
				return count, nil
			}
			if seen[*page.Cursor] {
				return 0, sourceUnavailable()
			}
			cursor = *page.Cursor
		}
		batch.Coverage = "partial"
		return count, nil
	}
	if _, err := scan(nil); err != nil {
		return commentBatch{}, err
	}
	checked := map[string]bool{}
	for _, root := range roots {
		if root.Replies != nil && *root.Replies == 0 {
			continue
		}
		if !slices.Contains(g.Fields, "parent_comment_id") || root.ID == nil || *root.ID == "" {
			batch.Coverage = "partial"
			continue
		}
		if checked[*root.ID] {
			continue
		}
		checked[*root.ID] = true
		count, err := scan(root.ID)
		if err != nil {
			return commentBatch{}, err
		}
		if root.Replies != nil && int64(count) < *root.Replies {
			batch.Coverage = "partial"
		}
	}
	return batch, nil
}
