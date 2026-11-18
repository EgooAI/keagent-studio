import { expect, test, type Page } from "@playwright/test";
import { createInitialWorkspace } from "../../packages/api-client/src/fixtures";
import type { DouyinQueueRow } from "../../packages/shared-types/src/douyin";
import type {
  CreatorHubAccountSummary,
  LeadAnalysisRow,
  OutreachTask,
  WorkMonitorSummary,
} from "../../packages/shared-types/src/collection";

function activeAccount(): CreatorHubAccountSummary {
  return {
    id: "b".repeat(32),
    nickname: "测试抖音账号",
    platform: "douyin",
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
  evidence: "买一套三居室",
  qualified: true,
  reason: "明确购房意向",
  draft: "你好，看到你想在浦东买三居室，方便聊聊预算吗？",
};

const leadRow2: LeadAnalysisRow = {
  ...leadRow,
  id: "an1b",
  commentId: "comment-1b",
  commentText: "我想在徐汇租房",
  commenterName: "第二位客户",
  commenterProfile: "https://www.douyin.com/user/test-lead-2",
  intent: "rent",
  evidence: "想在徐汇租房",
  draft: "你好，看到你想在徐汇租房，方便聊聊预算吗？",
};

const failedRow: LeadAnalysisRow = {
  id: "an-failed",
  jobId: "job1",
  commentId: "comment-failed",
  commentText: "这条评论分析失败了",
  commenterName: "失败客户",
  commenterProfile: "https://www.douyin.com/user/failed-lead",
  likeCount: null,
  commentTime: null,
  status: "failed",
  error: "模型服务未完成此次分析，请稍后重试",
  intent: "",
  evidence: "",
  qualified: false,
  reason: "",
  draft: "",
};

const nonQualifiedRow: LeadAnalysisRow = {
  ...leadRow,
  id: "an2",
  commentId: "comment-2",
  commentText: "这个小区物业怎么样",
  commenterName: "咨询客户",
  commenterProfile: "https://www.douyin.com/user/question-lead",
  likeCount: 0,
  status: "done",
  intent: "question",
  evidence: "物业怎么样",
  qualified: false,
  reason: "仅咨询物业",
  draft: "",
};

interface FixtureOptions {
  analysisTrialRemaining?: number;
  failFirstAnalysis?: boolean;
  retryDraft?: (analysisId: string) => MockResponse | Promise<MockResponse>;
  manualContact?: boolean;
  jobStatus?: "queued" | "running" | "done" | "partial" | "failed" | "canceled";
  jobFailed?: number;
  qualifiedItems?: LeadAnalysisRow[];
  failedItems?: LeadAnalysisRow[];
  allItems?: LeadAnalysisRow[];
}

type MockResponse = { ok: boolean; data?: unknown; error?: unknown };

async function leadFixture(
  page: Page,
  initialAccounts: CreatorHubAccountSummary[] = [activeAccount()],
  respondOutreach?: (
    input: Record<string, unknown>,
    items: OutreachTask[],
  ) => MockResponse,
  respondRefresh?: (
    input: Record<string, unknown>,
    items: OutreachTask[],
  ) => MockResponse,
  respondConfirm?: (
    input: Record<string, unknown>,
    items: OutreachTask[],
  ) => MockResponse,
  options: FixtureOptions = {},
) {
  let accounts = [...initialAccounts];
  let consentState: "active" | "revoked" = "active";
  let startFailure: unknown = undefined;
  let outreachSequence = 0;
  let outreachHold: Promise<void> | undefined;
  let releaseOutreach: (() => void) | undefined;
  let outreachListCalls = 0;
  const monitors: WorkMonitorSummary[] = [];
  const historicalAccount = {
    id: "d".repeat(32),
    nickname: "历史抖音账号",
    platform: "douyin",
  };
  const historicalWork = {
    accountId: historicalAccount.id,
    workId: "7392457264415722767",
    title: "之前采集的作品",
    sourceState: "active",
    canAnalyze: true,
    canContact: true,
    lastSyncedAt: "2026-11-15T03:10:00Z",
    readCount: 200,
    addedCount: 200,
    commentCount: 200,
  };
  const scans: string[] = [];
  const replies: Record<string, unknown>[] = [];
  const startInputs: Record<string, unknown>[] = [];
  const analysisListInputs: Record<string, unknown>[] = [];
  const analysisInputs: Record<string, unknown>[] = [];
  const retryInputs: Record<string, unknown>[] = [];
  const cancelInputs: Record<string, unknown>[] = [];
  const contacts: Record<string, unknown>[] = [];
  const queueRows: DouyinQueueRow[] = [];
  let queuePaused = false;
  let messageResumeAvailable = false;
  const queueActions: unknown[] = [];
  const submittedKeys: string[] = [];
  const submittedDrafts: string[] = [];
  const outreachItems: OutreachTask[] = [];
  await page.exposeFunction(
    "leadTestRequest",
    async (method: string, input: Record<string, unknown> = {}) => {
      const okay = (data: unknown) => ({ ok: true, data });
      if (method === "state")
        return okay({
          deviceId: "lead-test-device",
          resolverAvailable: true,
          tabs: [],
          queue: {
            paused: queuePaused,
            rows: queueRows,
            messageResumeAvailable,
          },
        });
      if (method === "publish.queue" && input.action === "resume-message") {
        queueActions.push(input.action);
        queuePaused = false;
        messageResumeAvailable = false;
        return okay({ paused: false, rows: queueRows });
      }
      if (method === "collection.contact") {
        contacts.push(input);
        const platform =
          accounts.find((a) => a.id === input.accountId)?.platform ?? "douyin";
        return okay({
          activeAccountId: input.accountId,
          tabs: [
            {
              accountId: input.accountId,
              platform,
              title: "目标评论者主页",
              url:
                platform === "xhs"
                  ? "https://www.xiaohongshu.com/user/profile/" + "a".repeat(24)
                  : leadRow.commenterProfile,
              saved: true,
            },
          ],
          queue: { paused: false, rows: queueRows },
        });
      }
      if (method === "browser.viewport") return okay({});
      if (method === "social.status")
        return okay({ health: "ready", accounts, selectedAccountId: "" });
      if (method === "social.workHistory") return okay([...monitors]);
      if (method === "lead/workspace/overview")
        return okay({
          pending: input.accountId === historicalAccount.id ? 1 : 0,
          missingDraft: 0,
          uncertain: 0,
        });
      if (method === "lead/workspace/works") {
        const rows =
          input.accountId === historicalAccount.id
            ? [historicalWork]
            : monitors
                .filter((m) => m.accountId === input.accountId)
                .map((m) => ({
                  ...historicalWork,
                  accountId: m.accountId,
                  workId: m.workId,
                  title: "新监控作品",
                  readCount: m.readCount,
                  addedCount: m.addedCount,
                  commentCount: m.readCount,
                }));
        return okay({
          items: rows.filter(
            (w) =>
              (!input.workId || input.workId === w.workId) &&
              (!input.search ||
                (w.title + w.workId).includes(String(input.search))),
          ),
        });
      }
      if (method === "lead/workspace/comments") {
        const old = input.accountId === historicalAccount.id;
        const row = {
          ...historicalWork,
          accountId: input.accountId,
          id: "c".repeat(32),
          workId: old ? historicalWork.workId : monitors[0]?.workId,
          title: old ? historicalWork.title : "新监控作品",
          comment_text: old ? "@ZANE 又想买房了" : leadRow.commentText,
          commenter_name: old ? "jennyy" : leadRow.commenterName,
          commenter_profile: leadRow.commenterProfile,
        };
        return okay({
          items:
            (!input.workId || row.workId === input.workId) &&
            (!input.search ||
              (row.comment_text + row.commenter_name).includes(
                String(input.search),
              ))
              ? [row]
              : [],
        });
      }
      if (method === "lead/workspace/leads")
        return okay({
          items:
            input.accountId === historicalAccount.id &&
            input.status !== "missingDraft"
              ? [
                  {
                    ...leadRow,
                    ...historicalWork,
                    commenterName: "jennyy",
                    commentText: "@ZANE 又想买房了",
                    manualDraft: null,
                    reviewStatus: "pending",
                  },
                ]
              : [],
        });
      if (
        method === "lead/workspace/jobs" ||
        method === "lead/workspace/outreach"
      )
        return okay({ items: [] });
      if (method === "accounts/list") return okay({ items: [] });
      if (method === "social.start") {
        startInputs.push(input);
        if (startFailure) return { ok: false, error: startFailure };
        const platform =
          accounts.find((a) => a.id === input.accountId)?.platform ?? "douyin";
        const workId =
          platform === "xhs" ? "xhs-0123456789abcdef01234567" : "7".repeat(19);
        if (input.monitor)
          monitors.push({
            id: "watch1",
            accountId: String(input.accountId),
            platform,
            workId,
            readCount: 2,
            addedCount: 2,
            error: "",
            nextScan: Date.now() + 900000,
          });
        return okay({
          awemeId: workId,
          platform,
          accountId: input.accountId,
          readCount: 2,
          addedCount: 2,
          updatedCount: 0,
          coverage: "partial",
        });
      }
      if (method === "social.monitors") return okay([...monitors]);
      if (method === "social.scan") {
        scans.push(String(input.id));
        return okay({ readCount: 2, addedCount: 0, updatedCount: 0 });
      }
      if (method === "social.remove") {
        const index = monitors.findIndex((row) => row.id === input.id);
        if (index !== -1) monitors.splice(index, 1);
        return okay({});
      }
      if (method === "comments/list")
        return okay({
          items: [
            {
              id: "row-db-id",
              comment_id: "native-comment-id",
              comment_text: leadRow.commentText,
              commenter_name: leadRow.commenterName,
              commenter_profile: String(input.workId).startsWith("xhs-")
                ? "https://www.xiaohongshu.com/user/profile/0123456789abcdef01234567"
                : leadRow.commenterProfile,
            },
          ],
          canContact: options.manualContact ?? true,
          sourceState: consentState,
          coverage: "partial",
        });
      if (method === "social.reply") {
        replies.push(input);
        return okay({ id: "queued-dm-1", state: "pending" });
      }
      if (method === "lead/consent/get")
        return okay({
          state: consentState,
          label: "本机平台账号",
          purposes: {
            analyzeWithAI: true,
            manualContact: options.manualContact ?? true,
          },
          expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
          retentionDays: 7,
          aiEndpoint: "https://example.test/v1",
        });
      if (method === "lead/consent/revoke") {
        consentState = "revoked";
        return okay({ ok: true });
      }
      if (method === "lead/settings/get")
        return okay({
          criteria: "只找购房客户",
          defaultCriteria: "判断评论者是否有明确的购房需求。",
          criteriaHash: "x",
          maxComments: 200,
        });
      if (method === "lead/settings/trial") {
        const remaining = options.analysisTrialRemaining ?? 200;
        return okay({
          analysis: { limit: 200, used: 200 - remaining, remaining },
          draft: { limit: 50, used: 8, remaining: 42 },
          resetsAt: new Date(Date.now() + 86400000).toISOString(),
        });
      }
      if (method === "comments/analyze-batch") {
        analysisInputs.push(input);
        if (options.failFirstAnalysis && analysisInputs.length === 1)
          return {
            ok: false,
            error: {
              status: 503,
              code: "UNAVAILABLE",
              message: "分析暂不可用",
            },
          };
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
      }
      if (method === "comments/analysis/job")
        return okay({
          id: "job1",
          status: options.jobStatus ?? "done",
          total: 2,
          processed: 2,
          qualified: 2,
          failed: options.jobFailed ?? 0,
          error: "",
          criteriaHash: "abcdef1234567890",
        });
      if (method === "comments/analysis/retry-draft" && options.retryDraft)
        return options.retryDraft(String(input.analysisId));
      if (method === "comments/analysis/retry") {
        retryInputs.push(input);
        return okay({
          id: "job1",
          status: "queued",
          total: 2,
          processed: 0,
          qualified: 0,
          failed: 0,
          error: "",
          criteriaHash: "abcdef1234567890",
        });
      }
      if (method === "comments/analysis/list") {
        analysisListInputs.push(input);
        if (input.status === "failed")
          return okay({ items: options.failedItems ?? [] });
        if (input.qualified === true)
          return okay({ items: options.qualifiedItems ?? [leadRow] });
        return okay({ items: options.allItems ?? [leadRow] });
      }
      if (method === "outreach/list") {
        outreachListCalls++;
        if (outreachHold) await outreachHold;
        return okay({ items: outreachItems });
      }
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
        if (respondConfirm) return respondConfirm(input, outreachItems);
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
      if (method === "outreach.cancel") {
        cancelInputs.push(input);
        const index = outreachItems.findIndex(
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
        const canceled: OutreachTask = {
          ...outreachItems[index],
          status: "canceled",
        };
        outreachItems[index] = canceled;
        return okay(canceled);
      }
      if (method === "outreach.submit") {
        submittedKeys.push(String(input.requestKey));
        submittedDrafts.push(String(input.draft));
        const analysisId = String(input.analysisId);
        const index = outreachItems.findIndex(
          (candidate) => candidate.analysisId === analysisId,
        );
        const existing = index >= 0 ? outreachItems[index] : undefined;
        if (existing && existing.requestKey === input.requestKey) {
          // Go returns the stored receipt for a replayed key. The bridge only
          // continues sending when that receipt is still `approved`.
          if (existing.status !== "approved") return okay({ ...existing });
        }
        if (
          existing &&
          existing.requestKey !== input.requestKey &&
          existing.status !== "failed" &&
          existing.status !== "canceled"
        )
          return {
            ok: false,
            error: {
              status: 409,
              code: "OUTREACH_EXISTS",
              message: "该评论已有私信任务",
            },
          };
        const base: OutreachTask = existing
          ? existing.requestKey === input.requestKey
            ? existing
            : {
                ...existing,
                status: "approved",
                attempt: existing.attempt + 1,
                creatorhubTaskId: "",
                error: "",
                draft: String(input.draft),
                requestKey: String(input.requestKey),
              }
          : {
              id: `o-${++outreachSequence}`,
              analysisId,
              attempt: 1,
              status: "approved",
              creatorhubTaskId: "",
              error: "",
              draft: String(input.draft),
              requestKey: String(input.requestKey),
            };
        const response = respondOutreach
          ? respondOutreach(input, outreachItems)
          : okay({
              id: base.id,
              analysisId,
              attempt: base.attempt,
              status: "submitted",
              creatorhubTaskId: "7",
              error: "",
              draft: String(input.draft),
              requestKey: String(input.requestKey),
            });
        const data = response.data as Partial<OutreachTask> | undefined;
        if (response.ok && data) {
          const stored: OutreachTask = {
            id: base.id,
            analysisId,
            attempt: base.attempt,
            status: (data.status as OutreachTask["status"]) ?? base.status,
            creatorhubTaskId: data.creatorhubTaskId ?? base.creatorhubTaskId,
            error: data.error ?? base.error,
            draft: data.draft ?? base.draft,
            requestKey: String(input.requestKey),
          };
          if (index >= 0) outreachItems[index] = stored;
          else outreachItems.push(stored);
        }
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
    holdOutreach: () => {
      outreachHold = new Promise<void>((resolve) => {
        releaseOutreach = resolve;
      });
    },
    releaseOutreach: () => {
      releaseOutreach?.();
      outreachHold = undefined;
      releaseOutreach = undefined;
    },
    outreachListCalls: () => outreachListCalls,
    consentState: () => consentState,
    monitors,
    scans,
    replies,
    contacts,
    queueRows,
    queueActions,
    setQueuePause: (paused: boolean, canResumeMessages = false) => {
      queuePaused = paused;
      messageResumeAvailable = canResumeMessages;
    },
    startInputs,
    analysisListInputs,
    analysisInputs,
    retryInputs,
    cancelInputs,
    submittedKeys,
    submittedDrafts,
    outreachItems,
  };
}

async function fillAndStart(page: Page) {
  await page
    .getByLabel("作品详情页链接")
    .fill("https://www.douyin.com/video/7777777777777777777");
  await page.getByRole("checkbox", { name: "来源授权" }).check();
  const start = page.getByRole("button", { name: "从评论中找客户" });
  await expect(start).toBeEnabled();
  await start.click();
}

async function openReview(page: Page) {
  await page.goto("/#/leads/comment-lead");
  await fillAndStart(page);
  await expect(page.getByRole("blockquote")).toHaveText(leadRow.commentText);
}

test("评论获客：抓取、分析、审核并提交私信草稿", async ({ page }) => {
  const fixture = await leadFixture(page);
  await page.goto("/#/leads/comment-lead");
  await expect(page.getByRole("heading", { name: "评论获客" })).toBeVisible();
  await expect(page.getByLabel("自定义筛选条件")).toHaveValue("只找购房客户");
  await page.getByRole("button", { name: "想约看房源的人" }).click();
  await fillAndStart(page);
  await expect(page.getByRole("blockquote")).toHaveText(leadRow.commentText);
  await expect(page.locator("blockquote mark")).toHaveText(leadRow.evidence);
  expect(fixture.analysisInputs).toHaveLength(1);
  expect(fixture.analysisInputs[0]).toMatchObject({
    criteria: "想约看房源的人",
    maxComments: 200,
  });
  expect(fixture.submittedKeys).toHaveLength(0);
  await page.getByText(/作品与来源授权 ·/).click();
  await expect(
    page.getByText(/读取 2 条 · 新增 2 条 · 已存在 0 条/),
  ).toContainText("部分覆盖");
  await expect(page.getByText(/默认留存 7 天，授权有效期至/)).toBeVisible();
  await page.getByRole("button", { name: "确认加入发送队列" }).click();
  await expect(page.getByText("已加入本机账号执行队列")).toBeVisible();
  expect(fixture.submittedKeys).toHaveLength(1);
});

test("评论获客：登录后刷新账号并可开始抓取", async ({ page }) => {
  const fixture = await leadFixture(page, []);
  await page.goto("/#/leads/comment-lead");
  await page.getByRole("button", { name: "登录并保存平台账号" }).click();
  await expect(page).toHaveURL(/settings\/platforms/);
  await expect(
    page.getByRole("button", { name: "添加小红书账号" }),
  ).toBeVisible();
  fixture.setAccounts([activeAccount()]);
  await page.goto("/#/leads/comment-lead");
  await page.reload();
  await expect(page.getByText("抖音 · 测试抖音账号")).toBeVisible();
  await fillAndStart(page);
});

test("评论获客：账号列表变化后清除失效账号", async ({ page }) => {
  const fixture = await leadFixture(page);
  await page.goto("/#/leads/comment-lead");
  await expect(page.getByText("测试抖音账号")).toBeVisible();
  await page
    .getByLabel("作品详情页链接")
    .fill("https://www.douyin.com/video/7777777777777777777");
  await page.getByRole("checkbox", { name: "来源授权" }).check();
  const start = page.getByRole("button", { name: "从评论中找客户" });
  await expect(start).toBeEnabled();
  fixture.setAccounts([]);
  fixture.setStartFailure({
    status: 409,
    code: "ACCOUNT_UNAVAILABLE",
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
  await page.getByRole("button", { name: "确认加入发送队列" }).click();
  await expect(page.getByText("上次提交未完成，请重试")).toBeVisible();
  await expect(page.getByText("已加入本机账号执行队列")).toHaveCount(0);
  await expect(page.getByText("失败", { exact: true })).toBeVisible();
  await expect(fixture.outreachItems).toHaveLength(1);
  const firstId = fixture.outreachItems[0].id;
  await page.getByRole("button", { name: "重新提交" }).click();
  await expect(page.getByText("已加入本机账号执行队列")).toBeVisible();
  expect(fixture.submittedKeys).toHaveLength(2);
  expect(fixture.submittedKeys[0]).not.toBe(fixture.submittedKeys[1]);
  expect(fixture.outreachItems).toHaveLength(1);
  expect(fixture.outreachItems[0]).toMatchObject({
    id: firstId,
    attempt: 2,
    status: "submitted",
    requestKey: fixture.submittedKeys[1],
  });
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
  const submit = page.getByRole("button", { name: "确认加入发送队列" });
  await submit.click();
  await expect(page.getByText("提交结果暂时无法确认")).toBeVisible();
  await expect(page.getByText("已加入本机账号执行队列")).toHaveCount(0);
  await submit.click();
  await expect(
    page.getByText("结果待确认，请到平台会话核对后再确认"),
  ).toBeVisible();
  await expect(page.getByText("已加入本机账号执行队列")).toHaveCount(0);
  expect(fixture.submittedKeys).toHaveLength(2);
  expect(fixture.submittedKeys[0]).toBe(fixture.submittedKeys[1]);
});

test("评论获客：平台明确拒绝后展示失败并使用新请求键重新提交", async ({
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
        error: "来源不允许发送该私信",
        draft: String(input.draft),
        requestKey: String(input.requestKey),
      });
      return {
        ok: false,
        error: {
          status: 400,
          code: "COMMENT_PURPOSE_DENIED",
          message: "来源不允许发送该私信",
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
  await page.getByRole("button", { name: "确认加入发送队列" }).click();
  await expect(page.getByText("来源不允许发送该私信").first()).toBeVisible();
  await expect(page.getByText("已加入本机账号执行队列")).toHaveCount(0);
  await expect(page.getByText("失败", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "重新提交" })).toBeVisible();
  await page.getByRole("button", { name: "重新提交" }).click();
  await expect(page.getByText("已加入本机账号执行队列")).toBeVisible();
  expect(calls).toBe(2);
  expect(fixture.submittedKeys).toHaveLength(2);
  expect(fixture.submittedKeys[0]).not.toBe(fixture.submittedKeys[1]);
  expect(fixture.outreachItems).toHaveLength(1);
  expect(fixture.outreachItems[0]).toMatchObject({
    id: "o-failed",
    attempt: 2,
    status: "submitted",
    requestKey: fixture.submittedKeys[1],
  });
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
    requestKey: "existing-request-key",
  });
  await openReview(page);
  await expect(page.getByText("已发送", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "确认加入发送队列" }),
  ).toHaveCount(0);
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
  await page.getByRole("button", { name: "确认加入发送队列" }).click();
  await expect(page.getByText("已加入本机账号执行队列")).toBeVisible();
  await expect(page.getByText("排队中", { exact: true })).toBeVisible();
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
    requestKey: "existing-request-key",
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

test("评论获客：人工确认失败不会被过期列表回退", async ({ page }) => {
  const fixture = await leadFixture(
    page,
    undefined,
    undefined,
    undefined,
    (input, items) => {
      const item = items.find((candidate) => candidate.id === input.outreachId);
      if (!item)
        return {
          ok: false,
          error: {
            status: 404,
            code: "OUTREACH_NOT_FOUND",
            message: "私信任务不存在",
          },
        };
      // The confirmation succeeds, but the list copy stays uncertain so a
      // delayed refetch tries to downgrade the terminal state.
      return { ok: true, data: { ...item, status: input.status } };
    },
  );
  fixture.outreachItems.push({
    id: "o-uncertain",
    analysisId: "an1",
    attempt: 1,
    status: "uncertain",
    creatorhubTaskId: "9",
    error: "",
    draft: leadRow.draft,
    requestKey: "existing-request-key",
  });
  await openReview(page);
  await expect(page.getByText("结果待确认", { exact: true })).toBeVisible();
  const before = fixture.outreachListCalls();
  fixture.holdOutreach();
  await page.getByRole("button", { name: "确认失败" }).click();
  await page.getByRole("button", { name: /^确\s*认$/ }).click();
  await expect(page.getByText("已确认失败")).toBeVisible();
  await expect(page.getByText("失败", { exact: true })).toBeVisible();
  fixture.releaseOutreach();
  await expect.poll(() => fixture.outreachListCalls()).toBeGreaterThan(before);
  await expect(page.getByText("失败", { exact: true })).toBeVisible();
  expect(fixture.outreachItems[0]?.status).toBe("uncertain");
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
    requestKey: "approved-stored-key",
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
  await expect(page.getByText("已加入本机账号执行队列")).toBeVisible();
  expect(fixture.submittedDrafts).toEqual(["继续发送时使用的新草稿"]);
  expect(fixture.submittedKeys).toEqual(["approved-stored-key"]);
  expect(fixture.outreachItems).toHaveLength(1);
  expect(fixture.outreachItems[0]).toMatchObject({
    id: "o-approved",
    attempt: 1,
    status: "submitted",
    requestKey: "approved-stored-key",
  });
});

test("评论获客：缺少请求标识的待发送任务无法继续发送", async ({ page }) => {
  const fixture = await leadFixture(page);
  fixture.outreachItems.push({
    id: "o-approved",
    analysisId: "an1",
    attempt: 1,
    status: "approved",
    creatorhubTaskId: "",
    error: "",
    draft: "服务端保存的待发送草稿",
    requestKey: "",
  });
  await openReview(page);
  await expect(page.getByText("待发送", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "继续发送" })).toHaveCount(0);
  await expect(
    page.getByText("缺少请求标识，无法继续发送，请重新分析后再提交"),
  ).toBeVisible();
  expect(fixture.submittedKeys).toHaveLength(0);
});

test("评论获客：刷新后慢速列表回退不会降级状态", async ({ page }) => {
  const fixture = await leadFixture(
    page,
    undefined,
    undefined,
    (input, items) => {
      const item = items.find((candidate) => candidate.id === input.outreachId);
      if (!item)
        return {
          ok: false,
          error: {
            status: 404,
            code: "OUTREACH_NOT_FOUND",
            message: "私信任务不存在",
          },
        };
      // Return the terminal server row but leave the list copy stale (submitted)
      // so the delayed refetch tries to downgrade the Tag.
      return { ok: true, data: { ...item, status: "sent" } };
    },
  );
  await openReview(page);
  await page.getByRole("button", { name: "确认加入发送队列" }).click();
  await expect(page.getByText("已加入本机账号执行队列")).toBeVisible();
  await expect(page.getByText("排队中", { exact: true })).toBeVisible();
  await expect
    .poll(() => fixture.outreachListCalls())
    .toBeGreaterThanOrEqual(2);
  const before = fixture.outreachListCalls();
  fixture.holdOutreach();
  await page.getByRole("button", { name: "刷新状态" }).click();
  await expect(page.getByText("已发送", { exact: true })).toBeVisible();
  fixture.releaseOutreach();
  await expect.poll(() => fixture.outreachListCalls()).toBeGreaterThan(before);
  await expect(page.getByText("已发送", { exact: true })).toBeVisible();
  expect(fixture.outreachItems[0]?.status).toBe("submitted");
});

test("评论获客：撤销来源授权后无法继续分析", async ({ page }) => {
  const fixture = await leadFixture(page);
  await page.goto("/#/leads/comment-lead");
  await fillAndStart(page);
  await expect(page.getByRole("heading", { name: "线索审核" })).toBeVisible();
  await page.getByText(/作品与来源授权 ·/).click();
  await expect(page.getByText("来源授权：")).toBeVisible();
  await expect(page.getByText("有效", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "撤销授权" }).click();
  await page.getByRole("button", { name: /^确\s*认$/ }).click();
  await expect(page.getByText("已撤销来源授权", { exact: true })).toBeVisible();
  await expect(
    page.getByText("来源授权已撤销，无法继续分析或提交私信。"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "确认加入发送队列" }),
  ).toHaveCount(0);
  await expect(page.getByRole("blockquote")).toHaveCount(0);
  await page.getByRole("button", { name: "调整筛选条件" }).click();
  await expect(page.getByRole("button", { name: "开始分析" })).toBeDisabled();
  expect(fixture.consentState()).toBe("revoked");
});

test("评论获客：失败条目可单独重试", async ({ page }) => {
  const fixture = await leadFixture(
    page,
    undefined,
    undefined,
    undefined,
    undefined,
    { jobStatus: "partial", jobFailed: 1, failedItems: [failedRow] },
  );
  await page.goto("/#/leads/comment-lead");
  await fillAndStart(page);
  await expect(page.getByText("失败条目")).toBeVisible();
  await expect(page.getByText(failedRow.commentText)).toBeVisible();
  await expect(page.getByText("已处理 2 / 2，达标 2，失败 1")).toBeVisible();
  await page.getByRole("button", { name: /^重\s*试$/ }).click();
  await expect(page.getByText("已重新提交该条分析")).toBeVisible();
  expect(fixture.retryInputs).toContainEqual({
    jobId: "job1",
    analysisIds: [failedRow.id],
  });
});

test("评论获客：显示全部会加载未达标评论", async ({ page }) => {
  const fixture = await leadFixture(
    page,
    undefined,
    undefined,
    undefined,
    undefined,
    { allItems: [leadRow, nonQualifiedRow] },
  );
  await openReview(page);
  await expect(
    page.getByRole("button", { name: /^查看 .* 的评论$/ }),
  ).toHaveCount(1);
  await expect(page.getByText(nonQualifiedRow.commentText)).toHaveCount(0);
  await page.getByRole("checkbox", { name: "显示未达标评论" }).check();
  await expect(page.getByText(nonQualifiedRow.commentText)).toBeVisible();
  await page.getByRole("button", { name: "查看 咨询客户 的评论" }).click();
  await expect(page.getByRole("blockquote")).toHaveText(
    nonQualifiedRow.commentText,
  );
  await expect(
    page.getByRole("button", { name: "确认加入发送队列" }),
  ).toHaveCount(0);
  expect(
    fixture.analysisListInputs.some((input) => input.qualified !== true),
  ).toBe(true);
});

test("评论获客：抓取时传入留存与授权有效期", async ({ page }) => {
  const fixture = await leadFixture(page);
  await page.goto("/#/leads/comment-lead");
  await page
    .getByLabel("作品详情页链接")
    .fill("https://www.douyin.com/video/7777777777777777777");
  await page.getByText(/更多设置 ·/).click();
  await page.getByLabel("默认留存天数").fill("14");
  await page.getByLabel("授权有效期（天）").fill("60");
  await page.getByRole("checkbox", { name: "来源授权" }).check();
  await page.getByRole("button", { name: "从评论中找客户" }).click();
  await expect(page.getByRole("heading", { name: "线索审核" })).toBeVisible();
  expect(fixture.startInputs).toHaveLength(1);
  const consentInput = fixture.startInputs[0].consent as {
    retentionDays: number;
    expiresAt: string;
  };
  expect(consentInput.retentionDays).toBe(14);
  const days =
    (new Date(consentInput.expiresAt).getTime() - Date.now()) / 86400000;
  expect(days).toBeGreaterThan(59.5);
  expect(days).toBeLessThan(60.1);
});

test("评论获客：批量提交选中的私信草稿", async ({ page }) => {
  const fixture = await leadFixture(
    page,
    undefined,
    undefined,
    undefined,
    undefined,
    { qualifiedItems: [leadRow, leadRow2] },
  );
  await openReview(page);
  await expect(
    page.getByRole("button", { name: /^查看 .* 的评论$/ }),
  ).toHaveCount(2);
  await page.getByRole("button", { name: "批量选择", exact: true }).click();
  await page.getByRole("checkbox", { name: "批量选择 意向客户" }).check();
  await page.getByRole("checkbox", { name: "批量选择 第二位客户" }).check();
  const batch = page.getByRole("button", { name: "批量提交 (2)" });
  await expect(batch).toBeEnabled();
  await batch.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(leadRow.commenterName)).toBeVisible();
  await expect(dialog.getByText(leadRow2.commenterName)).toBeVisible();
  await expect(dialog.getByText(leadRow.draft)).toBeVisible();
  await expect(dialog.getByText(leadRow2.draft)).toBeVisible();
  await dialog.getByRole("button", { name: "确认提交" }).click();
  await expect(
    page.getByText("批量提交：已受理 2，待确认 0，失败 0"),
  ).toBeVisible();
  await expect(page.getByText("排队中", { exact: true })).toHaveCount(2);
  expect(fixture.submittedKeys).toHaveLength(2);
  expect(new Set(fixture.submittedKeys).size).toBe(2);
  expect(fixture.submittedDrafts).toEqual([leadRow.draft, leadRow2.draft]);
});

test("评论获客：取消排队中的私信任务", async ({ page }) => {
  const fixture = await leadFixture(page);
  fixture.outreachItems.push({
    id: "o-cancel",
    analysisId: "an1",
    attempt: 2,
    status: "submitted",
    creatorhubTaskId: "9",
    error: "",
    draft: leadRow.draft,
    requestKey: "cancel-request-key",
  });
  await openReview(page);
  await expect(page.getByText("排队中", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "取消发送" }).click();
  await page.getByRole("button", { name: /^确\s*认$/ }).click();
  await expect(page.getByText("已取消发送", { exact: true })).toBeVisible();
  await expect(page.getByText("已取消", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "重新提交" })).toBeVisible();
  expect(fixture.cancelInputs).toContainEqual({
    outreachId: "o-cancel",
    attempt: 2,
  });
});

test("评论获客：待确认任务展示存储的错误信息", async ({ page }) => {
  const fixture = await leadFixture(page);
  fixture.outreachItems.push({
    id: "o-uncertain",
    analysisId: "an1",
    attempt: 1,
    status: "uncertain",
    creatorhubTaskId: "9",
    error: "上游返回不确定，请核对后确认发送结果",
    draft: leadRow.draft,
    requestKey: "uncertain-request-key",
  });
  await openReview(page);
  await expect(page.getByText("结果待确认", { exact: true })).toBeVisible();
  await expect(
    page.getByText("上游返回不确定，请核对后确认发送结果"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "确认已发送" })).toBeVisible();
  await expect(page.getByRole("button", { name: "确认失败" })).toBeVisible();
});

