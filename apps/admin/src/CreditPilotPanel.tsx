import {
  Alert,
  Button,
  Form,
  Input,
  InputNumber,
  Skeleton,
  Switch,
  Table,
} from "antd";
import { useQuery } from "@tanstack/react-query";
import { serviceRequest } from "@keagent/api-client";
import type {
  CreditPackId,
  CreditPackPilot,
  CreditPackStats,
  CreditPilotQuoteStats,
} from "@keagent/shared-types";
import { useAdminAction } from "./admin-api";

export const creditPackLabels: Record<CreditPackId, string> = {
  starter: "体验包",
  regular: "常用包",
};

export function useCreditPilot() {
  return useQuery({
    queryKey: ["admin", "credit-packs"],
    queryFn: () => serviceRequest<CreditPackPilot>("/v1/admin/credits/packs"),
    retry: false,
  });
}

type PilotFormValues = {
  instructions?: string;
  typicalVideoCredits?: number;
  packs: { enabled: boolean; credits?: number; priceYuan?: number }[];
};

function PilotSettings({ pilot }: { pilot: CreditPackPilot }) {
  const { run, busy } = useAdminAction();
  const initialValues: PilotFormValues = {
    instructions: pilot.instructions,
    typicalVideoCredits: pilot.typicalVideoCredits || undefined,
    packs: pilot.packs.map((pack) => ({
      enabled: pack.enabled,
      credits: pack.credits || undefined,
      priceYuan: pack.priceFen ? pack.priceFen / 100 : undefined,
    })),
  };
  function save(values: PilotFormValues) {
    return run(
      () =>
        serviceRequest("/v1/admin/credits/packs", {
          instructions: values.instructions ?? "",
          typicalVideoCredits: values.typicalVideoCredits ?? 0,
          packs: pilot.packs.map(({ id }, index) => {
            const pack = values.packs[index];
            return {
              id,
              enabled: pack.enabled,
              credits: pack.credits ?? 0,
              priceFen: pack.priceYuan
                ? Math.round(pack.priceYuan * 100)
                : undefined,
            };
          }),
        }),
      "试点积分包已保存",
    );
  }
  return (
    <Form<PilotFormValues>
      layout="vertical"
      initialValues={initialValues}
      onFinish={(values) => void save(values)}
      style={{ maxWidth: 820 }}
    >
      <div className="admin-pilot-cards">
        {pilot.packs.map((pack, index) => (
          <div className="admin-pilot-card" key={pack.id}>
            <div className="admin-pilot-card-head">
              <h4>{creditPackLabels[pack.id]}</h4>
              <Form.Item
                name={["packs", index, "enabled"]}
                valuePropName="checked"
              >
                <Switch
                  aria-label={`启用${creditPackLabels[pack.id]}`}
                  checkedChildren="已启用"
                  unCheckedChildren="已关闭"
                />
              </Form.Item>
            </div>
            <Form.Item name={["packs", index, "credits"]} label="面额（积分）">
              <InputNumber
                min={1}
                max={10_000_000}
                precision={0}
                style={{ width: "100%" }}
              />
            </Form.Item>
            <Form.Item
              name={["packs", index, "priceYuan"]}
              label="试点价格（元，可选）"
              style={{ marginBottom: 0 }}
            >
              <InputNumber
                min={0.01}
                max={1_000_000}
                precision={2}
                style={{ width: "100%" }}
              />
            </Form.Item>
          </div>
        ))}
      </div>
      <Form.Item
        name="typicalVideoCredits"
        label="普通房源视频参考用量（积分／条）"
        extra="填写已核对的带看文案和配音实测用量。桌面端据此估算视频条数。"
      >
        <InputNumber
          min={1}
          max={1_000_000}
          precision={0}
          style={{ width: 240 }}
        />
      </Form.Item>
      <Form.Item
        name="instructions"
        label="获取方式"
        extra="这段文字会显示给用户。填写领取或联系购买的方式。"
      >
        <Input.TextArea maxLength={500} rows={2} />
      </Form.Item>
      <Button type="primary" htmlType="submit" loading={busy}>
        保存积分包
      </Button>
    </Form>
  );
}

