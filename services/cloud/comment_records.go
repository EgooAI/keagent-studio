package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
	"time"
)

const commentSchema = `
CREATE TABLE IF NOT EXISTS keagent_comment_sources (
 id text PRIMARY KEY, owner_id text NOT NULL, device_id text NOT NULL, account_id text NOT NULL, work_id text NOT NULL,
 policy_key text NOT NULL, expires_at timestamptz NOT NULL, denied boolean NOT NULL DEFAULT false,
 UNIQUE(owner_id,device_id,account_id,work_id));
CREATE INDEX IF NOT EXISTS keagent_comment_source_expiry ON keagent_comment_sources(expires_at);
CREATE TABLE IF NOT EXISTS keagent_comment_observations (
 id text PRIMARY KEY, seq bigserial UNIQUE NOT NULL, source_id text NOT NULL REFERENCES keagent_comment_sources ON DELETE CASCADE,
 row_key text NOT NULL, fields jsonb NOT NULL, first_seen_at timestamptz NOT NULL, last_seen_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL, retain_until timestamptz NOT NULL, UNIQUE(source_id,row_key));
CREATE INDEX IF NOT EXISTS keagent_comment_page ON keagent_comment_observations(source_id,seq DESC);
CREATE INDEX IF NOT EXISTS keagent_comment_retention ON keagent_comment_observations(retain_until);
CREATE TABLE IF NOT EXISTS keagent_comment_snapshots (
 source_id text NOT NULL REFERENCES keagent_comment_sources ON DELETE CASCADE, snapshot_id text NOT NULL,
 fingerprint text NOT NULL, observed_at timestamptz NOT NULL, retain_until timestamptz NOT NULL, result jsonb NOT NULL,
 PRIMARY KEY(source_id,snapshot_id));
CREATE INDEX IF NOT EXISTS keagent_comment_latest ON keagent_comment_snapshots(source_id,observed_at DESC);
CREATE INDEX IF NOT EXISTS keagent_snapshot_retention ON keagent_comment_snapshots(retain_until);
CREATE TABLE IF NOT EXISTS keagent_comment_requests (
 source_id text NOT NULL, request_key text NOT NULL, snapshot_id text NOT NULL, result jsonb NOT NULL,
 PRIMARY KEY(source_id, request_key), FOREIGN KEY(source_id,snapshot_id)
 REFERENCES keagent_comment_snapshots(source_id,snapshot_id) ON DELETE CASCADE);
`

