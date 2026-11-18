package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type providerRate struct {
	Provider          string     `json:"provider"`
	Model             string     `json:"model"`
	InputMicros       *int64     `json:"inputMicros"`
	CachedInputMicros *int64     `json:"cachedInputMicros"`
	OutputMicros      *int64     `json:"outputMicros"`
	CharacterMicros   *int64     `json:"characterMicros"`
	SecondMicros      *int64     `json:"secondMicros"`
	RequestMicros     *int64     `json:"requestMicros"`
	UpdatedAt         *time.Time `json:"updatedAt"`
}

type providerUsageRow struct {
	ID                string    `json:"id"`
	OwnerID           string    `json:"ownerId"`
	Operation         string    `json:"operation"`
	TaskID            string    `json:"taskId"`
	BatchID           string    `json:"batchId"`
	Provider          string    `json:"provider"`
	Model             string    `json:"model"`
	ProviderRef       string    `json:"providerRef"`
	Status            string    `json:"status"`
	Source            string    `json:"source"`
	Unit              string    `json:"unit"`
	InputTokens       *int64    `json:"inputTokens"`
	CachedInputTokens *int64    `json:"cachedInputTokens"`
	OutputTokens      *int64    `json:"outputTokens"`
	Characters        *int64    `json:"characters"`
	Seconds           *int64    `json:"seconds"`
	Requests          *int64    `json:"requests"`
	CostMicros        *int64    `json:"costMicros"`
	CreatedAt         time.Time `json:"createdAt"`
}

const recognizedProviderCost = `CASE WHEN status='succeeded' OR usage_source='provider' THEN cost_micros END`

func (s *server) adminProviderUsage(r *http.Request, a actor, kind string, body []byte) (any, error) {
	switch {
	case kind == "credits/provider-usage" && r.Method == http.MethodGet:
		if r.URL.Query().Get("view") == "finished" {
			return s.finishedVideoCostReport(r.Context(), r.URL.Query())
		}
		return s.providerUsageReport(r.Context(), r.URL.Query())
	case kind == "credits/provider-rates" && r.Method == http.MethodGet:
		return s.providerRates(r.Context())
	case kind == "credits/provider-rates" && r.Method == http.MethodPost:
		return s.updateProviderRate(r.Context(), a, body)
	default:
		return nil, fail(405, "不支持该请求方法")
	}
}

func (s *server) finishedVideoCostReport(ctx context.Context, query url.Values) (any, error) {
	start, end, err := providerUsageDateRange(query)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `
WITH archived AS (
  SELECT m.owner_id,m.task_id,MIN((a.payload->>'createdAt')::timestamptz) AS finished_at
  FROM keagent_credit_artifact_task m JOIN keagent_video_artifact a ON a.id=m.artifact_id AND a.owner_id=m.owner_id
  GROUP BY m.owner_id,m.task_id
), production_usage AS (
  SELECT owner_id,task_id,operation,created_at,`+recognizedProviderCost+` AS cost
  FROM keagent_provider_usage
  WHERE operation IN ('script','script_vision','legacy_script','tts','opening')
), task_totals AS (
  SELECT
    CASE WHEN COUNT(u.operation)=0 THEN 'unclassified'
         WHEN BOOL_OR(u.operation='opening') THEN 'minimax'
         ELSE 'standard' END AS category,
    COUNT(u.operation)>0 AND COUNT(u.cost)=COUNT(u.operation) AS priced,
    SUM(u.cost) AS total
  FROM archived a LEFT JOIN production_usage u
    ON u.owner_id=a.owner_id AND u.task_id=a.task_id AND u.created_at<=a.finished_at
  WHERE a.finished_at >= $1 AND a.finished_at < $2
  GROUP BY a.owner_id,a.task_id
)
SELECT category,COUNT(*),COUNT(*) FILTER (WHERE NOT priced),
       ROUND(AVG(total) FILTER (WHERE priced))::bigint,
       (percentile_disc(0.9) WITHIN GROUP (ORDER BY total) FILTER (WHERE priced))::bigint
FROM task_totals
GROUP BY category
ORDER BY CASE category WHEN 'standard' THEN 1 WHEN 'minimax' THEN 2 ELSE 3 END`, start, end)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []object{}
	for rows.Next() {
		var category string
		var count, unpriced int64
		var average, p90 *int64
		if err = rows.Scan(&category, &count, &unpriced, &average, &p90); err != nil {
			return nil, err
		}
		items = append(items, object{"category": category, "count": count, "unpriced": unpriced, "averageMicros": average, "p90Micros": p90})
	}
	return object{"items": items}, rows.Err()
}

