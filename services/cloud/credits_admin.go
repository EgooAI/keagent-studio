package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// adminCredits 管理后台积分能力：余额与流水查询、发放、差错调整、对账收尾、
// 价目与欢迎赠送配置、兑换码批次生成与查询。所有写操作写 keagent_audit。
func (s *server) adminCredits(r *http.Request, a actor, kind string, body []byte) (any, error) {
	ctx := r.Context()
	query := r.URL.Query()
	switch r.Method {
	case "GET":
		switch kind {
		case "credits/usage":
			return s.creditUsage(ctx, query, nil)
		case "credits/packs":
			return readCreditPilot(ctx, s.db)
		case "credits/pack-stats":
			return s.creditPackStatistics(ctx)
		case "credits/quote-stats":
			return s.creditPilotQuoteStats(ctx)
		case "credits/list":
			return s.adminCreditList(ctx, query)
		case "credits/holds":
			return s.adminCreditHolds(ctx)
		case "credits/pricing":
			prices, version, err := readCreditPricing(ctx, s.db)
			if err != nil {
				return nil, err
			}
			return object{"prices": prices, "version": version}, nil
		case "credits/welcome":
			return adminReadSetting(ctx, s.db, "credit_welcome", object{"enabled": false, "amount": int64(0), "validityDays": 30})
		case "credit-codes":
			return s.adminCreditCodeBatches(ctx)
		}
	case "PUT", "POST":
		if kind == "credits/packs" {
			return s.updateCreditPilot(ctx, a, body)
		}
		var input object
		if json.Unmarshal(body, &input) != nil {
			return nil, fail(400, "参数无效")
		}
		switch kind {
		case "credits/pricing":
			return s.adminCreditPricingUpdate(ctx, a, input)
		case "credits/welcome":
			return s.adminCreditWelcomeUpdate(ctx, a, input)
		case "credits/grant":
			return s.adminCreditGrant(ctx, a, input)
		case "credits/adjust":
			return s.adminCreditAdjust(ctx, a, input)
		case "credits/settle":
			return s.adminCreditSettle(ctx, a, input)
		case "credit-codes":
			return s.adminCreditCodesCreate(ctx, a, input)
		}
	}
	return nil, fail(404, "管理接口不存在")
}

func adminReadSetting(ctx context.Context, db *sql.DB, settingID string, fallback object) (object, error) {
	var raw []byte
	err := db.QueryRowContext(ctx, `SELECT payload FROM keagent_setting WHERE id=$1`, settingID).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return fallback, nil
	}
	if err != nil {
		return nil, err
	}
	var v object
	if json.Unmarshal(raw, &v) != nil {
		return fallback, nil
	}
	return v, nil
}

func writeCreditAudit(ctx context.Context, exec interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}, actorID, action, targetID string, metadata object) error {
	b, _ := json.Marshal(metadata)
	_, err := exec.ExecContext(ctx, `INSERT INTO keagent_audit(id,actor_id,action,target_id,metadata) VALUES($1,$2,$3,$4,$5)`, id(), actorID, action, targetID, b)
	return err
}

func requireCreditUser(ctx context.Context, tx *sql.Tx, ownerID string) error {
	var exists bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM "user" WHERE id=$1)`, ownerID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return fail(404, "用户不存在")
	}
	return nil
}

func (s *server) adminCreditList(ctx context.Context, query url.Values) (any, error) {
	if ownerID := strings.TrimSpace(query.Get("ownerId")); ownerID != "" {
		return s.adminCreditOwnerDetail(ctx, ownerID)
	}
	limit, offset := 20, 0
	if v, err := strconvAtoiLimit(query.Get("limit"), 100); err == nil && v > 0 {
		limit = int(v)
	}
	if v, err := strconvAtoiLimit(query.Get("offset"), 1<<30); err == nil && v >= 0 {
		offset = int(v)
	}
	var total int64
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(DISTINCT owner_id) FROM keagent_credit_lot`).Scan(&total); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT l.owner_id, u.name, u.email,
       COALESCE(SUM(CASE WHEN l.kind='purchased' THEN l.remaining ELSE 0 END),0),
       COALESCE(SUM(CASE WHEN l.kind='purchased' THEN l.held ELSE 0 END),0),
       COALESCE(SUM(CASE WHEN l.kind='granted' THEN l.remaining ELSE 0 END),0),
       COALESCE(SUM(CASE WHEN l.kind='granted' THEN l.held ELSE 0 END),0),
       MIN(CASE WHEN l.kind='granted' AND l.remaining>0 THEN l.expires_at END)