// Absent provider values stay null, including counts. A local row id is never a platform id.
type commentFields struct {
	CommentID        *string `json:"comment_id"`
	ParentCommentID  *string `json:"parent_comment_id"`
	CommentText      *string `json:"comment_text"`
	CommenterName    *string `json:"commenter_name"`
	CommenterProfile *string `json:"commenter_profile"`
	CommentTime      *string `json:"comment_time"`
	LikeCount        *int64  `json:"like_count"`
	ReplyCount       *int64  `json:"reply_count"`
	Truncated        bool    `json:"truncated"`
}
type commentBatch struct {
	SnapshotID string
	ObservedAt time.Time
	Coverage   string
	Items      []commentFields
}
type commentScope struct {
	AccountID string `json:"accountId"`
	WorkID    string `json:"workId"`
}
type commentDetail struct {
	commentScope
	commentFields
	ID          string    `json:"id"`
	FirstSeenAt time.Time `json:"firstSeenAt"`
	LastSeenAt  time.Time `json:"lastSeenAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}
type commentPage struct {
	Items        []commentDetail `json:"items"`
	NextCursor   string          `json:"nextCursor,omitempty"`
	SourceState  string          `json:"sourceState"`
	SourceLabel  string          `json:"sourceLabel,omitempty"`
	CanAnalyze   bool            `json:"canAnalyze"`
	CanContact   bool            `json:"canContact"`
	Coverage     string          `json:"coverage"`
	LastSyncedAt *time.Time      `json:"lastSyncedAt,omitempty"`
}
type commentSyncResult struct {
	Coverage     string    `json:"coverage"`
	ReadCount    int       `json:"readCount"`
	AddedCount   int       `json:"addedCount"`
	UpdatedCount int       `json:"updatedCount"`
	SyncedAt     time.Time `json:"syncedAt"`
}

type commentInput struct {
	commentScope
	ID         string
	Cursor     int64
	Limit      int
	RequestKey string
}

func parseCommentInput(op string, body []byte) (commentInput, error) {
	var in commentInput
	switch op {
	case "comments/list":
		var req struct {
			commentScope
			Cursor string `json:"cursor"`
			Limit  int    `json:"limit"`
		}
		if decodeExchange(body, &req) != nil || req.Limit < 0 || req.Limit > 100 {
			return in, collectionInvalid()
		}
		in.commentScope, in.Limit = req.commentScope, req.Limit
		if in.Limit == 0 {
			in.Limit = 30
		}
		if req.Cursor != "" {
			n, err := strconv.ParseInt(req.Cursor, 10, 64)
			if err != nil || n <= 0 {
				return in, collectionInvalid()
			}
			in.Cursor = n
		}
	case "comments/get":
		var req struct {
			commentScope
			ID string `json:"id"`
		}
		if decodeExchange(body, &req) != nil || !exchangeID.MatchString(req.ID) {
			return in, collectionInvalid()
		}
		in.commentScope, in.ID = req.commentScope, req.ID
	case "comments/sync":
		var req struct {
			commentScope
			RequestKey string `json:"requestKey"`
		}
		if decodeExchange(body, &req) != nil || !exchangeKey.MatchString(req.RequestKey) {
			return in, collectionInvalid()
		}
		in.commentScope, in.RequestKey = req.commentScope, req.RequestKey
	default:
		return in, collectionMissing()
	}
	if !exchangeID.MatchString(in.AccountID) || !douyinPostID.MatchString(in.WorkID) {
		return in, collectionInvalid()
	}
	return in, nil
}

func lockCommentScope(ctx context.Context, tx *sql.Tx, a actor, scope commentScope) error {
	_, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
		commentScopeKey(a, scope))
	return err
}

func commentScopeKey(a actor, scope commentScope) string {
	return "comments:" + exchangeFingerprint([]string{a.UserID, a.DeviceID, scope.AccountID, scope.WorkID})
}

// Only syncs for the same work wait for one another. A retry looks up its committed receipt
// before contacting the provider. List, detail and revocation can proceed during provider I/O.
func (s *server) waitCommentSync(ctx context.Context, a actor, scope commentScope) (func(), error) {
	key := commentScopeKey(a, scope)
	ch := make(chan struct{})
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		active, loaded := s.commentSyncs.LoadOrStore(key, ch)
		if !loaded {
			return func() { s.commentSyncs.Delete(key); close(ch) }, nil
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-active.(chan struct{}):
		}
	}
}

func commitCommentMiss(tx *sql.Tx, err error) error {
	var e exchangeFault
	if errors.As(err, &e) && e.code == "NOT_FOUND" {
		// A missing row after grant rotation is expected; keep the successful cleanup transaction.
		if commitErr := tx.Commit(); commitErr != nil {
			return commitErr
		}
	}
	return err
}

func verifyCommentScope(ctx context.Context, tx *sql.Tx, a actor, scope commentScope) error {
	if err := collectionDevice(ctx, tx, a); err != nil {
		return err
	}
	state, err := accountStatus(ctx, tx, a, scope.AccountID)
	if err != nil {
		return err
	}
	if state == "" {
		return collectionMissing()
	}
	var verified bool
	err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM keagent_monitored_videos v
	JOIN keagent_collection_runs r ON r.owner_id=v.owner_id AND r.payload->>'verifiedWorkId'=v.work_id
	WHERE v.owner_id=$1 AND r.device_id=$2 AND r.payload->>'accountId'=$3 AND v.work_id=$4 AND r.observed_at IS NOT NULL)`,
		a.UserID, a.DeviceID, scope.AccountID, scope.WorkID).Scan(&verified)
	if err == nil && !verified {
		return collectionMissing()
	}
	return err
}

