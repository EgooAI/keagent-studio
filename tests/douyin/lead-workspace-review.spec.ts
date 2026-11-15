import { expect, test } from "@playwright/test";
import { createInitialWorkspace } from "../../packages/api-client/src/fixtures";
import type { WorkspaceLead } from "../../packages/shared-types/src/lead-workspace";

test("从当前账号读取已识别线索，保存草稿和单独重试不创建分析任务", async ({
  page,
}) => {
  const accountId = "b".repeat(32);
  const workId = "7392457264415722767";
  const row: WorkspaceLead = {
    id: "review1",
    accountId,
    workId,
    title: "历史作品",
    sourceState: "active",
    canAnalyze: true,
    canContact: true,
    jobId: "saved-job",
    commentId: "comment1",
    commentRowId: "record1",
    commenterName: "看房人",
    commentText: "周末可以约看吗？",
    commenterProfile: "https://www.douyin.com/user/fixture",
    commentTime: null,
    likeCount: 1,
    qualified: true,
    intent: "viewing",
    evidence: "周末可以约看",
    reason: "希望周末看房",
    status: "done",
    error: "",
    draft: "",
    draftError: "草稿尚未生成",
    manualDraft: null,
    reviewStatus: "pending",
  };
  const history: WorkspaceLead = {
    ...row,
    id: "review2",
    commenterName: "历史联系人",
    reviewStatus: "queued",
    outreachStatus: "sent",
    outreach: {
      id: "old-task",
      analysisId: "review2",
      accountId,
      workId,
      status: "sent",
      attempt: 1,
      creatorhubTaskId: "2",
      method: "browser",
      draft: "1",
      requestKey: "key",
      error: "",
      commenterName: "历史联系人",
      createdAt: "2026-11-15T01:00:00Z",
      updatedAt: "2026-11-15T01:00:00Z",
      submittedAt: null,
      finishedAt: null,
    },
  };
  const calls: string[] = [];
  await page.exposeFunction(
    "workspaceReviewCall",
    async (op: string, input: Record<string, unknown> = {}) => {
      calls.push(op);
      let data: unknown = {};
      if (op === "state")
        data = {
          deviceId: "review-fixture",
          tabs: [],
          resolverAvailable: true,
        };
      if (op === "accounts/list") data = { items: [] };
      if (op === "social.status")
        data = {
          health: "ready",
          accounts: [
            {
              id: accountId,
              nickname: "看房账号",
              platform: "douyin",
              status: "active",
              has_read_login: true,
            },
          ],
          selectedAccountId: accountId,
        };
      if (op === "lead/workspace/leads") data = { items: [row, history] };
      if (op === "comments/analysis/retry-draft") {
        row.draft = "你周末哪天方便？";
        row.draftError = "";
        data = { draft: row.draft };
      }
      if (op === "lead/workspace/save-review") {
        if (typeof input.draft === "string") row.manualDraft = input.draft;
        if (typeof input.skipped === "boolean")
          row.reviewStatus = input.skipped ? "skipped" : "pending";
        data = { ok: true };
      }
      return { ok: true, data };
    },
  );
  await page.addInitScript(
    ({ workspace }) => {
      const call = (
        window as unknown as {
          workspaceReviewCall: (
            op: string,
            input?: unknown,
          ) => Promise<unknown>;
        }
      ).workspaceReviewCall;
      Object.assign(window, {
        desktop: {
          mode: "authenticated",
          platform: "win32",
          request: async (op: string, args: unknown[] = []) => {
            if (op === "session")
              return { userId: "ui-test", name: "端到端测试", role: "user" };
            if (op === "getWorkspace") return workspace;
            if (op === "tick") return null;
            if (op === "collection.cloud" || op === "douyin.cloud")
              return call(String(args[0]), args[1]);
            throw new Error(op);
          },
          publishing: { subscribe: () => () => {}, request: call },
        },
      });
    },
    { workspace: createInitialWorkspace() },
  );
  await page.goto(
    "/#/leads/review?accountId=" + accountId + "&platform=douyin",
  );
  await expect(page.getByRole("blockquote")).toHaveText(row.commentText);
  await expect(
    page.getByRole("button", { name: "加入私信队列", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "重试生成草稿" }).click();
  const editor = page.getByRole("textbox", { name: "私信草稿", exact: true });
  await expect(editor).toHaveValue("你周末哪天方便？");
  await editor.fill("周六上午可以安排看房。");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect.poll(() => row.manualDraft).toBe("周六上午可以安排看房。");
  await page.getByRole("button", { name: "暂不联系", exact: true }).click();
  await expect.poll(() => row.reviewStatus).toBe("skipped");
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await expect(editor).toHaveValue("周六上午可以安排看房。");
  await expect(page.getByRole("button", { name: "恢复待审核" })).toBeVisible();
  await page.getByRole("button", { name: "查看 历史联系人 的评论" }).click();
  await expect(
    page
      .getByRole("region", { name: "评论者列表" })
      .getByText("历史任务 · 待核实"),
  ).toBeVisible();
  await expect(editor).toHaveValue("1");
  expect(
    calls.filter((op) => op === "comments/analysis/retry-draft"),
  ).toHaveLength(1);
  expect(calls).not.toContain("comments/analyze-batch");
  expect(calls).not.toContain("social.start");
  expect(calls).not.toContain("outreach.submit");
});
