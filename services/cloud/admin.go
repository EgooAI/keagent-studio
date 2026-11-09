package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"
)

type adminQuerier interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

type adminPage struct {
	limit, offset int
	conditions    []string
	args          []any
}

func (p *adminPage) where(expression string, value any) {
	p.args = append(p.args, value)
	p.conditions = append(p.conditions, fmt.Sprintf(expression, len(p.args)))
}

func parseAdminPage(kind string, q url.Values) (adminPage, error) {
	p := adminPage{limit: 20}
	for key, target := range map[string]*int{"limit": &p.limit, "offset": &p.offset} {
		if raw, exists := q[key]; exists {
			if len(raw) != 1 {
				return p, fail(422, "分页参数无效")
			}
			n, err := strconv.Atoi(raw[0])
			if err != nil || n < 0 || (key == "limit" && (n < 1 || n > 100)) || (key == "offset" && n > 10000000) {
				return p, fail(422, "limit 必须为 1–100，offset 必须为非负整数")
			}
			*target = n
		}
	}
	search := strings.TrimSpace(q.Get("q"))
	if len([]rune(search)) > 200 {
		return p, fail(422, "搜索内容不能超过 200 字")
	}
	if search != "" {
		// Search is literal: user-entered percent and underscore are not SQL wildcards.
		search = "%" + strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_").Replace(search) + "%"
		p.where("search ILIKE $%d", search)
	}
	fields := map[string][]string{
		"users": {"role", "banned"}, "devices": {"ownerId", "revoked"},
		"resources": {"type", "state"}, "tasks": {"ownerId", "status", "stage"},
		"audit": {"actorId", "targetId", "action"}, "auth-audit": {"actorId", "targetId", "action", "status"},
	}
	for _, field := range fields[kind] {
		value := q.Get(field)
		if value == "" {
			continue
		}
		if len(value) > 512 {
			return p, fail(422, "筛选参数过长")
		}
		choices := map[string]string{
			"role": "admin,user", "banned": "true,false", "revoked": "true,false",
			"type": "video,style,cover,subtitle,prompt", "state": "draft,published,unpublished",
			"stage": "prepare,script,tts,avatar,render,cover",
		}
		if field == "status" {
			choices[field] = "queued,running,awaiting_review,succeeded,failed,canceled"
			if kind == "auth-audit" {
				choices[field] = "started,succeeded,failed"
			}
		}
		if allowed, ok := choices[field]; ok && !slices.Contains(strings.Split(allowed, ","), value) {
			return p, fail(422, "筛选值无效："+field)
		}
		if field == "role" {
			p.where("$%d = ANY(string_to_array(data->>'role', ','))", value)
		} else {
			p.where("data->>'"+field+"' = $%d", value)
		}
	}
	if kind == "audit" || kind == "auth-audit" {
		var from, to time.Time
		for _, field := range []string{"from", "to"} {
			if raw := q.Get(field); raw != "" {
				parsed, err := time.Parse(time.RFC3339, raw)
				if err != nil {
					return p, fail(422, "日志时间必须包含日期、时间和时区")
				}
				if field == "from" {
					from = parsed
					p.where("sort_at >= $%d::timestamptz", parsed)
				} else {
					to = parsed
					p.where("sort_at <= $%d::timestamptz", parsed)
				}
			}
		}
		if !from.IsZero() && !to.IsZero() && from.After(to) {
			return p, fail(422, "开始时间不能晚于结束时间")
		}
	}
	return p, nil
}

func identitySQL(alias string) string {
	return `CASE WHEN ` + alias + `.id IS NULL THEN NULL ELSE jsonb_build_object('id',` + alias + `.id,'name',` + alias + `.name,'email',` + alias + `.email) END`
}

const taskFrom = ` FROM keagent_workspace w CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w.payload->'tasks','[]'::jsonb)) t(value) LEFT JOIN "user" u ON u.id=w.owner_id`

func taskSummarySQL() string {
	return `jsonb_build_object('id',t.value->>'id','ownerId',w.owner_id,'owner',` + identitySQL("u") + `,
	'propertyId',COALESCE(t.value->>'propertyId',''),'propertyTitle',COALESCE(t.value#>>'{propertySnapshot,title}',''),
	'propertyNumber',COALESCE(t.value#>>'{propertySnapshot,propertyNumber}',''),'batchId',COALESCE(t.value->>'batchId',''),
	'videoMode',COALESCE(t.value#>>'{configSnapshot,videoMode}','voiceover'),'stage',t.value->>'stage','status',t.value->>'status',
	'progress',COALESCE(t.value->'progress','0'::jsonb),'createdAt',t.value->>'createdAt') ||
	CASE WHEN t.value->>'error' IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('error',t.value->>'error') END`
}