// This short transaction consults the local grant file, never the remote provider or export.
func prepareCommentSource(ctx context.Context, tx *sql.Tx, a actor, scope commentScope) (*commentGrant, string, string, error) {
	g, err := loadCommentGrant(a.UserID, a.DeviceID, scope.AccountID, scope.WorkID)
	if err != nil {
		return nil, "", "", err
	}
	state, key := "active", ""
	switch {
	case g == nil:
		state = "unconfigured"
	case g.Revoked:
		state = "revoked"
	case !g.ExpiresAt.After(time.Now()):
		state = "expired"
	default:
		key = g.policyKey()
	}
	// The source id changes across grant lifetimes. Cascades erase old rows and request receipts.
	if _, err = tx.ExecContext(ctx, `DELETE FROM keagent_comment_sources WHERE owner_id=$1 AND device_id=$2 AND account_id=$3 AND work_id=$4 AND (policy_key<>$5 OR expires_at<=clock_timestamp())`,
		a.UserID, a.DeviceID, scope.AccountID, scope.WorkID, key); err != nil {
		return nil, "", "", err
	}
	if state != "active" {
		return g, state, "", nil
	}
	var sourceID string
	var denied bool
	err = tx.QueryRowContext(ctx, `SELECT id,denied FROM keagent_comment_sources WHERE owner_id=$1 AND device_id=$2 AND account_id=$3 AND work_id=$4`,
		a.UserID, a.DeviceID, scope.AccountID, scope.WorkID).Scan(&sourceID, &denied)
	if errors.Is(err, sql.ErrNoRows) {
		err = nil
	}
	if denied {
		return g, "revoked", sourceID, nil
	}
	if err == nil && sourceID != "" {
		if _, err = tx.ExecContext(ctx, `DELETE FROM keagent_comment_observations WHERE source_id=$1 AND retain_until<=clock_timestamp()`, sourceID); err == nil {
			_, err = tx.ExecContext(ctx, `DELETE FROM keagent_comment_snapshots WHERE source_id=$1 AND retain_until<=clock_timestamp()`, sourceID)
		}
	}
	return g, state, sourceID, err
}

func unavailableCommentGrant(state string) error {
	switch state {
	case "revoked":
		return exchangeFail(403, "COMMENT_GRANT_REVOKED", "该作品的数据授权已撤回")
	case "expired":
		return exchangeFail(403, "COMMENT_GRANT_EXPIRED", "该作品的数据授权已过期")
	default:
		return exchangeFail(409, "COMMENT_SOURCE_UNCONFIGURED", "该账号与作品尚未配置获准评论来源")
	}
}

