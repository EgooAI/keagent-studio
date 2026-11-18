package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/url"
	"regexp"
	"strconv"
	"time"
)

var creditTaskID = regexp.MustCompile(`^[a-zA-Z0-9_.:-]{1,160}$`)
var creditEstimateVersion = regexp.MustCompile(`^(default|v[0-9]{1,19})$`)

type creditTaskReference struct {
	TaskID           string `json:"taskId"`
	BatchID          string `json:"batchId,omitempty"`
	Stage            string `json:"-"`
	EstimatedCredits *int64 `json:"estimatedCredits,omitempty"`
	EstimateVersion  string `json:"estimateVersion,omitempty"`
}

type creditTaskContextKey struct{}

// The desktop's task identifiers are labels scoped to the authenticated wallet.
// Remove the labels from the request so they never change the provider payload or charge key.
func withBillingTask(ctx context.Context, input object, operation string) (context.Context, error) {
	raw, found := input["billingContext"]
	if !found {
		return ctx, nil
	}
	delete(input, "billingContext")
	var task creditTaskReference
	if json.Unmarshal(mustJSON(raw), &task) != nil || !creditTaskID.MatchString(task.TaskID) ||
		(task.BatchID != "" && !creditTaskID.MatchString(task.BatchID)) ||
		(task.EstimatedCredits == nil && task.EstimateVersion != "") ||
		(task.EstimatedCredits != nil && (*task.EstimatedCredits < 0 || *task.EstimatedCredits > 3_000_000 || !creditEstimateVersion.MatchString(task.EstimateVersion))) {
		return ctx, fail(422, "任务账单引用或预估信息无效")
	}
	task.Stage = operation
	return context.WithValue(ctx, creditTaskContextKey{}, task), nil
}

func billingTaskFromContext(ctx context.Context) creditTaskReference {
	task, _ := ctx.Value(creditTaskContextKey{}).(creditTaskReference)
	return task
}

func creditChargeDetails(ctx context.Context, reference, unit string, quantity, unitPrice int64) (string, object) {
	metadata := object{"unit": unit, "quantity": quantity, "unitPrice": unitPrice}
	task := billingTaskFromContext(ctx)
	if task.TaskID != "" {
		reference = task.TaskID
		metadata["batchId"] = task.BatchID
		metadata["stage"] = task.Stage
		if task.EstimatedCredits != nil {
			metadata["estimatedCredits"] = *task.EstimatedCredits
			metadata["estimateVersion"] = task.EstimateVersion
		}
	}
	return reference, metadata
}

const (
	creditActivityPageSize = 20
	creditActivityMaxPage  = 10000
)

const creditHoldSpentSQL = `CASE WHEN state='captured' THEN COALESCE((
 SELECT SUM((item->>'amount')::bigint)
 FROM jsonb_array_elements(NULLIF(allocation,'null'::jsonb)) AS item
),0) ELSE 0 END`

type creditActivityMetadata struct {
	BatchID       string `json:"batchId,omitempty"`
	Stage         string `json:"stage,omitempty"`
	Unit          string `json:"unit,omitempty"`
	Quantity      *int64 `json:"quantity,omitempty"`
	UnitPrice     *int64 `json:"unitPrice,omitempty"`
	Characters    *int64 `json:"characters,omitempty"`
	ReleaseReason string `json:"releaseReason,omitempty"`
}

type creditActivityItem struct {
	ID           string `json:"id"`
	Op           string `json:"op"`
	State        string `json:"state"`
	TaskID       string `json:"taskId,omitempty"`
	PriceVersion string `json:"priceVersion,omitempty"`
	Held         int64  `json:"held"`
	Spent        int64  `json:"spent"`
	Released     int64  `json:"released"`
	CreatedAt    string `json:"createdAt"`
	SettledAt    string `json:"settledAt,omitempty"`
	creditActivityMetadata
}

func (s *server) creditActivity(ctx context.Context, ownerID string, query url.Values) (any, error) {
	taskID, batchID := query.Get("taskId"), query.Get("batchId")
	if (taskID != "" && !creditTaskID.MatchString(taskID)) || (batchID != "" && !creditTaskID.MatchString(batchID)) {
		return nil, fail(422, "视频任务或批次编号无效")
	}
	page := 1
	if raw := query.Get("page"); raw != "" {
		var err error
		if page, err = strconv.Atoi(raw); err != nil || page < 1 || page > creditActivityMaxPage {
			return nil, fail(422, "账单页码无效")
		}
	}
	where := " FROM keagent_credit_hold WHERE owner_id=$1"
	args := []any{ownerID}
	if taskID != "" {
		args = append(args, taskID)
		where += " AND metadata ? 'stage' AND ref_id=$" + strconv.Itoa(len(args))
	}
	if batchID != "" {
		args = append(args, batchID)
		where += " AND metadata ? 'batchId' AND metadata->>'batchId'=$" + strconv.Itoa(len(args))
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true, Isolation: sql.LevelRepeatableRead})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	statement := `SELECT id, op, ref_id, state, amount, price_version, metadata, created_at, settled_at, ` + creditHoldSpentSQL + where +
		" ORDER BY created_at DESC, id DESC LIMIT " + strconv.Itoa(creditActivityPageSize+1) + " OFFSET $" + strconv.Itoa(len(args)+1)
	rows, err := tx.QueryContext(ctx, statement, append(args, (page-1)*creditActivityPageSize)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]creditActivityItem, 0, creditActivityPageSize)
	hasMore := false
	for rows.Next() {
		if len(items) == creditActivityPageSize {
			hasMore = page < creditActivityMaxPage
			break
		}
		var item creditActivityItem
		var reference string
		var amount int64
		var metadata []byte
		var created time.Time
		var settled sql.NullTime
		if err = rows.Scan(&item.ID, &item.Op, &reference, &item.State, &amount, &item.PriceVersion, &metadata, &created, &settled, &item.Spent); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(metadata, &item.creditActivityMetadata); err != nil {
			return nil, err
		}
		if item.Stage != "" {
			item.TaskID = reference
		}
		if item.State == creditStateHeld {
			item.Held = amount
		} else {
			item.Released = amount - item.Spent
		}
		item.CreatedAt = created.UTC().Format(time.RFC3339Nano)
		if settled.Valid {
			item.SettledAt = settled.Time.UTC().Format(time.RFC3339Nano)
		}
		items = append(items, item)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return nil, err
	}
	result := object{"items": items, "hasMore": hasMore}
	if taskID != "" || batchID != "" {
		var spent int64
		if err = tx.QueryRowContext(ctx, "SELECT COALESCE(SUM("+creditHoldSpentSQL+"),0)"+where, args...).Scan(&spent); err != nil {
			return nil, err
		}
		result["totalSpent"] = spent
	}
	if taskID != "" {
		var estimated int64
		var version string
		err = tx.QueryRowContext(ctx, `SELECT (metadata->>'estimatedCredits')::bigint, metadata->>'estimateVersion'`+where+
			` AND metadata ? 'estimatedCredits' ORDER BY created_at, id LIMIT 1`, args...).Scan(&estimated, &version)
		if err == nil {
			result["estimate"] = object{"credits": estimated, "version": version}
		} else if !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return result, nil
}
