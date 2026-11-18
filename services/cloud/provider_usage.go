package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const providerUsageSchema = `
CREATE TABLE IF NOT EXISTS keagent_provider_rate (
  provider text NOT NULL, model text NOT NULL,
  input_micros bigint, cached_input_micros bigint, output_micros bigint,
  character_micros bigint, second_micros bigint, request_micros bigint,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(provider,model)
);
CREATE TABLE IF NOT EXISTS keagent_provider_usage (
  id text PRIMARY KEY, owner_id text NOT NULL, operation text NOT NULL,
  task_id text NOT NULL, batch_id text NOT NULL, business_ref text NOT NULL,
  provider text NOT NULL, model text NOT NULL, provider_ref text NOT NULL,
  status text NOT NULL, usage_source text NOT NULL, unit text NOT NULL,
  input_tokens bigint, cached_input_tokens bigint, output_tokens bigint,
  characters bigint, seconds bigint, requests bigint, cost_micros bigint,
  rate_updated_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS keagent_provider_usage_date_idx ON keagent_provider_usage(created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS keagent_provider_usage_task_idx ON keagent_provider_usage(task_id,created_at DESC);
CREATE INDEX IF NOT EXISTS keagent_provider_usage_batch_idx ON keagent_provider_usage(batch_id,created_at DESC);
CREATE INDEX IF NOT EXISTS keagent_provider_usage_pending_idx
  ON keagent_provider_usage(owner_id,operation,business_ref,created_at DESC) WHERE status IN ('pending','unknown');
CREATE INDEX IF NOT EXISTS keagent_provider_usage_unpriced_idx
  ON keagent_provider_usage(provider,model) WHERE cost_micros IS NULL;
CREATE OR REPLACE FUNCTION keagent_estimate_provider_cost(
  unit text, input_tokens bigint, cached_tokens bigint, output_tokens bigint, characters bigint, seconds bigint, requests bigint,
  input_rate bigint, cached_rate bigint, output_rate bigint, character_rate bigint, second_rate bigint, request_rate bigint
) RETURNS bigint LANGUAGE sql IMMUTABLE AS $$
  SELECT (CASE unit
    WHEN 'tokens' THEN (
        GREATEST(input_tokens-COALESCE(cached_tokens,0),0)::numeric * input_rate
        + LEAST(input_tokens,COALESCE(cached_tokens,0))::numeric * COALESCE(cached_rate,input_rate)
        + output_tokens::numeric * output_rate
      ) / 1000000
    WHEN 'characters' THEN characters::numeric * character_rate / 1000
    WHEN 'seconds' THEN seconds::numeric * second_rate
    WHEN 'requests' THEN requests::numeric * request_rate
  END)::bigint
  WHERE unit <> 'tokens' OR (input_tokens IS NOT NULL AND output_tokens IS NOT NULL)
$$;
`

type providerUsageKey struct{}

type providerUsageScope struct {
	server                        *server
	owner, operation, task, batch string
}

type providerUsage struct {
	Provider, Model, ProviderRef, BusinessRef, Status, Source, Unit string
	InputTokens, CachedInputTokens, OutputTokens                    *int64
	Characters, Seconds, Requests                                   *int64
}

func (s *server) withProviderUsage(ctx context.Context, owner, operation string) context.Context {
	task := billingTaskFromContext(ctx)
	return s.withProviderUsageReference(ctx, owner, operation, task.TaskID, task.BatchID)
}

func (s *server) withProviderUsageReference(ctx context.Context, owner, operation, task, batch string) context.Context {
	return context.WithValue(ctx, providerUsageKey{}, providerUsageScope{s, owner, operation, task, batch})
}

func usageScope(ctx context.Context) providerUsageScope {
	scope, _ := ctx.Value(providerUsageKey{}).(providerUsageScope)
	return scope
}

func providerHostname(endpoint string) string {
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return ""
	}
	return strings.ToLower(parsed.Hostname())
}