// Recheck binding, policy and receipt after source I/O. Only short DB operations hold the scope lock.
func (s *server) commentRecords(ctx context.Context, a actor, op string, body []byte) (any, error) {
	in, err := parseCommentInput(op, body)
	if err != nil {
		return nil, err
	}
	if op == "comments/sync" {
		release, err := s.waitCommentSync(ctx, a, in.commentScope)
		if err != nil {
			return nil, err
		}
		defer release()
	}
	var batch *commentBatch
	var expectedPolicy, expectedSource string
	for {
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return nil, err
		}
		// Rollback is a no-op after Commit, including the first pass of a sync.
		defer tx.Rollback()
		if err = lockCommentScope(ctx, tx, a, in.commentScope); err != nil {
			return nil, err
		}
		if err = verifyCommentScope(ctx, tx, a, in.commentScope); err != nil {
			return nil, err
		}
		g, state, sourceID, err := prepareCommentSource(ctx, tx, a, in.commentScope)
		if err != nil {
			return nil, err
		}
		if state != "active" {
			if err = tx.Commit(); err != nil {
				return nil, err
			}
			if op == "comments/list" {
				return commentPage{Items: []commentDetail{}, Coverage: "unknown", SourceState: state}, nil
			}
			return nil, unavailableCommentGrant(state)
		}
		if expectedPolicy != "" && (expectedPolicy != g.policyKey() || expectedSource != sourceID) {
			if err = tx.Commit(); err != nil {
				return nil, err
			}
			return nil, exchangeFail(409, "COMMENT_GRANT_CHANGED", "授权范围已变化，请重新同步")
		}
		var result any
		switch op {
		case "comments/list":
			result, err = readCommentPage(ctx, tx, in, sourceID, g)
		case "comments/get":
			result, err = readCommentDetail(ctx, tx, in, sourceID)
			if err != nil {
				return nil, commitCommentMiss(tx, err)
			}
		case "comments/sync":
			var receipt json.RawMessage
			err = tx.QueryRowContext(ctx, `SELECT result FROM keagent_comment_requests WHERE source_id=$1 AND request_key=$2`, sourceID, in.RequestKey).Scan(&receipt)
			if err == nil {
				result = receipt
				break
			}
			if !errors.Is(err, sql.ErrNoRows) {
				return nil, err
			}
			if batch != nil {
				result, err = applyCommentBatch(ctx, tx, in, g, sourceID, *batch)
				break
			}
			if sourceID == "" {
				sourceID, err = insertCommentSource(ctx, tx, a, in.commentScope, g, false)
				if err != nil {
					return nil, err
				}
			}
			expectedPolicy, expectedSource = g.policyKey(), sourceID
			if err = tx.Commit(); err != nil {
				return nil, err
			}
			read := s.commentRead
			if read == nil {
				read = readCommentSource
			}
			fetched, err := read(ctx, g)
			if err != nil {
				var f exchangeFault
				if errors.As(err, &f) && (f.code == "COMMENT_SCOPE_DENIED" || f.code == "COMMENT_REAUTHORIZE") {
					// A client closing the window cannot undo a denial the provider has already reported.
					cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
					revokeErr := s.invalidateCommentSource(cleanup, a, in.commentScope, expectedSource, g, f.code == "COMMENT_SCOPE_DENIED")
					cancel()
					if revokeErr != nil {
						return nil, revokeErr
					}
				}
				return nil, err
			}
			batch = &fetched
			continue
		}
		if err != nil {
			return nil, err
		}
		if err = recheckCommentGrant(a, in.commentScope, g); err != nil {
			return nil, err
		}
		return result, tx.Commit()
	}
}

func (s *server) invalidateCommentSource(ctx context.Context, a actor, scope commentScope, expected string, g *commentGrant, denied bool) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = lockCommentScope(ctx, tx, a, scope); err != nil {
		return err
	}
	// The generation came from the checked first transaction. A stale response must not erase
	// a newer grant. The next read reconciles this marker with the current operator configuration.
	r, err := tx.ExecContext(ctx, `DELETE FROM keagent_comment_sources WHERE id=$1 AND policy_key=$2`, expected, g.policyKey())
	if err != nil {
		return err
	}
	n, err := r.RowsAffected()
	if err != nil {
		return err
	}
	if n != 0 {
		if _, err = insertCommentSource(ctx, tx, a, scope, g, denied); err != nil {
			return err
		}
	}
	return tx.Commit()
}

const commentColumns = `seq,id,fields,first_seen_at,last_seen_at,updated_at`

