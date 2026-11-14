package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

var outreachRank = map[string]int{"approved": 1, "submitted": 2, "sending": 3, "sent": 4, "uncertain": 4, "failed": 4, "canceled": 4}

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
	var analysisID, owner, device, account, work, source, commentProfile, commenterName string
	var qualified bool
	var status string
	err = tx.QueryRowContext(ctx, `SELECT a.id,a.owner_id,a.device_id,a.account_id,a.work_id,a.source_id,
		a.qualified,a.status,coalesce(o.fields->>'commenter_profile',''),
		coalesce(o.fields->>'commenter_name','')
		FROM keagent_comment_analyses a JOIN keagent_comment_observations o ON o.id=a.comment_row_id
		WHERE a.id=$1 AND a.owner_id=$2 AND a.device_id=$3 FOR UPDATE`,
		in.AnalysisID, a.UserID, a.DeviceID).Scan(&analysisID, &owner, &device, &account, &work,
		&source, &qualified, &status, &commentProfile, &commenterName)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, collectionMissing()
	}
	if err != nil {
		return nil, err
	}
	if status != "done" || !qualified {
		return nil, exchangeFail(409, "COMMENT_NOT_QUALIFIED", "该评论尚未完成分析或未达标")
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
	var existingID, existingStatus string
	err = tx.QueryRowContext(ctx, `SELECT id,status FROM keagent_outreach_tasks WHERE analysis_id=$1 FOR UPDATE`, analysisID).Scan(&existingID, &existingStatus)
	if err == nil {
		if existingStatus != "failed" && existingStatus != "canceled" {
			return nil, exchangeFail(409, "OUTREACH_EXISTS", "该评论已有私信任务")
		}
		if _, err = tx.ExecContext(ctx, `UPDATE keagent_outreach_tasks SET draft=$2,status='approved',
			creatorhub_task_id='',error='',request_key=$3,updated_at=now() WHERE id=$1`,
			existingID, strings.TrimSpace(in.Draft), in.RequestKey); err != nil {
			return nil, err
		}
		if err = tx.Commit(); err != nil {
			return nil, err
		}
		return object{"id": existingID, "analysisId": analysisID, "status": "approved",
			"commenterProfile": commentProfile, "commenterName": commenterName}, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	outreachID := id()
	_, err = tx.ExecContext(ctx, `INSERT INTO keagent_outreach_tasks(
		id,analysis_id,owner_id,device_id,account_id,work_id,draft,status,request_key)
		VALUES($1,$2,$3,$4,$5,$6,$7,'approved',$8)`,
		outreachID, analysisID, a.UserID, a.DeviceID, account, work, strings.TrimSpace(in.Draft), in.RequestKey)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return object{"id": outreachID, "analysisId": analysisID, "status": "approved",
		"commenterProfile": commentProfile, "commenterName": commenterName}, nil
}

func (s *server) outreachResult(ctx context.Context, a actor, body []byte) (any, error) {
	var in struct {
		ID               string `json:"id"`
		Status           string `json:"status"`
		CreatorHubTaskID string `json:"creatorhubTaskId"`
		Error            string `json:"error"`
		Method           string `json:"method"`
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
	err = tx.QueryRowContext(ctx, `SELECT status FROM keagent_outreach_tasks
		WHERE id=$1 AND owner_id=$2 AND device_id=$3 FOR UPDATE`, in.ID, a.UserID, a.DeviceID).Scan(&current)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, collectionMissing()
	}
	if err != nil {
		return nil, err
	}
	if outreachRank[in.Status] < outreachRank[current] || current == "sent" || current == "uncertain" {
		return object{"id": in.ID, "status": current, "ignored": true}, nil
	}
	finished := in.Status == "sent" || in.Status == "uncertain" || in.Status == "failed" || in.Status == "canceled"
	_, err = tx.ExecContext(ctx, `UPDATE keagent_outreach_tasks SET status=$2,creatorhub_task_id=$3,
		error=$4,method=$5,updated_at=now(),
		submitted_at=coalesce(submitted_at,CASE WHEN $2='submitted' THEN now() END),
		finished_at=CASE WHEN $6 THEN now() ELSE finished_at END WHERE id=$1`,
		in.ID, in.Status, in.CreatorHubTaskID, in.Error, in.Method, finished)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return object{"id": in.ID, "status": in.Status}, nil
}

func (s *server) outreachList(ctx context.Context, a actor, body []byte) (any, error) {
	var in struct {
		ID        string `json:"id"`
		AccountID string `json:"accountId"`
		WorkID    string `json:"workId"`
		Status    string `json:"status"`
		Limit     int    `json:"limit"`
	}
	if decodeExchange(body, &in) != nil || in.Limit < 0 || in.Limit > 100 {
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
		if !douyinPostID.MatchString(in.WorkID) {
			return nil, collectionInvalid()
		}
		add("work_id", in.WorkID)
	}
	if in.Status != "" {
		add("status", in.Status)
	}
	args = append(args, in.Limit)
	rs, err := s.db.QueryContext(ctx, `SELECT id,analysis_id,account_id,work_id,draft,status,
		creatorhub_task_id,method,error,attempts,created_at,submitted_at,finished_at
		FROM keagent_outreach_tasks`+where+` ORDER BY created_at DESC LIMIT $`+strconv.Itoa(len(args)), args...)
	if err != nil {
		return nil, err
	}
	defer rs.Close()
	items := []object{}
	for rs.Next() {
		var id, analysisID, accountID, workID, draft, status, taskID, method, errText string
		var attempts int
		var created time.Time
		var submitted, finished sql.NullTime
		if err = rs.Scan(&id, &analysisID, &accountID, &workID, &draft, &status, &taskID,
			&method, &errText, &attempts, &created, &submitted, &finished); err != nil {
			return nil, err
		}
		items = append(items, object{"id": id, "analysisId": analysisID, "accountId": accountID,
			"workId": workID, "draft": draft, "status": status, "creatorhubTaskId": taskID,
			"method": method, "error": errText, "attempts": attempts,
			"createdAt": created.UTC(), "submittedAt": submitted.Time, "finishedAt": finished.Time})
	}
	return object{"items": items}, rs.Err()
}

func (s *server) outreachCancel(ctx context.Context, a actor, body []byte) (any, error) {
	var in struct {
		ID string `json:"id"`
	}
	if decodeExchange(body, &in) != nil || !exchangeID.MatchString(in.ID) {
		return nil, collectionInvalid()
	}
	result, err := s.db.ExecContext(ctx, `UPDATE keagent_outreach_tasks SET status='canceled',
		updated_at=now(),finished_at=now()
		WHERE id=$1 AND owner_id=$2 AND device_id=$3 AND status IN ('approved','submitted')`,
		in.ID, a.UserID, a.DeviceID)
	if err != nil {
		return nil, err
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		return nil, exchangeFail(409, "OUTREACH_NOT_CANCELABLE", "任务已执行或不存在")
	}
	return object{"id": in.ID, "status": "canceled"}, nil
}
