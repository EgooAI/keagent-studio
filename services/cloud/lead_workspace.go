package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"
)

type workspaceInput struct {
	AccountID  string `json:"accountId"`
	WorkID     string `json:"workId"`
	Search     string `json:"search"`
	Status     string `json:"status"`
	JobID      string `json:"jobId"`
	AnalysisID string `json:"analysisId"`
	Cursor     string `json:"cursor"`
	Limit      int    `json:"limit"`
}

type workspaceSource struct {
	commentScope
	Title       string `json:"title"`
	SourceState string `json:"sourceState"`
	CanAnalyze  bool   `json:"canAnalyze"`
	CanContact  bool   `json:"canContact"`
	sourceID    string
}

func (s *server) leadWorkspace(ctx context.Context, a actor, op string, body []byte) (any, error) {
	if op == "save-review" {
		return s.saveWorkspaceReview(ctx, a, body)
	}
	var in workspaceInput
	if decodeExchange(body, &in) != nil || (op != "accounts" && !exchangeID.MatchString(in.AccountID)) ||
		(in.WorkID != "" && !validLeadWork(in.WorkID)) || (in.AnalysisID != "" && !exchangeID.MatchString(in.AnalysisID)) ||
		(in.JobID != "" && !exchangeID.MatchString(in.JobID)) || len([]rune(in.Search)) > 200 ||
		strings.ContainsRune(in.Search, 0) || in.Limit < 0 || in.Limit > 200 {
		return nil, collectionInvalid()
	}
	in.Search = strings.TrimSpace(in.Search)
	if in.Limit == 0 {
		in.Limit = 50
	}
	showPermissions := op == "works" || op == "comments" || op == "leads"
	if showPermissions {
		if providerCtx, e := s.activeAI(ctx); e == nil {
			ctx = providerCtx
		}
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err = collectionDevice(ctx, tx, a); err != nil {
		return nil, err
	}
	if op == "accounts" {
		return workspaceAccounts(ctx, tx, a)
	}
	scopes, err := workspaceSources(ctx, tx, a, in, op, showPermissions)
	if err != nil {
		return nil, err
	}
	sourceIDs := []string{}
	for _, w := range scopes {
		if w.sourceID != "" && w.SourceState == "active" {
			sourceIDs = append(sourceIDs, w.sourceID)
		}
	}
	switch op {
	case "works":
		return workspaceWorks(ctx, tx, in, scopes, sourceIDs)
	case "overview":
		return workspaceOverview(ctx, tx, sourceIDs)
	case "comments", "leads", "jobs", "outreach":
		return workspaceRows(ctx, tx, op, in, scopes, sourceIDs)
	default:
		return nil, collectionMissing()
	}
}

func workspaceAccounts(ctx context.Context, tx *sql.Tx, a actor) (any, error) {
	rows, err := tx.QueryContext(ctx, `WITH existing AS (
 SELECT account_id,work_id FROM keagent_comment_consents WHERE owner_id=$1 AND device_id=$2
 UNION SELECT account_id,work_id FROM keagent_comment_sources WHERE owner_id=$1 AND device_id=$2
 UNION SELECT payload->>'accountId',payload->>'verifiedWorkId' FROM keagent_collection_runs
 WHERE owner_id=$1 AND device_id=$2 AND payload->>'source' IN ('creatorhub','electron') AND observed_at IS NOT NULL)
 SELECT e.account_id,coalesce(nullif(b.payload->>'name',''),'历史账号 '||right(e.account_id,6)),
 coalesce(b.payload->>'platform', CASE WHEN bool_and(e.work_id LIKE 'xhs-%') THEN 'xhs' ELSE 'douyin' END)
 FROM existing e LEFT JOIN keagent_douyin_account b ON b.id=e.account_id AND b.owner_id=$1 AND b.device_id=$2
 GROUP BY e.account_id,b.payload ORDER BY 2,1`, a.UserID, a.DeviceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []object{}
	for rows.Next() {
		var account, name, platform string
		if err = rows.Scan(&account, &name, &platform); err != nil {
			return nil, err
		}
		items = append(items, object{"id": account, "nickname": name, "platform": platform})
	}
	return object{"items": items}, rows.Err()
}

// Resolve file and database permissions in the same priority order as comments/list.
// Looking at history must never renew a grant, synchronize comments or mutate its source.
func workspaceSources(ctx context.Context, tx *sql.Tx, a actor, in workspaceInput, op string, showPermissions bool) (map[string]workspaceSource, error) {
	rs, err := tx.QueryContext(ctx, `WITH works AS (
 SELECT work_id FROM keagent_comment_consents WHERE owner_id=$1 AND device_id=$2 AND account_id=$3
 UNION SELECT work_id FROM keagent_comment_sources WHERE owner_id=$1 AND device_id=$2 AND account_id=$3
 UNION SELECT payload->>'verifiedWorkId' FROM keagent_collection_runs WHERE $6::boolean
 AND owner_id=$1 AND device_id=$2 AND payload->>'accountId'=$3 AND observed_at IS NOT NULL
 AND payload->>'source' IN ('creatorhub','electron'))
 SELECT w.work_id,coalesce(nullif(r.payload->>'title',''),nullif(r.payload->>'targetName',''),w.work_id),
 coalesce(s.id,''),coalesce(s.policy_key,''),coalesce(s.denied,false),
 coalesce(c.label,''),coalesce(c.base_url,''),coalesce(c.creatorhub_account_id,''),coalesce(c.ai_endpoint,''),
 c.purposes,c.expires_at,coalesce(c.retention_days,0),coalesce(c.revoked,false)
 FROM works w LEFT JOIN keagent_comment_sources s ON s.owner_id=$1 AND s.device_id=$2 AND s.account_id=$3 AND s.work_id=w.work_id
 LEFT JOIN keagent_comment_consents c ON c.owner_id=$1 AND c.device_id=$2 AND c.account_id=$3 AND c.work_id=w.work_id
 LEFT JOIN LATERAL (SELECT payload FROM keagent_collection_runs WHERE $5::boolean AND owner_id=$1 AND device_id=$2
 AND payload->>'accountId'=$3 AND payload->>'verifiedWorkId'=w.work_id AND observed_at IS NOT NULL
 ORDER BY (coalesce(payload->>'source','') NOT IN ('electron','creatorhub')) DESC,observed_at DESC,seq DESC LIMIT 1) r ON true
 WHERE $4='' OR w.work_id=$4`, a.UserID, a.DeviceID, in.AccountID, in.WorkID, op != "overview" && (op != "outreach" || in.Search != ""), op == "works")
	if err != nil {
		return nil, err
	}
	defer rs.Close()
	scopes := map[string]workspaceSource{}
	for rs.Next() {
		w := workspaceSource{commentScope: commentScope{AccountID: in.AccountID}, SourceState: "unconfigured"}
		var source, key, label, base, creator, endpoint string
		var denied, revoked bool
		var expires sql.NullTime
		var purposes []byte
		var retention int
		if err = rs.Scan(&w.WorkID, &w.Title, &source, &key, &denied, &label, &base, &creator, &endpoint, &purposes, &expires, &retention, &revoked); err != nil {
			return nil, err
		}
		g, e := loadCommentGrant(a.UserID, a.DeviceID, in.AccountID, w.WorkID)
		if e != nil {
			return nil, e
		}
		if g == nil && expires.Valid {
			g = consentGrant(a, w.commentScope, label, base, creator, endpoint, purposes, expires.Time, retention, revoked)
		}
		switch {
		case g == nil:
		case g.Revoked || denied:
			w.SourceState = "revoked"
		case !g.ExpiresAt.After(time.Now()):
			w.SourceState = "expired"
		default:
			w.SourceState = "active"
			w.CanAnalyze = showPermissions && commentAnalysisAllowed(ctx, g)
			w.CanContact = g.ManualContact
			if source != "" && key == g.policyKey() {
				w.sourceID = source
			}
		}
		scopes[w.WorkID] = w
	}
	return scopes, rs.Err()
}

const workspacePending = `(t.id IS NULL OR t.status IN ('failed','canceled')) AND NOT a.review_skipped`
const workspaceUncertain = `(t.status='uncertain' OR (t.method='browser' AND t.status IN ('sent','submitted','sending')))`
const workspaceFromLeads = ` FROM keagent_comment_analyses a JOIN keagent_comment_observations o ON o.id=a.comment_row_id
 LEFT JOIN keagent_outreach_tasks t ON t.analysis_id=a.id
 WHERE a.source_id=ANY($1::text[]) AND o.retain_until>current_timestamp AND a.qualified AND a.status='done'`

func workspaceOverview(ctx context.Context, tx *sql.Tx, sourceIDs []string) (any, error) {
	var pending, missing, uncertain int
	err := tx.QueryRowContext(ctx, `SELECT count(*) FILTER (WHERE `+workspacePending+`),
 count(*) FILTER (WHERE `+workspacePending+` AND trim(coalesce(a.manual_draft,a.draft))=''),
 count(*) FILTER (WHERE `+workspaceUncertain+`)`+workspaceFromLeads, sourceIDs).Scan(&pending, &missing, &uncertain)
	return object{"pending": pending, "missingDraft": missing, "uncertain": uncertain}, err
}

func workspaceWorks(ctx context.Context, tx *sql.Tx, in workspaceInput, scopes map[string]workspaceSource, sourceIDs []string) (any, error) {
	type work struct {
		workspaceSource
		LastSyncedAt *time.Time `json:"lastSyncedAt,omitempty"`
		ReadCount    int        `json:"readCount"`
		AddedCount   int        `json:"addedCount"`
		CommentCount int        `json:"commentCount"`
	}
	works := map[string]*work{}
	for id, scope := range scopes {
		works[id] = &work{workspaceSource: scope}
	}
	rs, err := tx.QueryContext(ctx, `SELECT s.work_id,p.result,count(o.id) FROM keagent_comment_sources s
 LEFT JOIN LATERAL (SELECT result FROM keagent_comment_snapshots WHERE source_id=s.id AND retain_until>current_timestamp
 ORDER BY observed_at DESC LIMIT 1) p ON true
 LEFT JOIN keagent_comment_observations o ON o.source_id=s.id AND o.retain_until>current_timestamp
 WHERE s.id=ANY($1::text[]) GROUP BY s.id,p.result`, sourceIDs)
	if err != nil {
		return nil, err
	}
	defer rs.Close()
	for rs.Next() {
		var id string
		var raw []byte
		var n int
		if err = rs.Scan(&id, &raw, &n); err != nil {
			return nil, err
		}
		w := works[id]
		w.CommentCount = n
		if raw != nil {
			var last commentSyncResult
			if err = json.Unmarshal(raw, &last); err != nil {
				return nil, err
			}
			w.LastSyncedAt = &last.SyncedAt
			w.ReadCount = last.ReadCount
			w.AddedCount = last.AddedCount
		}
	}
	if err = rs.Err(); err != nil {
		return nil, err
	}
	list := []*work{}
	for _, w := range works {
		if in.Search == "" || strings.Contains(strings.ToLower(w.Title+" "+w.WorkID), strings.ToLower(in.Search)) {
			list = append(list, w)
		}
	}
	date := func(w *work) time.Time {
		if w.LastSyncedAt == nil {
			return time.Time{}
		}
		return *w.LastSyncedAt
	}
	slices.SortFunc(list, func(l, r *work) int {
		if cmp := date(r).Compare(date(l)); cmp != 0 {
			return cmp
		}
		return strings.Compare(r.WorkID, l.WorkID)
	})
	if in.Cursor != "" {
		ts, id, ok := strings.Cut(in.Cursor, "|")
		at, e := time.Parse(time.RFC3339Nano, ts)
		if !ok || e != nil || !validLeadWork(id) {
			return nil, collectionInvalid()
		}
		for len(list) > 0 && (date(list[0]).After(at) || (date(list[0]).Equal(at) && list[0].WorkID >= id)) {
			list = list[1:]
		}
	}
	result := object{"items": list}
	if len(list) > in.Limit {
		last := list[in.Limit-1]
		result["items"] = list[:in.Limit]
		result["nextCursor"] = analysisCursor(date(last), last.WorkID)
	}
	return result, nil
}

// All four lists use a stable (creation time, row ID) cursor. Filters are evaluated
// in PostgreSQL before the limit, including searches across older jobs and works.
func workspaceRows(ctx context.Context, tx *sql.Tx, op string, in workspaceInput, scopes map[string]workspaceSource, sourceIDs []string) (any, error) {
	args := []any{sourceIDs}
	bind := func(value any) string { args = append(args, value); return "$" + strconv.Itoa(len(args)) }
	const outreachJSON = `jsonb_build_object('id',t.id,'analysisId',t.analysis_id,'accountId',t.account_id,'workId',t.work_id,
 'draft',t.draft,'status',t.status,'creatorhubTaskId',t.creatorhub_task_id,'method',t.method,'error',t.error,
 'attempt',t.attempts,'requestKey',t.request_key,'createdAt',t.created_at,'updatedAt',t.updated_at,'submittedAt',t.submitted_at,
 'finishedAt',t.finished_at,'commenterName',coalesce(o.fields->>'commenter_name',''))`
	reviewState := `CASE WHEN t.id IS NOT NULL AND t.status NOT IN ('failed','canceled') THEN 'queued' WHEN a.review_skipped THEN 'skipped' ELSE 'pending' END`
	var value, from, work, date, row, search string
	switch op {
	case "comments":
		value = `o.fields || jsonb_build_object('id',o.id,'firstSeenAt',o.first_seen_at,'lastSeenAt',o.last_seen_at,'updatedAt',o.updated_at)`
		from = ` FROM keagent_comment_observations o JOIN keagent_comment_sources s ON o.source_id=s.id
  WHERE o.source_id=ANY($1::text[]) AND o.retain_until>current_timestamp`
		work, date, row, search = "s.work_id", "o.first_seen_at", "o.id", `concat_ws(' ',o.fields->>'comment_text',o.fields->>'commenter_name',o.fields->>'comment_id')`
	case "leads":
		value = `jsonb_build_object('id',a.id,'jobId',a.job_id,'commentRowId',a.comment_row_id,'commentId',a.comment_id,
  'intent',a.intent,'evidence',a.evidence,'qualified',a.qualified,'reason',a.reason,'draft',a.draft,
  'manualDraft',a.manual_draft,'draftError',a.draft_error,'status',a.status,'error',a.error,
  'commentText',coalesce(o.fields->>'comment_text',''),'commenterName',coalesce(o.fields->>'commenter_name',''),
  'commenterProfile',o.fields->'commenter_profile','likeCount',o.fields->'like_count','commentTime',o.fields->'comment_time',
  'reviewStatus',` + reviewState + `) || CASE WHEN t.id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('outreachStatus',t.status,'outreach',` + outreachJSON + `) END`
		from = workspaceFromLeads
		switch in.Status {
		case "", "all":
		case "pending":
			from += " AND " + workspacePending
		case "missingDraft":
			from += " AND " + workspacePending + ` AND trim(coalesce(a.manual_draft,a.draft))=''`
		case "queued", "skipped":
			from += " AND (" + reviewState + ")=" + bind(in.Status)
		default:
			return nil, collectionInvalid()
		}
		if in.JobID != "" {
			from += " AND a.job_id=" + bind(in.JobID)
		}
		if in.AnalysisID != "" {
			from += " AND a.id=" + bind(in.AnalysisID)
		}
		work, date, row, search = "a.work_id", "a.created_at", "a.id", `concat_ws(' ',o.fields->>'commenter_name',o.fields->>'comment_text',a.reason,a.intent)`
	case "jobs":
		value = `jsonb_build_object('id',j.id,'accountId',j.account_id,'workId',j.work_id,'status',j.status,'total',j.total,
  'processed',j.processed,'qualified',j.qualified,'failed',j.failed,'error',j.error,'criteriaHash',j.criteria_hash,
  'criteriaVersion',j.criteria_version,'criteria',j.criteria,'createdAt',j.created_at)`
		from = ` FROM keagent_comment_analysis_jobs j WHERE j.source_id=ANY($1::text[])`
		if in.Status != "" && in.Status != "all" {
			from += " AND j.status=" + bind(in.Status)
		}
		if in.JobID != "" {
			from += " AND j.id=" + bind(in.JobID)
		}
		work, date, row, search = "j.work_id", "j.created_at", "j.id", "j.criteria"
	case "outreach":
		value = outreachJSON
		from = ` FROM keagent_outreach_tasks t JOIN keagent_comment_analyses a ON t.analysis_id=a.id
  JOIN keagent_comment_observations o ON o.id=a.comment_row_id
  WHERE a.source_id=ANY($1::text[]) AND o.retain_until>current_timestamp`
		if in.Status == "uncertain" {
			from += " AND " + workspaceUncertain
		} else if in.Status != "" && in.Status != "all" {
			from += " AND t.status=" + bind(in.Status)
		}
		if in.AnalysisID != "" {
			from += " AND t.analysis_id=" + bind(in.AnalysisID)
		}
		work, date, row, search = "t.work_id", "t.created_at", "t.id", `concat_ws(' ',o.fields->>'commenter_name',t.draft,t.error)`
	}
	if in.Search != "" {
		p := bind(in.Search)
		from += " AND (strpos(lower(" + search + "),lower(" + p + "))>0"
		matching := []string{}
		for id, scope := range scopes {
			if strings.Contains(strings.ToLower(scope.Title+" "+id), strings.ToLower(in.Search)) {
				matching = append(matching, id)
			}
		}
		from += " OR " + work + "=ANY(" + bind(matching) + "::text[]))"
	}
	if in.Cursor != "" {
		at, id, ok := parseAnalysisCursor(in.Cursor)
		if !ok {
			return nil, collectionInvalid()
		}
		from += " AND (" + date + "," + row + ")<(" + bind(at) + "," + bind(id) + ")"
	}
	q := fmt.Sprintf("SELECT %s,%s,%s,%s%s ORDER BY %s DESC,%s DESC LIMIT %s", value, work, date, row, from, date, row, bind(in.Limit+1))
	rs, err := tx.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rs.Close()
	items := []object{}
	var lastCursor string
	for rs.Next() {
		if len(items) == in.Limit {
			return object{"items": items, "nextCursor": lastCursor}, rs.Err()
		}
		var id, w string
		var at time.Time
		var raw []byte
		var v object
		if err = rs.Scan(&raw, &w, &at, &id); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(raw, &v); err != nil {
			return nil, err
		}
		scope := scopes[w]
		v["workId"] = w
		v["accountId"] = scope.AccountID
		v["title"] = scope.Title
		if op == "leads" || op == "comments" {
			v["sourceState"] = scope.SourceState
			v["canAnalyze"] = scope.CanAnalyze
			v["canContact"] = scope.CanContact
		}
		items = append(items, v)
		lastCursor = analysisCursor(at, id)
	}
	return object{"items": items}, rs.Err()
}

func (s *server) saveWorkspaceReview(ctx context.Context, a actor, body []byte) (any, error) {
	var in struct {
		AnalysisID string          `json:"analysisId"`
		Draft      json.RawMessage `json:"draft"`
		Skipped    *bool           `json:"skipped"`
	}
	if decodeExchange(body, &in) != nil || !exchangeID.MatchString(in.AnalysisID) || (in.Skipped == nil && len(in.Draft) == 0) {
		return nil, collectionInvalid()
	}
	var draft *string
	if len(in.Draft) > 0 && (json.Unmarshal(in.Draft, &draft) != nil || (draft != nil && (len([]rune(*draft)) > 320 || strings.ContainsRune(*draft, 0)))) {
		return nil, collectionInvalid()
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err = collectionDevice(ctx, tx, a); err != nil {
		return nil, err
	}
	var scope commentScope
	var source string
	err = tx.QueryRowContext(ctx, `SELECT a.account_id,a.work_id,a.source_id FROM keagent_comment_analyses a JOIN keagent_comment_observations o ON o.id=a.comment_row_id
 WHERE a.id=$1 AND a.owner_id=$2 AND a.device_id=$3 AND a.status='done' AND a.qualified AND o.retain_until>current_timestamp FOR UPDATE OF a`, in.AnalysisID, a.UserID, a.DeviceID).Scan(&scope.AccountID, &scope.WorkID, &source)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, collectionMissing()
	}
	if err != nil {
		return nil, err
	}
	g, state, current, err := prepareCommentSource(ctx, tx, a, scope)
	if err != nil {
		return nil, err
	}
	if state != "active" {
		return nil, unavailableCommentGrant(state)
	}
	if current != source {
		return nil, exchangeFail(409, "COMMENT_GRANT_CHANGED", "来源授权已更新，请刷新后查看线索")
	}
	if draft != nil && !g.ManualContact {
		return nil, exchangeFail(403, "COMMENT_PURPOSE_DENIED", "来源未授权人工联系")
	}
	result, err := tx.ExecContext(ctx, `UPDATE keagent_comment_analyses a SET manual_draft=CASE WHEN $2 THEN $3 ELSE manual_draft END,
 review_skipped=coalesce($4,review_skipped)
 WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM keagent_outreach_tasks t WHERE t.analysis_id=a.id AND t.status NOT IN('failed','canceled'))`, in.AnalysisID, len(in.Draft) > 0, draft, in.Skipped)
	if err != nil {
		return nil, err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return nil, exchangeFail(409, "OUTREACH_EXISTS", "该线索已加入队列，请查看任务记录")
	}
	return object{"ok": true}, tx.Commit()
}