test("AI 获客四个工作区可直接打开原评论和已识别线索，查看过程不会重新采集或分析", async ({
  page,
}) => {
  const fixture = await leadFixture(page, [
    { ...activeAccount(), id: "d".repeat(32) },
  ]);
  await page.goto("/#/leads/works?accountId=old-account&add=1");
  await expect(page.getByRole("heading", { name: "我的待办" })).toBeVisible();
  await expect(page).toHaveURL(/accountId=d{32}&platform=douyin$/);
  await expect(
    page.getByText(activeAccount().nickname, { exact: true }),
  ).toBeVisible();
  for (const name of ["我的待办", "作品与评论", "线索审核", "账号队列"])
    await expect(
      page
        .getByRole("navigation", { name: "主要导航" })
        .getByRole("link", { name, exact: true }),
    ).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "当前平台账号" }),
  ).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "历史账号资料" })).toHaveCount(
    0,
  );
  await page.getByRole("link", { name: "作品与评论", exact: true }).click();
  await page.getByRole("tab", { name: "评论记录" }).click();
  await page
    .getByRole("textbox", { name: "搜索昵称或评论原文" })
    .fill("jennyy");
  await expect(
    page.getByRole("row").filter({ hasText: "jennyy" }),
  ).toContainText("@ZANE 又想买房了");
  await expect(page.getByRole("button", { name: "添加作品" })).toBeEnabled();
  await page.getByRole("tab", { name: "作品列表" }).click();
  const work = page.getByRole("row").filter({ hasText: "之前采集的作品" });
  await expect(work).toContainText("历史采集");
  await expect(work).toContainText("200 / +200");
  await work.getByRole("button", { name: "查看评论" }).click();
  await page.getByRole("link", { name: "查看已有线索" }).click();
  await expect(page).toHaveURL(/workId=7392457264415722767/);
  await expect(page.getByRole("blockquote")).toContainText("@ZANE 又想买房了");
  expect(fixture.startInputs).toEqual([]);
  expect(fixture.analysisInputs).toEqual([]);
  expect(fixture.replies).toEqual([]);
});

