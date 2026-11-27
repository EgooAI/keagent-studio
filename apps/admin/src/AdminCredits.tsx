import { useState } from "react";
import {
  Alert,
  Button,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
} from "antd";
import { useQuery } from "@tanstack/react-query";
import { Plus, RefreshCw } from "lucide-react";
import { dateTime, useAdminAction } from "./admin-api";
import { serviceRequest } from "@keagent/api-client";
import AdminCreditUsage from "./AdminCreditUsage";
import CreditPilotPanel, {
  creditPackLabels,
  useCreditPilot,
} from "./CreditPilotPanel";
import ProviderCostPanel from "./ProviderCostPanel";
import LeadTrialPanel from "./LeadTrialPanel";
import type { CreditPackId } from "@keagent/shared-types";

interface CreditBalanceRow {
  ownerId: string;
  name: string;
  email: string;
  purchasedAvailable: number;
  purchasedHeld: number;
  grantedAvailable: number;
  grantedHeld: number;
  nextExpiry?: string;
}
interface CreditHoldRow {
  id: string;
  ownerId: string;
  name: string;
  email: string;
  op: string;
  refId: string;
  amount: number;
  idemKey: string;
  priceVersion: string;
  createdAt: string;
}
interface CreditBatchRow {
  batchId: string;
  amount: number;
  note: string;
  total: number;
  used: number;
  createdAt: string;
  expiresAt?: string;
  packId?: CreditPackId;
  priceFen?: number;
}

const opLabels: Record<string, string> = {
  opening: "MiniMax 开场",
  voice_clone: "声音复刻",
  script: "AI 文案",
  tts: "云端配音",
  image_expand: "AI 扩图（已下线）",
};
const sourceLabels: Record<string, string> = {
  welcome: "欢迎赠送",
  admin_grant: "后台发放",
  code: "兑换码",
  order: "在线支付",
  release: "扣费退回",
};

function useAdminGet<T>(key: string[], path: string) {
  return useQuery({
    queryKey: key,
    queryFn: () => serviceRequest<T>(path),
    retry: false,
  });
}

function OwnerBalances({
  onInspect,
}: {
  onInspect: (ownerId: string) => void;
}) {
  const balances = useAdminGet<{
    items: CreditBalanceRow[];
    total: number;
  }>(["admin", "credits-list"], "/v1/admin/credits/list");
  return (
    <section
      className="admin-panel admin-table-panel"
      aria-labelledby="credits-balances-title"
    >
      <div className="admin-section-heading">
        <div>
          <h2 id="credits-balances-title">用户积分余额</h2>
          <p className="admin-secondary">
            查看各账号充值积分与赠送积分可用余额及冻结情况，点击明细核对流水。
          </p>
        </div>
        <Button
          icon={<RefreshCw size={14} />}
          loading={balances.isFetching}
          onClick={() => void balances.refetch()}
        >
          刷新
        </Button>
      </div>
      {balances.error && (
        <Alert
          className="admin-notice"
          type="error"
          showIcon
          title="余额列表加载失败"
          description={balances.error.message}
        />
      )}
      <Table<CreditBalanceRow>
        size="small"
        rowKey="ownerId"
        loading={balances.isLoading}
        dataSource={balances.data?.items ?? []}
        scroll={{ x: 740 }}
        locale={{ emptyText: <Empty description="还没有积分用户" /> }}
        pagination={{
          pageSize: 10,
          total: balances.data?.total,
          hideOnSinglePage: true,
        }}
        columns={[
          {
            title: "用户",
            render: (row: CreditBalanceRow) => (
              <div className="admin-user-cell">
                <strong style={{ fontWeight: 550 }}>
                  {row.name || "未命名用户"}
                </strong>
                <span className="admin-secondary">
                  {row.email || row.ownerId}
                </span>
              </div>
            ),
          },
          {
            title: "充值积分",
            align: "right",
            render: (row: CreditBalanceRow) => (
              <span className="admin-num">
                {row.purchasedAvailable}
                {row.purchasedHeld > 0 && (
                  <span className="admin-num-sub">
                    （冻结 {row.purchasedHeld}）
                  </span>
                )}
              </span>
            ),
          },
          {
            title: "赠送积分",
            align: "right",
            render: (row: CreditBalanceRow) => (
              <span className="admin-num">
                {row.grantedAvailable}
                {row.grantedHeld > 0 && (
                  <span className="admin-num-sub">
                    （冻结 {row.grantedHeld}）
                  </span>
                )}
              </span>
            ),
          },
          {
            title: "最近过期",
            dataIndex: "nextExpiry",
            width: 175,
            render: (value?: string) =>
              value ? (
                dateTime(value)
              ) : (
                <span className="admin-empty-val">—</span>
              ),
          },
          {
            title: "操作",
            align: "right",
            width: 90,
            render: (row: CreditBalanceRow) => (
              <Button
                type="link"
                className="admin-row-actions"
                onClick={() => onInspect(row.ownerId)}
              >
                明细
              </Button>
            ),
          },
        ]}
      />
    </section>
  );
}

