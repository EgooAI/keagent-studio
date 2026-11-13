package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

// 积分售卖核心：批次（lot）记账 + 冻结/结算/释放。
// 设计约定见 docs/16-积分售卖与计费.md：
//   - 充值积分（purchased）不过期；赠送积分（granted）发放时必须带过期时间。
//   - 扣费先冻结（hold）再结算（capture）/释放（release），冻结时按“先扣将过期的赠送积分”排序。
//   - 冻结中的积分不参与过期；释放回已过期的赠送批次时，退回金额转为充值积分。
//   - 流水只追加，sum(amount) 恒等于所有批次的 remaining 之和（capture 行金额为 0，消耗量记在 metadata.spent）。
const creditSchema = `
CREATE TABLE IF NOT EXISTS keagent_credit_lot (
 id text PRIMARY KEY, owner_id text NOT NULL, kind text NOT NULL,
 initial_amount bigint NOT NULL, remaining bigint NOT NULL, held bigint NOT NULL DEFAULT 0,
 expires_at timestamptz, source text NOT NULL, source_ref text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK (remaining >= 0), CHECK (held >= 0), CHECK (kind IN ('purchased','granted')));
CREATE INDEX IF NOT EXISTS keagent_credit_lot_owner_idx ON keagent_credit_lot(owner_id);
CREATE TABLE IF NOT EXISTS keagent_credit_hold (
 id text PRIMARY KEY, owner_id text NOT NULL, op text NOT NULL, ref_id text NOT NULL DEFAULT '',
 amount bigint NOT NULL, state text NOT NULL, allocation jsonb NOT NULL,
 idem_key text NOT NULL, price_version text NOT NULL DEFAULT '',
 metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), settled_at timestamptz);
-- 同键同时只允许一个未释放的冻结单；释放后的同键可重新冻结（失败重试）。
CREATE UNIQUE INDEX IF NOT EXISTS keagent_credit_hold_idem_idx ON keagent_credit_hold(owner_id, op, idem_key) WHERE state <> 'released';
CREATE TABLE IF NOT EXISTS keagent_credit_ledger (
 id text PRIMARY KEY, owner_id text NOT NULL, kind text NOT NULL, lot_id text NOT NULL DEFAULT '',
 amount bigint NOT NULL, op text NOT NULL DEFAULT '', ref_id text NOT NULL DEFAULT '',
 idem_key text NOT NULL DEFAULT '', price_version text NOT NULL DEFAULT '',
 operator_id text NOT NULL DEFAULT '', metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS keagent_credit_ledger_owner_idx ON keagent_credit_ledger(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS keagent_credit_ledger_capture_time_idx ON keagent_credit_ledger(created_at) WHERE kind='capture';
CREATE TABLE IF NOT EXISTS keagent_credit_code (
 batch_id text NOT NULL, code_hash text PRIMARY KEY, amount bigint NOT NULL,
 used_by text NOT NULL DEFAULT '', used_at timestamptz, expires_at timestamptz,
 note text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now());`

type codedFault struct {
	fault
	code string
}

func (f codedFault) ErrorCode() string { return f.code }
func creditFail(status int, code, message string) error {
	return codedFault{fault{status: status, message: message}, code}
}

const (
	creditKindPurchased = "purchased"
	creditKindGranted   = "granted"
	creditStateHeld     = "held"
	creditStateCaptured = "captured"
	creditStateReleased = "released"
)

var creditOps = map[string]bool{"opening": true, "voice_clone": true, "script": true, "tts": true, "image_expand": true}

var creditSources = map[string]bool{"welcome": true, "admin_grant": true, "code": true, "order": true, "release": true}

var defaultCreditPrices = map[string]int64{"opening": 100, "voice_clone": 200, "script": 5, "tts_per_kilo_char": 10, "image_expand": 0}

var creditCodePattern = regexp.MustCompile(`^[A-Z0-9][A-Z0-9-]{7,63}$`)

type creditAllocation struct {
	LotID  string `json:"lotId"`
	Amount int64  `json:"amount"`
}

