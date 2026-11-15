package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

var outreachRank = map[string]int{"approved": 1, "submitted": 2, "sending": 3, "sent": 4, "uncertain": 4, "failed": 4, "canceled": 4}

func outreachConflict(err error) error {
	var pg *pgconn.PgError
	if errors.As(err, &pg) && pg.Code == "23505" {
		return exchangeFail(409, "REQUEST_CONFLICT", "同一请求已用于其他私信任务")
	}
	return err
}

func (s *server) leadOutreach(ctx context.Context, a actor, op string, body []byte) (any, error) {
	switch op {
	case "outreach/submit":
		return s.outreachSubmit(ctx, a, body)
	case "outreach/result":
		return s.outreachResult(ctx, a, body)
	case "outreach/list":
		return s.outreachList(ctx, a, body)
	case "outreach/cancel":
		return s.outreachCancel(ctx, a, body)
	default:
		return nil, collectionMissing()
	}
}

func (s *server) outreachSubmit(ctx context.Context, a actor, body []byte) (any, error) {
	var in struct {
		AnalysisID string `json:"analysisId"`
		Draft      string `json:"draft"`
		RequestKey string `json:"requestKey"`
	}
	if decodeExchange(body, &in) != nil || !exchangeID.MatchString(in.AnalysisID) ||
		!exchangeKey.MatchString(in.RequestKey) || !validExchangeText(in.Draft, 320) ||
		strings.TrimSpace(in.Draft) == "" {
		return nil, collectionInvalid()
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var analysisID, owner, device, account, work, source, commentProfile, commenterName, commentID string
	var qualified, skipped bool
	var status string
	err = tx.QueryRowContext(ctx, `SELECT a.id,a.owner_id,a.device_id,a.account_id,a.work_id,a.source_id,
		a.qualified,a.review_skipped,a.status,coalesce(o.fields->>'commenter_profile',''),
		coalesce(o.fields->>'commenter_name',''),o.id
		FROM keagent_comment_analyses a JOIN keagent_comment_observations o ON o.id=a.comment_row_id
		WHERE a.id=$1 AND a.owner_id=$2 AND a.device_id=$3
			AND o.retain_until > clock_timestamp() FOR UPDATE`,
		in.AnalysisID, a.UserID, a.DeviceID).Scan(&analysisID, &owner, &device, &account, &work,
		&source, &qualified, &skipped, &status, &commentProfile, &commenterName, &commentID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, collectionMissing()
	}
	if err != nil {
		return nil, err
	}
	if status != "done" || !qualified {
		return nil, exchangeFail(409, "COMMENT_NOT_QUALIFIED", "该评论尚未完成分析或未达标")
	}
	if skipped {
		return nil, exchangeFail(409, "LEAD_SKIPPED", "已标记暂不联系，请先恢复待审核")
	}
	if commentProfile == "" {
		return nil, exchangeFail(409, "COMMENT_PROFILE_UNAVAILABLE", "该来源没有提供可核对的评论者主页")
	}
	scope := commentScope{AccountID: account, WorkID: work}
	g, state, _, err := prepareCommentSource(ctx, tx, a, scope)
	if err != nil {
		return nil, err
	}
	if state != "active" || !g.ManualContact {
		return nil, exchangeFail(403, "COMMENT_PURPOSE_DENIED", "来源未授权人工联系")
	}
	// Source refresh may have cascaded the analysis away; never let the insert surface as an FK error.
	var stillValid bool
	if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM keagent_comment_analyses a
		JOIN keagent_comment_observations o ON o.id=a.comment_row_id
		WHERE a.id=$1 AND a.owner_id=$2 AND a.device_id=$3 AND a.status='done' AND a.qualified
			AND o.retain_until > clock_timestamp())`,
		analysisID, a.UserID, a.DeviceID).Scan(&stillValid); err != nil {
		return nil, err
	}
	if !stillValid {
		return nil, exchangeFail(409, "COMMENT_CHANGED", "评论或授权已更新，请重新分析")
	}
	var existingID, existingStatus, existingKey, existingDraft string
	var existingAttempt int
	err = tx.QueryRowContext(ctx, `SELECT id,status,attempts,request_key,draft FROM keagent_outreach_tasks
		WHERE analysis_id=$1 FOR UPDATE`, analysisID).Scan(&existingID, &existingStatus,
		&existingAttempt, &existingKey, &existingDraft)
	if err == nil {
		if existingKey == in.RequestKey {
			draft := existingDraft
			if existingStatus == "approved" {
				// The renderer may edit an approved draft before resuming; persist
				// exactly what will be sent. Replays against any other status stay
				// pure receipts and must not rewrite the stored draft.
				draft = strings.TrimSpace(in.Draft)
				if _, err = tx.ExecContext(ctx, `UPDATE keagent_outreach_tasks SET draft=$2,updated_at=now()
					WHERE id=$1`, existingID, draft); err != nil {
					return nil, err
				}
			}
			if err = tx.Commit(); err != nil {
				return nil, err
			}
			return object{"id": existingID, "analysisId": analysisID, "status": existingStatus,
				"attempt": existingAttempt, "draft": draft,
				"commentId": commentID, "commenterProfile": commentProfile, "commenterName": commenterName}, nil
		}
		if existingStatus != "failed" && existingStatus != "canceled" {
			return nil, exchangeFail(409, "OUTREACH_EXISTS", "该评论已有私信任务")
		}
		// A retry is a new CreatorHub generation; Task 9 keys idempotency by id plus attempt.
		var attempt int
		err = tx.QueryRowContext(ctx, `UPDATE keagent_outreach_tasks SET draft=$2,status='approved',
			creatorhub_task_id='',error='',method='',submitted_at=NULL,finished_at=NULL,
			request_key=$3,attempts=attempts+1,updated_at=now() WHERE id=$1 RETURNING attempts`,
			existingID, strings.TrimSpace(in.Draft), in.RequestKey).Scan(&attempt)
		if err != nil {
			return nil, outreachConflict(err)
		}
		if err = tx.Commit(); err != nil {
			return nil, err
		}
		return object{"id": existingID, "analysisId": analysisID, "status": "approved",
			"attempt": attempt, "commentId": commentID, "commenterProfile": commentProfile, "commenterName": commenterName}, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	outreachID := id()
	_, err = tx.ExecContext(ctx, `INSERT INTO keagent_outreach_tasks(
		id,analysis_id,owner_id,device_id,account_id,work_id,draft,status,attempts,request_key)
		VALUES($1,$2,$3,$4,$5,$6,$7,'approved',1,$8)`,
		outreachID, analysisID, a.UserID, a.DeviceID, account, work, strings.TrimSpace(in.Draft), in.RequestKey)
	if err != nil {
		return nil, outreachConflict(err)
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return object{"id": outreachID, "analysisId": analysisID, "status": "approved",
		"attempt": 1, "commentId": commentID, "commenterProfile": commentProfile, "commenterName": commenterName}, nil
}

func (s *server) outreachResult(ctx context.Context, a actor, body []byte) (any, error) {
	var in struct {
		ID               string `json:"id"`
		Status           string `json:"status"`
		CreatorHubTaskID string `json:"creatorhubTaskId"`
		Error            string `json:"error"`
		Method           string `json:"method"`
		Attempt          int    `json:"attempt"`
		Confirmed        bool   `json:"confirmed"`
	}
	if decodeExchange(body, &in) != nil || !exchangeID.MatchString(in.ID) ||
		outreachRank[in.Status] == 0 || len([]rune(in.Error)) > 500 || len([]rune(in.Method)) > 40 {
		return nil, collectionInvalid()
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var current string
	var currentAttempt int
	err = tx.QueryRowContext(ctx, `SELECT status,attempts FROM keagent_outreach_tasks
		WHERE id=$1 AND owner_id=$2 AND device_id=$3 FOR UPDATE`,
		in.ID, a.UserID, a.DeviceID).Scan(&current, &currentAttempt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, collectionMissing()
	}
	if err != nil {
		return nil, err
	}
	ignored := object{"id": in.ID, "status": current, "attempt": currentAttempt, "ignored": true}
	if in.Attempt != currentAttempt || current == "sent" {
		return ignored, nil
	}
	// An uncertain delivery is only resolved by an explicit confirmation.
	if current == "uncertain" && !(in.Confirmed && (in.Status == "sent" || in.Status == "failed")) {
		return ignored, nil
	}
	if outreachRank[in.Status] < outreachRank[current] {
		return ignored, nil
	}
	finished := in.Status == "sent" || in.Status == "uncertain" || in.Status == "failed" || in.Status == "canceled"
	result, err := tx.ExecContext(ctx, `UPDATE keagent_outreach_tasks SET status=$2,
		creatorhub_task_id=COALESCE(NULLIF($3,''),creatorhub_task_id),
		error=$4,method=COALESCE(NULLIF($5,''),method),updated_at=now(),
		submitted_at=COALESCE(submitted_at,CASE WHEN $2 IN ('submitted','sending','sent') THEN now() END),
		finished_at=CASE WHEN $6 THEN COALESCE(finished_at,now()) ELSE NULL END
		WHERE id=$1 AND attempts=$7`,
		in.ID, in.Status, in.CreatorHubTaskID, in.Error, in.Method, finished, currentAttempt)
	if err != nil {
		return nil, err
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		return ignored, nil
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return object{"id": in.ID, "status": in.Status, "attempt": currentAttempt}, nil
}

func nullableTime(value sql.NullTime) any {
	if !value.Valid {
		return nil
	}
	return value.Time.UTC()
}

func (s *server) outreachList(ctx context.Context, a actor, body []byte) (any, error) {
	var in struct {
		ID        string `json:"id"`
		AccountID string `json:"accountId"`
		WorkID    string `json:"workId"`
		Status    string `json:"status"`
		Limit     int    `json:"limit"`
	}
	if decodeExchange(body, &in) != nil || in.Limit < 0 || in.Limit > 500 {
		return nil, collectionInvalid()
	}
	if in.Limit == 0 {
		in.Limit = 50
	}
	where := " WHERE owner_id=$1 AND device_id=$2"
	args := []any{a.UserID, a.DeviceID}
	add := func(column string, value any) {
		args = append(args, value)
		where += fmt.Sprintf(" AND %s=$%d", column, len(args))
	}
	if in.ID != "" {
		if !exchangeID.MatchString(in.ID) {
			return nil, collectionInvalid()
		}
		add("id", in.ID)
	}
	if in.AccountID != "" {
		if !exchangeID.MatchString(in.AccountID) {
			return nil, collectionInvalid()
		}
		add("account_id", in.AccountID)
	}
	if in.WorkID != "" {
		if !validLeadWork(in.WorkID) {
			return nil, collectionInvalid()
		}
		add("work_id", in.WorkID)
	}
	if in.Status != "" {
		add("status", in.Status)
	}
	args = append(args, in.Limit)
	rs, err := s.db.QueryContext(ctx, `SELECT id,analysis_id,account_id,work_id,draft,status,
		creatorhub_task_id,method,error,attempts,request_key,created_at,submitted_at,finished_at
		FROM keagent_outreach_tasks`+where+` ORDER BY created_at DESC LIMIT $`+strconv.Itoa(len(args)), args...)
	if err != nil {
		return nil, err
	}
	defer rs.Close()
	items := []object{}
	for rs.Next() {
		var id, analysisID, accountID, workID, draft, status, taskID, method, errText, requestKey string
		var attempts int
		var created time.Time
		var submitted, finished sql.NullTime
		if err = rs.Scan(&id, &analysisID, &accountID, &workID, &draft, &status, &taskID,
			&method, &errText, &attempts, &requestKey, &created, &submitted, &finished); err != nil {
			return nil, err
		}
		items = append(items, object{"id": id, "analysisId": analysisID, "accountId": accountID,
			"workId": workID, "draft": draft, "status": status, "creatorhubTaskId": taskID,
			"method": method, "error": errText, "attempt": attempts, "requestKey": requestKey,
			"createdAt": created.UTC(), "submittedAt": nullableTime(submitted), "finishedAt": nullableTime(finished)})
	}
	return object{"items": items}, rs.Err()
}

func (s *server) outreachCancel(ctx context.Context, a actor, body []byte) (any, error) {
	var in struct {
		ID      string `json:"id"`
		Attempt int    `json:"attempt"`
	}
	if decodeExchange(body, &in) != nil || !exchangeID.MatchString(in.ID) {
		return nil, collectionInvalid()
	}
	args := []any{in.ID, a.UserID, a.DeviceID}
	where := ` WHERE id=$1 AND owner_id=$2 AND device_id=$3 AND status IN ('approved','submitted')`
	if in.Attempt != 0 {
		args = append(args, in.Attempt)
		where += fmt.Sprintf(" AND attempts=$%d", len(args))
	}
	var attempt int
	err := s.db.QueryRowContext(ctx, `UPDATE keagent_outreach_tasks SET status='canceled',
		updated_at=now(),finished_at=now()`+where+` RETURNING attempts`, args...).Scan(&attempt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, exchangeFail(409, "OUTREACH_NOT_CANCELABLE", "任务已执行或不存在")
	}
	if err != nil {
		return nil, err
	}
	return object{"id": in.ID, "status": "canceled", "attempt": attempt}, nil
}