interface OwnerDetail {
  ownerId: string;
  lots?: {
    id: string;
    kind: string;
    initialAmount: number;
    remaining: number;
    held: number;
    source: string;
    expiresAt?: string;
    createdAt: string;
  }[];
  holds?: {
    id: string;
    op: string;
    amount: number;
    state: string;
    createdAt: string;
  }[];
  ledger?: {
    kind: string;
    amount: number;
    op: string;
    refId: string;
    operatorId: string;
    metadata?: { note?: string; spent?: number };
    createdAt: string;
  }[];
}

function OwnerDetailDrawer({
  ownerId,
  onClose,
}: {
  ownerId: string | null;
  onClose: () => void;
}) {
  const detail = useAdminGet<OwnerDetail>(
    ["admin", "credits-owner", ownerId ?? ""],
    ownerId
      ? `/v1/admin/credits/list?ownerId=${ownerId}`
      : "/v1/admin/credits/list",
  );
  return (
    <Drawer
      rootClassName="admin-detail-drawer"
      open={!!ownerId}
      onClose={onClose}
      width={660}
      title="积分明细"
    >
      {detail.data && (
        <>
          <Descriptions
            bordered
            size="small"
            column={2}
            style={{ marginBottom: 18 }}
            items={[
              {
                key: "id",
                label: "用户编号",
                children: (
                  <Typography.Text copyable>
                    {detail.data.ownerId}
                  </Typography.Text>
                ),
              },
              {
                key: "lots",
                label: "积分批次",
                children: `${detail.data.lots?.length ?? 0} 个`,
              },
            ]}
          />
          <h3 className="admin-detail-heading" style={{ marginTop: 0 }}>
            积分批次
          </h3>
          <Table
            size="small"
            rowKey="id"
            dataSource={detail.data.lots ?? []}
            pagination={false}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="暂无有效积分批次"
                />
              ),
            }}
            style={{ marginBottom: 18 }}
            columns={[
              {
                title: "类别",
                dataIndex: "kind",
                render: (kind: string) => (
                  <Tag color={kind === "purchased" ? "blue" : "green"}>
                    {kind === "purchased" ? "充值" : "赠送"}
                  </Tag>
                ),
              },
              { title: "剩余", dataIndex: "remaining", align: "right" },
              { title: "冻结", dataIndex: "held", align: "right" },
              {
                title: "来源",
                dataIndex: "source",
                render: (source: string) => sourceLabels[source] ?? source,
              },
              {
                title: "过期",
                dataIndex: "expiresAt",
                render: (value?: string) =>
                  value ? dateTime(value) : "不过期",
              },
              {
                title: "发放时间",
                dataIndex: "createdAt",
                render: (value: string) => dateTime(value),
              },
            ]}
          />
          <h3 className="admin-detail-heading">变动流水</h3>
          <Table
            size="small"
            rowKey={(row) => `${row.kind}-${row.createdAt}-${row.amount}`}
            dataSource={detail.data.ledger ?? []}
            pagination={{ pageSize: 8, hideOnSinglePage: true }}
            columns={[
              {
                title: "类型",
                dataIndex: "kind",
                width: 88,
                render: (value: string) => (
                  <code className="admin-code">{value}</code>
                ),
              },
              {
                title: "余额变动",
                dataIndex: "amount",
                width: 90,
                align: "right",
              },
              {
                title: "实际消耗",
                width: 90,
                align: "right",
                render: (row: NonNullable<OwnerDetail["ledger"]>[number]) =>
                  row.kind === "capture" ? (row.metadata?.spent ?? "—") : "—",
              },
              {
                title: "操作",
                dataIndex: "op",
                render: (op: string) => (op ? (opLabels[op] ?? op) : "—"),
              },
              {
                title: "备注",
                render: (row: NonNullable<OwnerDetail["ledger"]>[number]) =>
                  row.metadata?.note || row.refId || "—",
              },
              {
                title: "时间",
                dataIndex: "createdAt",
                render: (value: string) => dateTime(value),
              },
            ]}
          />
          <p className="admin-muted admin-block">
            余额在冻结时扣减，结算时的实际消耗单独列示。
          </p>
        </>
      )}
    </Drawer>
  );
}

function GrantDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [form] = Form.useForm();
  const { run, busy } = useAdminAction();
  const kind = Form.useWatch("kind", form);
  async function submit() {
    const values = await form.validateFields();
    const ok = await run(
      () =>
        serviceRequest("/v1/admin/credits/grant", {
          ownerId: values.ownerId.trim(),
          kind: values.kind,
          amount: values.amount,
          validityDays:
            values.kind === "granted" ? values.validityDays : undefined,
          note: values.note,
        }),
      "发放成功",
    );
    if (ok) {
      form.resetFields();
      onClose();
    }
  }
  return (
    <Modal
      title="积分发放"
      open={open}
      onCancel={onClose}
      onOk={() => void submit()}
      confirmLoading={busy}
      okText="确认发放"
    >
      <Alert
        type="warning"
        showIcon
        title="充值积分不过期；赠送积分到期自动清零。所有发放都会记录在操作日志。"
        style={{ marginBottom: 16 }}
      />
      <Form
        form={form}
        layout="vertical"
        initialValues={{ kind: "purchased", amount: 100 }}
      >
        <Form.Item
          name="ownerId"
          label="用户编号"
          rules={[{ required: true, message: "请输入用户编号" }]}
        >
          <Input placeholder="在用户列表中复制用户编号" />
        </Form.Item>
        <Form.Item name="kind" label="类别" rules={[{ required: true }]}>
          <Select
            options={[
              { value: "purchased", label: "充值积分（不过期）" },
              { value: "granted", label: "赠送积分（会过期）" },
            ]}
          />
        </Form.Item>
        <Form.Item
          name="amount"
          label="数额"
          rules={[{ required: true, message: "请输入数额" }]}
        >
          <InputNumber min={1} max={10000000} style={{ width: "100%" }} />
        </Form.Item>
        {kind === "granted" && (
          <Form.Item
            name="validityDays"
            label="有效期（天）"
            rules={[{ required: true, message: "请输入有效期" }]}
          >
            <InputNumber min={1} max={3650} style={{ width: "100%" }} />
          </Form.Item>
        )}
        <Form.Item
          name="note"
          label="备注"
          rules={[{ required: true, message: "必须填写备注" }]}
        >
          <Input.TextArea placeholder="例如：线下收款凭证号" rows={2} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function OpenHolds() {
  const holds = useAdminGet<CreditHoldRow[]>(
    ["admin", "credits-holds"],
    "/v1/admin/credits/holds",
  );
  const { run, busy } = useAdminAction();
  async function settle(holdId: string, action: "capture" | "release") {
    await run(
      () => serviceRequest("/v1/admin/credits/settle", { holdId, action }),
      action === "capture" ? "已结算扣费" : "已释放退款",
    );
  }
  return (
    <section
      className="admin-panel admin-table-panel"
      aria-labelledby="credits-holds-title"
    >
      <div className="admin-section-heading">
        <div>
          <h2 id="credits-holds-title">在途冻结对账</h2>
          <p className="admin-muted">
            供应商结果未知时积分保持冻结；可在此人工确认成功（结算）或失败（退款）。
          </p>
        </div>
        <Button
          icon={<RefreshCw size={14} />}
          loading={holds.isFetching}
          onClick={() => void holds.refetch()}
        >
          刷新
        </Button>
      </div>
      <Table<CreditHoldRow>
        size="small"
        rowKey="id"
        loading={holds.isLoading}
        dataSource={holds.data ?? []}
        scroll={{ x: 760 }}
        locale={{ emptyText: <Empty description="当前没有待对账的在途冻结" /> }}
        pagination={{ pageSize: 10, hideOnSinglePage: true }}
        columns={[
          {
            title: "操作",
            dataIndex: "op",
            render: (op: string) => <Tag>{opLabels[op] ?? op}</Tag>,
          },
          {
            title: "用户",
            render: (row: CreditHoldRow) => row.name || row.ownerId,
          },
          {
            title: "数额",
            dataIndex: "amount",
            align: "right",
            render: (value: number) => (
              <span className="admin-num">{value}</span>
            ),
          },
          {
            title: "价目版本",
            dataIndex: "priceVersion",
            render: (value: string) => (
              <code className="admin-code">{value}</code>
            ),
          },
          {
            title: "冻结时间",
            dataIndex: "createdAt",
            render: (value: string) => dateTime(value),
          },
          {
            title: "操作",
            align: "right",
            width: 150,
            render: (row: CreditHoldRow) => (
              <Space className="admin-row-actions" size={4}>
                <Button
                  type="link"
                  disabled={busy}
                  onClick={() => void settle(row.id, "capture")}
                >
                  确认成功
                </Button>
                <Button
                  type="link"
                  danger
                  disabled={busy}
                  onClick={() => void settle(row.id, "release")}
                >
                  退款
                </Button>
              </Space>
            ),
          },
        ]}
      />
    </section>
  );
}

function PricingAndWelcome() {
  const pricing = useAdminGet<{
    prices: Record<string, number>;
    version: string;
  }>(["admin", "credits-pricing"], "/v1/admin/credits/pricing");
  const welcome = useAdminGet<{
    enabled: boolean;
    amount: number;
    validityDays: number;
  }>(["admin", "credits-welcome"], "/v1/admin/credits/welcome");
  const { run, busy } = useAdminAction();
  const priceLabels: Record<string, string> = {
    voice_clone: "声音复刻（每次）",
    script: "AI 文案（每次）",
    tts_per_kilo_char: "云端配音（每千字）",
  };
  async function savePricing(next: Record<string, number>) {
    await run(
      () => serviceRequest("/v1/admin/credits/pricing", { prices: next }),
      "价目已保存",
    );
  }
  async function saveWelcome(
    enabled: boolean,
    amount: number,
    validityDays: number,
  ) {
    await run(
      () =>
        serviceRequest("/v1/admin/credits/welcome", {
          enabled,
          amount,
          validityDays,
        }),
      "欢迎赠送配置已保存",
    );
  }
  return (
    <div className="admin-pricing-grid">
      <section className="admin-panel" aria-labelledby="credits-pricing-title">
        <div className="admin-section-heading">
          <div>
            <h2 id="credits-pricing-title">
              计费单价（版本 {pricing.data?.version ?? "…"}）
            </h2>
            <p className="admin-muted">
              调整单项 AI 服务的积分消耗单价，保存后对新任务生效。
            </p>
          </div>
        </div>
        {pricing.data &&
          Object.entries(pricing.data.prices)
            .filter(([key]) => key !== "image_expand" && key !== "opening")
            .map(([key, value]) => (
              <PricingRow
                key={key}
                label={priceLabels[key] ?? key}
                value={value}
                onSave={(next) => void savePricing({ [key]: next })}
                busy={busy}
              />
            ))}
      </section>
      <section className="admin-panel" aria-labelledby="credits-welcome-title">
        <div className="admin-section-heading">
          <div>
            <h2 id="credits-welcome-title">新用户欢迎赠送</h2>
            <p className="admin-muted">
              新账号首次进入工作区时自动发放赠送积分；关闭后不发放。
            </p>
          </div>
        </div>
        {welcome.data && (
          <WelcomeForm
            initial={welcome.data}
            busy={busy}
            onSave={(enabled, amount, validityDays) =>
              void saveWelcome(enabled, amount, validityDays)
            }
          />
        )}
      </section>
    </div>
  );
}

function PricingRow({
  label,
  value,
  onSave,
  busy,
}: {
  label: string;
  value: number;
  onSave: (next: number) => void;
  busy: boolean;
}) {
  const [draft, setDraft] = useState(value);
  return (
    <div className="admin-pricing-row">
      <span>{label}</span>
      <Space>
        <InputNumber
          min={0}
          max={1000000}
          value={draft}
          onChange={(next) => setDraft(next ?? 0)}
          style={{ width: 120 }}
        />
        <Button
          type={draft !== value ? "primary" : "default"}
          disabled={busy || draft === value}
          onClick={() => onSave(draft)}
        >
          保存
        </Button>
      </Space>
    </div>
  );
}

function WelcomeForm({
  initial,
  busy,
  onSave,
}: {
  initial: { enabled: boolean; amount: number; validityDays: number };
  busy: boolean;
  onSave: (enabled: boolean, amount: number, validityDays: number) => void;
}) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [amount, setAmount] = useState(initial.amount);
  const [days, setDays] = useState(initial.validityDays);
  return (
    <div className="admin-stack">
      <div className="admin-pricing-row" style={{ paddingTop: 0 }}>
        <span>自动发放开关</span>
        <Switch
          checked={enabled}
          onChange={setEnabled}
          checkedChildren="开启"
          unCheckedChildren="关闭"
        />
      </div>
      <div className="admin-form-columns">
        <Form.Item label="赠送数额（积分）" style={{ marginBottom: 0 }}>
          <InputNumber
            min={1}
            max={1000000}
            value={amount}
            onChange={(next) => setAmount(next ?? 1)}
            style={{ width: "100%" }}
          />
        </Form.Item>
        <Form.Item label="有效期（天）" style={{ marginBottom: 0 }}>
          <InputNumber
            min={1}
            max={3650}
            value={days}
            onChange={(next) => setDays(next ?? 30)}
            style={{ width: "100%" }}
          />
        </Form.Item>
      </div>
      <div>
        <Button
          type="primary"
          disabled={
            busy ||
            (enabled === initial.enabled &&
              amount === initial.amount &&
              days === initial.validityDays)
          }
          onClick={() => onSave(enabled, amount, days)}
        >
          保存
        </Button>
      </div>
    </div>
  );
}