type creditHold struct {
	ID           string
	OwnerID      string
	Op           string
	RefID        string
	Amount       int64
	State        string
	Allocation   []creditAllocation
	IdemKey      string
	PriceVersion string
	Metadata     object
	CreatedAt    time.Time
	SettledAt    sql.NullTime
}

type rowQuerier interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// readCreditPricing 读取后台价目配置，未配置或单项缺失时回落到默认值。
func readCreditPricing(ctx context.Context, q rowQuerier) (map[string]int64, string, error) {
	prices := make(map[string]int64, len(defaultCreditPrices))
	for k, v := range defaultCreditPrices {
		prices[k] = v
	}
	version := "default"
	var raw []byte
	err := q.QueryRowContext(ctx, `SELECT payload FROM keagent_setting WHERE id='credit_pricing'`).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return prices, version, nil
	}
	if err != nil {
		return nil, "", err
	}
	var stored struct {
		Version int64            `json:"version"`
		Prices  map[string]int64 `json:"prices"`
	}
	if json.Unmarshal(raw, &stored) != nil || stored.Version < 1 {
		return nil, "", fail(500, "积分价目配置无效")
	}
	for k, v := range stored.Prices {
		if _, known := defaultCreditPrices[k]; known && v >= 0 {
			prices[k] = v
		}
	}
	return prices, fmt.Sprintf("v%d", stored.Version), nil
}