export default function CreditPilotPanel() {
  const pilot = useCreditPilot();
  const packs = useQuery({
    queryKey: ["admin", "credit-pack-stats"],
    queryFn: () =>
      serviceRequest<CreditPackStats[]>("/v1/admin/credits/pack-stats"),
    retry: false,
  });
  const quotes = useQuery({
    queryKey: ["admin", "credit-quote-stats"],
    queryFn: () =>
      serviceRequest<CreditPilotQuoteStats>("/v1/admin/credits/quote-stats"),
    retry: false,
  });
  const quote = quotes.data;
  return (
    <div className="admin-stack">
      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <h2>试点积分包配置</h2>
            <p className="admin-muted">
              启用后的积分包会显示在桌面端「积分与兑换」。在「兑换码批次」选择对应积分包生成发放码。
            </p>
          </div>
        </div>
        {pilot.isError ? (
          <Alert type="error" showIcon title={pilot.error.message} />
        ) : pilot.data ? (
          <PilotSettings pilot={pilot.data} key={JSON.stringify(pilot.data)} />
        ) : (
          <Skeleton active paragraph={{ rows: 4 }} />
        )}
      </section>

      <section className="admin-panel admin-table-panel">
        <div className="admin-section-heading">
          <div>
            <h2>积分包兑换</h2>
            <p className="admin-muted">
              首次和再次兑换按账号在两档试点包中的兑换顺序统计。线下收款须单独核对。
            </p>
          </div>
        </div>
        {packs.isError && (
          <Alert
            className="admin-notice"
            type="error"
            showIcon
            title={packs.error.message}
          />
        )}
        <Table<CreditPackStats>
          loading={packs.isPending}
          dataSource={packs.data ?? []}
          rowKey="id"
          size="small"
          pagination={false}
          scroll={{ x: 530 }}
          columns={[
            { title: "积分包", render: (_, row) => creditPackLabels[row.id] },
            { title: "生成码数", dataIndex: "issued", align: "right" },
            { title: "已兑换码数", dataIndex: "redeemed", align: "right" },
            {
              title: "首次兑换人数",
              dataIndex: "firstRedeemers",
              align: "right",
            },
            {
              title: "再次兑换人数",
              dataIndex: "returningRedeemers",
              align: "right",
            },
          ]}
        />
      </section>

      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <h2>近 30 天报价与结算</h2>
            <p className="admin-muted">进行中的任务也计入，数据随结算更新。</p>
          </div>
        </div>
        {quotes.isError ? (
          <Alert type="error" showIcon title={quotes.error.message} />
        ) : quotes.isPending ? (
          <Skeleton active paragraph={{ rows: 2 }} />
        ) : quote?.sample ? (
          <>
            <div className="admin-quote-grid">
              <div className="admin-quote-item">
                <span>统计样本</span>
                <strong>{quote.sample} 个任务</strong>
              </div>
              <div className="admin-quote-item">
                <span>平均预估</span>
                <strong>{quote.averageEstimate.toFixed(1)} 积分</strong>
              </div>
              <div className="admin-quote-item">
                <span>平均已结算</span>
                <strong>{quote.averageSettled.toFixed(1)} 积分</strong>
              </div>
              <div className="admin-quote-item">
                <span>平均绝对差 / 超估</span>
                <strong>
                  {quote.meanAbsoluteDifference.toFixed(1)} /{" "}
                  {quote.aboveEstimate} 个
                </strong>
              </div>
            </div>
            <p className="admin-muted">
              {quote.sample} 个有报价且已发生扣费的任务，平均预估{" "}
              {quote.averageEstimate.toFixed(1)} 积分，平均已结算{" "}
              {quote.averageSettled.toFixed(1)} 积分，平均绝对差{" "}
              {quote.meanAbsoluteDifference.toFixed(1)} 积分。
              {quote.aboveEstimate} 个任务的已结算金额超出预估。
            </p>
          </>
        ) : (
          <p className="admin-muted" style={{ margin: 0 }}>
            暂无同时记录报价和扣费的任务。
          </p>
        )}
      </section>
    </div>
  );
}
