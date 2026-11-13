import { useState } from "react";
import { Alert, Button, Input, Space, Table } from "antd";
import { useQuery } from "@tanstack/react-query";
import { authRequest } from "@keagent/api-client";

interface CreditUsage {
  items: { op: string; spent: number }[];
  total: number;
}

export default function CreditUsage({
  opLabels,
}: {
  opLabels: Record<string, string>;
}) {
  const [range, setRange] = useState(() => {
    const today = Date.now() + 8 * 60 * 60 * 1000;
    return {
      from: new Date(today - 29 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10),
      to: new Date(today).toISOString().slice(0, 10),
    };
  });
  const rangeError =
    !range.from || !range.to
      ? "请选择开始和结束日期"
      : range.from > range.to
        ? "开始日期不能晚于结束日期"
        : "";
  const query = useQuery({
    queryKey: ["credits-usage", range.from, range.to],
    queryFn: () => authRequest<CreditUsage>("credits.usage", [range]),
    enabled: !rangeError,
    retry: false,
  });
  return (
    <section aria-label="服务消耗" style={{ marginBottom: 28 }}>
      <h3 style={{ fontSize: 16, margin: "0 0 10px" }}>服务消耗</h3>
      <p className="muted">
        仅统计你的实际消耗，按结算时间（北京时间）统计，包含起止日期全天。冻结、退回、发放和过期不计入消耗。
      </p>
      <Space wrap style={{ marginBottom: 16 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          开始日期
          <Input
            style={{ width: 160 }}
            type="date"
            aria-label="开始日期"
            value={range.from}
            max={range.to}
            onChange={(event) =>
              setRange({ ...range, from: event.target.value })
            }
          />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          结束日期
          <Input
            style={{ width: 160 }}
            type="date"
            aria-label="结束日期"
            value={range.to}
            min={range.from}
            onChange={(event) => setRange({ ...range, to: event.target.value })}
          />
        </label>
        <Button
          aria-label="刷新服务消耗"
          disabled={!!rangeError}
          loading={query.isFetching}
          onClick={() => void query.refetch()}
        >
          刷新
        </Button>
      </Space>
      {rangeError ? (
        <Alert type="warning" showIcon title={rangeError} />
      ) : query.error ? (
        <Alert
          type="error"
          showIcon
          title="服务消耗加载失败"
          description={query.error.message}
          action={<Button onClick={() => void query.refetch()}>重试</Button>}
        />
      ) : (
        <Table
          size="small"
          rowKey="op"
          loading={query.isPending}
          dataSource={query.data?.items ?? []}
          pagination={false}
          columns={[
            {
              title: "服务",
              dataIndex: "op",
              render: (op: string) => opLabels[op] ?? op,
            },
            {
              title: "消耗积分",
              dataIndex: "spent",
              align: "right",
              render: (spent: number) => spent.toLocaleString("zh-CN"),
            },
          ]}
          footer={
            query.data
              ? () =>
                  query.data.total === 0
                    ? "该时间范围内暂无已结算消耗，合计 0 积分"
                    : `合计消耗 ${query.data.total.toLocaleString("zh-CN")} 积分`
              : undefined
          }
        />
      )}
    </section>
  );
}