// grantCredits 在事务内发放一个积分批次并写流水。赠送积分必须带未来过期时间。
func grantCredits(ctx context.Context, tx *sql.Tx, ownerID, kind string, amount int64, source, sourceRef string, expires *time.Time, operatorID, note string) (string, error) {
	if amount <= 0 {
		return "", fail(422, "发放积分必须大于零")
	}
	if kind != creditKindPurchased && kind != creditKindGranted {
		return "", fail(422, "积分类别无效")
	}
	if kind == creditKindPurchased && expires != nil {
		return "", fail(422, "充值积分不能设置过期时间")
	}
	if kind == creditKindGranted && (expires == nil || !expires.After(time.Now())) {
		return "", fail(422, "赠送积分必须设置未来的过期时间")
	}
	if !creditSources[source] {
		return "", fail(422, "积分来源无效")
	}
	lotID := id()
	if _, err := tx.ExecContext(ctx, `INSERT INTO keagent_credit_lot(id,owner_id,kind,initial_amount,remaining,expires_at,source,source_ref) VALUES($1,$2,$3,$4,$4,$5,$6,$7)`, lotID, ownerID, kind, amount, expires, source, sourceRef); err != nil {
		return "", err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO keagent_credit_ledger(id,owner_id,kind,lot_id,amount,ref_id,operator_id,metadata) VALUES($1,$2,'grant',$3,$4,$5,$6,$7)`, id(), ownerID, lotID, amount, sourceRef, operatorID, mustJSON(object{"note": note})); err != nil {
		return "", err
	}
	return lotID, nil
}

// expireCreditsTx 清零过期批次（冻结中的不参与），并写 expire 流水。ownerID 为空时清全表。
func expireCreditsTx(ctx context.Context, tx *sql.Tx, ownerID string) (int64, error) {
	// 先查出旧值再更新：UPDATE ... RETURNING 返回的是更新后的值，直接 RETURNING remaining 会把流水记成 0。
	rows, err := tx.QueryContext(ctx, `SELECT owner_id, id, remaining FROM keagent_credit_lot WHERE held=0 AND remaining>0 AND expires_at IS NOT NULL AND expires_at<now() AND ($1='' OR owner_id=$1) FOR UPDATE`, ownerID)
	if err != nil {
		return 0, err
	}
	type expiredLot struct {
		ownerID   string
		lotID     string
		remaining int64
	}
	var lots []expiredLot
	var lotIDs []string
	for rows.Next() {
		var e expiredLot
		if err = rows.Scan(&e.ownerID, &e.lotID, &e.remaining); err != nil {
			rows.Close()
			return 0, err
		}
		lots = append(lots, e)
		lotIDs = append(lotIDs, e.lotID)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return 0, err
	}
	if len(lots) > 0 {
		if _, err = tx.ExecContext(ctx, `UPDATE keagent_credit_lot SET remaining=0 WHERE id = ANY($1)`, lotIDs); err != nil {
			return 0, err
		}
	}
	for _, e := range lots {
		if _, err = tx.ExecContext(ctx, `INSERT INTO keagent_credit_ledger(id,owner_id,kind,lot_id,amount) VALUES($1,$2,'expire',$3,$4)`, id(), e.ownerID, e.lotID, -e.remaining); err != nil {
			return 0, err
		}
	}
	return int64(len(lots)), nil
}

func (s *server) expireAllCredits(ctx context.Context) (int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	count, err := expireCreditsTx(ctx, tx, "")
	if err != nil {
		return 0, err
	}
	return count, tx.Commit()
}

// creditExpireSweeper 后台过期与悬挂冻结清扫，主进程启动时开启。
func (s *server) creditExpireSweeper(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if count, err := s.expireAllCredits(ctx); err != nil {
				log.Printf("credit expire sweep failed: %v", err)
			} else if count > 0 {
				log.Printf("credit expire swept %d lots", count)
			}
			if count, err := s.releaseAllStaleHolds(ctx); err != nil {
				log.Printf("credit stale hold sweep failed: %v", err)
			} else if count > 0 {
				log.Printf("credit stale holds released: %d", count)
			}
		}
	}
}

func (s *server) releaseAllStaleHolds(ctx context.Context) (int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	count, err := releaseStaleHolds(ctx, tx)
	if err != nil {
		return 0, err
	}
	return count, tx.Commit()
}

// releaseStaleHolds 释放长时间未收尾的悬挂冻结（供应商结果未知且用户未再操作），防止余额永久占用。
func releaseStaleHolds(ctx context.Context, tx *sql.Tx) (int64, error) {
	rows, err := tx.QueryContext(ctx, `SELECT id, owner_id, allocation FROM keagent_credit_hold WHERE state='held' AND created_at<now()-interval '7 days' FOR UPDATE`)
	if err != nil {
		return 0, err
	}
	type staleHold struct {
		id         string
		ownerID    string
		allocation []creditAllocation
	}
	var holds []staleHold
	for rows.Next() {
		var h staleHold
		var allocationRaw []byte
		if err = rows.Scan(&h.id, &h.ownerID, &allocationRaw); err != nil {
			rows.Close()
			return 0, err
		}
		_ = json.Unmarshal(allocationRaw, &h.allocation)
		holds = append(holds, h)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return 0, err
	}
	for _, h := range holds {
		if err = releaseAllocation(ctx, tx, h.ownerID, h.id, h.allocation); err != nil {
			return 0, err
		}
		if _, err = tx.ExecContext(ctx, `UPDATE keagent_credit_hold SET state=$2, settled_at=now() WHERE id=$1`, h.id, creditStateReleased); err != nil {
			return 0, err
		}
	}
	return int64(len(holds)), nil
}

// chargeSync 同步供应商调用的扣费封装：冻结→调用→成功结算/失败释放。
// 同一内容此前已成功结算（captured）的重放不再扣费，直接重新调用供应商返回结果，
// 避免桌面端网络重试被重复扣费；上次调用中断留下的悬挂冻结由下一次同键调用收尾。
func (s *server) chargeSync(ctx context.Context, ownerID, op, refID string, amount int64, idemKey, priceVersion string, meta object, run func(context.Context) (any, error)) (any, error) {
	if amount <= 0 {
		return run(ctx)
	}
	hold, err := s.holdCredits(ctx, ownerID, op, refID, amount, idemKey, priceVersion, meta)
	if err != nil {
		return nil, err
	}
	if hold.State == creditStateCaptured {
		return run(ctx)
	}
	result, runErr := run(ctx)
	if runErr != nil {
		if releaseErr := s.releaseHold(ctx, hold.ID); releaseErr != nil {
			log.Printf("credit release after failed %s: %v", op, releaseErr)
		}
		return nil, runErr
	}
	if err = s.captureHold(ctx, hold.ID, amount); err != nil {
		return nil, err
	}
	return result, nil
}

// chargedScript AI 文案生成的扣费封装：幂等键取请求内容哈希，同内容重放不重复扣费。
func (s *server) chargedScript(ctx context.Context, a actor, input object, run func(context.Context) (any, error)) (any, error) {
	prices, version, err := readCreditPricing(ctx, s.db)
	if err != nil {
		return nil, err
	}
	return s.chargeSync(ctx, a.UserID, "script", "", prices["script"], digestBytes(mustJSON(input)), version, nil, run)
}

// settleHoldByKey 按幂等键收尾异步任务的冻结单（opening / voice_clone / image_expand）。
// 没有在途冻结单（免费操作或已收尾）时静默跳过；capture=true 全额结算，否则释放退款。
func (s *server) settleHoldByKey(ctx context.Context, ownerID, op, idemKey string, capture bool) error {
	var holdID string
	var amount int64
	err := s.db.QueryRowContext(ctx, `SELECT id, amount FROM keagent_credit_hold WHERE owner_id=$1 AND op=$2 AND idem_key=$3 AND state='held'`, ownerID, op, idemKey).Scan(&holdID, &amount)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if capture {
		return s.captureHold(ctx, holdID, amount)
	}
	return s.releaseHold(ctx, holdID)
}

func scanHoldRow(row *sql.Row) (creditHold, error) {
	var h creditHold
	var allocationRaw, metadataRaw []byte
	err := row.Scan(&h.ID, &h.OwnerID, &h.Op, &h.RefID, &h.Amount, &h.State, &allocationRaw, &h.IdemKey, &h.PriceVersion, &metadataRaw, &h.CreatedAt, &h.SettledAt)
	if err != nil {
		return h, err
	}
	_ = json.Unmarshal(allocationRaw, &h.Allocation)
	h.Metadata = object{}
	_ = json.Unmarshal(metadataRaw, &h.Metadata)
	return h, nil
}

func lockHold(ctx context.Context, q rowQuerier, holdID string) (creditHold, error) {
	return scanHoldRow(q.QueryRowContext(ctx, `SELECT id,owner_id,op,ref_id,amount,state,allocation,idem_key,price_version,metadata,created_at,settled_at FROM keagent_credit_hold WHERE id=$1 FOR UPDATE`, holdID))
}

func splitAllocation(allocation []creditAllocation, actual int64) (captured, released []creditAllocation) {
	left := actual
	for _, a := range allocation {
		take := a.Amount
		if take > left {
			take = left
		}
		if take > 0 {
			captured = append(captured, creditAllocation{LotID: a.LotID, Amount: take})
			left -= take
		}
		if a.Amount > take {
			released = append(released, creditAllocation{LotID: a.LotID, Amount: a.Amount - take})
		}
	}
	return captured, released
}

// releaseAllocation 把未消耗的冻结额度退回原批次；赠送批次已过期的，退回金额转为充值积分。
func releaseAllocation(ctx context.Context, tx *sql.Tx, ownerID, holdID string, allocation []creditAllocation) error {
	for _, a := range allocation {
		var kind string
		var expires sql.NullTime
		if err := tx.QueryRowContext(ctx, `SELECT kind, expires_at FROM keagent_credit_lot WHERE id=$1 AND owner_id=$2 FOR UPDATE`, a.LotID, ownerID).Scan(&kind, &expires); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE keagent_credit_lot SET held=held-$2 WHERE id=$1 AND held>=$2`, a.LotID, a.Amount); err != nil {
			return err
		}
		ledgerLot := a.LotID
		if kind == creditKindGranted && expires.Valid && expires.Time.Before(time.Now()) {
			ledgerLot = id()
			if _, err := tx.ExecContext(ctx, `INSERT INTO keagent_credit_lot(id,owner_id,kind,initial_amount,remaining,expires_at,source,source_ref) VALUES($1,$2,$3,$4,$4,NULL,'release',$5)`, ledgerLot, ownerID, creditKindPurchased, a.Amount, holdID); err != nil {
				return err
			}
		} else {
			if _, err := tx.ExecContext(ctx, `UPDATE keagent_credit_lot SET remaining=remaining+$2 WHERE id=$1`, a.LotID, a.Amount); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO keagent_credit_ledger(id,owner_id,kind,lot_id,amount,ref_id) VALUES($1,$2,'release',$3,$4,$5)`, id(), ownerID, ledgerLot, a.Amount, holdID); err != nil {
			return err
		}
	}
	return nil
}

// holdCredits 冻结积分。幂等键 (owner, op, idemKey) 已存在时直接返回原冻结单，
// 调用方需按返回的 State 决定是否继续调用供应商：held 才可以发起，captured 表示已结算成功。
func (s *server) holdCredits(ctx context.Context, ownerID, op, refID string, amount int64, idemKey, priceVersion string, meta object) (creditHold, error) {
	if !creditOps[op] {
		return creditHold{}, fail(422, "计费操作无效")
	}
	if amount <= 0 {
		return creditHold{}, fail(422, "冻结积分必须大于零")
	}
	if idemKey == "" || len(idemKey) > 128 {
		return creditHold{}, fail(422, "幂等键无效")
	}
	if meta == nil {
		meta = object{}
	}
	for attempt := 0; attempt < 2; attempt++ {
		hold, retryable, err := s.holdCreditsOnce(ctx, ownerID, op, refID, amount, idemKey, priceVersion, meta)
		if err == nil || !retryable {
			return hold, err
		}
	}
	return creditHold{}, errors.New("积分冻结重试后仍未成功")
}

func (s *server) holdCreditsOnce(ctx context.Context, ownerID, op, refID string, amount int64, idemKey, priceVersion string, meta object) (hold creditHold, retryable bool, err error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return creditHold{}, false, err
	}
	defer tx.Rollback()
	existing, scanErr := scanHoldRow(tx.QueryRowContext(ctx, `SELECT id,owner_id,op,ref_id,amount,state,allocation,idem_key,price_version,metadata,created_at,settled_at FROM keagent_credit_hold WHERE owner_id=$1 AND op=$2 AND idem_key=$3 AND state<>'released'`, ownerID, op, idemKey))
	if scanErr == nil {
		return existing, false, nil
	}
	if !errors.Is(scanErr, sql.ErrNoRows) {
		return creditHold{}, false, scanErr
	}
	if _, err = expireCreditsTx(ctx, tx, ownerID); err != nil {
		return creditHold{}, false, err
	}
	// 先扣将过期的赠送积分，再扣充值积分；FOR UPDATE 保证并发下批次按同一顺序锁定。
	rows, err := tx.QueryContext(ctx, `SELECT id, remaining FROM keagent_credit_lot WHERE owner_id=$1 AND remaining>0 ORDER BY expires_at ASC NULLS LAST, created_at ASC FOR UPDATE`, ownerID)
	if err != nil {
		return creditHold{}, false, err
	}
	type lotAmount struct {
		id        string
		remaining int64
	}
	var lots []lotAmount
	for rows.Next() {
		var l lotAmount
		if err = rows.Scan(&l.id, &l.remaining); err != nil {
			rows.Close()
			return creditHold{}, false, err
		}
		lots = append(lots, l)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return creditHold{}, false, err
	}
	allocation := []creditAllocation{}
	remaining := amount
	for _, l := range lots {
		if remaining == 0 {
			break
		}
		take := l.remaining
		if take > remaining {
			take = remaining
		}
		if _, err = tx.ExecContext(ctx, `UPDATE keagent_credit_lot SET remaining=remaining-$2, held=held+$2 WHERE id=$1`, l.id, take); err != nil {
			return creditHold{}, false, err
		}
		allocation = append(allocation, creditAllocation{LotID: l.id, Amount: take})
		remaining -= take
	}
	if remaining > 0 {
		// 并发同幂等键可能在等锁期间已被其它事务创建，重新检查后再判不足。
		existing, existingErr := scanHoldRow(tx.QueryRowContext(ctx, `SELECT id,owner_id,op,ref_id,amount,state,allocation,idem_key,price_version,metadata,created_at,settled_at FROM keagent_credit_hold WHERE owner_id=$1 AND op=$2 AND idem_key=$3`, ownerID, op, idemKey))
		if existingErr == nil {
			return existing, false, nil
		}
		if !errors.Is(existingErr, sql.ErrNoRows) {
			return creditHold{}, false, existingErr
		}
		return creditHold{}, false, creditFail(402, "CREDITS_INSUFFICIENT", "积分不足，请先充值或兑换")
	}
	holdID := id()
	if _, err = tx.ExecContext(ctx, `INSERT INTO keagent_credit_hold(id,owner_id,op,ref_id,amount,state,allocation,idem_key,price_version,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, holdID, ownerID, op, refID, amount, creditStateHeld, mustJSON(allocation), idemKey, priceVersion, mustJSON(meta)); err != nil {
		if isUniqueViolation(err) {
			return creditHold{}, true, nil // 并发同幂等键：重试读取已有冻结单
		}
		return creditHold{}, false, err
	}
	for _, a := range allocation {
		if _, err = tx.ExecContext(ctx, `INSERT INTO keagent_credit_ledger(id,owner_id,kind,lot_id,amount,op,ref_id,idem_key,price_version,metadata) VALUES($1,$2,'hold',$3,$4,$5,$6,$7,$8,$9)`, id(), ownerID, a.LotID, -a.Amount, op, refID, idemKey, priceVersion, mustJSON(meta)); err != nil {
			return creditHold{}, false, err
		}
	}
	if err = tx.Commit(); err != nil {
		return creditHold{}, false, err
	}
	return creditHold{ID: holdID, OwnerID: ownerID, Op: op, RefID: refID, Amount: amount, State: creditStateHeld, Allocation: allocation, IdemKey: idemKey, PriceVersion: priceVersion, Metadata: meta}, false, nil
}

// captureHold 结算冻结单：actual 为实际消耗，差额退回；actual 为 0 表示全额释放。
// 已结算的冻结单重复结算直接返回成功（幂等）。
func (s *server) captureHold(ctx context.Context, holdID string, actual int64) error {
	if actual < 0 {
		return fail(422, "结算金额无效")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	hold, err := lockHold(ctx, tx, holdID)
	if err != nil {
		return err
	}
	switch hold.State {
	case creditStateCaptured:
		return nil
	case creditStateReleased:
		return fail(409, "扣费单已释放，不能结算")
	}
	if actual > hold.Amount {
		return fail(422, "结算金额不能超过冻结金额")
	}
	captured, released := splitAllocation(hold.Allocation, actual)
	for _, a := range captured {
		if _, err = tx.ExecContext(ctx, `UPDATE keagent_credit_lot SET held=held-$2 WHERE id=$1 AND held>=$2`, a.LotID, a.Amount); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO keagent_credit_ledger(id,owner_id,kind,lot_id,amount,op,ref_id,idem_key,metadata) VALUES($1,$2,'capture',$3,0,$4,$5,$6,$7)`, id(), hold.OwnerID, a.LotID, hold.Op, hold.RefID, hold.IdemKey, mustJSON(object{"spent": a.Amount})); err != nil {
			return err
		}
	}
	if err = releaseAllocation(ctx, tx, hold.OwnerID, hold.ID, released); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE keagent_credit_hold SET state=$2, settled_at=now(), allocation=$3 WHERE id=$1`, hold.ID, creditStateCaptured, mustJSON(captured)); err != nil {
		return err
	}
	return tx.Commit()
}

// releaseHold 全额释放冻结单。已释放的重复释放直接返回成功（幂等）。
func (s *server) releaseHold(ctx context.Context, holdID string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	hold, err := lockHold(ctx, tx, holdID)
	if err != nil {
		return err
	}
	switch hold.State {
	case creditStateReleased:
		return nil
	case creditStateCaptured:
		return fail(409, "扣费单已结算，不能释放")
	}
	if err = releaseAllocation(ctx, tx, hold.OwnerID, hold.ID, hold.Allocation); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE keagent_credit_hold SET state=$2, settled_at=now() WHERE id=$1`, hold.ID, creditStateReleased); err != nil {
		return err
	}
	return tx.Commit()
}

// adjustCredits 后台差错调整：正数发放充值积分，负数按“先扣将过期的”从可用余额直接扣减（不动冻结中的额度）。
func (s *server) adjustCredits(ctx context.Context, ownerID string, delta int64, operatorID, note string) (object, error) {
	if strings.TrimSpace(note) == "" {
		return nil, fail(422, "调整必须填写备注")
	}
	if delta == 0 {
		return nil, fail(422, "调整数额不能为零")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	metadata := mustJSON(object{"note": note})
	if delta > 0 {
		lotID := id()
		if _, err = tx.ExecContext(ctx, `INSERT INTO keagent_credit_lot(id,owner_id,kind,initial_amount,remaining,source,source_ref) VALUES($1,$2,$3,$4,$4,'admin_grant','')`, lotID, ownerID, creditKindPurchased, delta); err != nil {
			return nil, err
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO keagent_credit_ledger(id,owner_id,kind,lot_id,amount,operator_id,metadata) VALUES($1,$2,'adjust',$3,$4,$5,$6)`, id(), ownerID, lotID, delta, operatorID, metadata); err != nil {
			return nil, err
		}
	} else {
		if _, err = expireCreditsTx(ctx, tx, ownerID); err != nil {
			return nil, err
		}
		need := -delta
		rows, err := tx.QueryContext(ctx, `SELECT id, remaining FROM keagent_credit_lot WHERE owner_id=$1 AND remaining>0 ORDER BY expires_at ASC NULLS LAST, created_at ASC FOR UPDATE`, ownerID)
		if err != nil {
			return nil, err
		}
		type lotAmount struct {
			id        string
			remaining int64
		}
		var lots []lotAmount
		for rows.Next() {
			var l lotAmount
			if err = rows.Scan(&l.id, &l.remaining); err != nil {
				rows.Close()
				return nil, err
			}
			lots = append(lots, l)
		}
		rows.Close()
		if err = rows.Err(); err != nil {
			return nil, err
		}
		for _, l := range lots {
			if need == 0 {
				break
			}
			take := l.remaining
			if take > need {
				take = need
			}
			if _, err = tx.ExecContext(ctx, `UPDATE keagent_credit_lot SET remaining=remaining-$2 WHERE id=$1`, l.id, take); err != nil {
				return nil, err
			}
			if _, err = tx.ExecContext(ctx, `INSERT INTO keagent_credit_ledger(id,owner_id,kind,lot_id,amount,operator_id,metadata) VALUES($1,$2,'adjust',$3,$4,$5,$6)`, id(), ownerID, l.id, -take, operatorID, metadata); err != nil {
				return nil, err
			}
			need -= take
		}
		if need > 0 {
			return nil, creditFail(402, "CREDITS_INSUFFICIENT", "可用积分不足以完成该调整")
		}
	}
	var balance int64
	if err = tx.QueryRowContext(ctx, `SELECT COALESCE(SUM(remaining),0) FROM keagent_credit_lot WHERE owner_id=$1`, ownerID).Scan(&balance); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return object{"balance": balance}, nil
}

