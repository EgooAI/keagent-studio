package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
)

const creditPilotSchema = `
CREATE TABLE IF NOT EXISTS keagent_credit_pack_batch (
	batch_id text PRIMARY KEY,
	pack_id text NOT NULL CHECK (pack_id IN ('starter','regular')),
	price_fen bigint CHECK (price_fen > 0)
);
CREATE INDEX IF NOT EXISTS keagent_credit_code_batch_idx ON keagent_credit_code(batch_id);
`

const creditPilotSetting = "credit_pack_pilot"

type creditPack struct {
	ID       string `json:"id"`
	Enabled  bool   `json:"enabled"`
	Credits  int64  `json:"credits"`
	PriceFen *int64 `json:"priceFen,omitempty"`
}

type creditPilot struct {
	Instructions        string       `json:"instructions"`
	TypicalVideoCredits int64        `json:"typicalVideoCredits"`
	Packs               []creditPack `json:"packs"`
}

func defaultCreditPilot() creditPilot {
	return creditPilot{Packs: []creditPack{{ID: "starter"}, {ID: "regular"}}}
}

func readCreditPilot(ctx context.Context, q rowQuerier) (creditPilot, error) {
	var raw []byte
	pilot := defaultCreditPilot()
	err := q.QueryRowContext(ctx, `SELECT payload FROM keagent_setting WHERE id=$1`, creditPilotSetting).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return pilot, nil
	}
	if err != nil {
		return pilot, err
	}
	err = json.Unmarshal(raw, &pilot)
	return pilot, err
}

func (p creditPilot) availablePack(id string) (creditPack, error) {
	for _, pack := range p.Packs {
		if pack.ID == id && pack.Enabled {
			return pack, nil
		}
	}
	return creditPack{}, fail(422, "请选择已启用的试点积分包")
}

func (s *server) creditPackOffers(ctx context.Context) (any, error) {
	pilot, err := readCreditPilot(ctx, s.db)
	if err != nil {
		return nil, err
	}
	active := make([]creditPack, 0, len(pilot.Packs))
	for _, pack := range pilot.Packs {
		if pack.Enabled {
			active = append(active, pack)
		}
	}
	if len(active) == 0 {
		return creditPilot{Packs: active}, nil
	}
	pilot.Packs = active
	return pilot, nil
}

func (s *server) updateCreditPilot(ctx context.Context, a actor, body []byte) (any, error) {
	var input creditPilot
	if json.Unmarshal(body, &input) != nil {
		return nil, fail(422, "积分包配置格式无效")
	}
	input.Instructions = strings.TrimSpace(input.Instructions)
	if len([]rune(input.Instructions)) > 500 || input.TypicalVideoCredits < 0 || input.TypicalVideoCredits > 1_000_000 {
		return nil, fail(422, "领取说明或普通视频用量参考超出范围")
	}
	if len(input.Packs) != 2 || input.Packs[0].ID != "starter" || input.Packs[1].ID != "regular" {
		return nil, fail(422, "请同时配置体验包和常用包")
	}
	for _, pack := range input.Packs {
		if pack.Credits < 0 || pack.Credits > 10_000_000 ||
			(pack.PriceFen != nil && (*pack.PriceFen <= 0 || *pack.PriceFen > 100_000_000)) {
			return nil, fail(422, "积分包面额或人民币价格超出范围")
		}
		if pack.Enabled && (pack.Credits == 0 || input.TypicalVideoCredits == 0 || input.Instructions == "") {
			return nil, fail(422, "启用前请填写面额、普通视频用量参考和获取方式")
		}
	}
	starter, regular := input.Packs[0], input.Packs[1]
	if starter.Enabled && regular.Enabled && regular.Credits <= starter.Credits {
		return nil, fail(422, "常用包积分需多于体验包")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `INSERT INTO keagent_setting(id,payload) VALUES($1,$2)
		ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`, creditPilotSetting, mustJSON(input)); err != nil {
		return nil, err
	}
	if err = writeCreditAudit(ctx, tx, a.UserID, "credit.packs.update", creditPilotSetting, object{
		"packs": input.Packs, "typicalVideoCredits": input.TypicalVideoCredits, "instructions": input.Instructions,
	}); err != nil {
		return nil, err
	}
	return input, tx.Commit()
}