FROM keagent_credit_lot l LEFT JOIN "user" u ON u.id=l.owner_id
GROUP BY l.owner_id, u.name, u.email
ORDER BY l.owner_id LIMIT $1 OFFSET $2`, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []any{}
	for rows.Next() {
		var ownerID, name, email sql.NullString
		var purchasedAvailable, purchasedHeld, grantedAvailable, grantedHeld int64
		var nextExpiry sql.NullTime
		if err = rows.Scan(&ownerID, &name, &email, &purchasedAvailable, &purchasedHeld, &grantedAvailable, &grantedHeld, &nextExpiry); err != nil {
			return nil, err
		}
		item := object{
			"ownerId": ownerID.String, "name": name.String, "email": email.String,
			"purchasedAvailable": purchasedAvailable, "purchasedHeld": purchasedHeld,
			"grantedAvailable": grantedAvailable, "grantedHeld": grantedHeld,
		}
		if nextExpiry.Valid {
			item["nextExpiry"] = nextExpiry.Time.UTC().Format(time.RFC3339)
		}
		items = append(items, item)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	return object{"items": items, "total": total, "limit": limit, "offset": offset}, nil
}

func (s *server) adminCreditOwnerDetail(ctx context.Context, ownerID string) (any, error) {
	detail := object{"ownerId": ownerID}
	lotRows, err := s.db.QueryContext(ctx, `
SELECT id, kind, initial_amount, remaining, held, expires_at, source, created_at
FROM keagent_credit_lot WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 100`, ownerID)
	if err != nil {
		return nil, err
	}
	lots := []any{}
	for lotRows.Next() {
		var lotID, kind, source string
		var initialAmount, remaining, held int64
		var expires sql.NullTime
		var createdAt time.Time
		if err = lotRows.Scan(&lotID, &kind, &initialAmount, &remaining, &held, &expires, &source, &createdAt); err != nil {
			lotRows.Close()
			return nil, err
		}
		lot := object{"id": lotID, "kind": kind, "initialAmount": initialAmount, "remaining": remaining, "held": held, "source": source, "createdAt": createdAt.UTC().Format(time.RFC3339)}
		if expires.Valid {
			lot["expiresAt"] = expires.Time.UTC().Format(time.RFC3339)
		}
		lots = append(lots, lot)
	}
	lotRows.Close()
	if err = lotRows.Err(); err != nil {
		return nil, err
	}
	detail["lots"] = lots

	holdRows, err := s.db.QueryContext(ctx, `
SELECT id, op, ref_id, amount, state, idem_key, created_at, settled_at
FROM keagent_credit_hold WHERE owner_id=$1
ORDER BY created_at DESC LIMIT 50`, ownerID)
	if err != nil {
		return nil, err
	}
	holds := []any{}
	for holdRows.Next() {
		var holdID, op, refID, state, idemKey string
		var amount int64
		var createdAt time.Time
		var settled sql.NullTime
		if err = holdRows.Scan(&holdID, &op, &refID, &amount, &state, &idemKey, &createdAt, &settled); err != nil {
			holdRows.Close()
			return nil, err
		}
		hold := object{"id": holdID, "op": op, "refId": refID, "amount": amount, "state": state, "idemKey": idemKey, "createdAt": createdAt.UTC().Format(time.RFC3339)}
		if settled.Valid {
			hold["settledAt"] = settled.Time.UTC().Format(time.RFC3339)
		}
		holds = append(holds, hold)
	}
	holdRows.Close()
	if err = holdRows.Err(); err != nil {
		return nil, err
	}
	detail["holds"] = holds

	ledgerRows, err := s.db.QueryContext(ctx, `
