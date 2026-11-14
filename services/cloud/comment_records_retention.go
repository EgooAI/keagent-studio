package main

import (
	"context"
	"log"
	"time"
)

// No platform requests: housekeeping removes retained data even when nobody opens the page.
func (s *server) commentRetentionWorker(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		if err := s.purgeCommentRecords(ctx); err != nil && ctx.Err() == nil {
			log.Print("comment retention sweep incomplete")
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (s *server) purgeCommentRecords(ctx context.Context) error {
	// Indexed by expiry and independent of the availability of the operator's grant file.
	for _, q := range []string{
		`DELETE FROM keagent_comment_sources WHERE expires_at<=clock_timestamp()`,
		`DELETE FROM keagent_comment_observations WHERE retain_until<=clock_timestamp()`,
		`DELETE FROM keagent_comment_snapshots WHERE retain_until<=clock_timestamp()`,
	} {
		if _, err := s.db.ExecContext(ctx, q); err != nil {
			return err
		}
	}
	// Release the DB connection before starting per-scope cleanup. A second check under the same
	// per-scope lock as sync avoids pruning a replacement generation from an old enumeration.
	type stored struct {
		actor
		commentScope
	}
	var pending []stored
	rs, err := s.db.QueryContext(ctx, `SELECT owner_id,device_id,account_id,work_id FROM keagent_comment_sources`)
	if err != nil {
		return err
	}
	for rs.Next() {
		var c stored
		if err = rs.Scan(&c.UserID, &c.DeviceID, &c.AccountID, &c.WorkID); err != nil {
			rs.Close()
			return err
		}
		pending = append(pending, c)
	}
	err = rs.Err()
	rs.Close()
	if err != nil {
		return err
	}
	var firstError error
	for _, c := range pending {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err = s.purgeCommentScope(ctx, c.actor, c.commentScope); err != nil && firstError == nil {
			firstError = err
		}
	}
	return firstError
}

func (s *server) purgeCommentScope(ctx context.Context, a actor, scope commentScope) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = lockCommentScope(ctx, tx, a, scope); err != nil {
		return err
	}
	var bound bool
	if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM keagent_device d JOIN keagent_douyin_account ac
	 ON ac.owner_id=d.owner_id AND ac.device_id=d.id WHERE d.owner_id=$1 AND d.id=$2 AND NOT d.revoked
	 AND ac.id=$3 AND NOT (ac.payload ? 'unboundAt'))`, a.UserID, a.DeviceID, scope.AccountID).Scan(&bound); err != nil {
		return err
	}
	if !bound {
		_, err = tx.ExecContext(ctx, `DELETE FROM keagent_comment_sources WHERE owner_id=$1 AND device_id=$2 AND account_id=$3 AND work_id=$4`, a.UserID, a.DeviceID, scope.AccountID, scope.WorkID)
	} else {
		_, _, _, err = prepareCommentSource(ctx, tx, a, scope)
	}
	if err != nil {
		return err
	}
	return tx.Commit()
}
