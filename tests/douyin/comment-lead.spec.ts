import { expect, test, type Page } from "@playwright/test";
import { createInitialWorkspace } from "../../packages/api-client/src/fixtures";
import type {
  CreatorHubAccountSummary,
  OutreachTask,
} from "../../packages/shared-types/src/collection";

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
  respondOutreach?: (
    input: Record<string, unknown>,
    items: OutreachTask[],
  ) => {
    ok: boolean;
    data?: unknown;
    error?: unknown;
  },
  respondRefresh?: (
    input: Record<string, unknown>,
    items: OutreachTask[],
  ) => {
    ok: boolean;
    data?: unknown;
    error?: unknown;
  },
) {
  let accounts = [...initialAccounts];
  let startFailure: unknown = undefined;
  const submittedKeys: string[] = [];
  const submittedDrafts: string[] = [];
  const outreachItems: OutreachTask[] = [];
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
      if (method === "creatorhub.start") {
        if (startFailure) return { ok: false, error: startFailure };
        return okay({
          watchId: 1,
          awemeId: "7".repeat(19),
          accountId: "b".repeat(32),
          readCount: 2,
          addedCount: 2,
          updatedCount: 0,
          coverage: "partial",
        });
      }
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
      if (method === "outreach/list") return okay({ items: outreachItems });
      if (method === "outreach.refresh") {
        if (respondRefresh) return respondRefresh(input, outreachItems);
        const item = outreachItems.find(
          (candidate) => candidate.id === input.outreachId,
        );
        return item
          ? okay({ ...item })
          : {
              ok: false,
              error: {
                status: 404,
                code: "OUTREACH_NOT_FOUND",
                message: "私信任务不存在",
              },
            };
      }
      if (method === "outreach.confirm") {
        const item = outreachItems.find(
          (candidate) => candidate.id === input.outreachId,
        );
        if (!item)
          return {
            ok: false,
            error: {
              status: 404,
              code: "OUTREACH_NOT_FOUND",
              message: "私信任务不存在",
            },
          };
        item.status = input.status as OutreachTask["status"];
        return okay({ ...item });
      }
      if (method === "outreach.submit") {
        submittedKeys.push(String(input.requestKey));
        submittedDrafts.push(String(input.draft));
        const response = respondOutreach
          ? respondOutreach(input, outreachItems)
          : okay({
              id: "o1",
              analysisId: "an1",
              attempt: 1,
              status: "submitted",
              creatorhubTaskId: "7",
              error: "",
              draft: String(input.draft),
            });
        const data = response.data as OutreachTask | undefined;
        if (
          response.ok &&
          data &&
          !outreachItems.some(({ id }) => id === data.id)
        )
          outreachItems.push(data);
        return response;
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
    setAccounts: (next: CreatorHubAccountSummary[]) => {
      accounts = next;
    },
    setStartFailure: (error: unknown) => {
      startFailure = error;
    },
    submittedKeys,
    submittedDrafts,
    outreachItems,
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

test("评论获客：账号列表变化后清除失效账号", async ({ page }) => {
  const fixture = await leadFixture(page);
  await page.goto("/#/leads/comment-lead");
  await expect(page.getByText("测试抖音账号")).toBeVisible();
  await page
    .getByLabel("视频链接")
    .fill("https://v.douyin.com/comment-lead-test/");
  await page.getByRole("checkbox", { name: "来源授权" }).check();
  const start = page.getByRole("button", { name: "开始抓取" });
  await expect(start).toBeEnabled();
  fixture.setAccounts([]);
  fixture.setStartFailure({
    status: 409,
    code: "CREATORHUB_UNAVAILABLE",
    message: "账号已失效",
  });
  await start.click();
  await expect(page.getByText("账号已失效")).toBeVisible();
  await expect(start).toBeDisabled();
});

test("评论获客：私信提交失败后使用新请求键重试", async ({ page }) => {
  let calls = 0;
  const fixture = await leadFixture(page, undefined, (input) => {
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
            draft: String(input.draft),
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
            draft: String(input.draft),
          },
        };
  });
  await openReview(page);
  await page.getByRole("button", { name: "确认发送" }).click();
  await expect(page.getByText("上次提交未完成，请重试")).toBeVisible();
  await expect(page.getByText("已提交 CreatorHub 私信队列")).toHaveCount(0);
  await expect(page.getByText("失败", { exact: true })).toBeVisible();
  await expect(fixture.outreachItems).toHaveLength(1);
  await page.getByRole("button", { name: "重新提交" }).click();
  await expect(page.getByText("已提交 CreatorHub 私信队列")).toBeVisible();
  expect(fixture.submittedKeys).toHaveLength(2);
  expect(fixture.submittedKeys[0]).not.toBe(fixture.submittedKeys[1]);
});