func scanComment(row interface{ Scan(...any) error }, scope commentScope) (commentDetail, int64, error) {
	d := commentDetail{commentScope: scope}
	var seq int64
	var raw []byte
	err := row.Scan(&seq, &d.ID, &raw, &d.FirstSeenAt, &d.LastSeenAt, &d.UpdatedAt)
	if err == nil {
		err = json.Unmarshal(raw, &d.commentFields)
	}
	return d, seq, err
}
func readCommentDetail(ctx context.Context, tx *sql.Tx, in commentInput, sourceID string) (commentDetail, error) {
	d, _, err := scanComment(tx.QueryRowContext(ctx, `SELECT `+commentColumns+` FROM keagent_comment_observations WHERE source_id=$1 AND id=$2 AND retain_until>clock_timestamp()`, sourceID, in.ID), in.commentScope)
	if errors.Is(err, sql.ErrNoRows) {
		err = collectionMissing()
	}
	return d, err
}
func readCommentPage(ctx context.Context, tx *sql.Tx, in commentInput, sourceID string, g *commentGrant) (commentPage, error) {
	page := commentPage{Items: []commentDetail{}, SourceState: "active", SourceLabel: g.Label, Coverage: "unknown", CanAnalyze: g.AnalyzeWithAI, CanContact: g.ManualContact}
	var raw []byte
	err := tx.QueryRowContext(ctx, `SELECT result FROM keagent_comment_snapshots WHERE source_id=$1 AND retain_until>clock_timestamp() ORDER BY observed_at DESC LIMIT 1`, sourceID).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return page, nil
	}
	if err != nil {
		return page, err
	}
	var last commentSyncResult
	if err = json.Unmarshal(raw, &last); err != nil {
		return page, err
	}
	page.Coverage, page.LastSyncedAt = last.Coverage, &last.SyncedAt
	rs, err := tx.QueryContext(ctx, `SELECT `+commentColumns+` FROM keagent_comment_observations WHERE source_id=$1 AND ($2::bigint=0 OR seq<$2)
	 AND retain_until>clock_timestamp() ORDER BY seq DESC LIMIT $3`, sourceID, in.Cursor, in.Limit+1)
	if err != nil {
		return page, err
	}
	defer rs.Close()
	var lastSeq int64
	for rs.Next() {
		d, seq, err := scanComment(rs, in.commentScope)
		if err != nil {
			return page, err
		}
		if len(page.Items) == in.Limit {
			page.NextCursor = strconv.FormatInt(lastSeq, 10)
			break
		}
		lastSeq = seq
		page.Items = append(page.Items, d)
	}
	return page, rs.Err()
}

