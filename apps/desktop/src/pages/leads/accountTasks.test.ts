import { expect, it } from "vitest";
import type { WorkspaceOutreach } from "@keagent/shared-types";
import { accountTasks, needsOutreachRefresh } from "./accountTasks";

const receipt: WorkspaceOutreach = {
  id: "cloud-task",
  accountId: "old",
  workId: "work",
  analysisId: "lead",
  attempt: 1,
  status: "sent",
  creatorhubTaskId: "local-task",
  error: "",
  draft: "1",
  requestKey: "key",
  method: "browser",
  commenterName: "评论者",
  createdAt: "2026-11-15T03:08:00Z",
  updatedAt: "2026-11-15T03:17:00Z",
  submittedAt: null,
  finishedAt: null,
};
it("keeps older browser receipts unverified and prefers matching Electron queue evidence", () => {
  expect(accountTasks([], [receipt])[0]).toMatchObject({
    stage: "uncertain",
    label: "待核实",
  });
  const tasks = accountTasks(
    [
      {
        id: "local-task",
        batchId: "batch",
        accountId: "old",
        kind: "message",
        title: "私信 · 评论者",
        state: "accepted",
        resultSource: "manual",
      },
    ],
    [{ ...receipt, method: "electron", status: "submitted" }],
  );
  expect(tasks).toHaveLength(1);
  expect(tasks[0]).toMatchObject({
    label: "人工确认已发送",
    receipt: { analysisId: "lead" },
  });
});

it("shows a platform-confirmed message as sent even while the cloud receipt is updating", () => {
  const checkedAt = "2026-11-15T07:08:55Z";
  const tasks = accountTasks(
    [
      {
        id: "local-task",
        batchId: "batch",
        accountId: "acct",
        kind: "message",
        title: "私信 · 评论者",
        state: "accepted",
        checkedAt,
      },
    ],
    [{ ...receipt, method: "electron", status: "sending" }],
  );
  expect(tasks).toHaveLength(1);
  expect(tasks[0]).toMatchObject({
    stage: "done",
    label: "发送成功",
    checkedAt,
  });
});

it("excludes publishing tasks from lead account history and status counts", () => {
  const tasks = accountTasks(
    [
      {
        id: "publish",
        batchId: "batch",
        accountId: "old",
        title: "发布房源视频",
        state: "accepted",
      },
      {
        id: "local-task",
        batchId: "batch",
        accountId: "old",
        kind: "message",
        title: "私信 · 评论者",
        state: "queued",
      },
    ],
    [{ ...receipt, method: "electron" }],
  );
  expect(tasks.map(({ id, stage }) => [id, stage])).toEqual([
    ["local-task", "waiting"],
  ]);
});

it.each([
  {
    state: "failed",
    status: "uncertain",
    resultSource: "manual",
    refresh: true,
  },
  {
    state: "failed",
    status: "uncertain",
    resultSource: undefined,
    refresh: false,
  },
  {
    state: "failed",
    status: "sending",
    resultSource: undefined,
    refresh: true,
  },
  {
    state: "canceled",
    status: "submitted",
    resultSource: undefined,
    refresh: true,
  },
  {
    state: "canceled",
    status: "canceled",
    resultSource: undefined,
    refresh: false,
  },
] as const)(
  "syncs $state to a compatible cloud status $status",
  ({ state, status, resultSource, refresh }) => {
    const [task] = accountTasks(
      [
        {
          id: "local-task",
          batchId: "local-task",
          accountId: "old",
          kind: "message",
          title: "私信",
          state,
          resultSource,
        },
      ],
      [{ ...receipt, method: "electron", status }],
    );
    expect(needsOutreachRefresh(task)).toBe(refresh);
  },
);
