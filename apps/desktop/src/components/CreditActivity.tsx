import { Alert, Button, Space, Table, Tag } from "antd";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { authRequest } from "@keagent/api-client";

interface CreditActivityItem {
  id: string;
  op: string;
  stage?: string;
  state: "held" | "captured" | "released";
  taskId?: string;
  batchId?: string;
  unit?: "request" | "kilo_char";
  quantity?: number;
  unitPrice?: number;
  characters?: number;
  priceVersion?: string;
  spent: number;
  held: number;
  released: number;
  releaseReason?: string;
  createdAt: string;
  settledAt?: string;
}

interface CreditActivityResponse {
  items: CreditActivityItem[];
  hasMore: boolean;
  totalSpent?: number;
  estimate?: { credits: number; version: string };
}

const stageLabels: Record<string, string> = {
  "script-vision": "看图写文案",
  script: "AI 文案",
  tts: "云端配音",
  "opening-submit": "MiniMax 开场",
  opening: "MiniMax 开场",
  voice_clone: "声音复刻",
  image_expand: "AI 扩图（已下线）",
};

const reasonLabels: Record<string, string> = {
  operation_failed: "操作未完成",
  provider_rejected: "AI 服务拒绝请求",
  provider_cancelled: "AI 服务取消任务",
  manual: "管理员核对后退回",
  stale_hold: "冻结超过处理期限",
  removed: "已移除音色",
  unused: "退回未使用的积分",
};

const stateLabels = { held: "冻结中", captured: "已结算", released: "已退回" };
const stateColors = {
  held: "processing",
  captured: "success",
  released: "default",
};
const formatNumber = (value: number) => value.toLocaleString("zh-CN");
const formatVersion = (version: string) =>
  version === "default" ? "默认价目" : `价目 ${version}`;

export function CreditActivity() {
  const [params] = useSearchParams();
  const taskId = params.get("taskId") || undefined;
  const batchId = params.get("batchId") || undefined;
  return (
    <ActivityList
      key={`${taskId ?? ""}|${batchId ?? ""}`}
      taskId={taskId}
      batchId={batchId}
    />
  );
}

function ActivityList({
  taskId,
  batchId,
}: {
  taskId?: string;
  batchId?: string;
}) {
  const [page, setPage] = useState(1);
  const activity = useQuery({
    queryKey: ["credit-activity", taskId, batchId, page],
    queryFn: () =>
      authRequest<CreditActivityResponse>("credits.activity", [
        { taskId, batchId, page },
      ]),
    retry: false,
  });
  const data = activity.data;
  const studioParams = new URLSearchParams({ view: "tasks" });
  if (taskId) studioParams.set("taskId", taskId);
  if (batchId) studioParams.set("batchId", batchId);
  return (
    <section aria-label="任务账单" className="settings-credit-usage">
      <header className="settings-section-head">
        <h3>
          {taskId ? "视频任务账单" : batchId ? "视频批次账单" : "任务账单"}
        </h3>
        <Button
          aria-label="刷新任务账单"
          loading={activity.isFetching}
          onClick={() => void activity.refetch()}
        >
          刷新
        </Button>
      </header>
      {(taskId || batchId) && (
        <Space wrap>
          <Link to="/settings/credits">全部积分</Link>
          {!!window.desktop && (
            <Link to={`/studio?${studioParams}`}>
              {taskId ? "查看视频任务" : "查看批次任务"}
            </Link>
          )}
        </Space>
      )}
      {data?.totalSpent !== undefined && (
        <p>
          当前已结算 {formatNumber(data.totalSpent)} 积分
          {data.estimate && (
            <>
              {" "}
              · 建批时预估 {formatNumber(data.estimate.credits)} 积分（
              {formatVersion(data.estimate.version)}）
            </>
          )}
        </p>
      )}
      {activity.isError ? (
        <Alert
          type="error"
          showIcon
          title="任务账单加载失败"
          description={activity.error.message}
          action={<Button onClick={() => void activity.refetch()}>重试</Button>}
        />
      ) : (
        <Table<CreditActivityItem>
          size="small"
          rowKey="id"
          dataSource={data?.items ?? []}
          loading={activity.isPending}
          pagination={false}
          locale={{ emptyText: "暂无账单记录" }}
          scroll={{ x: 760 }}
          columns={[
            {
              title: "计费阶段",
              key: "stage",
              render: (_, item) => (
                <Space vertical size={2}>
                  <span>{stageLabels[item.stage ?? item.op] ?? item.op}</span>
                  {item.taskId && !taskId && (
                    <Link
                      to={`/settings/credits?${new URLSearchParams({ taskId: item.taskId })}`}
                      title={item.taskId}
                    >
                      任务 {item.taskId.slice(0, 8)}
                    </Link>
                  )}
                  {item.batchId && !batchId && (
                    <Link
                      to={`/settings/credits?${new URLSearchParams({ batchId: item.batchId })}`}
                      title={item.batchId}
                    >
                      批次 {item.batchId.slice(0, 8)}
                    </Link>
                  )}
                </Space>
              ),
            },
            {
              title: "计费用量",
              key: "quantity",
              render: (_, item) => {
                if (item.quantity === undefined) return "—";
                if (item.unit !== "kilo_char")
                  return `${formatNumber(item.quantity)} 次`;
                return item.characters === undefined
                  ? `按 ${formatNumber(item.quantity)} 千字符计费`
                  : `${formatNumber(item.characters)} 字符 · 按 ${formatNumber(item.quantity)} 千字符计费`;
              },
            },
            {
              title: "结算价目",
              key: "price",
              render: (_, item) => (
                <Space vertical size={2}>
                  {item.unitPrice !== undefined && (
                    <span>
                      {formatNumber(item.unitPrice)} 积分 /{" "}
                      {item.unit === "kilo_char" ? "千字符" : "次"}
                    </span>
                  )}
                  <span className="muted">
                    {item.priceVersion ? formatVersion(item.priceVersion) : "—"}
                  </span>
                </Space>
              ),
            },
            {
              title: "积分结算",
              key: "settlement",
              render: (_, item) => (
                <Space vertical size={2}>
                  <Tag color={stateColors[item.state]}>
                    {stateLabels[item.state]}
                  </Tag>
                  {item.held > 0 && (
                    <span>冻结 {formatNumber(item.held)} 积分</span>
                  )}
                  {item.state === "captured" && (
                    <span>消耗 {formatNumber(item.spent)} 积分</span>
                  )}
                  {item.released > 0 && (
                    <span>
                      退回 {formatNumber(item.released)} 积分 ·{" "}
                      {reasonLabels[item.releaseReason ?? ""] ?? "原因未记录"}
                    </span>
                  )}
                </Space>
              ),
            },
            {
              title: "时间（北京时间）",
              key: "time",
              render: (_, item) =>
                new Date(item.settledAt || item.createdAt).toLocaleString(
                  "zh-CN",
                  {
                    timeZone: "Asia/Shanghai",
                  },
                ),
            },
          ]}
        />
      )}
      {(page > 1 || data?.hasMore) && (
        <Space style={{ marginTop: 12 }}>
          <Button
            disabled={page === 1 || activity.isFetching}
            onClick={() => setPage(page - 1)}
          >
            上一页
          </Button>
          <span>第 {page} 页</span>
          <Button
            disabled={!data?.hasMore || activity.isFetching}
            onClick={() => setPage(page + 1)}
          >
            下一页
          </Button>
        </Space>
      )}
    </section>
  );
}