SELECT kind, amount, op, ref_id, operator_id, metadata, created_at
FROM keagent_credit_ledger WHERE owner_id=$1
ORDER BY created_at DESC, id DESC LIMIT 50`, ownerID)
	if err != nil {
		return nil, err
	}
	ledger := []any{}
	for ledgerRows.Next() {
		var kind, op, refID, operatorID string
		var amount int64
		var metadataRaw []byte
		var createdAt time.Time
		if err = ledgerRows.Scan(&kind, &amount, &op, &refID, &operatorID, &metadataRaw, &createdAt); err != nil {
			ledgerRows.Close()
			return nil, err
		}
		meta := object{}
		_ = json.Unmarshal(metadataRaw, &meta)
		ledger = append(ledger, object{"kind": kind, "amount": amount, "op": op, "refId": refID, "operatorId": operatorID, "metadata": meta, "createdAt": createdAt.UTC().Format(time.RFC3339)})
	}
	ledgerRows.Close()
	if err = ledgerRows.Err(); err != nil {
		return nil, err
	}
	detail["ledger"] = ledger
	return detail, nil
}

func (s *server) adminCreditHolds(ctx context.Context) (any, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT h.id, h.owner_id, u.name, u.email, h.op, h.ref_id, h.amount, h.idem_key, h.price_version, h.created_at
FROM keagent_credit_hold h LEFT JOIN "user" u ON u.id=h.owner_id
WHERE h.state='held' ORDER BY h.created_at DESC LIMIT 100`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []any{}
	for rows.Next() {
		var holdID, ownerID, op, refID, idemKey, priceVersion string
		var name, email sql.NullString
		var amount int64
		var createdAt time.Time
		if err = rows.Scan(&holdID, &ownerID, &name, &email, &op, &refID, &amount, &idemKey, &priceVersion, &createdAt); err != nil {
			return nil, err
		}
		items = append(items, object{
			"id": holdID, "ownerId": ownerID, "name": name.String, "email": email.String,
			"op": op, "refId": refID, "amount": amount, "idemKey": idemKey,
			"priceVersion": priceVersion, "createdAt": createdAt.UTC().Format(time.RFC3339),
		})
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}

