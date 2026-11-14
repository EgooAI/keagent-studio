import { expect, test, type Page } from "@playwright/test";
import { createInitialWorkspace } from "../../packages/api-client/src/fixtures";
import type { CreatorHubAccountSummary } from "../../packages/shared-types/src/collection";

function activeAccount(): CreatorHubAccountSummary {
  return {
    id: "b".repeat(32),
    nickname: "测试抖音账号",
    status: "active",
    has_read_login: true,
  };
}

const leadRow = {
  id: "an1",
  jobId: "job1",
  commentId: "comment-1",
  commentText: "我想在浦东买一套三居室",
  commenterName: "意向客户",
  commenterProfile: "https://www.douyin.com/user/test-lead",
  likeCount: 3,
  commentTime: null,
  status: "qualified",
  error: "",
  intent: "buy" as const,
  evidence: "想买三居室",
  qualified: true,
  reason: "明确购房意向",
  draft: "你好，看到你想在浦东买三居室，方便聊聊预算吗？",
};

async function leadFixture(
  page: Page,
  initialAccounts: CreatorHubAccountSummary[] = [activeAccount()],
  respondOutreach?: (input: Record<string, unknown>) => {
    ok: boolean;
    data?: unknown;
    error?: unknown;
  },
) {
  let accounts = [...initialAccounts];
  const submittedKeys: string[] = [];
  await page.exposeFunction(
    "leadTestRequest",
    (method: string, input: Record<string, unknown> = {}) => {
      const okay = (data: unknown) => ({ ok: true, data });
      if (method === "state")
        return okay({
          deviceId: "lead-test-device",
          resolverAvailable: true,
          tabs: [],
        });
      if (method === "creatorhub.status")
        return okay({ health: "ready", accounts, selectedAccountId: "" });
      if (method === "creatorhub.login") {
        accounts = [activeAccount()];
        return okay({ health: "ready", accounts, selectedAccountId: "" });
      }
      if (method === "creatorhub.start")
        return okay({
          watchId: 1,
          awemeId: "7".repeat(19),
          accountId: "b".repeat(32),
          readCount: 2,
          addedCount: 2,
          updatedCount: 0,
          coverage: "partial",
        });
      if (method === "lead/settings/get")
        return okay({
          criteria: "只找购房客户",
          criteriaHash: "x",
          maxComments: 200,
        });
      if (method === "comments/analyze-batch")
        return okay({
          id: "job1",
          status: "queued",
          total: 2,
          processed: 0,
          qualified: 0,
          failed: 0,
          error: "",
          criteriaHash: "x",
        });
      if (method === "comments/analysis/job")
        return okay({
          id: "job1",
          status: "done",
          total: 2,
          processed: 2,
          qualified: 2,
          failed: 0,
          error: "",
          criteriaHash: "x",
        });
      if (method === "comments/analysis/list")
        return okay({ items: [leadRow] });
      if (method === "outreach.submit") {
        submittedKeys.push(String(input.requestKey));
        if (respondOutreach) return respondOutreach(input);
        return okay({
          id: "o1",
          analysisId: "an1",
          attempt: 1,
          status: "submitted",
          creatorhubTaskId: "7",
          error: "",
        });
      }
      return okay({});
    },
  );
  await page.addInitScript(
    ({ workspace }) => {
      const call = (
        window as unknown as {
          leadTestRequest: (
            method: string,
            input?: unknown,
          ) => Promise<unknown>;
        }
      ).leadTestRequest;
      Object.assign(window, {
        desktop: {
          platform: "win32",
          mode: "authenticated",
          request: async (method: string, args: unknown[] = []) => {
            if (method === "session")
              return { userId: "ui-test", name: "端到端测试", role: "user" };
            if (method === "getWorkspace") return workspace;
            if (method === "tick") return null;
            if (method === "collection.cloud" || method === "douyin.cloud")
              return call(String(args[0]), args[1]);
            throw new Error("Unexpected " + method);
          },
          publishing: { subscribe: () => () => {}, request: call },
        },
      });
    },
    { workspace: createInitialWorkspace() },
  );
  return {
    accounts: () => accounts,
    submittedKeys,
  };
}

async function fillAndStart(page: Page) {
  await page
    .getByLabel("视频链接")
    .fill("https://v.douyin.com/comment-lead-test/");
  await page.getByRole("checkbox", { name: "来源授权" }).check();
  const start = page.getByRole("button", { name: "开始抓取" });
  await expect(start).toBeEnabled();
  await start.click();
  await expect(page.getByText("已导入 2 条评论")).toBeVisible();
}