test("评论分析试用用完后显示剩余额度并阻止新任务", async ({ page }) => {
  const fixture = await leadFixture(
    page,
    [{ ...activeAccount(), id: "d".repeat(32) }],
    undefined,
    undefined,
    undefined,
    { analysisTrialRemaining: 0 },
  );
  await page.goto("/#/leads/works?tab=comments&workId=7392457264415722767");
  await expect(page.getByText(/今日试用剩余 0 条评论分析/)).toBeVisible();
  await page.getByRole("button", { name: "AI 筛选线索" }).click();
  await expect(
    page.getByText("今日评论分析额度已用完，次日北京时间零点恢复。"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "开始分析" })).toBeDisabled();
  expect(fixture.analysisInputs).toHaveLength(0);
});

test("作品与评论从当前账号打开评论者主页，只提交来源引用", async ({ page }) => {
  const accountId = "d".repeat(32);
  const workId = "7392457264415722767";
  const fixture = await leadFixture(page, [
    { ...activeAccount(), id: accountId },
  ]);
  await page.goto("/#/leads/works?tab=comments&workId=" + workId);
  await page.getByRole("button", { name: "打开平台主页" }).click();
  await expect(
    page.getByRole("region", { name: "抖音账号浏览器" }),
  ).toBeVisible();
  expect(fixture.contacts).toEqual([{ accountId, workId, id: "c".repeat(32) }]);
  expect(fixture.replies).toEqual([]);
});

