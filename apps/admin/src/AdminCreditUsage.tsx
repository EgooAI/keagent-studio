import { useState } from "react";
import { Alert, Button, Input, Space, Table } from "antd";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { serviceRequest } from "@keagent/api-client";

interface CreditUsage {
  items: { op: string; spent: number }[];
  total: number;
}

export default function AdminCreditUsage({
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
    queryKey: ["admin", "credits-usage", range.from, range.to],
    queryFn: () =>
      serviceRequest<CreditUsage>(
        `/v1/admin/credits/usage?${new URLSearchParams(range)}`,
      ),
    enabled: !rangeError,
    retry: false,
  });
  return (
    <section
      className="admin-panel admin-table-panel"
      aria-labelledby="credits-usage-title"
    >
      <div className="admin-section-heading">
        <div>
          <h2 id="credits-usage-title">服务积分消耗</h2>
          <p className="admin-muted">
            汇总所有用户已结算的实际消耗，按北京时间统计，包含起止日期全天。冻结、退回、发放和过期不计入消耗。
          </p>
        </div>
      </div>
      <div className="admin-filter-strip">
        <Space wrap size={[12, 10]}>
          <label className="admin-date-filter">
            开始日期
            <Input
              type="date"
              aria-label="开始日期"
              value={range.from}
              max={range.to}
              onChange={(event) =>
                setRange({ ...range, from: event.target.value })
              }
            />
          </label>
          <label className="admin-date-filter">
            结束日期
            <Input
              type="date"
              aria-label="结束日期"
              value={range.to}
              min={range.from}
              onChange={(event) =>
                setRange({ ...range, to: event.target.value })
              }
            />
          </label>
          <Button
            icon={<RefreshCw size={14} />}
            disabled={!!rangeError}
            loading={query.isFetching}
            onClick={() => void query.refetch()}
          >
            刷新
          </Button>
        </Space>
      </div>
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
              width: 160,
              render: (spent: number) => (
                <span className="admin-num">
                  {spent.toLocaleString("zh-CN")}
                </span>
              ),
            },
          ]}
          footer={
            query.data
              ? () => (
                  <div className="admin-usage-footer">
                    {query.data.total === 0
                      ? "该时间范围内暂无已结算消耗，合计 0 积分"
                      : `合计消耗 ${query.data.total.toLocaleString("zh-CN")} 积分`}
                  </div>
                )
              : undefined
          }
        />
      )}
    </section>
  );
}
