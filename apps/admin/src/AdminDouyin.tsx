import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Button,
  DatePicker,
  Descriptions,
  Drawer,
  Empty,
  Input,
  Select,
  Skeleton,
  Space,
  Table,
  Tag,
  Timeline,
} from "antd";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  CheckCircle2,
  HelpCircle,
  Mail,
  RefreshCw,
  Send,
} from "lucide-react";
import { serviceRequest } from "@keagent/api-client";
import {
  douyinStateLabels,
  type DouyinPublishRecord,
} from "@keagent/shared-types";
import { dateTime } from "./admin-api";
import AdminUserSelect from "./AdminUserSelect";

export default function AdminDouyin() {
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState("");
  const client = useQueryClient();
  const params = new URLSearchParams({
    ...filters,
    limit: "20",
    offset: String((page - 1) * 20),
  }).toString();
  const records = useQuery({
    queryKey: ["admin", "douyin", "records", params],
    queryFn: () =>
      serviceRequest<{ items: DouyinPublishRecord[]; total: number }>(
        `/v1/admin/douyin/records?${params}`,
      ),
    refetchInterval: 10000,
  });
  const summary = useQuery({
    queryKey: ["admin", "douyin", "summary", filters],
    queryFn: () =>
      serviceRequest<{ total: number; states: Record<string, number> }>(
        `/v1/admin/douyin/summary?${new URLSearchParams(filters)}`,
      ),
    refetchInterval: 10000,
  });
  const health = useQuery({
    queryKey: ["admin", "douyin", "health"],
    queryFn: () =>
      serviceRequest<{
        failures: number;
        incident: boolean;
        pendingEmails: number;
      }>("/v1/admin/douyin/health"),
    refetchInterval: 10000,
  });
  const detail = useQuery({
    queryKey: ["admin", "douyin", "detail", selected],
    enabled: !!selected,
    queryFn: () =>
      serviceRequest<DouyinPublishRecord>(
        `/v1/admin/douyin/detail?id=${encodeURIComponent(selected)}`,
      ),
  });
  function filter(key: string, value?: string) {
    setFilters((current) => {
      const next = { ...current };
      if (value) next[key] = value;
      else delete next[key];
      return next;
    });
    setPage(1);
  }
  const hasFailures = (health.data?.failures ?? 0) > 0;
  return (
    <div className="admin-stack">
      {[records.error, summary.error, health.error]
        .filter(Boolean)
        .map((error, index) => (
          <Alert key={index} type="error" showIcon title={error!.message} />
        ))}
      <section className="admin-kpi-grid" aria-label="发布指标">
        <div className="admin-kpi-card">
          <div className="admin-kpi-top">
            <span className="admin-kpi-label">
              <span className="admin-kpi-icon" aria-hidden="true">
                <Send size={15} />
              </span>
              发布尝试
            </span>
          </div>
          <strong className="admin-kpi-value">
            {summary.data?.total ?? "—"}
          </strong>
        </div>
        <div className="admin-kpi-card">
          <div className="admin-kpi-top">
            <span className="admin-kpi-label">
              <span
                className="admin-kpi-icon admin-kpi-icon-success"
                aria-hidden="true"
              >
                <CheckCircle2 size={15} />
              </span>
              已提交抖音
            </span>
          </div>
          <strong className="admin-kpi-value">
            {summary.data ? (summary.data.states.accepted ?? 0) : "—"}
          </strong>
        </div>
        <div className="admin-kpi-card">
          <div className="admin-kpi-top">
            <span className="admin-kpi-label">
              <span
                className="admin-kpi-icon admin-kpi-icon-warning"
                aria-hidden="true"
              >
                <HelpCircle size={15} />
              </span>
              结果待核对
            </span>
          </div>
          <strong className="admin-kpi-value">
            {summary.data ? (summary.data.states.unknown ?? 0) : "—"}
          </strong>
        </div>
        <div className="admin-kpi-card">
          <div className="admin-kpi-top">
            <span className="admin-kpi-label">
              <span
                className={
                  hasFailures
                    ? "admin-kpi-icon admin-kpi-icon-danger"
                    : "admin-kpi-icon admin-kpi-icon-success"
                }
                aria-hidden="true"
              >
                <AlertTriangle size={15} />
              </span>
              符合告警条件的连续失败
            </span>
          </div>
          <strong
            className={
              hasFailures
                ? "admin-kpi-value admin-kpi-value-danger"
                : "admin-kpi-value"
            }
          >
            {health.data?.failures ?? "—"}
          </strong>
        </div>
      </section>

      <section
        className="admin-panel admin-panel-compact"
        aria-labelledby="admin-publish-alerts"
      >
        <div className="admin-alert-banner">
          <div className="admin-alert-banner-main">
            <Space wrap size={10} style={{ marginBottom: 4 }}>
              <h2 id="admin-publish-alerts" style={{ margin: 0, fontSize: 15 }}>
                发布流程告警
              </h2>
              <Tag
                color={
                  health.data?.incident
                    ? "red"
                    : health.data
                      ? "green"
                      : "default"
                }
              >
                {health.data?.incident
                  ? "发布流程异常"
                  : health.data
                    ? "暂无流程告警"
                    : "状态待获取"}
              </Tag>
            </Space>
            <p className="admin-secondary">
              24 小时内连续 3
              次执行失败时发送告警，之后首次自动成功时发送恢复通知。登录、文件、验收、未知结果和人工核对不计入。
            </p>
          </div>
          <div className="admin-alert-banner-meta">
            <span className="admin-alert-pending">
              <Mail
                size={13}
                style={{ verticalAlign: -2, marginRight: 6 }}
                aria-hidden="true"
              />
              待投递邮件：{health.data?.pendingEmails ?? "—"}（每 5 分钟重试）
            </span>
            <Link to="/admin/settings?tab=mail">
              <Button>管理邮件通知</Button>
            </Link>
          </div>
        </div>
      </section>

      <section
        className="admin-panel admin-table-panel"
        aria-labelledby="admin-publish-records"
      >
        <div className="admin-section-heading">
          <div>
            <h2 id="admin-publish-records">发布记录</h2>
            <p className="admin-secondary">
              <strong>发布记录与步骤只读</strong>
              。用户在桌面客户端发起发布，作品审核结果以抖音为准。
            </p>
          </div>
          <Button
            icon={<RefreshCw size={14} />}
            loading={records.isFetching}
            onClick={() =>
              void client.invalidateQueries({ queryKey: ["admin", "douyin"] })
            }
          >
            刷新
          </Button>
        </div>
        <div className="admin-filter-strip">
          <Space wrap size={[10, 10]}>
            <AdminUserSelect
              label="所属用户"
              value={filters.ownerId}
              onChange={(value) => filter("ownerId", value)}
            />
            <Input.Search
              aria-label="设备ID"
              placeholder="完整设备ID"
              style={{ width: 190 }}
              onSearch={(value) => filter("deviceId", value)}
              allowClear
            />
            <Select
              aria-label="发布状态"
              placeholder="全部状态"
              allowClear
              value={filters.state}
              style={{ width: 145 }}
              onChange={(value) => filter("state", value)}
              options={Object.entries(douyinStateLabels).map(
                ([value, label]) => ({ value, label }),
              )}
            />
            <Input.Search
              aria-label="错误类别"
              placeholder="错误码，如 EXECUTION_FAILED"
              style={{ width: 220 }}
              onSearch={(value) => filter("errorCode", value)}
              allowClear
            />
            <DatePicker.RangePicker
              showTime
              onChange={(value) => {
                filter("from", value?.[0]?.toISOString());
                filter("to", value?.[1]?.toISOString());
              }}
            />
          </Space>
        </div>
        <Table<DouyinPublishRecord>
          rowKey="id"
          loading={records.isPending}
          dataSource={records.data?.items || []}
          scroll={{ x: 1100 }}
          locale={{
            emptyText: (
              <Empty description="没有符合条件的发布记录。可调整筛选条件。" />
            ),
          }}
          pagination={{
            current: page,
            pageSize: 20,
            total: records.data?.total || 0,
            showSizeChanger: false,
            onChange: setPage,
          }}
          columns={[
            {
              title: "发布记录",
              dataIndex: "id",
              width: 260,
              render: (id) => (
                <Button
                  type="link"
                  className="admin-cell-link"
                  onClick={() => setSelected(id)}
                >
                  {id}
                </Button>
              ),
            },
            {
              title: "所属用户",
              dataIndex: "ownerId",
              width: 130,
              render: (value: string) => (
                <code className="admin-code">{value}</code>
              ),
            },
            {
              title: "设备",
              dataIndex: "deviceId",
              width: 130,
              render: (value: string) =>
                value ? (
                  <code className="admin-code">{value}</code>
                ) : (
                  <span className="admin-empty-val">—</span>
                ),
            },
            {
              title: "成片 / 账号",
              render: (_, row) => (
                <div className="admin-user-cell">
                  <span>{row.artifactId}</span>
                  <span className="admin-secondary">{row.accountId}</span>
                </div>
              ),
            },
            {
              title: "状态",
              dataIndex: "state",
              width: 120,
              render: (state: keyof typeof douyinStateLabels) => (
                <Tag
                  color={
                    state === "accepted"
                      ? "green"
                      : state === "failed"
                        ? "red"
                        : state === "unknown"
                          ? "orange"
                          : "default"
                  }
                >
                  {douyinStateLabels[state]}
                </Tag>
              ),
            },
            {
              title: "错误类别",
              dataIndex: "errorCode",
              width: 160,
              render: (value?: string) =>
                value ? (
                  <Tag color="red">{value}</Tag>
                ) : (
                  <span className="admin-empty-val">—</span>
                ),
            },
            {
              title: "时间",
              dataIndex: "createdAt",
              width: 180,
              render: dateTime,
            },
          ]}
        />
      </section>
      <Drawer
        rootClassName="admin-detail-drawer"
        title="抖音发布诊断"
        open={!!selected}
        onClose={() => setSelected("")}
        width={640}
      >
        {detail.isPending && <Skeleton active />}
        {detail.error && (
          <Alert
            type="error"
            showIcon
            title={detail.error.message}
            action={<Button onClick={() => void detail.refetch()}>重试</Button>}
          />
        )}
        {detail.data && (
          <>
            <div className="admin-detail-summary">
              <Tag
                color={
                  detail.data.state === "accepted"
                    ? "green"
                    : detail.data.state === "failed"
                      ? "red"
                      : detail.data.state === "unknown"
                        ? "orange"
                        : "default"
                }
              >
                {douyinStateLabels[detail.data.state]}
              </Tag>
              <span>
                {detail.data.resultSource === "manual"
                  ? "用户人工核对"
                  : "平台回报"}
              </span>
              {detail.data.errorCode && (
                <Tag color="red">{detail.data.errorCode}</Tag>
              )}
            </div>
            <Descriptions
              bordered
              size="small"
              column={1}
              items={[
                { key: "id", label: "记录", children: detail.data.id },
                {
                  key: "handoff",
                  label: "固定交接",
                  children: detail.data.handoffId,
                },
                {
                  key: "state",
                  label: "结果",
                  children: douyinStateLabels[detail.data.state],
                },
                {
                  key: "result",
                  label: "结果来源",
                  children:
                    detail.data.resultSource === "manual"
                      ? "用户人工核对"
                      : "平台回报",
                },
                {
                  key: "url",
                  label: "作品引用",
                  children: detail.data.url || "尚无",
                },
                {
                  key: "error",
                  label: "错误码",
                  children: detail.data.errorCode || "无",
                },
              ]}
            />
            <h3 className="admin-detail-heading">安全执行日志</h3>
            <Timeline
              items={detail.data.logs?.map((log, index) => ({
                key: index,
                content: (
                  <div>
                    <strong>{log.step}</strong>
                    <p className="admin-secondary">
                      {log.status} · {dateTime(log.timestamp)}
                      {log.durationMs === undefined
                        ? ""
                        : ` · ${log.durationMs}ms`}
                      {log.errorCode ? ` · ${log.errorCode}` : ""}
                    </p>
                  </div>
                ),
              }))}
            />
          </>
        )}
      </Drawer>
    </div>
  );
}