type creditPackStats struct {
	ID                 string `json:"id"`
	Issued             int64  `json:"issued"`
	Redeemed           int64  `json:"redeemed"`
	FirstRedeemers     int64  `json:"firstRedeemers"`
	ReturningRedeemers int64  `json:"returningRedeemers"`
}

func (s *server) creditPackStatistics(ctx context.Context) (any, error) {
	rows, err := s.db.QueryContext(ctx, `
WITH pilot_codes AS (
	SELECT b.pack_id,c.used_by,c.used_at,c.code_hash
	FROM keagent_credit_pack_batch b JOIN keagent_credit_code c ON c.batch_id=b.batch_id
),
redemptions AS (
	SELECT pack_id, used_by, ROW_NUMBER() OVER (PARTITION BY used_by ORDER BY used_at,code_hash) AS position
	FROM pilot_codes WHERE used_by <> ''
),
usage AS (
	SELECT pack_id, COUNT(*) AS issued, COUNT(*) FILTER (WHERE used_by <> '') AS redeemed
	FROM pilot_codes GROUP BY pack_id
),
cohort AS (
	SELECT pack_id, COUNT(*) FILTER (WHERE position=1) AS first_redeemers,
		COUNT(DISTINCT used_by) FILTER (WHERE position>1) AS returning_redeemers
	FROM redemptions GROUP BY pack_id
)
SELECT packs.id,COALESCE(u.issued,0),COALESCE(u.redeemed,0),COALESCE(c.first_redeemers,0),COALESCE(c.returning_redeemers,0)
FROM (VALUES ('starter',1),('regular',2)) AS packs(id,sort)
LEFT JOIN usage u ON u.pack_id=packs.id LEFT JOIN cohort c ON c.pack_id=packs.id ORDER BY packs.sort`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]creditPackStats, 0, 2)
	for rows.Next() {
		var item creditPackStats
		if err = rows.Scan(&item.ID, &item.Issued, &item.Redeemed, &item.FirstRedeemers, &item.ReturningRedeemers); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *server) creditPilotQuoteStats(ctx context.Context) (any, error) {
	var sample, aboveEstimate int64
	var averageEstimate, averageSettled, meanAbsoluteDifference float64
	err := s.db.QueryRowContext(ctx, `
WITH quoted AS (
	SELECT DISTINCT ON (owner_id,ref_id) owner_id,ref_id,(metadata->>'estimatedCredits')::bigint AS estimate
	FROM keagent_credit_hold
	WHERE state='captured' AND created_at >= now()-interval '30 days' AND ref_id <> ''
		AND op IN ('script','tts','opening') AND metadata->>'stage' <> ''
		AND metadata->>'estimatedCredits' ~ '^[0-9]{1,8}$'
	ORDER BY owner_id,ref_id,created_at,id
),
amounts AS (
	SELECT q.owner_id,q.ref_id,q.estimate,SUM(`+creditHoldSpentSQL+`) AS settled
	FROM quoted q JOIN keagent_credit_hold h ON h.owner_id=q.owner_id AND h.ref_id=q.ref_id
	WHERE h.state='captured' AND h.op IN ('script','tts','opening') AND h.metadata->>'stage' <> ''
	GROUP BY q.owner_id,q.ref_id,q.estimate
)
SELECT COUNT(*), COUNT(*) FILTER (WHERE settled>estimate),
	COALESCE(AVG(estimate),0),COALESCE(AVG(settled),0),COALESCE(AVG(abs(settled-estimate)),0)
FROM amounts`).Scan(&sample, &aboveEstimate, &averageEstimate, &averageSettled, &meanAbsoluteDifference)
	if err != nil {
		return nil, err
	}
	return object{"sample": sample, "aboveEstimate": aboveEstimate, "averageEstimate": averageEstimate,
		"averageSettled": averageSettled, "meanAbsoluteDifference": meanAbsoluteDifference}, nil
}
