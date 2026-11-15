import { useQuery } from "@tanstack/react-query";
import { leadWorkspaceApi } from "@keagent/api-client";
import type { DouyinQueueRow } from "@keagent/shared-types";
import { useDouyinDesktop } from "../../lib/douyin";
type Receipt = Awaited<
  ReturnType<typeof leadWorkspaceApi.outreach>
>["items"][number];
type Stage =
  "waiting" | "running" | "uncertain" | "done" | "failed" | "canceled";
export interface AccountTask {
  id: string;
  title: string;
  kind: "message" | "video";
  stage: Stage;
  label: string;
  detail: string;
  createdAt?: string;
  checkedAt?: string;
  local?: DouyinQueueRow;
  receipt?: Receipt;
}

export function accountTasks(
  rows: DouyinQueueRow[],
  receipts: Receipt[],
): AccountTask[] {
  const byLocalId = new Map(
    receipts
      .filter((r) => r.method === "electron" && r.creatorhubTaskId)
      .map((r) => [r.creatorhubTaskId, r]),
  );
  const localIds = new Set(rows.map((r) => r.id));
  const tasks: AccountTask[] = rows.map((local) => {
    const receipt = byLocalId.get(local.id);
    const kind = local.kind === "message" ? "message" : "video";
    const stage: Stage = (
      {
        queued: "waiting",
        running: "running",
        submitting: "running",
        unknown: "uncertain",
        interrupted: "uncertain",
        accepted: "done",
        failed: "failed",
        canceled: "canceled",
      } as const
    )[local.state];
    const labels: Record<Stage, string> = {
      waiting: local.eligibleAt ? "等待发送间隔" : "排队中",
      running: kind === "message" ? "发送中" : "发布中",
      uncertain: "待核实",
      done:
        kind === "video"
          ? "平台已接受发布"
          : local.resultSource === "manual"
            ? "人工确认已发送"
            : "发送成功",
      failed: local.resultSource === "manual" ? "人工确认未发送" : "执行失败",
      canceled: "已取消",
    };
    return {
      id: local.id,
      kind,
      stage,
      label: labels[stage],
      title: local.title,
      createdAt: local.createdAt ?? receipt?.createdAt,
      checkedAt: local.checkedAt,
      detail: local.errorMessage || local.errorCode || "",
      local,
      receipt,
    };
  });
  for (const receipt of receipts) {
    if (receipt.method === "electron" && localIds.has(receipt.creatorhubTaskId))
      continue;
    const legacy =
      receipt.method !== "electron" &&
      ["sent", "submitted", "sending"].includes(receipt.status);
    const stage: Stage = legacy
      ? "uncertain"
      : (
          {
            approved: "waiting",
            submitted: "waiting",
            sending: "running",
            sent: "done",
            uncertain: "uncertain",
            failed: "failed",
            canceled: "canceled",
          } as const
        )[receipt.status];
    const label = {
      waiting: "待执行",
      running: "发送中",
      done: "已记录发送",
      uncertain: "待核实",
      failed: "执行失败",
      canceled: "已取消",
    }[stage];
    tasks.push({
      id: receipt.id,
      kind: "message",
      stage,
      label,
      title: "私信 · " + (receipt.commenterName || "评论者"),
      createdAt: receipt.createdAt,
      detail: legacy ? "历史任务缺少平台会话凭据" : receipt.error,
      receipt,
    });
  }
  return tasks.sort((a, b) =>
    (b.createdAt || "").localeCompare(a.createdAt || ""),
  );
}

export function useAccountTasks(accountId: string) {
  const desktop = useDouyinDesktop();
  const history = useQuery({
    queryKey: ["lead-workspace", "queue", accountId],
    queryFn: async ({ signal }) => {
      const receipts: Receipt[] = [];
      let cursor: string | undefined;
      do {
        signal.throwIfAborted();
        const page = await leadWorkspaceApi.outreach({
          accountId,
          cursor,
          limit: 100,
        });
        receipts.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      return receipts;
    },
    refetchInterval: 15000,
  });
  const rows = (desktop.data?.queue?.rows ?? []).filter(
    (r) => r.accountId === accountId,
  );
  return {
    tasks: accountTasks(rows, history.data ?? []),
    paused: desktop.data?.queue?.paused,
    loading: desktop.isPending || history.isPending,
    error: history.error ?? desktop.error,
    refresh: () => Promise.all([desktop.refetch(), history.refetch()]),
  };
}