function CreditCodes() {
  const batches = useAdminGet<CreditBatchRow[]>(
    ["admin", "credit-codes"],
    "/v1/admin/credit-codes",
  );
  const { run, busy } = useAdminAction();
  const pilot = useCreditPilot();
  const [creating, setCreating] = useState(false);
  const [form] = Form.useForm();
  const selectedPack = Form.useWatch<CreditPackId | undefined>("packId", form);
  const [issued, setIssued] = useState<{
    batchId: string;
    codes: string[];
    amount: number;
  } | null>(null);
  async function createBatch() {
    const values = await form.validateFields();
    const holder: {
      created?: { batchId: string; codes: string[]; amount: number };
    } = {};
    const ok = await run(async () => {
      holder.created = await serviceRequest<{
        batchId: string;
        codes: string[];
        amount: number;
      }>("/v1/admin/credit-codes", {
        amount: values.amount,
        packId: values.packId,
        count: values.count,
        validityDays: values.validityDays,
        note: values.note,
      });
    }, "兑换码已生成");
    if (ok && holder.created) {
      setIssued(holder.created);
      setCreating(false);
      form.resetFields();
    }
  }
  return (
    <>
      <section
        className="admin-panel admin-table-panel"
        aria-labelledby="credits-codes-title"
      >
        <div className="admin-section-heading">
          <div>
            <h2 id="credits-codes-title">兑换码批次</h2>
            <p className="admin-muted">
              批量生成积分兑换码并跟踪兑换进度；明文码仅在生成时展示一次。
            </p>
          </div>
          <Space>
            <Button
              icon={<RefreshCw size={14} />}
              loading={batches.isFetching}
              onClick={() => void batches.refetch()}
            >
              刷新
            </Button>
            <Button
              type="primary"
              icon={<Plus size={15} />}
              onClick={() => setCreating(true)}
            >
              生成兑换码批次
            </Button>
          </Space>
        </div>
        <Table<CreditBatchRow>
          size="small"
          rowKey="batchId"
          loading={batches.isLoading}
          dataSource={batches.data ?? []}
          scroll={{ x: 860 }}
          locale={{ emptyText: <Empty description="还没有生成过兑换码批次" /> }}
          pagination={{ pageSize: 10, hideOnSinglePage: true }}
          columns={[
            {
              title: "批次",
              dataIndex: "batchId",
              render: (value: string) => (
                <Typography.Text copyable style={{ fontSize: 12 }}>
                  {value.slice(0, 8)}…
                </Typography.Text>
              ),
            },
            {
              title: "面额",
              dataIndex: "amount",
              align: "right",
              render: (value: number) => (
                <span className="admin-num">{value}</span>
              ),
            },
            {
              title: "试点积分包",
              render: (_, row) =>
                row.packId ? (
                  <Tag color="blue">
                    {creditPackLabels[row.packId]}
                    {row.priceFen
                      ? ` · ¥${(row.priceFen / 100).toFixed(2)}`
                      : ""}
                  </Tag>
                ) : (
                  <span className="admin-empty-val">—</span>
                ),
            },
            { title: "数量", dataIndex: "total", align: "right" },
            { title: "已兑换", dataIndex: "used", align: "right" },
            {
              title: "备注",
              dataIndex: "note",
              render: (value: string) =>
                value || <span className="admin-empty-val">—</span>,
            },
            {
              title: "兑换截止",
              dataIndex: "expiresAt",
              render: (value?: string) => (value ? dateTime(value) : "不限"),
            },
            {
              title: "创建时间",
              dataIndex: "createdAt",
              render: (value: string) => dateTime(value),
            },
          ]}
        />
      </section>
      <Modal
        title="生成兑换码批次"
        open={creating}
        onCancel={() => setCreating(false)}
        onOk={() => void createBatch()}
        confirmLoading={busy}
        okText="生成"
      >
        <Alert
          type="warning"
          showIcon
          title="明文码只在生成时显示一次，请立即复制保存；系统只保留哈希。"
          style={{ marginBottom: 16 }}
        />
        <Form
          form={form}
          layout="vertical"
          initialValues={{ amount: 100, count: 20 }}
        >
          {pilot.data?.packs.some((pack) => pack.enabled) && (
            <Form.Item name="packId" label="关联试点积分包">
              <Select
                allowClear
                virtual={false}
                placeholder="直接填写面额"
                options={pilot.data.packs
                  .filter((pack) => pack.enabled)
                  .map((pack) => ({
                    value: pack.id,
                    label: `${creditPackLabels[pack.id]} · ${pack.credits} 积分`,
                  }))}
              />
            </Form.Item>
          )}
          {!selectedPack && (
            <Form.Item
              name="amount"
              label="每码面额"
              rules={[{ required: true }]}
            >
              <InputNumber min={1} max={10000000} style={{ width: "100%" }} />
            </Form.Item>
          )}
          <Form.Item
            name="count"
            label="生成数量（1–500）"
            rules={[{ required: true }]}
          >
            <InputNumber min={1} max={500} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="validityDays" label="兑换截止（天，留空不限）">
            <InputNumber min={1} max={3650} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input.TextArea placeholder="例如：11 月渠道 A 批次" rows={2} />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title={`兑换码已生成（${issued?.codes.length ?? 0} 个 × ${issued?.amount} 积分）`}
        open={!!issued}
        onCancel={() => setIssued(null)}
        footer={
          <Button type="primary" onClick={() => setIssued(null)}>
            我已保存，关闭
          </Button>
        }
      >
        <Alert
          type="warning"
          showIcon
          title="关闭后无法再次查看明文。"
          style={{ marginBottom: 12 }}
        />
        <Typography.Paragraph
          copyable={{ text: (issued?.codes ?? []).join("\n") }}
          className="admin-codes-box"
        >
          {(issued?.codes ?? []).join("\n")}
        </Typography.Paragraph>
        <p className="admin-muted">批次编号：{issued?.batchId}</p>
      </Modal>
    </>
  );
}