async function openReview(page: Page) {
  await page.goto("/#/leads/comment-lead");
  await fillAndStart(page);
  await page.getByRole("button", { name: "开始分析" }).click();
  await page.getByRole("button", { name: "查看达标评论" }).click();
  await expect(page.getByText(leadRow.commentText)).toBeVisible();
}

test("评论获客：抓取、分析、审核并提交私信草稿", async ({ page }) => {
  const fixture = await leadFixture(page);
  await page.goto("/#/leads/comment-lead");
  await expect(page.getByRole("heading", { name: "评论获客" })).toBeVisible();
  await fillAndStart(page);
  await expect(page.getByLabel("筛选提示词")).toHaveValue("只找购房客户");
  await expect(page.getByText("最多分析 200 条评论")).toBeVisible();
  await page.getByRole("button", { name: "开始分析" }).click();
  await page.getByRole("button", { name: "查看达标评论" }).click();
  await expect(page.getByText(leadRow.commentText)).toBeVisible();
  await expect(page.getByText("已加载 1 条达标评论。")).toBeVisible();
  await expect(
    page.getByText(
      "CreatorHub 私信默认限速：2 次/小时、8 次/天、最短 900 秒；发送可能持续多天。",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "确认发送" }).click();
  await expect(page.getByText("已提交 CreatorHub 私信队列")).toBeVisible();
  expect(fixture.submittedKeys).toHaveLength(1);
});

test("评论获客：登录后刷新账号并可开始抓取", async ({ page }) => {
  const fixture = await leadFixture(page, []);
  await page.goto("/#/leads/comment-lead");
  const login = page.getByRole("button", { name: "登录抖音" });
  await expect(login).toBeVisible();
  await login.click();
  await expect(page.getByText("测试抖音账号")).toBeVisible();
  await expect(page.getByRole("button", { name: "登录抖音" })).toHaveCount(0);
  expect(fixture.accounts()).toHaveLength(1);
  await fillAndStart(page);
});

test("评论获客：私信提交失败后使用新请求键重试", async ({ page }) => {
  let calls = 0;
  const fixture = await leadFixture(page, undefined, () => {
    calls++;
    return calls === 1
      ? {
          ok: true,
          data: {
            id: "o1",
            analysisId: "an1",
            attempt: 1,
            status: "failed",
            creatorhubTaskId: "",
            error: "发送失败",
          },
        }
      : {
          ok: true,
          data: {
            id: "o2",
            analysisId: "an1",
            attempt: 2,
            status: "submitted",
            creatorhubTaskId: "7",
            error: "",
          },
        };
  });
  await openReview(page);
  const submit = page.getByRole("button", { name: "确认发送" });
  await submit.click();
  await expect(page.getByText("上次提交未完成，请重试")).toBeVisible();
  await expect(page.getByText("已提交 CreatorHub 私信队列")).toHaveCount(0);
  await submit.click();
  await expect(page.getByText("已提交 CreatorHub 私信队列")).toBeVisible();
  expect(fixture.submittedKeys).toHaveLength(2);
  expect(fixture.submittedKeys[0]).not.toBe(fixture.submittedKeys[1]);
});

test("评论获客：提交结果不确定时保留请求键并提示核对", async ({ page }) => {
  let calls = 0;
  const fixture = await leadFixture(page, undefined, () => {
    calls++;
    if (calls === 1)
      return {
        ok: false,
        error: {
          status: 409,
          code: "OUTREACH_UNCERTAIN",
          message: "提交结果暂时无法确认",
        },
      };
    return {
      ok: true,
      data: {
        id: "o1",
        analysisId: "an1",
        attempt: 1,
        status: "uncertain",
        creatorhubTaskId: "",
        error: "",
      },
    };
  });
  await openReview(page);
  const submit = page.getByRole("button", { name: "确认发送" });
  await submit.click();
  await expect(page.getByText("提交结果暂时无法确认")).toBeVisible();
  await expect(page.getByText("已提交 CreatorHub 私信队列")).toHaveCount(0);
  await submit.click();
  await expect(
    page.getByText("结果待确认，请到 CreatorHub 任务队列核对后再确认"),
  ).toBeVisible();
  await expect(page.getByText("已提交 CreatorHub 私信队列")).toHaveCount(0);
  expect(fixture.submittedKeys).toHaveLength(2);
  expect(fixture.submittedKeys[0]).toBe(fixture.submittedKeys[1]);
});