test("抖音账号队列可恢复已人工核对的私信暂停", async ({ page }) => {
  const account = activeAccount();
  const fixture = await leadFixture(page);
  fixture.setQueuePause(true, true);
  fixture.queueRows.push({
    id: "next-message",
    batchId: "batch1",
    accountId: account.id,
    kind: "message",
    state: "queued",
    title: "私信 · 待执行",
  });
  await page.goto("/#/leads/queue?platform=douyin&accountId=" + account.id);
  await expect(
    page.getByText("恢复后将继续执行本机已排队的私信。"),
  ).toBeVisible();
  await page.getByRole("button", { name: "恢复私信队列" }).click();
  await expect(page.getByText("本机私信队列已暂停")).toHaveCount(0);
  expect(fixture.queueActions).toEqual(["resume-message"]);
});

test("抖音账号队列显示私信失败步骤及旧任务的空记录", async ({ page }) => {
  const account = activeAccount();
  const fixture = await leadFixture(page);
  const row: DouyinQueueRow = {
    id: "legacy",
    batchId: "batch1",
    accountId: account.id,
    kind: "message",
    state: "unknown",
    title: "私信 · 测试用户",
    errorCode: "DM_OUTCOME_UNKNOWN",
  };
  fixture.queueRows.push(row, {
    ...row,
    id: "tracked",
    messageSteps: [
      {
        step: "trigger_send",
        status: "completed",
        timestamp: "2026-11-18T10:55:18Z",
        durationMs: 333,
      },
      {
        step: "verify_conversation",
        status: "failed",
        timestamp: "2026-11-18T10:55:22Z",
        errorMessage: "重开会话后仍未核实消息",
      },
    ],
  });
  await page.goto(
    "/#/leads/queue?platform=douyin&accountId=" +
      account.id +
      "&taskId=tracked",
  );
  const steps = page.getByRole("region", { name: "执行步骤" });
  await expect(steps).toContainText("校验授权并触发发送");
  await expect(steps).toContainText("完成");
  await expect(steps).toContainText("333 ms");
  await expect(steps).toContainText("重开会话核实消息");
  await expect(steps).toContainText("失败");
  await expect(steps).toContainText("重开会话后仍未核实消息");
  await page.goto(
    "/#/leads/queue?platform=douyin&accountId=" + account.id + "&taskId=legacy",
  );
  await expect(steps).toContainText("暂无执行步骤记录");
});