export default function AdminCredits() {
  const [inspected, setInspected] = useState<string | null>(null);
  const [granting, setGranting] = useState(false);
  return (
    <>
      <Tabs
        className="admin-credits-tabs"
        tabBarExtraContent={
          <Button
            type="primary"
            icon={<Plus size={15} />}
            onClick={() => setGranting(true)}
          >
            手动发放积分
          </Button>
        }
        items={[
          {
            key: "usage",
            label: "服务消耗",
            children: <AdminCreditUsage opLabels={opLabels} />,
          },
          {
            key: "provider-cost",
            label: "供应商成本",
            children: <ProviderCostPanel />,
          },
          {
            key: "lead-trial",
            label: "获客试用",
            children: <LeadTrialPanel />,
          },
          {
            key: "pilot-packs",
            label: "试点积分包",
            children: <CreditPilotPanel />,
          },
          {
            key: "balances",
            label: "用户余额",
            children: <OwnerBalances onInspect={setInspected} />,
          },
          { key: "holds", label: "在途对账", children: <OpenHolds /> },
          {
            key: "pricing",
            label: "价目与赠送",
            children: <PricingAndWelcome />,
          },
          { key: "codes", label: "兑换码批次", children: <CreditCodes /> },
        ]}
      />
      <OwnerDetailDrawer
        ownerId={inspected}
        onClose={() => setInspected(null)}
      />
      <GrantDialog open={granting} onClose={() => setGranting(false)} />
    </>
  );
}