func insertCommentSource(ctx context.Context, tx *sql.Tx, a actor, scope commentScope, g *commentGrant, denied bool) (string, error) {
	sourceID := id()
	_, err := tx.ExecContext(ctx, `INSERT INTO keagent_comment_sources(id,owner_id,device_id,account_id,work_id,policy_key,expires_at,denied) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
		sourceID, a.UserID, a.DeviceID, scope.AccountID, scope.WorkID, g.policyKey(), g.ExpiresAt, denied)
	return sourceID, err
}
func recheckCommentGrant(a actor, scope commentScope, expected *commentGrant) error {
	current, err := loadCommentGrant(a.UserID, a.DeviceID, scope.AccountID, scope.WorkID)
	if err != nil {
		return err
	}
	if current == nil {
		return unavailableCommentGrant("unconfigured")
	}
	if current.Revoked {
		return unavailableCommentGrant("revoked")
	}
	if !current.ExpiresAt.After(time.Now()) {
		return unavailableCommentGrant("expired")
	}
	if current.policyKey() != expected.policyKey() {
		return exchangeFail(409, "COMMENT_GRANT_CHANGED", "授权范围已变化，请重新同步")
	}
	return nil
}

func applyCommentBatch(ctx context.Context, tx *sql.Tx, in commentInput, g *commentGrant, sourceID string, b commentBatch) (commentSyncResult, error) {
	var result commentSyncResult
	digest := exchangeFingerprint(b)
	observed := b.ObservedAt.UTC().Truncate(time.Microsecond)
	until := g.ExpiresAt
	if g.RetentionDays < 1 || observed.IsZero() {
		return result, sourceInvalid()
	}
	// Cap even excessively large day values at the actual grant lifetime, without overflowing a duration.
	daysToExpiry := int64((until.Unix()-observed.Unix())/86400) + 2
	if int64(g.RetentionDays) < daysToExpiry {
		windowEnd := observed.AddDate(0, 0, g.RetentionDays)
		if windowEnd.Before(until) {
			until = windowEnd
		}
	}
	if !until.After(time.Now()) {
		return result, exchangeFail(409, "COMMENT_RETENTION_EXPIRED", "来源观察时间已超出允许保留期限")
	}
	var savedHash string
	var saved []byte
	err := tx.QueryRowContext(ctx, `SELECT fingerprint,result FROM keagent_comment_snapshots WHERE source_id=$1 AND snapshot_id=$2`, sourceID, b.SnapshotID).Scan(&savedHash, &saved)
	switch {
	case err == nil:
		if savedHash != digest {
			return result, exchangeFail(409, "COMMENT_SNAPSHOT_CONFLICT", "同一快照标识对应了不同内容")
		}
		if err = json.Unmarshal(saved, &result); err != nil {
			return result, err
		}
		result.AddedCount, result.UpdatedCount = 0, 0
	case !errors.Is(err, sql.ErrNoRows):
		return result, err
	default:
		var outOfOrder bool
		if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM keagent_comment_snapshots WHERE source_id=$1 AND observed_at>=$2)`, sourceID, observed).Scan(&outOfOrder); err != nil {
			return result, err
		}
		if outOfOrder {
			return result, exchangeFail(409, "COMMENT_STALE_SNAPSHOT", "已有相同或更新观察时间的其他快照，请核对来源版本")
		}
		result = commentSyncResult{Coverage: b.Coverage, ReadCount: len(b.Items), SyncedAt: time.Now().UTC()}
		result.AddedCount, result.UpdatedCount, err = mergeCommentRows(ctx, tx, sourceID, b.SnapshotID, b.Items, observed, until)
		if err != nil {
			return result, err
		}
		raw, _ := json.Marshal(result)
		if _, err = tx.ExecContext(ctx, `INSERT INTO keagent_comment_snapshots(source_id,snapshot_id,fingerprint,observed_at,retain_until,result) VALUES($1,$2,$3,$4,$5,$6)`,
			sourceID, b.SnapshotID, digest, observed, until, raw); err != nil {
			return result, err
		}
	}
	raw, _ := json.Marshal(result)
	_, err = tx.ExecContext(ctx, `INSERT INTO keagent_comment_requests(source_id,request_key,snapshot_id,result) VALUES($1,$2,$3,$4)`, sourceID, in.RequestKey, b.SnapshotID, raw)
	return result, err
}

