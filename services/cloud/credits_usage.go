package main

import (
	"context"
	"net/url"
	"sort"
	"time"
)

func (s *server) creditUsage(ctx context.Context, query url.Values, ownerID *string) (any, error) {
	var dates [2]time.Time
	for i, key := range []string{"from", "to"} {
		values := query[key]
		if len(values) != 1 {
			return nil, fail(422, "请提供开始和结束日期（YYYY-MM-DD）")
		}
		date, err := time.Parse("2006-01-02Z07:00", values[0]+"+08:00")
		if err != nil || date.Year() < 1 {
			return nil, fail(422, "日期格式必须为 YYYY-MM-DD")
		}
		dates[i] = date
	}
	if dates[0].After(dates[1]) {
		return nil, fail(422, "开始日期不能晚于结束日期")
	}
	// 按北京时间包含首尾两天；只累计结算消耗，冻结与退回不计入。
	statement := `
SELECT op, COALESCE(SUM((metadata->>'spent')::bigint),0)
FROM keagent_credit_ledger
WHERE kind='capture' AND created_at >= $1 AND created_at < $2
`
	args := []any{dates[0], dates[1].AddDate(0, 0, 1)}
	if ownerID != nil {
		statement += " AND owner_id=$3"
		args = append(args, *ownerID)
	}
	result, err := s.db.QueryContext(ctx, statement+" GROUP BY op", args...)
	if err != nil {
		return nil, err
	}
	defer result.Close()
	// 仅对仍在计费的服务补零，已下线服务只显示流水中的历史消耗。
	spentByOp := make(map[string]int64, len(creditOps))
	for op := range creditOps {
		spentByOp[op] = 0
	}
	var total int64
	for result.Next() {
		var op string
		var spent int64
		if err = result.Scan(&op, &spent); err != nil {
			return nil, err
		}
		spentByOp[op] = spent
		total += spent
	}
	if err = result.Err(); err != nil {
		return nil, err
	}
	ops := make([]string, 0, len(spentByOp))
	for op := range spentByOp {
		ops = append(ops, op)
	}
	sort.Strings(ops)
	items := make([]any, 0, len(ops))
	for _, op := range ops {
		items = append(items, object{"op": op, "spent": spentByOp[op]})
	}
	return object{"items": items, "total": total}, nil
}