// redeemCreditCode 兑换兑换码：单条 UPDATE 原子认领，天然幂等（重复兑换直接失败）。
func (s *server) redeemCreditCode(ctx context.Context, ownerID, rawCode string) (object, error) {
	code := strings.ToUpper(strings.TrimSpace(rawCode))
	if !creditCodePattern.MatchString(code) {
		return nil, fail(422, "兑换码格式无效")
	}
	sum := sha256.Sum256([]byte(code))
	codeHash := hex.EncodeToString(sum[:])
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var amount int64
	var batchID string
	err = tx.QueryRowContext(ctx, `UPDATE keagent_credit_code SET used_by=$2, used_at=now() WHERE code_hash=$1 AND used_by='' AND (expires_at IS NULL OR expires_at>now()) RETURNING amount, batch_id`, codeHash, ownerID).Scan(&amount, &batchID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fail(422, "兑换码无效、已使用或已过期")
	}
	if err != nil {
		return nil, err
	}
	lotID := id()
	if _, err = tx.ExecContext(ctx, `INSERT INTO keagent_credit_lot(id,owner_id,kind,initial_amount,remaining,source,source_ref) VALUES($1,$2,$3,$4,$4,'code',$5)`, lotID, ownerID, creditKindPurchased, amount, batchID); err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO keagent_credit_ledger(id,owner_id,kind,lot_id,amount,ref_id,metadata) VALUES($1,$2,'redeem',$3,$4,$5,$6)`, id(), ownerID, lotID, amount, batchID, mustJSON(object{"codeHash": codeHash[:12]})); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return object{"amount": amount, "batchId": batchID}, nil
}

// creditSummary 用户余额总览：先清扫过期，再汇总各类余额与最近流水。
func (s *server) creditSummary(ctx context.Context, ownerID string) (object, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err = expireCreditsTx(ctx, tx, ownerID); err != nil {
		return nil, err
	}
	summary := object{
		"purchased": object{"available": int64(0), "held": int64(0)},
		"granted":   object{"available": int64(0), "held": int64(0)},
	}
	balanceRows, err := tx.QueryContext(ctx, `SELECT kind, COALESCE(SUM(remaining),0), COALESCE(SUM(held),0) FROM keagent_credit_lot WHERE owner_id=$1 GROUP BY kind`, ownerID)
	if err != nil {
		return nil, err
	}
	for balanceRows.Next() {
		var kind string
		var available, held int64
		if err = balanceRows.Scan(&kind, &available, &held); err != nil {
			balanceRows.Close()
			return nil, err
		}
		summary[kind] = object{"available": available, "held": held}
	}
	balanceRows.Close()
	if err = balanceRows.Err(); err != nil {
		return nil, err
	}
	granted := summary[creditKindGranted].(object)
	var nextExpiry sql.NullTime
	if err = tx.QueryRowContext(ctx, `SELECT MIN(expires_at) FROM keagent_credit_lot WHERE owner_id=$1 AND kind='granted' AND remaining>0`, ownerID).Scan(&nextExpiry); err != nil {
		return nil, err
	}
	if nextExpiry.Valid {
		granted["nextExpiry"] = nextExpiry.Time.UTC().Format(time.RFC3339)
	}
	ledgerRows, err := tx.QueryContext(ctx, `SELECT kind, amount, op, ref_id, metadata, created_at FROM keagent_credit_ledger WHERE owner_id=$1 ORDER BY created_at DESC, id DESC LIMIT 20`, ownerID)
	if err != nil {
		return nil, err
	}
	entries := []any{}
	for ledgerRows.Next() {
		var kind string
		var amount int64
		var op, refID string
		var metadataRaw []byte
		var createdAt time.Time
		if err = ledgerRows.Scan(&kind, &amount, &op, &refID, &metadataRaw, &createdAt); err != nil {
			ledgerRows.Close()
			return nil, err
		}
		meta := object{}
		_ = json.Unmarshal(metadataRaw, &meta)
		entries = append(entries, object{"kind": kind, "amount": amount, "op": op, "refId": refID, "metadata": meta, "createdAt": createdAt.UTC().Format(time.RFC3339Nano)})
	}
	ledgerRows.Close()
	if err = ledgerRows.Err(); err != nil {
		return nil, err
	}
	summary["ledger"] = entries
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return summary, nil
}

// maybeGrantWelcomeCredits 按后台配置发放新用户欢迎赠送积分。
// 必须在播种工作区的同一事务内、且仅在确认是新账号时调用一次；配置缺失或关闭时静默跳过。
func maybeGrantWelcomeCredits(ctx context.Context, tx *sql.Tx, ownerID string) error {
	var raw []byte
	err := tx.QueryRowContext(ctx, `SELECT payload FROM keagent_setting WHERE id='credit_welcome'`).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	var cfg struct {
		Enabled      bool  `json:"enabled"`
		Amount       int64 `json:"amount"`
		ValidityDays int64 `json:"validityDays"`
	}
	if json.Unmarshal(raw, &cfg) != nil {
		return nil
	}
	if !cfg.Enabled || cfg.Amount <= 0 {
		return nil
	}
	days := cfg.ValidityDays
	if days <= 0 {
		days = 30
	}
	expires := time.Now().AddDate(0, 0, int(days))
	_, err = grantCredits(ctx, tx, ownerID, creditKindGranted, cfg.Amount, "welcome", "", &expires, "", "新用户欢迎赠送")
	return err
}
