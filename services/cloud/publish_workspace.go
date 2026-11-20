package main

import (
	"context"
	"encoding/json"
	"strings"
)

func (s *server) publishWorkspace(ctx context.Context, a actor, body []byte) (object, error) {
	var in struct {
		Search string `json:"search"`
		Review string `json:"review"`
		Status string `json:"status"`
		Limit  int    `json:"limit"`
		Offset int    `json:"offset"`
	}
	if err := decodeExchange(body, &in); err != nil {
		return nil, err
	}
	if in.Limit == 0 {
		in.Limit = 50
	}
	validStatus := map[string]bool{"": true, "unpublished": true, "running": true, "accepted": true, "scheduled": true, "unknown": true, "failed": true}
	if in.Limit < 1 || in.Limit > 100 || in.Offset < 0 || in.Offset > 1000000 ||
		len(in.Search) > 512 || !validStatus[in.Status] || (in.Review != "" && !validReview(in.Review)) {
		return nil, exchangeFail(422, "INVALID_INPUT", "发布工作台筛选无效")
	}
	const statement = `
WITH matches AS (
  SELECT a.id, a.payload->'content'->>'title' AS title,
    a.payload->'content'->'property'->>'title' AS "propertyTitle",
    a.payload->'review' AS review, a.source_revision AS "sourceRevision",
    a.payload->>'createdAt' AS "createdAt",
    CASE WHEN r.state='accepted' AND r.payload ? 'scheduledAt'
      AND r.payload->>'resultSource'='platform' THEN 'scheduled'
      WHEN r.state='submitting' THEN 'running' WHEN r.state='canceled' THEN 'failed'
      ELSE COALESCE(r.state,'unpublished') END AS status,
    r.state AS "recordState", r.id AS "recordId", r.payload->'progress' AS progress,
    r.payload->'scheduledAt' AS "scheduledAt", r.payload->>'resultSource' AS "resultSource",
    COALESCE($6<>'' AND v.device_id=$6 AND c.device_id=$6
      AND v.payload->'availability'->>'state'='available'
      AND c.payload->'availability'->>'state'='available'
      AND (a.subtitle_asset_id IS NULL OR
        (sub.device_id=$6 AND sub.payload->'availability'->>'state'='available')),false) AS "deviceReady"
  FROM keagent_video_artifact a
  LEFT JOIN LATERAL (
    SELECT id,state,payload FROM keagent_douyin_publish
    WHERE owner_id=a.owner_id AND artifact_id=a.id
    ORDER BY (state='unknown') DESC,created_at DESC,id DESC LIMIT 1
  ) r ON true
  LEFT JOIN keagent_media_asset v ON v.owner_id=a.owner_id AND v.id=a.video_asset_id
  LEFT JOIN keagent_media_asset c ON c.owner_id=a.owner_id AND c.id=a.cover_asset_id
  LEFT JOIN keagent_media_asset sub ON sub.owner_id=a.owner_id AND sub.id=a.subtitle_asset_id
  WHERE a.owner_id=$1 AND ($2='' OR a.payload->'review'->>'state'=$2)
    AND ($3='' OR strpos(lower(concat_ws(' ',a.payload->'content'->>'title',a.payload->'content'->'property'->>'title')),lower($3))>0)
), filtered AS (
  SELECT * FROM matches WHERE ($4='' OR status=$4)
), page AS (
  SELECT * FROM filtered ORDER BY "createdAt" DESC,id DESC LIMIT $5 OFFSET $7
)
SELECT jsonb_build_object(
  'items', COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY "createdAt" DESC,id DESC) FROM page),'[]'::jsonb),
  'total', (SELECT count(*) FROM filtered),
  'counts', COALESCE((SELECT jsonb_object_agg(status,n) FROM (SELECT status,count(*) n FROM matches GROUP BY status) counts),'{}'::jsonb)
)`
	var raw []byte
	if err := s.db.QueryRowContext(ctx, statement, a.UserID, in.Review, strings.TrimSpace(in.Search), in.Status, in.Limit, a.DeviceID, in.Offset).Scan(&raw); err != nil {
		return nil, err
	}
	var result object
	err := json.Unmarshal(raw, &result)
	return result, err
}
