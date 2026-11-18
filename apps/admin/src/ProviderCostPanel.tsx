import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
} from "antd";
import { serviceRequest } from "@keagent/api-client";
import { dateTime, useAdminAction } from "./admin-api";

const operations: Record<string, string> = {
  script: "视频文案改写",
  script_vision: "看图生成文案",
  legacy_script: "旧版视频文案",
  tts: "视频配音",
  opening: "MiniMax 开场",
  voice_clone: "声音复刻",
  voice_preview: "音色试听",
  lead_analysis: "评论线索分析",
  lead_draft: "私信草稿",
};
const providers: Record<string, string> = {
  bailian: "阿里云百炼",
  minimax: "MiniMax",
};
const statuses: Record<string, string> = {
  pending: "处理中",
  succeeded: "成功",
  failed: "失败",
  cancelled: "已取消",
  unknown: "结果未知",
};
const sourceLabels: Record<string, string> = {
  provider: "供应商返回",
  partial: "供应商返回的部分用量",
  request: "按请求推算",
  unknown: "未取得用量",
};

const rateFields = [
  ["inputMicros", "输入（元 / 百万 token）"],
  ["cachedInputMicros", "缓存输入（元 / 百万 token）"],
  ["outputMicros", "输出（元 / 百万 token）"],
  ["characterMicros", "配音（元 / 千字符）"],
  ["secondMicros", "视频（元 / 秒）"],
  ["requestMicros", "复刻（元 / 次）"],
] as const;
type RateField = (typeof rateFields)[number][0];
type Rate = {
  provider: string;
  model: string;
  updatedAt?: string | null;
} & Partial<Record<RateField, number | null>>;
type CostGroup = {
  operation: string;
  provider: string;
  model: string;
  count: number;
  unknown: number;
  costMicros: number | null;
};
type CostEvent = {
  id: string;
  ownerId: string;
  operation: string;
  taskId: string;
  batchId: string;
  provider: string;
  model: string;
  providerRef: string;
  status: string;
  source: string;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  characters: number | null;
  seconds: number | null;
  requests: number | null;
  costMicros: number | null;
  createdAt: string;
};
type CostReport = {
  items: CostEvent[];
  summary: CostGroup[];
  total: number;
  pageSize: number;
};
type Filters = {
  from: string;
  to: string;
  operation?: string;
  taskId?: string;
  batchId?: string;
};
type FinishedVideoCost = {
  category: string;
  count: number;
  unpriced: number;
  averageMicros: number | null;
  p90Micros: number | null;
};

const ratePath = "/v1/admin/credits/provider-rates";
const usagePath = "/v1/admin/credits/provider-usage";
const yuanFormat = new Intl.NumberFormat("zh-CN", {
  style: "currency",
  currency: "CNY",
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});

function formatCost(micros: number | null | undefined) {
  return micros == null ? "待核算" : yuanFormat.format(micros / 1_000_000);
}

function billingRange(): Filters {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const to = now.toISOString().slice(0, 10);
  now.setUTCDate(now.getUTCDate() - 29);
  return { from: now.toISOString().slice(0, 10), to };
}