test("评论获客：提交结果不确定时保留请求键并提示核对", async ({ page }) => {
  let calls = 0;
  const fixture = await leadFixture(page, undefined, (input) => {
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
        draft: String(input.draft),
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

test("评论获客：CreatorHub 明确拒绝后展示失败并使用新请求键重新提交", async ({
  page,
}) => {
  let calls = 0;
  const fixture = await leadFixture(page, undefined, (input, items) => {
    calls++;
    if (calls === 1) {
      items.push({
        id: "o-failed",
        analysisId: "an1",
        attempt: 1,
        status: "failed",
        creatorhubTaskId: "",
        error: "CreatorHub 拒绝该私信",
        draft: String(input.draft),
      });
      return {
        ok: false,
        error: {
          status: 400,
          code: "CREATORHUB_REJECTED",
          message: "CreatorHub 拒绝该私信",
        },
      };
    }
    return {
      ok: true,
      data: {
        id: "o2",
        analysisId: "an1",
        attempt: 2,
        status: "submitted",
        creatorhubTaskId: "7",
        error: "",
        draft: String(input.draft),
      },
    };
  });
  await openReview(page);
  await page.getByRole("button", { name: "确认发送" }).click();
  await expect(page.getByText("CreatorHub 拒绝该私信")).toBeVisible();
  await expect(page.getByText("已提交 CreatorHub 私信队列")).toHaveCount(0);
  await expect(page.getByText("失败", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "重新提交" })).toBeVisible();
  await page.getByRole("button", { name: "重新提交" }).click();
  await expect(page.getByText("已提交 CreatorHub 私信队列")).toBeVisible();
  expect(calls).toBe(2);
  expect(fixture.submittedKeys).toHaveLength(2);
  expect(fixture.submittedKeys[0]).not.toBe(fixture.submittedKeys[1]);
});

test("评论获客：已有的私信任务展示状态并禁止重复提交", async ({ page }) => {
  const fixture = await leadFixture(page);
  fixture.outreachItems.push({
    id: "o-existing",
    analysisId: "an1",
    attempt: 1,
    status: "sent",
    creatorhubTaskId: "9",
    error: "",
    draft: leadRow.draft,
  });
  await openReview(page);
  await expect(page.getByText("已发送", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "确认发送" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "刷新状态" })).toHaveCount(0);
  await expect(page.getByLabel("私信草稿-意向客户")).toHaveJSProperty(
    "readOnly",
    true,
  );
});

test("评论获客：刷新已提交任务后采用服务端状态与草稿", async ({ page }) => {
  const fixture = await leadFixture(
    page,
    undefined,
    undefined,
    (input, items) => {
      const index = items.findIndex(
        (candidate) => candidate.id === input.outreachId,
      );
      if (index < 0)
        return {
          ok: false,
          error: {
            status: 404,
            code: "OUTREACH_NOT_FOUND",
            message: "私信任务不存在",
          },
        };
      const sent: OutreachTask = {
        ...items[index],
        status: "sent",
        draft: "服务端记录的实际私信草稿",
      };
      items.splice(index, 1, sent);
      return { ok: true, data: sent };
    },
  );
  await openReview(page);
  await page.getByRole("button", { name: "确认发送" }).click();
  await expect(page.getByText("已提交 CreatorHub 私信队列")).toBeVisible();
  await expect(page.getByText("已提交", { exact: true })).toBeVisible();
  const refresh = page.getByRole("button", { name: "刷新状态" });
  await expect(refresh).toBeVisible();
  await refresh.click();
  await expect(page.getByText("已发送", { exact: true })).toBeVisible();
  await expect(page.getByText("任务状态已更新：已发送")).toBeVisible();
  await expect(page.getByRole("button", { name: "刷新状态" })).toHaveCount(0);
  const draft = page.getByLabel("私信草稿-意向客户");
  await expect(draft).toHaveValue("服务端记录的实际私信草稿");
  await expect(draft).toHaveJSProperty("readOnly", true);
  expect(fixture.outreachItems[0]?.status).toBe("sent");
});

test("评论获客：服务商结果待确认的任务可人工确认", async ({ page }) => {
  const fixture = await leadFixture(page);
  fixture.outreachItems.push({
    id: "o-uncertain",
    analysisId: "an1",
    attempt: 1,
    status: "uncertain",
    creatorhubTaskId: "9",
    error: "",
    draft: leadRow.draft,
  });
  await openReview(page);
  await expect(page.getByText("结果待确认", { exact: true })).toBeVisible();
  const confirmed = page.getByRole("button", { name: "确认已发送" });
  await expect(confirmed).toBeVisible();
  await expect(page.getByRole("button", { name: "确认失败" })).toBeVisible();
  await confirmed.click();
  await page.getByRole("button", { name: /^确\s*认$/ }).click();
  await expect(page.getByText("已确认发送")).toBeVisible();
  await expect(page.getByText("已发送", { exact: true })).toBeVisible();
  expect(fixture.outreachItems[0]?.status).toBe("sent");
});

test("评论获客：服务端待发送任务可编辑草稿并继续发送", async ({ page }) => {
  const fixture = await leadFixture(page);
  fixture.outreachItems.push({
    id: "o-approved",
    analysisId: "an1",
    attempt: 1,
    status: "approved",
    creatorhubTaskId: "",
    error: "",
    draft: "服务端保存的待发送草稿",
  });
  await openReview(page);
  await expect(page.getByText("待发送", { exact: true })).toBeVisible();
  const draft = page.getByLabel("私信草稿-意向客户");
  await expect(draft).toHaveValue("服务端保存的待发送草稿");
  await expect(draft).toHaveJSProperty("readOnly", false);
  await draft.fill("继续发送时使用的新草稿");
  const send = page.getByRole("button", { name: "继续发送" });
  await expect(send).toBeVisible();
  await send.click();
  await expect(page.getByText("已提交 CreatorHub 私信队列")).toBeVisible();
  expect(fixture.submittedDrafts).toEqual(["继续发送时使用的新草稿"]);
});
