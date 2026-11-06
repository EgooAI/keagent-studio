import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  DatePicker,
  Descriptions,
  Drawer,
  Form,
  Input,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Timeline,
} from "antd";
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
  const { message } = App.useApp();
  const client = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
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
  const settings = useQuery({
    queryKey: ["admin", "douyin", "settings"],
    queryFn: () =>
      serviceRequest<{ operationsEmail: string; smtpConfigured: boolean }>(
        "/v1/admin/douyin/settings",
      ),
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
  async function save(values: { operationsEmail?: string }) {
    setSaving(true);
    try {
      await serviceRequest("/v1/admin/douyin/settings", {
        operationsEmail: values.operationsEmail || "",
      });
      await client.invalidateQueries({
        queryKey: ["admin", "douyin", "settings"],
      });
      message.success("运维邮箱已保存");
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <Alert
        type="info"
        showIcon
        title="发布记录与步骤只读"
        description="由用户在桌面客户端直接发布；平台回执不等同于作品审核通过。管理员不持有抖音登录资料。"
      />
      {[records.error, summary.error, health.error, settings.error]
        .filter(Boolean)
        .map((error, index) => (
          <Alert key={index} type="error" title={error!.message} />
        ))}
      <section className="admin-panel admin-block">
        <Space wrap size="large">
          <Statistic title="发布尝试" value={summary.data?.total || 0} />
          <Statistic
            title="已提交抖音"
            value={summary.data?.states.accepted || 0}
          />
          <Statistic
            title="结果待核对"
            value={summary.data?.states.unknown || 0}
          />
          <Statistic
            title="符合告警条件的连续失败"
            value={health.data?.failures || 0}
          />
          <Tag color={health.data?.incident ? "red" : "green"}>
            {health.data?.incident ? "发布流程异常" : "暂无流程告警"}
          </Tag>
        </Space>
      </section>
      <section className="admin-panel admin-block">
        <h2>发布流程告警</h2>
        <p>
          24 小时内连续 3
          次执行失败时通知，之后首次自动成功发送恢复通知。登录、文件、验收、未知结果和人工核对不计入。
        </p>
        <Alert
          type={settings.data?.smtpConfigured ? "success" : "warning"}
          title={
            settings.data?.smtpConfigured
              ? "SMTP 已配置，实际投递结果以邮件队列为准"
              : "SMTP 尚未完整配置，管理员保存邮箱后仍需配置服务端环境"
          }
        />
        <Form
          form={form}
          layout="inline"
          key={settings.data?.operationsEmail || "empty"}
          initialValues={{
            operationsEmail: settings.data?.operationsEmail || "",
          }}
          onFinish={save}
        >
          <Form.Item
            name="operationsEmail"
            label="运维邮箱"
            rules={[{ type: "email", message: "请输入有效邮箱" }]}
          >
            <Input placeholder="留空关闭邮件通知" style={{ width: 300 }} />
          </Form.Item>
          <Button
            htmlType="submit"
            loading={saving}
            disabled={settings.isPending}
          >
            保存邮箱
          </Button>
        </Form>
        <p className="muted">
          待投递邮件：{health.data?.pendingEmails || 0}；失败后每 5 分钟重试。
        </p>
      </section>
      <section className="admin-panel admin-block">
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
          loading={records.isFetching}
          dataSource={records.data?.items || []}
          scroll={{ x: 1100 }}
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
              render: (id) => (
                <Button type="link" onClick={() => setSelected(id)}>
                  {id}
                </Button>
              ),
            },
            { title: "所属用户", dataIndex: "ownerId" },
            { title: "设备", dataIndex: "deviceId" },
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
              render: (state: keyof typeof douyinStateLabels) =>
                douyinStateLabels[state],
            },
            { title: "错误类别", dataIndex: "errorCode" },
            {
              title: "时间",
              dataIndex: "createdAt",
              render: (value) => new Date(value).toLocaleString("zh-CN"),
            },
          ]}
        />
      </section>
      <Drawer
        title="抖音发布诊断"
        open={!!selected}
        onClose={() => setSelected("")}
        size={640}
      >
        {detail.error && <Alert type="error" title={detail.error.message} />}{" "}
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
                children: (
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