function usedUnits(row: CostEvent) {
  return [
    row.inputTokens != null && `输入 ${row.inputTokens} token`,
    row.cachedInputTokens != null && `其中缓存 ${row.cachedInputTokens} token`,
    row.outputTokens != null && `输出 ${row.outputTokens} token`,
    row.characters != null && `${row.characters} 字符`,
    row.seconds != null && `${row.seconds} 秒`,
    row.requests != null && `${row.requests} 次`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function DateRangeFields() {
  return (
    <>
      <Form.Item name="from" label="开始日期" rules={[{ required: true }]}>
        <Input type="date" />
      </Form.Item>
      <Form.Item name="to" label="结束日期" rules={[{ required: true }]}>
        <Input type="date" />
      </Form.Item>
    </>
  );
}

function CostHistory() {
  const [form] = Form.useForm<Filters>();
  const [filters, setFilters] = useState(billingRange);
  const [page, setPage] = useState(1);
  const search = new URLSearchParams({
    from: filters.from,
    to: filters.to,
    page: String(page),
  });
  for (const field of ["operation", "taskId", "batchId"] as const) {
    const value = filters[field]?.trim();
    if (value) search.set(field, value);
  }
  const { data, error, isFetching, refetch } = useQuery({
    queryKey: ["admin", "provider-usage", search.toString()],
    queryFn: () => serviceRequest<CostReport>(`${usagePath}?${search}`),
    retry: false,
  });
  const summary = data?.summary ?? [];
  const priced = summary.filter((group) => group.costMicros !== null);
  const cost = priced.length
    ? priced.reduce((sum, group) => sum + (group.costMicros ?? 0), 0)
    : null;
  const missing = summary.reduce((sum, group) => sum + group.unknown, 0);

  function filterBy(field: "taskId" | "batchId", value: string) {
    form.setFieldValue(field, value);
    setFilters((previous) => ({ ...previous, [field]: value }));
    setPage(1);
  }

  return (
    <Space orientation="vertical" size="middle" style={{ display: "flex" }}>
      <p className="admin-muted">
        按北京时间筛选。成本按已配置的供应商费率估算，待核算的调用单独统计。
      </p>
      <Form<Filters>
        form={form}
        layout="inline"
        initialValues={filters}
        onFinish={(values) => {
          setFilters(values);
          setPage(1);
        }}
      >
        <DateRangeFields />
        <Form.Item name="operation" label="功能">
          <Select
            allowClear
            style={{ width: 140 }}
            options={Object.entries(operations).map(([value, label]) => ({
              value,
              label,
            }))}
          />
        </Form.Item>
        <Form.Item name="taskId" label="任务编号">
          <Input allowClear maxLength={200} style={{ width: 140 }} />
        </Form.Item>
        <Form.Item name="batchId" label="批次编号">
          <Input allowClear maxLength={200} style={{ width: 140 }} />
        </Form.Item>
        <Form.Item>
          <Space>
            <Button type="primary" htmlType="submit">
              查询
            </Button>
            <Button loading={isFetching} onClick={() => void refetch()}>
              刷新
            </Button>
          </Space>
        </Form.Item>
      </Form>
      {error && (
        <Alert
          showIcon
          type="error"
          title="成本记录查询失败"
          description={error.message}
        />
      )}
      <Space size="large" wrap>
        <Statistic
          title="已估算成本"
          value={data?.total ? formatCost(cost) : "—"}
        />
        <Statistic title="供应商调用" value={data?.total ?? "—"} />
        <Statistic title="待核算调用" value={data ? missing : "—"} />
      </Space>
      <Table<CostGroup>
        size="small"
        loading={isFetching}
        rowKey={(row) =>
          JSON.stringify([row.operation, row.provider, row.model])
        }
        dataSource={summary}
        pagination={{ pageSize: 10, hideOnSinglePage: true }}
        locale={{ emptyText: "此范围内暂无供应商用量" }}
        columns={[
          {
            title: "功能",
            dataIndex: "operation",
            render: (value: string) => operations[value] ?? value,
          },
          {
            title: "供应商",
            dataIndex: "provider",
            render: (value: string) => providers[value] ?? value,
          },
          { title: "模型", dataIndex: "model" },
          { title: "调用次数", dataIndex: "count", align: "right" },
          { title: "待核算", dataIndex: "unknown", align: "right" },
          {
            title: "已估算成本",
            dataIndex: "costMicros",
            align: "right",
            render: formatCost,
          },
        ]}
      />
      <Table<CostEvent>
        size="small"
        loading={isFetching}
        rowKey="id"
        dataSource={data?.items ?? []}
        scroll={{ x: 1000 }}
        locale={{ emptyText: "暂无调用明细" }}
        pagination={{
          current: page,
          pageSize: data?.pageSize ?? 50,
          total: data?.total ?? 0,
          showSizeChanger: false,
          onChange: setPage,
        }}
        columns={[
          { title: "时间", dataIndex: "createdAt", render: dateTime },
          { title: "账号", dataIndex: "ownerId", ellipsis: true },
          {
            title: "功能 / 模型",
            render: (_, row) => (
              <>
                {operations[row.operation] ?? row.operation}
                <br />
                {row.model}
              </>
            ),
          },
          {
            title: "任务 / 批次",
            render: (_, row) =>
              row.taskId || row.batchId ? (
                <Space orientation="vertical" size={0}>
                  {row.taskId && (
                    <Button
                      type="link"
                      size="small"
                      onClick={() => filterBy("taskId", row.taskId)}
                    >
                      {row.taskId}
                    </Button>
                  )}
                  {row.batchId && (
                    <Button
                      type="link"
                      size="small"
                      onClick={() => filterBy("batchId", row.batchId)}
                    >
                      {row.batchId}
                    </Button>
                  )}
                </Space>
              ) : (
                "—"
              ),
          },
          {
            title: "用量",
            render: (_, row) => (
              <>
                {usedUnits(row) || "—"}
                <br />
                <span className="admin-muted">
                  {sourceLabels[row.source] ?? row.source}
                </span>
              </>
            ),
          },
          {
            title: "状态",
            dataIndex: "status",
            render: (value: string) => <Tag>{statuses[value] ?? value}</Tag>,
          },
          {
            title: "供应商请求 / 任务 ID",
            dataIndex: "providerRef",
            ellipsis: true,
            render: (value: string) => value || "—",
          },
          {
            title: "预计成本",
            dataIndex: "costMicros",
            align: "right",
            render: formatCost,
          },
        ]}
      />
    </Space>
  );
}

const finishedCategories: Record<string, string> = {
  standard: "普通视频",
  minimax: "含 MiniMax 开场调用",
  unclassified: "缺少云端用量记录",
};

function FinishedVideoCosts() {
  const [range, setRange] = useState(billingRange);
  const search = new URLSearchParams({
    view: "finished",
    from: range.from,
    to: range.to,
  });
  const stats = useQuery({
    queryKey: ["admin", "provider-usage", search.toString()],
    queryFn: () =>
      serviceRequest<{ items: FinishedVideoCost[] }>(`${usagePath}?${search}`),
    retry: false,
  });
  return (
    <Space orientation="vertical" size="middle" style={{ display: "flex" }}>
      <p className="admin-muted">
        按北京时间统计本期首次归档且关联计费任务的视频，累加归档前的云端调用。均值和
        P90 仅使用费用已完整估算的样本。
      </p>
      <Form<Filters> layout="inline" initialValues={range} onFinish={setRange}>
        <DateRangeFields />
        <Form.Item>
          <Space>
            <Button type="primary" htmlType="submit">
              查询
            </Button>
            <Button
              loading={stats.isFetching}
              onClick={() => void stats.refetch()}
            >
              刷新
            </Button>
          </Space>
        </Form.Item>
      </Form>
      {stats.error && (
        <Alert
          type="error"
          showIcon
          title="成片成本加载失败"
          description={stats.error.message}
        />
      )}
      <Table<FinishedVideoCost>
        size="small"
        rowKey="category"
        loading={stats.isFetching}
        dataSource={stats.data?.items ?? []}
        pagination={false}
        locale={{ emptyText: "此范围内暂无关联计费任务的成片" }}
        columns={[
          {
            title: "成片类型",
            dataIndex: "category",
            render: (value: string) => finishedCategories[value] ?? value,
          },
          { title: "成片", dataIndex: "count", align: "right" },
          { title: "待核算成片", dataIndex: "unpriced", align: "right" },
          {
            title: "平均云端成本",
            dataIndex: "averageMicros",
            align: "right",
            render: formatCost,
          },
          {
            title: "P90 云端成本",
            dataIndex: "p90Micros",
            align: "right",
            render: formatCost,
          },
        ]}
      />
    </Space>
  );
}

function RateEditor({ rate, onClose }: { rate: Rate; onClose: () => void }) {
  const action = useAdminAction();
  const initial = {
    provider: rate.provider,
    model: rate.model,
    ...Object.fromEntries(
      rateFields.map(([key]) => [
        key,
        rate[key] == null ? null : rate[key] / 1_000_000,
      ]),
    ),
  };
  async function save(values: Rate) {
    const payload = Object.fromEntries(
      rateFields.map(([key]) => [
        key,
        values[key] == null ? null : Math.round(values[key] * 1_000_000),
      ]),
    );
    if (
      await action.run(
        () =>
          serviceRequest(ratePath, {
            ...payload,
            provider: values.provider,
            model: values.model,
          }),
        "已保存供应商费率",
      )
    )
      onClose();
  }
  return (
    <Modal
      open
      title="供应商费率"
      footer={null}
      onCancel={action.busy ? undefined : onClose}
    >
      <Form<Rate>
        layout="vertical"
        initialValues={initial}
        onFinish={(values) => void save(values)}
      >
        <Form.Item name="provider" label="供应商" rules={[{ required: true }]}>
          <Input
            placeholder="bailian、minimax 或文案模型接口域名"
            disabled={!!rate.provider}
            maxLength={252}
          />
        </Form.Item>
        <Form.Item name="model" label="模型" rules={[{ required: true }]}>
          <Input disabled={!!rate.model} maxLength={200} />
        </Form.Item>
        {rateFields.map(([key, label]) => (
          <Form.Item key={key} name={key} label={label}>
            <InputNumber
              min={0}
              max={1000}
              precision={6}
              style={{ width: 180 }}
            />
          </Form.Item>
        ))}
        <p className="admin-muted">
          留空表示该项费率未知，填 0
          表示该项免费。缓存输入留空时按普通输入费率估算。
        </p>
        <Space>
          <Button type="primary" htmlType="submit" loading={action.busy}>
            保存费率
          </Button>
          <Button disabled={action.busy} onClick={onClose}>
            取消
          </Button>
        </Space>
      </Form>
    </Modal>
  );
}

function RateCatalog() {
  const [editing, setEditing] = useState<Rate | null>(null);
  const rates = useQuery({
    queryKey: ["admin", "provider-rates"],
    queryFn: () => serviceRequest<{ items: Rate[] }>(ratePath),
    retry: false,
  });
  return (
    <Space orientation="vertical" size="middle" style={{ display: "flex" }}>
      <p className="admin-muted">
        填写商户实际适用的人民币费率。保存后补算已有用量中尚无费率的记录，已估算记录保留原金额。
      </p>
      <Button
        type="primary"
        onClick={() => setEditing({ provider: "", model: "" })}
      >
        添加费率
      </Button>
      {rates.error && (
        <Alert
          type="error"
          showIcon
          title="费率加载失败"
          description={rates.error.message}
        />
      )}
      <Table<Rate>
        size="small"
        scroll={{ x: 900 }}
        loading={rates.isFetching}
        rowKey={(row) => JSON.stringify([row.provider, row.model])}
        dataSource={rates.data?.items ?? []}
        locale={{ emptyText: "暂无已识别的模型或费率" }}
        pagination={{ pageSize: 10, hideOnSinglePage: true }}
        columns={[
          {
            title: "供应商",
            dataIndex: "provider",
            render: (value: string) => providers[value] ?? value,
          },
          { title: "模型", dataIndex: "model" },
          ...rateFields.map(([key, label]) => ({
            title: label,
            dataIndex: key,
            render: (value: number | null | undefined) =>
              value == null ? "—" : formatCost(value),
          })),
          {
            title: "操作",
            render: (_, row) => (
              <Button type="link" onClick={() => setEditing(row)}>
                {row.updatedAt ? "编辑" : "配置"}
              </Button>
            ),
          },
        ]}
      />
      {editing && (
        <RateEditor rate={editing} onClose={() => setEditing(null)} />
      )}
    </Space>
  );
}

export default function ProviderCostPanel() {
  return (
    <Tabs
      items={[
        { key: "history", label: "用量与成本", children: <CostHistory /> },
        {
          key: "finished",
          label: "成片成本",
          children: <FinishedVideoCosts />,
        },
        { key: "rates", label: "供应商费率", children: <RateCatalog /> },
      ]}
    />
  );
}