func (s *server) providerRates(ctx context.Context) (any, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT observed.provider,observed.model,r.input_micros,r.cached_input_micros,r.output_micros,
    r.character_micros,r.second_micros,r.request_micros,r.updated_at
FROM (SELECT provider,model FROM keagent_provider_rate
  UNION SELECT DISTINCT provider,model FROM keagent_provider_usage) observed
LEFT JOIN keagent_provider_rate r USING(provider,model)
ORDER BY observed.provider,observed.model`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	rates := []providerRate{}
	for rows.Next() {
		var r providerRate
		if err = rows.Scan(&r.Provider, &r.Model, &r.InputMicros, &r.CachedInputMicros, &r.OutputMicros,
			&r.CharacterMicros, &r.SecondMicros, &r.RequestMicros, &r.UpdatedAt); err != nil {
			return nil, err
		}
		rates = append(rates, r)
	}
	return object{"items": rates}, rows.Err()
}

func (s *server) updateProviderRate(ctx context.Context, a actor, body []byte) (any, error) {
	var r providerRate
	if json.Unmarshal(body, &r) != nil {
		return nil, fail(422, "供应商费率参数无效")
	}
	r.Provider, r.Model = strings.ToLower(strings.TrimSpace(r.Provider)), strings.TrimSpace(r.Model)
	if !providerRateName.MatchString(r.Provider) || r.Model == "" || len(r.Model) > 200 || strings.ContainsAny(r.Model, "\r\n\t") {
		return nil, fail(422, "请填写有效的供应商及模型")
	}
	configured := false
	for _, rate := range []*int64{r.InputMicros, r.CachedInputMicros, r.OutputMicros, r.CharacterMicros, r.SecondMicros, r.RequestMicros} {
		if rate != nil {
			if *rate < 0 || *rate > 1_000_000_000 {
				return nil, fail(422, "费率须在 0 至 1000 元之间")
			}
			configured = true
		}
	}
	if !configured {
		return nil, fail(422, "请至少填写一项费率")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	err = tx.QueryRowContext(ctx, `
INSERT INTO keagent_provider_rate(provider,model,input_micros,cached_input_micros,output_micros,character_micros,second_micros,request_micros)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
ON CONFLICT(provider,model) DO UPDATE SET input_micros=EXCLUDED.input_micros,cached_input_micros=EXCLUDED.cached_input_micros,
  output_micros=EXCLUDED.output_micros,character_micros=EXCLUDED.character_micros,second_micros=EXCLUDED.second_micros,
  request_micros=EXCLUDED.request_micros,updated_at=now()
RETURNING updated_at`, r.Provider, r.Model, r.InputMicros, r.CachedInputMicros, r.OutputMicros,
		r.CharacterMicros, r.SecondMicros, r.RequestMicros).Scan(&r.UpdatedAt)
	if err != nil {
		return nil, err
	}
	// Allow a pilot to collect usage before a rate is available. Preserve every existing estimate.
	_, err = tx.ExecContext(ctx, `
UPDATE keagent_provider_usage u SET cost_micros=keagent_estimate_provider_cost(
  u.unit,u.input_tokens,u.cached_input_tokens,u.output_tokens,u.characters,u.seconds,u.requests,
  r.input_micros,r.cached_input_micros,r.output_micros,r.character_micros,r.second_micros,r.request_micros),
  rate_updated_at=r.updated_at
FROM keagent_provider_rate r WHERE u.provider=$1 AND u.model=$2 AND r.provider=u.provider AND r.model=u.model
  AND u.cost_micros IS NULL AND (u.unit IN ('seconds','requests') OR u.usage_source<>'unknown')`, r.Provider, r.Model)
	if err != nil {
		return nil, err
	}
	if err = writeCreditAudit(ctx, tx, a.UserID, "credit.provider-rate.update", r.Provider+"/"+r.Model, object{"rate": r}); err != nil {
		return nil, err
	}
	return r, tx.Commit()
}

func providerUsageDateRange(query url.Values) (time.Time, time.Time, error) {
	day := time.FixedZone("UTC+8", 8*60*60)
	from, to := query.Get("from"), query.Get("to")
	if from == "" && to == "" {
		today := time.Now().In(day)
		to = today.Format(time.DateOnly)
		from = today.AddDate(0, 0, -29).Format(time.DateOnly)
	}
	start, startErr := time.ParseInLocation(time.DateOnly, from, day)
	end, endErr := time.ParseInLocation(time.DateOnly, to, day)
	if startErr != nil || endErr != nil || start.Year() < 1 || start.After(end) || end.Sub(start) >= 93*24*time.Hour {
		return time.Time{}, time.Time{}, fail(422, "请选择不超过 93 天的有效日期范围")
	}
	return start, end.AddDate(0, 0, 1), nil
}

func (s *server) providerUsageReport(ctx context.Context, query url.Values) (any, error) {
	start, end, err := providerUsageDateRange(query)
	if err != nil {
		return nil, err
	}
	page := 1
	if value := query.Get("page"); value != "" {
		page, err = strconv.Atoi(value)
		if err != nil || page < 1 || page > 10000 {
			return nil, fail(422, "页码无效")
		}
	}
	const pageSize = 50
	where := ` FROM keagent_provider_usage WHERE created_at >= $1 AND created_at < $2`
	args := []any{start, end}
	for _, field := range []struct{ column, param string }{
		{"operation", "operation"}, {"task_id", "taskId"}, {"batch_id", "batchId"},
	} {
		value := strings.TrimSpace(query.Get(field.param))
		if value != "" {
			if len(value) > 200 {
				return nil, fail(422, "筛选条件无效")
			}
			args = append(args, value)
			where += " AND " + field.column + "=$" + strconv.Itoa(len(args))
		}
	}
	grouped, err := s.db.QueryContext(ctx,
		`SELECT operation,provider,model,COUNT(*),COUNT(cost),SUM(cost)::bigint
FROM (SELECT operation,provider,model,`+recognizedProviderCost+" AS cost"+where+`) events
GROUP BY operation,provider,model ORDER BY operation,provider,model`, args...)
	if err != nil {
		return nil, err
	}
	defer grouped.Close()
	summary := []object{}
	var total int64
	for grouped.Next() {
		var operation, provider, model string
		var count, priced int64
		var cost *int64
		if err = grouped.Scan(&operation, &provider, &model, &count, &priced, &cost); err != nil {
			return nil, err
		}
		summary = append(summary, object{"operation": operation, "provider": provider, "model": model, "count": count, "unknown": count - priced, "costMicros": cost})
		total += count
	}
	if err = grouped.Err(); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT id,owner_id,operation,task_id,batch_id,provider,model,provider_ref,status,usage_source,unit,
input_tokens,cached_input_tokens,output_tokens,characters,seconds,requests,`+recognizedProviderCost+",created_at"+where+
			" ORDER BY created_at DESC,id DESC LIMIT "+strconv.Itoa(pageSize)+" OFFSET "+strconv.Itoa((page-1)*pageSize), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []providerUsageRow{}
	for rows.Next() {
		var row providerUsageRow
		if err = rows.Scan(&row.ID, &row.OwnerID, &row.Operation, &row.TaskID, &row.BatchID, &row.Provider, &row.Model,
			&row.ProviderRef, &row.Status, &row.Source, &row.Unit, &row.InputTokens, &row.CachedInputTokens, &row.OutputTokens,
			&row.Characters, &row.Seconds, &row.Requests, &row.CostMicros, &row.CreatedAt); err != nil {
			return nil, err
		}
		items = append(items, row)
	}
	return object{"items": items, "summary": summary, "total": total, "pageSize": pageSize}, rows.Err()
}
