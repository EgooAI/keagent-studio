import { Alert, Button, Input, Table, message } from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Coins, Gift, RefreshCw } from "lucide-react";
import { authRequest, ServiceRequestError } from "@keagent/api-client";
import { creditSummaryQuery, type CreditSummary } from "../lib/creditSummary";
import CreditUsage from "./CreditUsage";
import { CreditActivity } from "./CreditActivity";
import CreditPackOffers from "./CreditPackOffers";

const ledgerLabels: Record<string, string> = {
  grant: "发放",
  redeem: "兑换",
  hold: "冻结",
  capture: "消耗",
  release: "退回",
  adjust: "调整",
  expire: "过期",
};

const opLabels: Record<string, string> = {
  opening: "MiniMax 开场",
  voice_clone: "声音复刻",
  script: "AI 文案",
  tts: "云端配音",
  image_expand: "AI 扩图（已下线）",
};

export function CreditsPanel() {
  const [params] = useSearchParams();
  if (params.get("taskId") || params.get("batchId")) return <CreditActivity />;
  return <CreditWallet />;
}

function CreditWallet() {
  const queryClient = useQueryClient();
  const [code, setCode] = useState("");
  const [redeeming, setRedeeming] = useState(false);
  const summary = useQuery(creditSummaryQuery);
  async function redeem() {
    const trimmed = code.trim();
    if (!trimmed) {
      message.warning("请输入兑换码");
      return;
    }
    setRedeeming(true);
    try {
      const result = await authRequest<{ amount: number }>("credits.redeem", [
        { code: trimmed },
      ]);
      message.success(`兑换成功，到账 ${result.amount} 积分`);
      setCode("");
      await queryClient.invalidateQueries({
        queryKey: creditSummaryQuery.queryKey,
      });
    } catch (error) {
      message.error(
        error instanceof Error ? error.message : "兑换失败，请重试",
      );
    } finally {
      setRedeeming(false);
    }
  }
  const purchased = summary.data?.purchased;
  const granted = summary.data?.granted;
  return (
    <>
      <header className="settings-section-head">
        <h2>我的积分</h2>
        <Button
          aria-label="刷新积分余额"
          icon={<RefreshCw size={16} />}
          onClick={() => void summary.refetch()}
          loading={summary.isFetching}
        >
          刷新
        </Button>
      </header>
      <p>
        AI
        文案、配音和声音复刻按实际调用消耗积分。本机开场视频、视频合成与平台发布不消耗积分。
      </p>
      {summary.error && (
        <Alert
          type="error"
          showIcon
          title="无法读取积分余额"
          description={summary.error.message}
          style={{ marginBottom: 20 }}
        />
      )}
      <div className="settings-credit-balances" aria-busy={summary.isPending}>
        <div>
          <span>
            <Coins size={17} aria-hidden="true" />
            充值积分
          </span>
          <strong>
            {summary.data
              ? (purchased?.available ?? 0).toLocaleString("zh-CN")
              : "—"}
          </strong>
        </div>
        <div>
          <span>
            <Gift size={17} aria-hidden="true" />
            赠送积分
          </span>
          <strong>
            {summary.data
              ? (granted?.available ?? 0).toLocaleString("zh-CN")
              : "—"}
          </strong>
          {granted?.nextExpiry && (
            <small>
              {new Date(granted.nextExpiry).toLocaleDateString("zh-CN")} 过期
            </small>
          )}
        </div>
        {(purchased?.held ?? 0) + (granted?.held ?? 0) > 0 && (
          <div>
            <span>处理中</span>
            <strong>
              {((purchased?.held ?? 0) + (granted?.held ?? 0)).toLocaleString(
                "zh-CN",
              )}
            </strong>
          </div>
        )}
      </div>
      <CreditPackOffers />
      <div className="settings-redemption">
        <Input
          aria-label="兑换码"
          placeholder="输入兑换码"
          value={code}
          maxLength={64}
          onChange={(event) => setCode(event.target.value)}
          onPressEnter={() => void redeem()}
          allowClear
        />
        <Button
          type="primary"
          loading={redeeming}
          onClick={() => void redeem()}
        >
          兑换
        </Button>
      </div>
      <CreditUsage opLabels={opLabels} />
      <CreditActivity />
      <h3>最近流水</h3>
      <p className="muted">余额在冻结时扣减，结算时的实际消耗单独列示。</p>
      <Table
        size="small"
        rowKey={(record) =>
          `${record.kind}-${record.createdAt}-${record.amount}`
        }
        dataSource={summary.data?.ledger ?? []}
        pagination={{ pageSize: 8, hideOnSinglePage: true }}
        scroll={{ x: 600 }}
        columns={[
          {
            title: "类型",
            dataIndex: "kind",
            width: 90,
            render: (kind: string) => ledgerLabels[kind] ?? kind,
          },
          {
            title: "余额变动",
            dataIndex: "amount",
            width: 90,
            render: (amount: number) => (
              <span style={{ color: amount >= 0 ? "#12b76a" : "#f04438" }}>
                {amount >= 0 ? `+${amount}` : amount}
              </span>
            ),
          },
          {
            title: "实际消耗",
            width: 90,
            render: (record: NonNullable<CreditSummary["ledger"]>[number]) =>
              record.kind === "capture" ? (record.metadata?.spent ?? "—") : "—",
          },
          {
            title: "说明",
            render: (record: NonNullable<CreditSummary["ledger"]>[number]) =>
              record.metadata?.note || opLabels[record.op] || record.op || "—",
          },
          {
            title: "时间",
            dataIndex: "createdAt",
            render: (createdAt: string) =>
              new Date(createdAt).toLocaleString("zh-CN", {
                timeZone: "Asia/Shanghai",
              }),
          },
        ]}
      />
      {summary.data && (summary.data.ledger?.length ?? 0) === 0 && (
        <p className="muted">
          暂无流水。积分不足时可在管理后台充值或使用兑换码。
        </p>
      )}
    </>
  );
}

export function isInsufficientCredits(error: unknown): boolean {
  return (
    error instanceof ServiceRequestError &&
    error.code === "CREDITS_INSUFFICIENT"
  );
}