func (usage *providerUsage) readCompletion(data []byte) {
	var output struct {
		ID    string
		Model string
		Usage struct {
			Input   *int64 `json:"prompt_tokens"`
			Output  *int64 `json:"completion_tokens"`
			Details struct {
				Cached *int64 `json:"cached_tokens"`
			} `json:"prompt_tokens_details"`
		}
	}
	// Compatible endpoints can omit or extend telemetry without affecting the generated text.
	_ = json.Unmarshal(data, &output)
	if output.Model != "" {
		usage.Model = output.Model
	}
	if output.ID != "" {
		usage.ProviderRef = output.ID
	}
	usage.InputTokens, usage.OutputTokens = validUsageCount(output.Usage.Input), validUsageCount(output.Usage.Output)
	usage.CachedInputTokens = validUsageCount(output.Usage.Details.Cached)
	if usage.InputTokens != nil || usage.OutputTokens != nil {
		usage.Source = "provider"
	}
}

func (s *server) recordProviderUsage(ctx context.Context, usage providerUsage) {
	scope := usageScope(ctx)
	if s.db == nil || scope.owner == "" || scope.operation == "" || usage.Provider == "" {
		return
	}
	if usage.Source == "" {
		usage.Source = "unknown"
	}
	usage.Model = usageLabel(usage.Model, 200)
	usage.ProviderRef = usageLabel(usage.ProviderRef, 240)
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
	defer cancel()
	_, err := s.db.ExecContext(ctx, `
WITH rate AS (SELECT * FROM keagent_provider_rate WHERE provider=$7 AND model=$8)
INSERT INTO keagent_provider_usage(id,owner_id,operation,task_id,batch_id,business_ref,provider,model,provider_ref,status,usage_source,unit,
  input_tokens,cached_input_tokens,output_tokens,characters,seconds,requests,cost_micros,rate_updated_at)
SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
  keagent_estimate_provider_cost($12,$13,$14,$15,$16,$17,$18,rate.input_micros,rate.cached_input_micros,rate.output_micros,
    rate.character_micros,rate.second_micros,rate.request_micros), rate.updated_at
FROM (SELECT 1) AS event LEFT JOIN rate ON true`, id(), scope.owner, scope.operation, scope.task, scope.batch, usage.BusinessRef,
		usage.Provider, usage.Model, usage.ProviderRef, usage.Status, usage.Source, usage.Unit,
		validUsageCount(usage.InputTokens), validUsageCount(usage.CachedInputTokens), validUsageCount(usage.OutputTokens),
		validUsageCount(usage.Characters), validUsageCount(usage.Seconds), validUsageCount(usage.Requests))
	if err != nil {
		log.Printf("provider usage record failed for %s: %v", scope.operation, err)
	}
}

func usageLabel(value string, maxBytes int) string {
	if len(value) > maxBytes || strings.ContainsAny(value, "\x00\r\n\t") {
		return ""
	}
	return value
}

func validUsageCount(value *int64) *int64 {
	if value == nil || *value < 0 || *value > 1_000_000_000 {
		return nil
	}
	return value
}

func (s *server) finishProviderUsage(ctx context.Context, owner, operation, businessRef, providerRef, status string) {
	if s.db == nil || businessRef == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
	defer cancel()
	_, err := s.db.ExecContext(ctx, `
UPDATE keagent_provider_usage SET status=$5, provider_ref=COALESCE(NULLIF($4,''),provider_ref)
WHERE id=(SELECT id FROM keagent_provider_usage WHERE owner_id=$1 AND operation=$2 AND business_ref=$3
  AND status IN ('pending','unknown') AND ($4='' OR provider_ref IN ('',$4))
  ORDER BY created_at DESC,id DESC LIMIT 1)`, owner, operation, businessRef, providerRef, status)
	if err != nil {
		log.Printf("provider usage finish failed for %s: %v", operation, err)
	}
}

func providerUsageFailure(err error) string {
	var upstream providerHTTPError
	if errors.As(err, &upstream) && upstream.httpStatus >= 400 && upstream.httpStatus < 500 {
		return "failed"
	}
	return "unknown"
}

var providerRateName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,251}$`)