func mergeCommentRows(ctx context.Context, tx *sql.Tx, sourceID, snapshot string, items []commentFields, observed, until time.Time) (int, int, error) {
	type incoming struct {
		ID     string        `json:"id"`
		Key    string        `json:"key"`
		Fields commentFields `json:"fields"`
	}
	entries := make([]incoming, 0, len(items))
	seen := make(map[string]string, len(items))
	for index, fields := range items {
		key := "obs:" + exchangeFingerprint([]string{snapshot, strconv.Itoa(index)})
		if fields.CommentID != nil {
			key = "id:" + exchangeFingerprint(*fields.CommentID)
		}
		hash := exchangeFingerprint(fields)
		if previous, ok := seen[key]; ok {
			if previous != hash {
				return 0, 0, exchangeFail(409, "COMMENT_ID_CONFLICT", "同一快照内的相同评论标识存在冲突")
			}
			continue
		}
		seen[key] = hash
		entries = append(entries, incoming{id(), key, fields})
	}
	raw, _ := json.Marshal(entries)
	// Preserve a previously confirmed parent when a later projection omits it; reject a contradictory parent.
	// Missing comments in a bounded snapshot are not evidence of deletion.
	var added, updated, conflicts int
	err := tx.QueryRowContext(ctx, `WITH incoming AS (
		SELECT * FROM jsonb_to_recordset($2::jsonb) AS x(id text,key text,fields jsonb)
	), reconciled AS MATERIALIZED (
		SELECT i.id,i.key,o.id IS NULL AS is_new,o.fields AS previous,
			CASE WHEN i.fields->>'parent_comment_id' IS NULL AND o.fields->>'parent_comment_id' IS NOT NULL
			     THEN jsonb_set(i.fields,'{parent_comment_id}',o.fields->'parent_comment_id') ELSE i.fields END AS fields,
			(o.fields->>'parent_comment_id')<>(i.fields->>'parent_comment_id') AS conflict
		FROM incoming i LEFT JOIN keagent_comment_observations o ON o.source_id=$1 AND o.row_key=i.key
	), write_rows AS (
		INSERT INTO keagent_comment_observations AS old(id,source_id,row_key,fields,first_seen_at,last_seen_at,updated_at,retain_until)
		SELECT id,$1,key,fields,$3,$3,$3,$4 FROM reconciled
		ON CONFLICT(source_id,row_key) DO UPDATE SET fields=EXCLUDED.fields,last_seen_at=EXCLUDED.last_seen_at,
		updated_at=CASE WHEN old.fields<>EXCLUDED.fields THEN EXCLUDED.updated_at ELSE old.updated_at END,
		retain_until=EXCLUDED.retain_until RETURNING id
	)
	SELECT count(*) FILTER (WHERE is_new),count(*) FILTER (WHERE NOT is_new AND previous<>fields),
	count(*) FILTER (WHERE conflict) FROM reconciled`, sourceID, raw, observed, until).Scan(&added, &updated, &conflicts)
	if err == nil && conflicts > 0 {
		return 0, 0, exchangeFail(409, "COMMENT_PARENT_CONFLICT", "来源变更了已核验的回复归属，请核对来源")
	}
	return added, updated, err
}

// Load a single row only for an explicitly granted use, with the same checks as the list/detail API.
func (s *server) authorizedComment(ctx context.Context, a actor, in commentInput, purpose string) (commentDetail, *commentGrant, error) {
	var zero commentDetail
	if !exchangeID.MatchString(in.ID) || !exchangeID.MatchString(in.AccountID) || !douyinPostID.MatchString(in.WorkID) {
		return zero, nil, collectionInvalid()
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return zero, nil, err
	}
	defer tx.Rollback()
	if err = lockCommentScope(ctx, tx, a, in.commentScope); err != nil {
		return zero, nil, err
	}
	if err = verifyCommentScope(ctx, tx, a, in.commentScope); err != nil {
		return zero, nil, err
	}
	g, state, sourceID, err := prepareCommentSource(ctx, tx, a, in.commentScope)
	if err != nil {
		return zero, nil, err
	}
	if state != "active" {
		if err = tx.Commit(); err != nil {
			return zero, nil, err
		}
		return zero, nil, unavailableCommentGrant(state)
	}
	if !(purpose == "analyze" && g.AnalyzeWithAI || purpose == "contact" && g.ManualContact) {
		if err = tx.Commit(); err != nil {
			return zero, nil, err
		}
		return zero, nil, exchangeFail(403, "COMMENT_PURPOSE_DENIED", "来源未授权该用途")
	}
	d, err := readCommentDetail(ctx, tx, in, sourceID)
	if err != nil {
		return zero, nil, commitCommentMiss(tx, err)
	}
	if err = recheckCommentGrant(a, in.commentScope, g); err != nil {
		return zero, nil, err
	}
	if err = tx.Commit(); err != nil {
		return zero, nil, err
	}
	return d, g, nil
}
