import {
  Alert,
  Button,
  Col,
  Form,
  Input,
  InputNumber,
  Row,
  Spin,
  Switch,
  Table,
  Typography,
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
      style={{ maxWidth: 760 }}
    >
      <Typography.Paragraph type="secondary">
        启用后的积分包会显示在桌面端「积分与兑换」。在「兑换码批次」选择对应积分包生成发放码。
      </Typography.Paragraph>
      <Row gutter={24}>
        {pilot.packs.map((pack, index) => (
          <Col xs={24} sm={12} key={pack.id}>
            <Typography.Title level={5}>
              {creditPackLabels[pack.id]}
            </Typography.Title>
            <Form.Item
              label={`启用${creditPackLabels[pack.id]}`}
              name={["packs", index, "enabled"]}
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
            <Form.Item name={["packs", index, "credits"]} label="面额（积分）">
              <InputNumber min={1} max={10_000_000} precision={0} />
            </Form.Item>
            <Form.Item
              name={["packs", index, "priceYuan"]}
              label="试点价格（元，可选）"
            >
              <InputNumber min={0.01} max={1_000_000} precision={2} />
            </Form.Item>
          </Col>
        ))}
      </Row>
      <Form.Item
        name="typicalVideoCredits"
        label="普通房源视频参考用量（积分／条）"
        extra="填写已核对的带看文案和配音实测用量。桌面端据此估算视频条数。"
      >
        <InputNumber min={1} max={1_000_000} precision={0} />
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
    <>
      {pilot.isError ? (
        <Alert type="error" showIcon title={pilot.error.message} />
      ) : pilot.data ? (
        <PilotSettings pilot={pilot.data} key={JSON.stringify(pilot.data)} />
      ) : (
        <Spin />
      )}
      <Typography.Title level={5}>积分包兑换</Typography.Title>
      <Typography.Paragraph type="secondary">
        首次和再次兑换按账号在两档试点包中的兑换顺序统计。线下收款须单独核对。
      </Typography.Paragraph>
      {packs.isError && (
        <Alert type="error" showIcon title={packs.error.message} />
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
          { title: "生成码数", dataIndex: "issued" },
          { title: "已兑换码数", dataIndex: "redeemed" },
          { title: "首次兑换人数", dataIndex: "firstRedeemers" },
          { title: "再次兑换人数", dataIndex: "returningRedeemers" },
        ]}
      />
      <Typography.Title level={5}>近 30 天报价与结算</Typography.Title>
      {quotes.isError ? (
        <Alert type="error" showIcon title={quotes.error.message} />
      ) : quotes.isPending ? (
        <Spin />
      ) : quote?.sample ? (
        <>
          <Typography.Paragraph>
            {quote.sample} 个有报价且已发生扣费的任务，平均预估{" "}
            {quote.averageEstimate.toFixed(1)} 积分，平均已结算{" "}
            {quote.averageSettled.toFixed(1)} 积分，平均绝对差{" "}
            {quote.meanAbsoluteDifference.toFixed(1)} 积分。
            {quote.aboveEstimate} 个任务的已结算金额超出预估。
          </Typography.Paragraph>
          <Typography.Paragraph type="secondary">
            进行中的任务也计入，数据随结算更新。
          </Typography.Paragraph>
        </>
      ) : (
        <Typography.Paragraph type="secondary">
          暂无同时记录报价和扣费的任务。
        </Typography.Paragraph>
      )}
    </>
  );
}
