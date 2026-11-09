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
import { serviceRequest } from "@keagent/api-client";
import {
  douyinStateLabels,
  type DouyinPublishRecord,
} from "@keagent/shared-types";
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
  return (
    <>
      {[records.error, summary.error, health.error]
        .filter(Boolean)
        .map((error, index) => (
          <Alert
            key={index}
            className="admin-notice"
            type="error"
            showIcon
            title={error!.message}
          />
        ))}
      <section className="admin-panel admin-metrics" aria-label="发布指标">
        <div>
          <span>发布尝试</span>
          <strong>{summary.data?.total ?? "—"}</strong>
        </div>
        <div>
          <span>已提交抖音</span>
          <strong>
            {summary.data ? (summary.data.states.accepted ?? 0) : "—"}
          </strong>
        </div>
        <div>
          <span>结果待核对</span>
          <strong>
            {summary.data ? (summary.data.states.unknown ?? 0) : "—"}
          </strong>
        </div>
        <div>
          <span>符合告警条件的连续失败</span>
          <strong>{health.data?.failures ?? "—"}</strong>
        </div>
      </section>
      <section
        className="admin-panel admin-block"
        aria-labelledby="admin-publish-alerts"
      >
        <div className="admin-section-heading">
          <Space wrap>
            <h2 id="admin-publish-alerts">发布流程告警</h2>
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
          <Link to="/admin/settings?tab=mail">管理邮件通知</Link>
        </div>
        <p className="admin-secondary">
          24 小时内连续 3
          次执行失败时发送告警，之后首次自动成功时发送恢复通知。登录、文件、验收、未知结果和人工核对不计入。
        </p>
        <p className="admin-secondary">
          待投递邮件：{health.data?.pendingEmails ?? "—"}。投递失败后每 5
          分钟重试。
        </p>
      </section>
      <section
        className="admin-panel admin-table-panel admin-block"
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
        </div>
        <div className="admin-toolbar">
          <Space wrap>
            <AdminUserSelect
              label="所属用户"
              value={filters.ownerId}
              onChange={(value) => filter("ownerId", value)}
            />
            <Input.Search
              aria-label="设备ID"
              placeholder="完整设备ID"
              onSearch={(value) => filter("deviceId", value)}
              allowClear
            />
            <Select
              aria-label="发布状态"
              placeholder="全部状态"
              allowClear
              value={filters.state}
              style={{ width: 160 }}
              onChange={(value) => filter("state", value)}
              options={Object.entries(douyinStateLabels).map(
                ([value, label]) => ({ value, label }),
              )}
            />
            <Input.Search
              aria-label="错误类别"
              placeholder="错误码，如 EXECUTION_FAILED"
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
          <Button
            onClick={() =>
              void client.invalidateQueries({ queryKey: ["admin", "douyin"] })
            }
          >
            刷新
          </Button>
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
              width: 288,
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
            { title: "所属用户", dataIndex: "ownerId", width: 110 },
            { title: "设备", dataIndex: "deviceId", width: 120 },
            {
              title: "成片 / 账号",
              render: (_, row) => (
                <>
                  <div>{row.artifactId}</div>
                  <small>{row.accountId}</small>
                </>
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
            { title: "错误类别", dataIndex: "errorCode", width: 145 },
            {
              title: "时间",
              dataIndex: "createdAt",
              width: 170,
              render: (value) => new Date(value).toLocaleString("zh-CN"),
            },
          ]}
        />
      </section>
      <Drawer
        rootClassName="admin-detail-drawer"
        title="抖音发布诊断"
        open={!!selected}
        onClose={() => setSelected("")}
        size={640}
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
            <Descriptions
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
            <h3>安全执行日志</h3>
            <Timeline
              items={detail.data.logs?.map((log, index) => ({
                key: index,
                content: (
                  <>
                    <strong>{log.step}</strong>
                    <p>
                      {log.status} ·{" "}
                      {new Date(log.timestamp).toLocaleString("zh-CN")}
                      {log.durationMs === undefined
                        ? ""
                        : ` · ${log.durationMs}ms`}
                      {log.errorCode ? ` · ${log.errorCode}` : ""}
                    </p>
                  </>
                ),
              }))}
            />
          </>
        )}
      </Drawer>
    </>
  );
}