func adminSource(kind string) (string, error) {
	switch kind {
	case "users":
		return `SELECT jsonb_build_object('id',u.id,'name',u.name,'email',u.email,'role',COALESCE(u.role,'user'),'banned',COALESCE(u.banned,false),'banReason',u."banReason",'createdAt',u."createdAt") data, u."createdAt" sort_at, concat_ws(' ',u.id,u.name,u.email) search FROM "user" u`, nil
	case "devices":
		return `SELECT jsonb_build_object('id',d.id,'ownerId',d.owner_id,'owner',` + identitySQL("u") + `,'name',d.name,'platform',d.platform,'revoked',d.revoked,'lastSeenAt',d.seen_at) data, d.seen_at sort_at, concat_ws(' ',d.id,d.name,d.platform,d.owner_id,u.name,u.email) search FROM keagent_device d LEFT JOIN "user" u ON u.id=d.owner_id`, nil
	case "resources":
		return `SELECT r.payload || jsonb_build_object('id',r.id,'state',CASE WHEN r.payload->>'published'='true' THEN 'published' WHEN r.payload->>'publishedOnce'='true' THEN 'unpublished' ELSE 'draft' END) data, NULL::timestamptz sort_at, concat_ws(' ',r.id,r.payload->>'name',r.payload->>'category',r.payload->>'description',r.payload->>'version') search FROM keagent_resource r`, nil
	case "tasks":
		return `SELECT ` + taskSummarySQL() + ` data, (t.value->>'createdAt')::timestamptz sort_at, concat_ws(' ',t.value->>'id',t.value->>'batchId',t.value#>>'{propertySnapshot,title}',t.value#>>'{propertySnapshot,propertyNumber}',w.owner_id,u.name,u.email) search` + taskFrom, nil
	case "audit":
		return `SELECT jsonb_build_object('id',a.id,'actorId',a.actor_id,'actor',` + identitySQL("u") + `,'targetId',a.target_id,'target',NULL,'targetLabel',COALESCE(NULLIF(a.metadata->>'name',''),r.payload->>'name',d.name,a.target_id),'action',a.action,'createdAt',a.created_at,'details',a.metadata) data, a.created_at sort_at, concat_ws(' ',a.id,a.actor_id,u.name,u.email,a.target_id,a.action,a.metadata->>'name',r.payload->>'name',d.name) search FROM keagent_audit a LEFT JOIN "user" u ON u.id=a.actor_id LEFT JOIN keagent_resource r ON r.id=a.target_id LEFT JOIN keagent_device d ON d.id=a.target_id`, nil
	case "auth-audit":
		return `SELECT jsonb_build_object('id',a.id,'actorId',a."actorId",'actor',` + identitySQL("u") + `,'targetId',a."targetId",'target',` + identitySQL("target_user") + `,'targetLabel',COALESCE(NULLIF(target_user.name,''),CASE WHEN a."targetId"='new-user' THEN '创建用户（未记录账号）' WHEN a.action='admin.revoke-user-session' OR a."targetId"='unknown-session' THEN '登录会话（对象不可用）' ELSE '用户已删除或对象不可用' END),'action',a.action,'createdAt',a."createdAt",'operationId',a."operationId",'status',a.status,'reason',a.reason,'details','{}'::jsonb) data, a."createdAt" sort_at, concat_ws(' ',a.id,a."actorId",u.name,u.email,a."targetId",target_user.name,target_user.email,a.action) search FROM "adminAuditLog" a LEFT JOIN "user" u ON u.id=a."actorId" LEFT JOIN "user" target_user ON target_user.id=a."targetId"`, nil
	}
	return "", fail(404, "管理查询不存在")
}

func queryAdminList(ctx context.Context, db adminQuerier, kind string, q url.Values) (object, error) {
	source, err := adminSource(kind)
	if err != nil {
		return nil, err
	}
	p, err := parseAdminPage(kind, q)
	if err != nil {
		return nil, err
	}
	filter := "true"
	if len(p.conditions) != 0 {
		filter = strings.Join(p.conditions, " AND ")
	}
	base := "WITH source AS (" + source + "), filtered AS (SELECT * FROM source WHERE " + filter + ") "
	var total int
	if err = db.QueryRowContext(ctx, base+"SELECT count(*) FROM filtered", p.args...).Scan(&total); err != nil {
		return nil, err
	}
	args := append(append([]any{}, p.args...), p.limit, p.offset)
	result, err := db.QueryContext(ctx, base+fmt.Sprintf("SELECT data FROM filtered ORDER BY sort_at DESC NULLS LAST, data->>'id' DESC LIMIT $%d OFFSET $%d", len(args)-1, len(args)), args...)
	if err != nil {
		return nil, err
	}
	defer result.Close()
	items := []any{}
	for result.Next() {
		var raw []byte
		var item object
		if err = result.Scan(&raw); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(raw, &item); err != nil {
			return nil, err
		}
		if kind == "resources" {
			item = publicResource(item)
		}
		if kind == "audit" || kind == "auth-audit" {
			item["details"] = auditDetails(obj(item["details"]))
		}
		items = append(items, item)
	}
	return object{"items": items, "total": total, "limit": p.limit, "offset": p.offset}, result.Err()
}