func (s *server) adminCreditGrant(ctx context.Context, a actor, input object) (any, error) {
	ownerID, kind := str(input["ownerId"]), str(input["kind"])
	amount := int64(number(input["amount"]))
	days := int(number(input["validityDays"]))
	note := strings.TrimSpace(str(input["note"]))
	if ownerID == "" || note == "" {
		return nil, fail(422, "发放必须指定用户并填写备注")
	}
	if kind != creditKindPurchased && kind != creditKindGranted {
		return nil, fail(422, "积分类别无效")
	}
	if amount <= 0 || amount > 10_000_000 {
		return nil, fail(422, "发放数额无效")
	}
	var expires *time.Time
	if kind == creditKindGranted {
		if days <= 0 || days > 3650 {
			return nil, fail(422, "赠送积分必须设置 1–3650 天有效期")
		}
		at := time.Now().AddDate(0, 0, days)
		expires = &at
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err = requireCreditUser(ctx, tx, ownerID); err != nil {
		return nil, err
	}
	lotID, err := grantCredits(ctx, tx, ownerID, kind, amount, "admin_grant", "", expires, a.UserID, note)
	if err != nil {
		return nil, err
	}
	if err = writeCreditAudit(ctx, tx, a.UserID, "credit.grant", ownerID, object{"kind": kind, "amount": amount, "validityDays": days, "note": note, "lotId": lotID}); err != nil {
		return nil, err
	}
	var balance int64
	if err = tx.QueryRowContext(ctx, `SELECT COALESCE(SUM(remaining),0) FROM keagent_credit_lot WHERE owner_id=$1`, ownerID).Scan(&balance); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return object{"lotId": lotID, "balance": balance}, nil
}

func (s *server) adminCreditAdjust(ctx context.Context, a actor, input object) (any, error) {
	ownerID := str(input["ownerId"])
	delta := int64(number(input["delta"]))
	note := strings.TrimSpace(str(input["note"]))
	if ownerID == "" {
		return nil, fail(422, "调整必须指定用户")
	}
	var exists bool
	if err := s.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM "user" WHERE id=$1)`, ownerID).Scan(&exists); err != nil {
		return nil, err
	}
	if !exists {
		return nil, fail(404, "用户不存在")
	}
	result, err := s.adjustCredits(ctx, ownerID, delta, a.UserID, note)
	if err != nil {
		return nil, err
	}
	if err = writeCreditAudit(ctx, s.db, a.UserID, "credit.adjust", ownerID, object{"delta": delta, "note": note}); err != nil {
		return nil, err
	}
	return result, nil
}

func (s *server) adminCreditSettle(ctx context.Context, a actor, input object) (any, error) {
	holdID := str(input["holdId"])
	action := str(input["action"])
	if holdID == "" || (action != "capture" && action != "release") {
		return nil, fail(422, "对账必须指定冻结单和操作（capture/release）")
	}
	var ownerID, state string
	var amount int64
	err := s.db.QueryRowContext(ctx, `SELECT owner_id, amount, state FROM keagent_credit_hold WHERE id=$1`, holdID).Scan(&ownerID, &amount, &state)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fail(404, "冻结单不存在")
	}
	if err != nil {
		return nil, err
	}
	if state != creditStateHeld {
		return nil, fail(409, "冻结单已收尾，无需处理")
	}
	if action == "capture" {
		err = s.captureHold(ctx, holdID, amount)
	} else {
		err = s.releaseHold(ctx, holdID)
	}
	if err != nil {
		return nil, err
	}
	if err = writeCreditAudit(ctx, s.db, a.UserID, "credit.settle."+action, ownerID, object{"holdId": holdID, "amount": amount}); err != nil {
		return nil, err
	}
	return object{"holdId": holdID, "state": map[string]string{"capture": creditStateCaptured, "release": creditStateReleased}[action]}, nil
}

var creditCodeAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

func newCreditCode() string {
	raw := make([]byte, 16)
	for i := range raw {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(creditCodeAlphabet))))
		if err != nil {
			panic(err)
		}
		raw[i] = creditCodeAlphabet[n.Int64()]
	}
	groups := make([]string, 4)
	for i := range groups {
		groups[i] = string(raw[i*4 : i*4+4])
	}
	return "KECODE-" + strings.Join(groups, "-")
}

func (s *server) adminCreditCodesCreate(ctx context.Context, a actor, input object) (any, error) {
	packID := str(input["packId"])
	amount := int64(number(input["amount"]))
	count := int(number(input["count"]))
	days := int(number(input["validityDays"]))
	note := strings.TrimSpace(str(input["note"]))
	if packID == "" && (amount <= 0 || amount > 10_000_000) {
		return nil, fail(422, "兑换码面额无效")
	}
	if count <= 0 || count > 500 {
		return nil, fail(422, "单批生成 1–500 个兑换码")
	}
	var expires any
	if days > 0 {
		if days > 3650 {
			return nil, fail(422, "兑换截止须为 1–3650 天")
		}
		expires = time.Now().AddDate(0, 0, days)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	batchID := id()
	audit := object{"count": count, "amount": amount, "validityDays": days, "note": note}
	if packID != "" {
		pilot, err := readCreditPilot(ctx, tx)
		if err != nil {
			return nil, err
		}
		pack, err := pilot.availablePack(packID)
		if err != nil {
			return nil, err
		}
		amount = pack.Credits
		if _, err = tx.ExecContext(ctx, `INSERT INTO keagent_credit_pack_batch(batch_id,pack_id,price_fen) VALUES($1,$2,$3)`, batchID, pack.ID, pack.PriceFen); err != nil {
			return nil, err
		}
		audit["packId"], audit["amount"], audit["priceFen"] = pack.ID, amount, pack.PriceFen
	}
	codes := make([]string, 0, count)
	for range count {
		code := newCreditCode()
		sum := sha256.Sum256([]byte(code))
		if _, err = tx.ExecContext(ctx, `INSERT INTO keagent_credit_code(batch_id, code_hash, amount, expires_at, note) VALUES($1,$2,$3,$4,$5)`, batchID, hex.EncodeToString(sum[:]), amount, expires, note); err != nil {
			return nil, err
		}
		codes = append(codes, code)
	}
	if err = writeCreditAudit(ctx, tx, a.UserID, "credit.code.create", batchID, audit); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	result := object{"batchId": batchID, "codes": codes, "amount": amount}
	if days > 0 {
		result["expiresAt"] = time.Now().AddDate(0, 0, days).UTC().Format(time.RFC3339)
	}
	return result, nil
}

func (s *server) adminCreditCodeBatches(ctx context.Context) (any, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT batch_id, amount, note, MAX(created_at), MIN(expires_at), COUNT(*),
       COUNT(CASE WHEN used_by<>'' THEN 1 END), b.pack_id, b.price_fen
 FROM keagent_credit_code c LEFT JOIN keagent_credit_pack_batch b USING (batch_id)
 GROUP BY batch_id, amount, note, b.pack_id, b.price_fen
ORDER BY MAX(created_at) DESC LIMIT 100`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []any{}
	for rows.Next() {
		var batchID, note string
		var amount, total, used int64
		var createdAt time.Time
		var expires sql.NullTime
		var packID sql.NullString
		var priceFen sql.NullInt64
		if err = rows.Scan(&batchID, &amount, &note, &createdAt, &expires, &total, &used, &packID, &priceFen); err != nil {
			return nil, err
		}
		item := object{"batchId": batchID, "amount": amount, "note": note, "total": total, "used": used, "createdAt": createdAt.UTC().Format(time.RFC3339)}
		if packID.Valid {
			item["packId"] = packID.String
		}
		if priceFen.Valid {
			item["priceFen"] = priceFen.Int64
		}
		if expires.Valid {
			item["expiresAt"] = expires.Time.UTC().Format(time.RFC3339)
		}
		items = append(items, item)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}

func (s *server) adminCreditPricingUpdate(ctx context.Context, a actor, input object) (any, error) {
	pricesInput := obj(input["prices"])
	if pricesInput == nil {
		return nil, fail(422, "价目配置必须包含 prices")
	}
	var raw []byte
	err := s.db.QueryRowContext(ctx, `SELECT payload FROM keagent_setting WHERE id='credit_pricing'`).Scan(&raw)
	currentVersion := int64(0)
	if err == nil {
		var stored struct {
			Version int64 `json:"version"`
		}
		_ = json.Unmarshal(raw, &stored)
		currentVersion = stored.Version
	} else if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	storedPrices := map[string]any{}
	for key, value := range pricesInput {
		if _, known := defaultCreditPrices[key]; !known {
			return nil, fail(422, "未知计费键 "+key)
		}
		price := int64(number(value))
		if price < 0 || price > 1_000_000 {
			return nil, fail(422, "计费键 "+key+" 的单价超出范围")
		}
		storedPrices[key] = price
	}
	next := object{"version": currentVersion + 1, "prices": storedPrices}
	b, _ := json.Marshal(next)
	if _, err = s.db.ExecContext(ctx, `INSERT INTO keagent_setting(id,payload) VALUES('credit_pricing',$1) ON CONFLICT (id) DO UPDATE SET payload=$1`, b); err != nil {
		return nil, err
	}
	if err = writeCreditAudit(ctx, s.db, a.UserID, "credit.pricing.update", "credit_pricing", next); err != nil {
		return nil, err
	}
	prices, version, err := readCreditPricing(ctx, s.db)
	if err != nil {
		return nil, err
	}
	return object{"prices": prices, "version": version}, nil
}

func (s *server) adminCreditWelcomeUpdate(ctx context.Context, a actor, input object) (any, error) {
	enabled := input["enabled"] == true
	amount := int64(number(input["amount"]))
	days := int(number(input["validityDays"]))
	if amount < 0 || amount > 1_000_000 {
		return nil, fail(422, "赠送数额无效")
	}
	if days <= 0 || days > 3650 {
		return nil, fail(422, "赠送有效期须为 1–3650 天")
	}
	next := object{"enabled": enabled, "amount": amount, "validityDays": days}
	b, _ := json.Marshal(next)
	if _, err := s.db.ExecContext(ctx, `INSERT INTO keagent_setting(id,payload) VALUES('credit_welcome',$1) ON CONFLICT (id) DO UPDATE SET payload=$1`, b); err != nil {
		return nil, err
	}
	if err := writeCreditAudit(ctx, s.db, a.UserID, "credit.welcome.update", "credit_welcome", next); err != nil {
		return nil, err
	}
	return next, nil
}

func strconvAtoiLimit(raw string, maxValue int64) (int64, error) {
	if raw == "" {
		return 0, errors.New("空值")
	}
	var value int64
	if _, err := fmt.Sscanf(raw, "%d", &value); err != nil || value < 0 || value > maxValue {
		return 0, errors.New("范围外")
	}
	return value, nil
}