test("账号队列可打开抖音收件人，未开放的小红书只显示提示", async ({ page }) => {
  const account = activeAccount();
  const fixture = await leadFixture(page, [account]);
  const workId = "7392457264415722767",
    commentId = "c".repeat(32);
  const row: DouyinQueueRow = {
    id: "old",
    batchId: "batch1",
    accountId: account.id,
    kind: "message",
    state: "failed",
    title: "私信 · 同一昵称",
    errorCode: "DM_RECIPIENT_UNVERIFIED",
    sourceWorkId: workId,
  };
  fixture.queueRows.push(row, {
    ...row,
    id: "new",
    sourceCommentId: commentId,
  });
  await page.goto("/#/leads/queue?platform=xhs&taskId=old");
  await expect(page.getByText("小红书 AI 获客暂未开发")).toBeVisible();
  await expect(page.getByRole("button", { name: "查看收件人" })).toHaveCount(0);
  await page.goto("/#/leads/queue?platform=douyin&taskId=old");
  await expect(page.getByRole("link", { name: "查看作品评论" })).toBeVisible();
  await expect(page.getByRole("button", { name: "查看收件人" })).toHaveCount(0);
  await expect(page.getByText("在发送前停止，未点击发送。")).toBeVisible();
  await page.goto("/#/leads/queue?platform=douyin&taskId=new");
  await page.getByRole("button", { name: "查看收件人" }).click();
  await expect(
    page.getByRole("region", { name: "抖音账号浏览器" }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(fixture.contacts).toEqual([
    { accountId: account.id, workId, id: commentId },
  ]);
  expect(fixture.replies).toEqual([]);
});

test("作品与评论：用当前登录账号添加持续监控，读完直接查看原评论", async ({
  page,
}) => {
  const fixture = await leadFixture(page);
  await page.goto("/#/leads/works");
  await page.getByRole("button", { name: "添加作品" }).click();
  await page
    .getByLabel("作品链接")
    .fill("https://www.douyin.com/jingxuan?modal_id=7705373735628393770");
  await page.getByRole("radio", { name: "持续监控" }).check();
  await page.getByRole("checkbox", { name: /我已获准/ }).check();
  await page.getByRole("button", { name: "读取评论", exact: true }).click();
  await expect(page.getByRole("tab", { name: "评论记录" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    page.getByRole("row").filter({ hasText: leadRow.commenterName }),
  ).toContainText(leadRow.commentText);
  await page.getByRole("tab", { name: "作品列表" }).click();
  const work = page.getByRole("row").filter({ hasText: "新监控作品" });
  await expect(work).toContainText("持续监控");
  expect(fixture.startInputs).toHaveLength(1);
  expect(fixture.startInputs[0]).toMatchObject({
    accountId: activeAccount().id,
    url: "https://www.douyin.com/jingxuan?modal_id=7705373735628393770",
    monitor: true,
  });
  expect(fixture.analysisInputs).toEqual([]);
});

test("评论获客：逐人审核、暂不联系与切换页面保留草稿", async ({ page }) => {
  const fixture = await leadFixture(
    page,
    undefined,
    undefined,
    undefined,
    undefined,
    { qualifiedItems: [leadRow, leadRow2] },
  );
  await openReview(page);
  const draft = page.getByLabel("私信草稿-意向客户");
  await draft.fill("周六几点方便看房？");
  await page.getByRole("button", { name: "暂不联系", exact: true }).click();
  await expect(page.getByRole("blockquote")).toHaveText(leadRow2.commentText);
  await expect(page.getByLabel("私信草稿-第二位客户")).toHaveValue(
    leadRow2.draft,
  );
  await page.getByRole("button", { name: "批量选择", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "批量选择 意向客户" }),
  ).toBeDisabled();
  await page.getByRole("link", { name: "工作台", exact: true }).click();
  await page.goto("/#/leads/comment-lead");
  await expect(page.getByRole("blockquote")).toHaveText(leadRow2.commentText);
  await page.getByRole("button", { name: "查看 意向客户 的评论" }).click();
  await expect(draft).toHaveValue("周六几点方便看房？");
  await page.getByRole("button", { name: "恢复审核" }).click();
  await page.getByRole("button", { name: "确认加入发送队列" }).click();
  await expect(page.getByText("排队中", { exact: true })).toBeVisible();
  expect(fixture.submittedDrafts).toEqual(["周六几点方便看房？"]);
  expect(fixture.analysisInputs).toHaveLength(1);
});

test("评论获客：创建分析失败后重试复用已抓取评论", async ({ page }) => {
  const fixture = await leadFixture(
    page,
    undefined,
    undefined,
    undefined,
    undefined,
    { failFirstAnalysis: true },
  );
  await page.goto("/#/leads/comment-lead");
  await fillAndStart(page);
  await expect(page.getByText("分析暂不可用")).toBeVisible();
  await page.getByRole("button", { name: "开始分析" }).click();
  await expect(page.getByRole("blockquote")).toHaveText(leadRow.commentText);
  expect(fixture.startInputs).toHaveLength(1);
  expect(fixture.analysisInputs).toHaveLength(2);
  expect(fixture.analysisInputs[1].requestKey).toBe(
    fixture.analysisInputs[0].requestKey,
  );
});

test("评论获客：空结果可调整筛选，桌面与窄窗口均可审核", async ({
  page,
}, testInfo) => {
  const items: LeadAnalysisRow[] = [];
  await leadFixture(page, undefined, undefined, undefined, undefined, {
    qualifiedItems: items,
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/#/leads/comment-lead");
  await expect(page.getByLabel("自定义筛选条件")).toHaveValue("只找购房客户");
  await page.getByRole("button", { name: "有明确房产需求的人" }).click();
  await expect(page.getByLabel("自定义筛选条件")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("setup.png") });
  await fillAndStart(page);
  await expect(page.getByText("这次没有找到符合条件的客户")).toBeVisible();
  await page
    .getByRole("region", { name: "线索详情" })
    .getByRole("button", { name: "调整筛选条件" })
    .click();
  items.push(leadRow, leadRow2);
  await page.getByRole("button", { name: "开始分析" }).click();
  await expect(page.getByRole("blockquote")).toHaveText(leadRow.commentText);
  const people = page.getByRole("region", { name: "评论者列表" });
  const reader = page.getByRole("region", { name: "线索详情" });
  const left = await people.boundingBox(),
    right = await reader.boundingBox();
  expect(left!.x + left!.width).toBeLessThanOrEqual(right!.x + 1);
  await page.screenshot({ path: testInfo.outputPath("review.png") });
  await page.setViewportSize({ width: 780, height: 800 });
  await page.getByRole("button", { name: "查看 第二位客户 的评论" }).click();
  await expect(page.getByRole("blockquote")).toHaveText(leadRow2.commentText);
  expect((await reader.boundingBox())!.y).toBeGreaterThan(
    (await people.boundingBox())!.y,
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(780);
});

test("草稿失败的达标线索可以手写后提交，不重新判断", async ({ page }) => {
  const qualifiedItems = [{ ...leadRow, draft: "", draftError: "未生成草稿" }];
  const fixture = await leadFixture(
    page,
    undefined,
    undefined,
    undefined,
    undefined,
    { qualifiedItems },
  );
  await openReview(page);
  await expect(page.getByText("已识别为线索，AI 草稿尚未生成")).toBeVisible();
  const send = page.getByRole("button", { name: "确认加入发送队列" });
  await expect(send).toBeDisabled();
  await page
    .getByLabel("私信草稿-意向客户")
    .fill("你对三居室的面积有什么要求？");
  await send.click();
  await expect(page.getByText("排队中", { exact: true })).toBeVisible();
  expect(fixture.submittedDrafts).toEqual(["你对三居室的面积有什么要求？"]);
  expect(fixture.analysisInputs).toHaveLength(1);
  expect(fixture.retryInputs).toHaveLength(0);
});

test("仅重试草稿，保留线索判断和经纪人正在编辑的内容", async ({ page }) => {
  const row = { ...leadRow, draft: "", draftError: "未生成草稿" };
  let calls = 0;
  let finish!: () => void;
  const wait = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const fixture = await leadFixture(
    page,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      qualifiedItems: [row],
      retryDraft: async (id) => {
        expect(id).toBe(row.id);
        calls++;
        if (calls === 1)
          return {
            ok: false,
            error: {
              code: "DRAFT_INVALID",
              status: 502,
              message: "草稿服务未完成请求",
            },
          };
        await wait;
        row.draft = "模型生成的新私信";
        row.draftError = "";
        return { ok: true, data: { draft: row.draft } };
      },
    },
  );
  await openReview(page);
  const retry = page.getByRole("button", { name: "重试 AI 草稿" });
  await retry.click();
  await expect(page.getByText("草稿服务未完成请求")).toBeVisible();
  await retry.click();
  const draft = page.getByLabel("私信草稿-意向客户");
  await draft.fill("我正在写的私信");
  finish();
  await expect(retry).toHaveCount(0);
  await expect(draft).toHaveValue("我正在写的私信");
  expect(calls).toBe(2);
  expect(fixture.analysisInputs).toHaveLength(1);
  expect(fixture.submittedKeys).toHaveLength(0);
});

test("未获人工联系授权时保留线索且不能写或重试私信", async ({ page }) => {
  await leadFixture(page, undefined, undefined, undefined, undefined, {
    qualifiedItems: [{ ...leadRow, draft: "" }],
    manualContact: false,
  });
  await openReview(page);
  await expect(
    page.getByText("已保留这条线索，当前来源未授权人工联系。"),
  ).toBeVisible();
  await expect(page.getByLabel("私信草稿-意向客户")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "重试 AI 草稿" })).toHaveCount(
    0,
  );
});
test("兼容入口保留作品监控，移除旧历史记录抽屉", async ({ page }) => {
  await leadFixture(page);
  await page.goto("/#/leads/comment-lead");
  await expect(
    page.getByRole("button", { name: "作品评论监控" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "历史记录" })).toHaveCount(0);
});

test("小红书作品可单独监控、读取评论并将人工私信加入账号队列", async ({
  page,
}) => {
  const account = {
    ...activeAccount(),
    platform: "xhs" as const,
    nickname: "小红书测试账号",
  };
  const fixture = await leadFixture(page, [account]);
  await page.goto("/#/leads/comment-lead");
  await page
    .getByLabel("作品详情页链接")
    .fill("https://www.xiaohongshu.com/explore/0123456789abcdef01234567");
  await page
    .getByRole("checkbox", { name: "持续监控这条作品", exact: false })
    .check();
  await page.getByRole("checkbox", { name: "来源授权" }).check();
  await page.getByRole("button", { name: "只读取评论" }).click();
  await expect(
    page.getByText("小红书 · 0123456789abcdef01234567"),
  ).toBeVisible();
  expect(fixture.analysisInputs).toHaveLength(0);
  expect(fixture.startInputs[0]).toMatchObject({
    accountId: account.id,
    monitor: true,
  });
  await page.getByRole("button", { name: "立即读取" }).click();
  await expect.poll(() => fixture.scans).toEqual(["watch1"]);
  await page.getByRole("button", { name: "查看评论" }).click();
  await expect(
    page.getByText(leadRow.commentText, { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "写私信", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "给 意向客户 写私信" });
  await expect(
    modal.getByRole("button", { name: "加入账号队列" }),
  ).toBeDisabled();
  await modal.getByRole("textbox").fill("想了解您的找房需求");
  await modal.getByRole("button", { name: "加入账号队列" }).click();
  await expect(
    page.getByText(/已加入账号队列，可在发布中心查看结果/),
  ).toBeVisible();
  expect(fixture.replies).toHaveLength(1);
  expect(fixture.replies[0]).toMatchObject({
    accountId: account.id,
    workId: "xhs-0123456789abcdef01234567",
    commentId: "row-db-id",
    text: "想了解您的找房需求",
    requestKey: expect.any(String),
  });
  await page.getByRole("button", { name: "停止监控" }).click();
  await expect(page.getByText("暂无持续监控的作品")).toBeVisible();
});