func pickFields(input object, keys ...string) object {
	out := object{}
	for _, key := range keys {
		if value, ok := input[key]; ok {
			out[key] = value
		}
	}
	return out
}

func publicResource(input object) object {
	out := publicFields(input, "id", "name", "description", "type", "category", "version", "thumbnail", "compatibleModes", "installed", "downloadStatus", "downloadProgress", "published", "sizeMb", "publishedOnce")
	if input["production"] != nil {
		out["production"] = input["production"]
		out["previewed"] = input["previewDigest"] == productionDigest(input)
	}
	return out
}

func publicFields(input object, keys ...string) object {
	out := object{}
	for key, value := range pickFields(input, keys...) {
		switch value.(type) {
		case nil, string, bool, float64, int:
			out[key] = value
		case []any:
			values := []any{}
			for _, item := range value.([]any) {
				if text, ok := item.(string); ok {
					values = append(values, text)
				}
			}
			out[key] = values
		}
	}
	return out
}

func auditDetails(input object) object {
	out := object{}
	for _, key := range []string{"name", "type", "version", "published", "ownerId", "platform", "reason", "service", "result"} {
		if value, ok := input[key]; ok {
			if _, nested := value.(map[string]any); !nested {
				out[key] = fmt.Sprint(value)
			}
		}
	}
	return out
}

func queryAdminTask(ctx context.Context, db adminQuerier, taskID string) (object, error) {
	if taskID == "" || len(taskID) > 512 {
		return nil, fail(422, "任务编号无效")
	}
	var raw []byte
	err := db.QueryRowContext(ctx, `SELECT jsonb_build_object('ownerId',w.owner_id,'owner',`+identitySQL("u")+`,'task',t.value)`+taskFrom+` WHERE t.value->>'id'=$1 LIMIT 1`, taskID).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fail(404, "云端任务不存在")
	}
	if err != nil {
		return nil, err
	}
	var out object
	if err = json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	task := obj(out["task"])
	clean := publicFields(task, "id", "batchId", "propertyId", "status", "stage", "script", "scriptRevision", "approvedRevision", "productionRevision", "createdAt", "completedAt", "error", "progress")
	clean["propertySnapshot"] = publicFields(obj(task["propertySnapshot"]), "id", "propertyNumber", "title", "city", "district", "community", "priceCents", "areaSqm", "layout", "description", "sellingPoints", "videoCount", "importStatus", "lastVerifiedAt")
	obj(clean["propertySnapshot"])["image"] = ""
	obj(clean["propertySnapshot"])["images"] = []any{}
	config := publicFields(obj(task["configSnapshot"]), "propertyIds", "videoMode", "voiceId", "avatarId", "requireScriptReview", "aspectRatio", "outputResolution")
	for _, key := range []string{"promptTemplate", "videoTemplate", "styleTemplate", "coverTemplate", "subtitleTemplate"} {
		if ref := obj(obj(task["configSnapshot"])[key]); ref != nil {
			config[key] = publicFields(ref, "id", "version")
		}
	}
	clean["configSnapshot"] = config
	history := []any{}
	for _, value := range rows(task["history"]) {
		history = append(history, publicFields(obj(value), "revision", "scriptRevision", "script"))
	}
	clean["history"] = history
	out["task"] = clean
	return out, nil
}

func queryAdminOverview(ctx context.Context, db adminQuerier) (object, error) {
	out := object{}
	var users, devices, resources, failed int
	err := db.QueryRowContext(ctx, `SELECT (SELECT count(*) FROM "user"), (SELECT count(*) FROM keagent_device WHERE NOT revoked), (SELECT count(*) FROM keagent_resource WHERE payload->>'published'='true'), (SELECT count(*) FROM keagent_workspace w CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w.payload->'tasks','[]'::jsonb)) t(value) WHERE t.value->>'status'='failed')`).Scan(&users, &devices, &resources, &failed)
	if err != nil {
		return nil, err
	}
	list, err := queryAdminList(ctx, db, "tasks", url.Values{"status": {"failed"}, "limit": {"5"}})
	if err != nil {
		return nil, err
	}
	out["users"], out["devices"], out["publishedResources"], out["failedTasks"] = users, devices, resources, failed
	out["recentFailedTasks"], out["services"] = list["items"], aiServicesFor(ctx)
	return out, nil
}
