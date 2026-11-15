package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

type leadImportInput struct {
	AccountID  string          `json:"accountId"`
	WorkID     string          `json:"workId"`
	RequestKey string          `json:"requestKey"`
	SnapshotID string          `json:"snapshotId"`
	ObservedAt time.Time       `json:"observedAt"`
	Coverage   string          `json:"coverage"`
	Items      []commentFields `json:"items"`
}

func (s *server) importCreatorHubComments(ctx context.Context, a actor, body []byte) (any, error) {
	if a.DeviceID == "" {
		return nil, exchangeFail(403, "DEVICE_REQUIRED", "请使用已绑定的桌面设备")
	}
	var in leadImportInput
	if decodeExchange(body, &in) != nil || !exchangeID.MatchString(in.AccountID) ||
		!validLeadWork(in.WorkID) || !exchangeKey.MatchString(in.RequestKey) ||
		!exchangeID.MatchString(in.SnapshotID) || in.ObservedAt.IsZero() ||
		len(in.Items) > 500 || !validCoverage(in.Coverage) {
		return nil, collectionInvalid()
	}
	for i := range in.Items {
		if !validPlatformCommentFields(&in.Items[i], xhsWorkID.MatchString(in.WorkID)) {
			return nil, collectionInvalid()
		}
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	scope := commentScope{AccountID: in.AccountID, WorkID: in.WorkID}
	if err = lockCommentScope(ctx, tx, a, scope); err != nil {
		return nil, err
	}
	if err = collectionDevice(ctx, tx, a); err != nil {
		return nil, err
	}
	if state, err := accountStatus(ctx, tx, a, scope.AccountID); err != nil || state == "" {
		if err != nil {
			return nil, err
		}
		return nil, collectionMissing()
	}
	g, state, sourceID, err := prepareCommentSource(ctx, tx, a, scope)
	if err != nil {
		return nil, err
	}
	if state != "active" {
		if err = tx.Commit(); err != nil {
			return nil, err
		}
		return nil, unavailableCommentGrant(state)
	}
	if g.Kind != "creatorhub" && g.Kind != "electron" {
		return nil, exchangeFail(409, "COMMENT_SOURCE_CONFLICT", "该作品使用其他评论来源")
	}
	if sourceID == "" {
		sourceID, err = insertCommentSource(ctx, tx, a, scope, g, false)
		if err != nil {
			return nil, err
		}
	}
	// A committed receipt is returned before verification so a retry succeeds even after
	// its observation window or synthetic run no longer satisfies the live checks.
	var receipt []byte
	err = tx.QueryRowContext(ctx, `SELECT result FROM keagent_comment_requests
		WHERE source_id=$1 AND request_key=$2`, sourceID, in.RequestKey).Scan(&receipt)
	if err == nil {
		if err = tx.Commit(); err != nil {
			return nil, err
		}
		return json.RawMessage(receipt), nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if err = ensureLeadImportRun(ctx, tx, a, scope, in.ObservedAt, g.Kind); err != nil {
		return nil, err
	}
	if err = verifyCommentScope(ctx, tx, a, scope); err != nil {
		return nil, err
	}
	batch := commentBatch{SnapshotID: in.SnapshotID, ObservedAt: in.ObservedAt,
		Coverage: in.Coverage, Items: in.Items}
	result, err := applyCommentBatch(ctx, tx, commentInput{commentScope: scope, RequestKey: in.RequestKey}, g, sourceID, batch)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return result, nil
}

func validCoverage(value string) bool {
	return value == "complete" || value == "partial" || value == "unknown"
}

func ensureLeadImportRun(ctx context.Context, tx *sql.Tx, a actor, scope commentScope, observed time.Time, kind string) error {
	observed = observed.UTC().Truncate(time.Microsecond)
	if observed.Before(time.Now().Add(-24*time.Hour)) || observed.After(time.Now().Add(5*time.Minute)) {
		return exchangeFail(409, "COMMENT_OBSERVATION_STALE", "评论抓取时间无效，请重新抓取")
	}
	value := videoBase + scope.WorkID
	title := "抖音作品 " + scope.WorkID
	if xhsWorkID.MatchString(scope.WorkID) {
		value = "https://www.xiaohongshu.com/explore/" + strings.TrimPrefix(scope.WorkID, "xhs-")
		title = "小红书笔记 " + strings.TrimPrefix(scope.WorkID, "xhs-")
	}
	// The account scopes the key so two accounts observing the same work cannot collide.
	targetKey := kind + "-" + exchangeFingerprint([]string{scope.AccountID, value})
	var targetID string
	err := tx.QueryRowContext(ctx, `SELECT id FROM keagent_collection_targets
		WHERE owner_id=$1 AND device_id=$2 AND payload->>'accountId'=$3
		AND payload->>'kind'='video' AND payload->>'value'=$4
		AND payload->>'state'<>'archived' LIMIT 1`,
		a.UserID, a.DeviceID, scope.AccountID, value).Scan(&targetID)
	if errors.Is(err, sql.ErrNoRows) {
		var raw []byte
		err = tx.QueryRowContext(ctx, `SELECT id,payload FROM keagent_collection_targets
			WHERE owner_id=$1 AND device_id=$2 AND payload->>'accountId'=$3
			AND payload->>'kind'='video' AND payload->>'value'=$4
			ORDER BY seq DESC LIMIT 1`,
			a.UserID, a.DeviceID, scope.AccountID, value).Scan(&targetID, &raw)
		switch {
		case err == nil:
			// An archived target keeps its row and unique keys; revive it instead of inserting.
			var target collectionTarget
			if err = json.Unmarshal(raw, &target); err != nil {
				return err
			}
			if target.State == "archived" {
				target.State, target.Version, target.UpdatedAt = "active", target.Version+1, now()
				raw, _ = json.Marshal(target)
				if _, err = tx.ExecContext(ctx, `UPDATE keagent_collection_targets SET payload=$2 WHERE id=$1`, targetID, raw); err != nil {
					return err
				}
			}
		case errors.Is(err, sql.ErrNoRows):
			targetID = id()
			target := collectionTarget{
				targetFields: targetFields{Kind: "video", Value: value, Name: title, AccountID: scope.AccountID},
				ID:           targetID, DeviceID: a.DeviceID, State: "active", Version: 1,
				CreatedAt: now(), UpdatedAt: now(),
			}
			raw, _ = json.Marshal(target)
			_, err = tx.ExecContext(ctx, `INSERT INTO keagent_collection_targets
				(id,owner_id,device_id,request_key,fingerprint,payload)
				VALUES($1,$2,$3,$4,$5,$6)`,
				targetID, a.UserID, a.DeviceID, targetKey, exchangeFingerprint(target), raw)
		}
	}
	if err != nil {
		return err
	}
	runRequestKey := kind + "-" + exchangeFingerprint([]string{a.UserID, a.DeviceID, scope.AccountID, scope.WorkID})
	var runID string
	var storedObserved sql.NullTime
	err = tx.QueryRowContext(ctx, `SELECT id,observed_at FROM keagent_collection_runs
		WHERE owner_id=$1 AND device_id=$2 AND request_key=$3`, a.UserID, a.DeviceID, runRequestKey).Scan(&runID, &storedObserved)
	switch {
	case err == nil:
		if storedObserved.Valid && !observed.After(storedObserved.Time) {
			observed = storedObserved.Time.UTC()
			break
		}
		if _, err = tx.ExecContext(ctx, `UPDATE keagent_collection_runs SET observed_at=$2 WHERE id=$1`, runID, observed); err != nil {
			return err
		}
	case errors.Is(err, sql.ErrNoRows):
		runID = id()
		run := collectionRun{
			collectionResult: collectionResult{
				State: "succeeded", PanelStatus: "visible", VerifiedWorkID: scope.WorkID,
				Title: title,
			},
			Source: kind,
			ID:     runID, TargetID: targetID, TargetName: title, TargetVersion: 1,
			TargetURL: value, InputWorkID: scope.WorkID, AccountID: scope.AccountID,
			DeviceID: a.DeviceID, CreatedAt: now(), StartedAt: now(), EndedAt: now(),
		}
		raw, _ := json.Marshal(run)
		_, err = tx.ExecContext(ctx, `INSERT INTO keagent_collection_runs
			(id,owner_id,device_id,target_id,request_key,fingerprint,payload,expires_at,observed_at)
			VALUES($1,$2,$3,$4,$5,$6,$7,NULL,$8)`,
			runID, a.UserID, a.DeviceID, targetID, runRequestKey, exchangeFingerprint(run), raw, observed)
	default:
		return err
	}
	if err != nil {
		return err
	}
	// Never repoint a row that belongs to a real desktop run; only advance our own synthetic row.
	_, err = tx.ExecContext(ctx, `INSERT INTO keagent_monitored_videos(owner_id,work_id,last_run_id,observed_at)
		VALUES($1,$2,$3,$4) ON CONFLICT(owner_id,work_id) DO UPDATE
		SET last_run_id=excluded.last_run_id,observed_at=excluded.observed_at
		WHERE keagent_monitored_videos.last_run_id=$3
		  AND keagent_monitored_videos.observed_at<=excluded.observed_at`,
		a.UserID, scope.WorkID, runID, observed)
	return err
}
