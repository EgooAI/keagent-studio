import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import type {
  ArtifactHandoff,
  CreateArtifactHandoffInput,
} from "../../packages/shared-types/src/artifact";
const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../packages/shared-types/fixtures/artifact-handoff.v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as ArtifactHandoff;
import { createInitialWorkspace } from "../../packages/api-client/src/fixtures";
import type { DouyinPublishRecord } from "../../packages/shared-types/src/douyin";
const account = {
  id: "d".repeat(32),
  deviceId: fixture.deviceId,
  name: "测试抖音账号",
  platformUserId: "test-public-id",
  loginStatus: "logged_in",
  lastCheckedAt: "2026-11-07T00:00:00Z",
};
const session = {
  userId: fixture.ownerId,
  sessionId: "ui-test-session",
  name: "测试用户",
  email: "test@example.test",
  role: "admin",
};
test("AI 获客 opens the observation form and renders a controlled desktop result", async ({
  page,
}) => {
  await desktopFixture(page);
  await page.goto("/#/leads/comment-observation");
  await page.getByRole("combobox", { name: "本机抖音账号" }).click();
  await page.getByText(account.name, { exact: true }).last().click();
  await page
    .getByLabel("标准视频链接")
    .fill("https://www.douyin.com/video/12345");
  await page.getByRole("button", { name: "打开并核验作品" }).click();
  await expect(page.getByText("明确为空").first()).toBeVisible();
  await expect(
    page.getByText("夹具作者", { exact: false }).first(),
  ).toBeVisible();
  await expect(page.getByRole("checkbox")).not.toBeChecked();
});
async function desktopFixture(
  page: Page,
  resolverAvailable = true,
  unknown = false,
  pending = false,
  initialRecord?: Pick<
    DouyinPublishRecord,
    "state" | "logs" | "errorCode" | "resultSource"
  >,
) {
  await page.addInitScript(
    ({
      fixture,
      account,
      workspace,
      session,
      resolverAvailable,
      unknown,
      pending,
      initialRecord,
    }) => {
      if (pending) fixture.artifact.review.state = "pending";
      let records: Record<string, unknown>[] =
        unknown || initialRecord
          ? [
              {
                id: "e".repeat(32),
                requestKey: "fixture-unknown-key",
                handoffId: fixture.id,
                artifactId: fixture.artifact.id,
                accountId: account.id,
                ownerId: fixture.ownerId,
                deviceId: fixture.deviceId,
                title: "待核对视频",
                description: "",
                hashtags: [],
                state: "unknown",
                progress: 95,
                createdAt: "2026-11-07T00:00:00Z",
                updatedAt: "2026-11-07T00:00:00Z",
                errorCode: "PUBLISH_OUTCOME_UNKNOWN",
                logs: [],
                ...initialRecord,
              },
            ]
          : [];
      let activeRecord: unknown;
      let activeAccountId: string | undefined;
      const observations: Record<string, unknown>[] = [];
      const artifacts = [
        fixture.artifact,
        {
          ...fixture.artifact,
          id: "f".repeat(32),
          content: { ...fixture.artifact.content, title: "第二套房源带看" },
        },
      ];
      const queue = { paused: false, rows: [] as Record<string, unknown>[] };
      const manuallyPublished =
        initialRecord?.resultSource === "manual" &&
        initialRecord.state === "accepted";
      if (manuallyPublished) {
        queue.paused = true;
        queue.rows.push({
          id: records[0].requestKey,
          recordId: records[0].id,
          artifactId: fixture.artifact.id,
          state: "accepted",
          resultSource: "manual",
          title: records[0].title,
          accountId: account.id,
        });
      }
      const okay = (data: unknown) => ({ ok: true, data });
      Object.assign(window, {
        __publishCount: 0,
        __reconcileRequests: [] as unknown[],
        __batchRequests: [] as unknown[],
        __source: fixture,
        __restores: 0,
        __restoreWrong: false,
        __previewChecks: 0,
        __handoffRequests: [] as CreateArtifactHandoffInput[],
        __failHandoff: false,
      });
      Object.assign(window, {
        desktop: {
          platform: "win32",
          mode: "authenticated",
          request: async (method: string, args: unknown[] = []) => {
            if (method === "session") return session;
            if (method === "getWorkspace") return workspace;
            if (method === "tick") return null;
            if (method === "artifact.list")
              return okay({
                items: [fixture.artifact],
                total: 1,
                limit: 20,
                offset: 0,
              });
            if (method === "artifact.get")
              return okay(
                artifacts.find(
                  (artifact) => artifact.id === (args[0] as { id: string }).id,
                ),
              );
            if (method === "artifact.review") {
              const input = args[0] as {
                expectedRevision: number;
                state: "approved" | "pending" | "rejected";
              };
              if (input.expectedRevision !== fixture.artifact.review.revision)
                return {
                  ok: false,
                  error: {
                    code: "REVISION_CONFLICT",
                    status: 409,
                    message: "验收已改变",
                  },
                };
              fixture.artifact.review = {
                state: input.state,
                revision: fixture.artifact.review.revision + 1,
              };
              return okay(fixture.artifact);
            }
            if (method === "asset.get")
              return okay(
                fixture.assets.find(
                  (asset) => asset.id === (args[0] as { id: string }).id,
                ),
              );
            if (method === "artifactHandoff.create") {
              const input = args[0] as CreateArtifactHandoffInput;
              const state = window as unknown as {
                __handoffRequests: CreateArtifactHandoffInput[];
                __failHandoff: boolean;
              };
              state.__handoffRequests.push(input);
              if (state.__failHandoff)
                return {
                  ok: false,
                  error: { status: 503, message: "测试自动接收失败" },
                };
              const source = artifacts.find(
                (value) => value.id === input.artifactId,
              );
              if (
                source?.review.state !== "approved" ||
                source.review.revision !== input.expectedReviewRevision
              )
                return {
                  ok: false,
                  error: {
                    status: 409,
                    code: "REVISION_CONFLICT",
                    message: "验收已改变",
                  },
                };
              return okay(structuredClone({ ...fixture, artifact: source }));
            }
            if (method === "douyin.cloud") {
              const op = args[0],
                input = args[1] as Record<string, unknown>;
              if (op === "accounts/list") return okay({ items: [account] });
              if (op === "workspace") {
                const matched = artifacts.filter(
                  (artifact) =>
                    !input.search ||
                    artifact.content.title.includes(String(input.search)),
                );
                return okay({
                  items: matched.map((artifact) => ({
                    id: artifact.id,
                    title: artifact.content.title,
                    propertyTitle: artifact.content.property?.title,
                    sourceRevision: artifact.source.revision,
                    review: artifact.review,
                    createdAt: artifact.createdAt,
                    ...(manuallyPublished && artifact.id === fixture.artifact.id
                      ? {
                          status: "accepted",
                          recordState: "accepted",
                          resultSource: "manual",
                          recordId: records[0].id,
                        }
                      : { status: "unpublished" }),
                    deviceReady: resolverAvailable,
                  })),
                  counts:
                    manuallyPublished &&
                    matched.some((row) => row.id === fixture.artifact.id)
                      ? { accepted: 1, unpublished: matched.length - 1 }
                      : { unpublished: matched.length },
                  total: matched.length,
                });
              }
              if (op === "records/list")
                return okay({ items: records, total: records.length });
              if (op === "records/reconcile") {
                (
                  window as unknown as { __reconcileRequests: unknown[] }
                ).__reconcileRequests.push(input);
                records = records.map((record) =>
                  record.id === input.id
                    ? {
                        ...record,
                        state: input.published ? "accepted" : "failed",
                        resultSource: "manual",
                        errorCode: input.published
                          ? undefined
                          : "USER_CONFIRMED_NOT_PUBLISHED",
                        url: input.url,
                      }
                    : record,
                );
                return okay(records[0]);
              }
            }
            throw new Error(`Unexpected test operation ${method}`);
          },
          artifactMedia: {
            request: async (method: string, input: { assetId: string }) => {
              if (method !== "asset.restore")
                throw new Error("Unexpected registry method");
              const state = window as unknown as {
                __restores: number;
                __restoreWrong: boolean;
              };
              if (state.__restoreWrong)
                return {
                  ok: false,
                  error: {
                    status: 422,
                    code: "FILE_MISMATCH",
                    message: "所选文件与验收版本不一致，请选择原始文件",
                  },
                };
              state.__restores++;
              const asset = fixture.assets.find(
                (asset) => asset.id === input.assetId,
              );
              if (asset) asset.availability.state = "available";
              return okay(asset);
            },
          },
          publishing: {
            subscribe: () => () => {},
            request: async (method: string, input: Record<string, unknown>) => {
              if (method === "observation.list") return okay(observations);
              if (method === "observation.start") {
                const observed = {
                  id: "controlled-observation",
                  accountId: account.id,
                  deviceId: account.deviceId,
                  targetUrl: input.url,
                  inputWorkId: "12345",
                  verifiedWorkId: "12345",
                  author: {
                    name: "夹具作者",
                    url: "https://www.douyin.com/user/fixture",
                  },
                  panelStatus: "explicitly_empty",
                  state: "finished",
                  startedAt: new Date().toISOString(),
                  endedAt: new Date().toISOString(),
                };
                observations.unshift(observed);
                return okay(observed);
              }
              if (method === "state")
                return okay({
                  deviceId: fixture.deviceId,
                  resolverAvailable,
                  tabs: activeAccountId
                    ? [
                        {
                          accountId: activeAccountId,
                          title: account.name,
                          url: "https://creator.douyin.com/creator-micro/content/upload",
                        },
                      ]
                    : [],
                  activeAccountId,
                  activeRecord,
                  queue,
                });
              if (method === "preview") {
                (window as unknown as { __previewChecks: number })
                  .__previewChecks++;
                return okay({
                  video: "/media/demo-property.mp4",
                  cover: "/media/interior-1.jpg",
                });
              }
              if (method === "publish.batch") {
                (
                  window as unknown as { __batchRequests: unknown[] }
                ).__batchRequests.push(input);
                queue.rows = (input.entries as Record<string, unknown>[]).map(
                  (entry, index) => ({
                    ...entry,
                    id: String(index),
                    batchId: input.requestKey,
                    accountId: input.accountId,
                    state: "queued",
                  }),
                );
                return okay(queue);
              }
              if (method === "publish.queue") {
                if (input.action === "pause" || input.action === "resume")
                  queue.paused = input.action === "pause";
                if (input.action === "cancel")
                  queue.rows = queue.rows.map((row) =>
                    row.id === input.id ? { ...row, state: "canceled" } : row,
                  );
                return okay(queue);
              }
              if (method === "publish.start") {
                const requests = window as unknown as {
                  __failPublish?: boolean;
                  __publishKeys?: unknown[];
                };
                (requests.__publishKeys ??= []).push(input.requestKey);
                if (requests.__failPublish)
                  return {
                    ok: false,
                    error: {
                      code: "TEST_SUBMIT_FAILURE",
                      status: 503,
                      message: "测试提交失败，请重试",
                    },
                  };
                if (records.some((record) => record.state === "unknown"))
                  return {
                    ok: false,
                    error: {
                      code: "OUTCOME_UNRESOLVED",
                      status: 409,
                      message: "请先核对上次发布",
                    },
                  };
                (window as unknown as { __publishCount: number })
                  .__publishCount++;
                activeRecord = {
                  ...input,
                  id: "e".repeat(32),
                  ownerId: fixture.ownerId,
                  deviceId: fixture.deviceId,
                  artifactId: fixture.artifact.id,
                  state: "accepted",
                  progress: 100,
                  createdAt: "2026-11-07T00:00:00Z",
                  updatedAt: "2026-11-07T00:00:00Z",
                  externalId: "123456789",
                  url: "https://www.douyin.com/video/123456789",
                  resultSource: "platform",
                  logs: [],
                };
                records = [activeRecord as Record<string, unknown>];
                return okay(activeRecord);
              }
              if (method === "account.open") {
                activeAccountId = String(input.accountId);
                return okay(null);
              }
              if (method === "browser.hide") activeAccountId = undefined;
              if (method === "browser.hide" || method === "browser.viewport")
                return okay(null);
              throw new Error(`Unexpected desktop fixture method ${method}`);
            },
          },
        },
      });
    },
    {
      fixture,
      account,
      workspace: createInitialWorkspace(),
      session,
      resolverAvailable,
      unknown,
      pending,
      initialRecord,
    },
  );
}
test("fixture UI prepares an approved artifact automatically, edits consumer fields and shows a submission receipt", async ({
  page,
}) => {
  await desktopFixture(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/#/publish");
  await page
    .getByRole("button", { name: fixture.artifact.content.title, exact: true })
    .click();
  const detail = page.getByRole("dialog", { name: "成片详情" });
  const config = page.getByRole("dialog", { name: "配置发布" });
  await expect(detail).toBeVisible();
  await expect(detail.locator('video[aria-label="成片预览"]')).toBeVisible();
  await expect(config).toBeHidden();
  const configure = detail.getByRole("button", { name: "配置发布" });
  await configure.click();
  await expect(detail).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(configure).toBeFocused();
  await configure.click();
  await expect(detail).toBeHidden();
  await config.getByLabel("发布账号").click();
  await page.getByText(account.name, { exact: true }).click();
  const title = config.getByLabel("标题", { exact: true });
  await title.fill("抖音独立标题");
  await config.getByLabel("正文", { exact: true }).fill("只修改发布文案");
  await expect(config.getByText(/成片封面将上传为抖音竖封面/)).toBeVisible();
  await page.setViewportSize({ width: 1080, height: 720 });
  await config.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(title).toHaveValue("抖音独立标题");
  await page.screenshot({
    path: "output/ui-dialogs/publish-1080.png",
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(title).toHaveValue("抖音独立标题");
  await page.screenshot({
    path: "output/ui-dialogs/publish-1440.png",
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  const submit = config.getByRole("button", {
    name: "立即发布到抖音",
    exact: true,
  });
  await page.evaluate(() => Object.assign(window, { __failPublish: true }));
  await submit.click();
  await expect(
    config.getByText("测试提交失败，请重试", { exact: true }),
  ).toBeVisible();
  await expect(title).toHaveValue("抖音独立标题");
  await page.evaluate(() => Object.assign(window, { __failPublish: false }));
  await submit.click();
  await expect(config).toBeHidden();
  await expect(detail).toBeVisible();
  const keys = await page.evaluate(
    () => (window as unknown as { __publishKeys: string[] }).__publishKeys,
  );
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  await expect(
    page.getByText("已提交抖音", { exact: true }).first(),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as { __publishCount: number }).__publishCount,
    ),
  ).toBe(1);
  expect(
    await page.evaluate(
      () => (window as unknown as { __source: unknown }).__source,
    ),
  ).toEqual(fixture);
  await expect(page.getByText(/平台回执|提交回执/).first()).toBeVisible();
  await page.screenshot({ path: "output/douyin-user.png", fullPage: true });
});
test("single-video scheduling validates Beijing time and displays a scheduled receipt", async ({
  page,
}) => {
  await desktopFixture(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/#/publish");
  await page
    .getByRole("button", { name: fixture.artifact.content.title, exact: true })
    .click();
  const detail = page.getByRole("dialog", { name: "成片详情" });
  await detail.getByRole("button", { name: "配置发布" }).click();
  const config = page.getByRole("dialog", { name: "配置发布" });
  const accountInput = config.getByRole("combobox", { name: "发布账号" });
  await accountInput.press("ArrowDown");
  await accountInput.press("Enter");
  await config.getByText("定时发布", { exact: true }).click();
  const time = config.getByLabel("预约时间（北京时间）");
  await time.fill("2020-01-01T12:00");
  await expect(
    config.getByRole("button", { name: "确认定时发布" }),
  ).toBeDisabled();
  const target = new Date(Date.now() + 24 * 3600_000 + 8 * 3600_000)
    .toISOString()
    .slice(0, 16);
  await time.fill(target);
  await expect(config.getByRole("img", { name: "预约发布封面" })).toBeVisible();
  await config.getByRole("button", { name: /^预约 .* 发布$/ }).click();
  await expect(
    detail.getByRole("button", { name: "去抖音管理" }),
  ).toBeVisible();
  await expect(detail.getByText(/预约时间.*北京时间/)).toBeVisible();
  await expect(
    detail.getByText("已排期", { exact: true }).first(),
  ).toBeVisible();
});

test("missing production resolver clearly blocks actual publishing", async ({
  page,
}) => {
  await desktopFixture(page, false);
  await page.goto(`/#/publish/${fixture.artifact.id}`);
  await expect(
    page.getByText("等待制作侧文件解析器", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "配置发布" })).toBeDisabled();
  await expect(page.locator("video")).toHaveCount(0);
});

test("a pending output previews automatically, receives the approved revision and can withdraw from More", async ({
  page,
}) => {
  await desktopFixture(page, true, false, true);
  await page.goto(`/#/publish/${fixture.artifact.id}`);
  await expect(page.locator('video[aria-label="成片预览"]')).toBeVisible();
  const handoffRequests = () =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            __handoffRequests: CreateArtifactHandoffInput[];
          }
        ).__handoffRequests,
    );
  expect(await handoffRequests()).toEqual([]);
  await page.getByRole("button", { name: "验收通过", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "确认成片验收通过？" });
  await confirmation
    .getByRole("button", { name: "验收通过", exact: true })
    .click();
  const configure = page.getByRole("button", { name: "配置发布" });
  await expect(configure).toBeEnabled();
  expect(await handoffRequests()).toEqual([
    expect.objectContaining({
      artifactId: fixture.artifact.id,
      expectedReviewRevision: fixture.artifact.review.revision + 1,
    }),
  ]);
  await expect(
    page.getByRole("menuitem", { name: "撤回验收", exact: true }),
  ).toBeHidden();
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("menuitem", { name: "撤回验收", exact: true }).click();
  await page
    .getByRole("dialog", { name: "撤回成片验收？" })
    .getByRole("button", { name: "撤回验收", exact: true })
    .click();
  await expect(configure).toBeHidden();
  await expect(
    page.getByRole("button", { name: "验收通过", exact: true }),
  ).toBeEnabled();
  expect(await handoffRequests()).toHaveLength(1);
  expect(
    await page.evaluate(
      () => (window as unknown as { __publishCount: number }).__publishCount,
    ),
  ).toBe(0);
});

test("file recovery reports mismatched bytes without changing the source review", async ({
  page,
}) => {
  await desktopFixture(page);
  await page.goto(`/#/publish/${fixture.artifact.id}`);
  await page.evaluate(() => {
    (window as unknown as { __restoreWrong: boolean }).__restoreWrong = true;
  });
  const more = page.getByRole("button", { name: "更多", exact: true });
  const restore = page.getByRole("menuitem", {
    name: "恢复视频文件",
    exact: true,
  });
  await expect(page.locator('video[aria-label="成片预览"]')).toBeVisible();
  await expect(restore).toBeHidden();
  await more.click();
  await restore.click();
  await expect(
    page.getByText("所选文件与验收版本不一致，请选择原始文件", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { __restoreWrong: boolean }).__restoreWrong = false;
  });
  await more.click();
  await restore.click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __restores: number }).__restores,
      ),
    )
    .toBe(1);
  await expect(page.locator('video[aria-label="成片预览"]')).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __previewChecks: number }).__previewChecks,
      ),
    )
    .toBe(2);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __source: ArtifactHandoff }).__source.artifact
          .review,
    ),
  ).toEqual(fixture.artifact.review);
});

test("a failed automatic receipt can be retried for the same reviewed version", async ({
  page,
}) => {
  await desktopFixture(page, true, false, true);
  await page.goto(`/#/publish/${fixture.artifact.id}`);
  const approve = page.getByRole("button", { name: "验收通过", exact: true });
  await expect(approve).toBeEnabled();
  await page.evaluate(() => Object.assign(window, { __failHandoff: true }));
  await approve.click();
  await page
    .getByRole("dialog", { name: "确认成片验收通过？" })
    .getByRole("button", { name: "验收通过", exact: true })
    .click();
  const configure = page.getByRole("button", { name: "配置发布" });
  await expect(page.getByText("测试自动接收失败")).toBeVisible();
  await expect(configure).toBeDisabled();
  await page.evaluate(() => Object.assign(window, { __failHandoff: false }));
  await page.getByRole("button", { name: "重试准备" }).click();
  await expect(configure).toBeEnabled();
  const requests = await page.evaluate(
    () =>
      (window as unknown as { __handoffRequests: CreateArtifactHandoffInput[] })
        .__handoffRequests,
  );
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
});

test("a new acceptance revision requires reopening configuration even after automatic receipt", async ({
  page,
}) => {
  await desktopFixture(page);
  await page.goto(`/#/publish/${fixture.artifact.id}`);
  const configure = page.getByRole("button", { name: "配置发布" });
  await configure.click();
  const config = page.getByRole("dialog", { name: "配置发布" });
  await expect(config).toBeVisible();
  await config.getByLabel("发布账号").click();
  await page.getByText(account.name, { exact: true }).click();
  await page.evaluate(() => {
    (window as unknown as { __source: ArtifactHandoff }).__source.artifact
      .review.revision++;
    Object.assign(window, { __failPublish: true });
  });
  await config.getByRole("button", { name: "立即发布到抖音" }).click();
  await expect(
    page.getByText("发布条件已变化，请返回详情检查验收和本机文件。"),
  ).toBeVisible();
  await expect(
    config.getByRole("button", { name: "立即发布到抖音" }),
  ).toBeDisabled();
  await config.getByRole("button", { name: /^取\s*消$/ }).click();
  await page.getByRole("button", { name: "放弃修改", exact: true }).click();
  await expect(configure).toBeEnabled();
  const requests = await page.evaluate(
    () =>
      (window as unknown as { __handoffRequests: CreateArtifactHandoffInput[] })
        .__handoffRequests,
  );
  expect(
    requests.map(({ expectedReviewRevision }) => expectedReviewRevision),
  ).toEqual([
    fixture.artifact.review.revision,
    fixture.artifact.review.revision + 1,
  ]);
});
test("刷新后成片列表和本机队列都显示人工确认已发布", async ({ page }) => {
  await desktopFixture(page, true, false, false, {
    state: "accepted",
    errorCode: "",
    resultSource: "manual",
    logs: [],
  });
  await page.goto("/#/publish");
  const list = page.getByRole("region", { name: "成片列表" });
  await expect(list.getByText("已发布", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(list.getByText("已发布", { exact: true })).toBeVisible();
  await page.getByText("本机队列", { exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "本机发布队列" })
      .getByText("已发布", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("有任务的结果待核对，队列已暂停", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "恢复发布队列" }),
  ).toBeVisible();
});
for (const published of [false, true]) {
  const button = published ? "确认已发布" : "确认未发布";
  test(`发布核对可一次点击${button}`, async ({ page }) => {
    await desktopFixture(page, true, true);
    await page.goto(`/#/publish/${fixture.artifact.id}`);
    await page.getByText("发布记录", { exact: true }).click();
    await page.getByRole("button", { name: "记录核对结果" }).click();
    const dialog = page.getByRole("dialog", { name: "记录人工核对结果" });
    await expect(dialog.locator(".ant-modal-footer button")).toHaveText([
      "确认未发布",
      "确认已发布",
    ]);
    await expect(dialog.getByRole("textbox")).toHaveCount(0);
    await dialog.getByRole("button", { name: button, exact: true }).click();
    await expect(dialog).toBeHidden();
    const record = page.locator(".douyin-record");
    await expect(
      record.getByText("用户人工核对", { exact: true }),
    ).toBeVisible();
    await expect(
      record.getByText(
        published ? "已发布" : "你已确认该视频未发布，可以重新操作。",
        { exact: true },
      ),
    ).toBeVisible();
    expect(
      await page.evaluate(() => Reflect.get(window, "__reconcileRequests")),
    ).toEqual([{ id: "e".repeat(32), published }]);
  });
}
test("admin publishing diagnostics link to mail settings with retry and recipient removal", async ({
  page,
}) => {
  let recipient = "ops@example.test";
  let readFailures = 1;
  let saveFailures = 1;
  let smtpConfigured = false;
  const attemptedRecipients: string[] = [];
  const record = {
    id: "e".repeat(32),
    ownerId: fixture.ownerId,
    deviceId: fixture.deviceId,
    artifactId: fixture.artifact.id,
    handoffId: fixture.id,
    accountId: account.id,
    state: "accepted",
    progress: 100,
    createdAt: "2026-11-07T00:00:00Z",
    updatedAt: "2026-11-07T00:00:00Z",
    resultSource: "platform",
    url: "https://www.douyin.com/video/123456789",
    logs: [
      {
        step: "upload_video",
        status: "completed",
        timestamp: "2026-11-07T00:00:00Z",
        durationMs: 123,
      },
    ],
  } as DouyinPublishRecord;
  await page.route("**/api/auth/token", (route) =>
    route.fulfill({ json: { token: "fixture-token" } }),
  );
  await page.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    let data: unknown = {};
    if (url.pathname === "/v1/session") data = session;
    else if (url.pathname.endsWith("/douyin/records"))
      data = { items: [record], total: 1, limit: 20, offset: 0 };
    else if (url.pathname.endsWith("/douyin/summary"))
      data = { total: 1, states: { accepted: 1 } };
    else if (url.pathname.endsWith("/douyin/health"))
      data = { failures: 0, incident: false, pendingEmails: 2 };
    else if (url.pathname.endsWith("/douyin/detail")) data = record;
    else if (url.pathname.endsWith("/douyin/settings")) {
      if (route.request().method() === "POST") {
        const email = route.request().postDataJSON().operationsEmail;
        attemptedRecipients.push(email);
        if (saveFailures-- > 0)
          return route.fulfill({
            status: 503,
            json: { error: { message: "暂时无法保存" } },
          });
        recipient = email;
        smtpConfigured = true;
      } else if (readFailures-- > 0) {
        return route.fulfill({
          status: 503,
          json: { error: { message: "暂时无法读取" } },
        });
      }
      data = { operationsEmail: recipient, smtpConfigured };
    } else if (url.pathname.endsWith("/users/list"))
      data = { items: [], total: 0 };
    await route.fulfill({ json: data });
  });
  await page.goto("http://127.0.0.1:5178/#/admin/douyin");
  await expect(
    page.getByText("发布记录与步骤只读", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: record.id, exact: true }).click();
  await expect(page.getByText("upload_video", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /重试发布|取消发布/ }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByText(/待投递邮件：2/)).toBeVisible();
  await expect(page.getByLabel("运维邮箱", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: "output/douyin-admin.png", fullPage: true });
  await page.getByRole("link", { name: "管理邮件通知" }).click();
  await expect(page).toHaveURL(/admin\/settings\?tab=mail$/);
  await expect(
    page.getByText("邮件设置读取失败", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "重试读取", exact: true }).click();
  await expect(
    page.getByText("SMTP 尚未完整配置", { exact: true }),
  ).toBeVisible();
  const email = page.getByLabel("运维邮箱", { exact: true });
  const save = page.getByRole("button", { name: "保存邮箱", exact: true });
  await expect(email).toHaveValue("ops@example.test");
  await email.fill("invalid");
  await save.click();
  await expect(page.getByText("请输入有效邮箱", { exact: true })).toBeVisible();
  expect(attemptedRecipients).toEqual([]);
  await email.fill("next-ops@example.test");
  await save.click();
  await expect(page.getByText("保存邮箱失败", { exact: true })).toBeVisible();
  await expect(email).toHaveValue("next-ops@example.test");
  expect(recipient).toBe("ops@example.test");
  await save.click();
  await expect(page.getByText("运维邮箱已保存", { exact: true })).toBeVisible();
  await expect(page.getByText("SMTP 已配置", { exact: true })).toBeVisible();
  await email.clear();
  await save.click();
  await expect.poll(() => recipient).toBe("");
  await page.reload();
  await expect(email).toHaveValue("");
  expect(attemptedRecipients).toEqual([
    "next-ops@example.test",
    "next-ops@example.test",
    "",
  ]);
});

test("发布工作台可在详情旁筛选成片，并在明确确认后批量入队", async ({
  page,
}) => {
  await desktopFixture(page);
  await page.goto("/#/publish");
  await expect(
    page.getByRole("heading", { name: "发布中心", exact: true }),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "搜索成片" }).fill("第二套");
  const list = page.getByRole("region", { name: "成片列表" });
  await list
    .getByRole("button", { name: "第二套房源带看", exact: true })
    .waitFor();
  await expect(
    list.getByRole("button", {
      name: fixture.artifact.content.title,
      exact: true,
    }),
  ).toHaveCount(0);
  await list
    .getByRole("button", { name: "第二套房源带看", exact: true })
    .click();
  await expect(
    page.getByRole("complementary", { name: "成片详情" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭成片详情" }).click();
  await page.getByRole("textbox", { name: "搜索成片" }).fill("");
  await list
    .getByRole("checkbox", {
      name: "选择 " + fixture.artifact.content.title,
      exact: true,
    })
    .check();
  await list
    .getByRole("checkbox", { name: "选择 第二套房源带看", exact: true })
    .check();
  await page
    .getByRole("button", { name: "配置批量发布 2 条", exact: true })
    .click();
  const batch = page.getByRole("dialog", { name: "配置批量发布 · 2 条" });
  await batch
    .getByRole("textbox", { name: "第 1 条发布标题" })
    .fill("第一套发布标题");
  await batch
    .getByRole("textbox", { name: "第 2 条发布标题" })
    .fill("第二套发布标题");
  await expect
    .poll(() => page.evaluate(() => (window as any).__batchRequests.length))
    .toBe(0);
  await batch.getByRole("button", { name: "确认发布 2 条" }).click();
  const queue = page.getByRole("region", { name: "本机发布队列" });
  await expect(queue.getByText("排队中", { exact: true })).toHaveCount(2);
  const requests = await page.evaluate(() => (window as any).__batchRequests);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    accountId: account.id,
    entries: [
      {
        artifactId: fixture.artifact.id,
        expectedReviewRevision: fixture.artifact.review.revision,
        title: "第一套发布标题",
      },
      { artifactId: "f".repeat(32), title: "第二套发布标题" },
    ],
  });
  await page.getByRole("button", { name: "暂停发布队列" }).click();
  await expect(
    page.getByRole("button", { name: "恢复发布队列" }),
  ).toBeVisible();
  await queue
    .getByRole("button", { name: "取消", exact: true })
    .first()
    .click();
  await expect(queue.getByText("已取消", { exact: true })).toBeVisible();
  await page.screenshot({
    path: "output/publish-workbench-1440.png",
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await queue
    .getByRole("button", { name: "详情", exact: true })
    .first()
    .click();
  await expect(page.getByRole("dialog", { name: "成片详情" })).toBeVisible();
  await page.screenshot({
    path: "output/publish-workbench-1280.png",
    animations: "disabled",
  });
});

test("历史发布记录合并步骤事件并定位旧版发布设置失败", async ({ page }) => {
  const events = [
    ["check_login", "started"],
    ["check_login", "completed"],
    ["platform_publish", "started"],
    ["publish_settings", "started"],
    ["set_download", "started"],
    ["click_page_control", "started"],
    ["click_page_control", "failed"],
    ["set_download", "failed"],
    ["publish_settings", "failed"],
    ["platform_publish", "failed"],
  ] as const;
  await desktopFixture(page, true, false, false, {
    state: "failed",
    errorCode: "EXECUTION_FAILED",
    logs: events.map(([step, status], index) => ({
      step,
      status,
      timestamp: new Date(
        Date.UTC(2026, 10, 18, 9, 0, 0, index * 150),
      ).toISOString(),
      ...(status === "failed" ? { errorCode: "EXECUTION_FAILED" } : {}),
    })),
  });
  await page.goto(`/#/publish/${fixture.artifact.id}`);
  await page.getByText("发布记录", { exact: true }).click();
  const steps = page.locator(".publish-execution-steps");
  await expect(steps).toHaveAttribute("open", "");
  const overview = steps.locator(".ant-timeline");
  await expect(overview.getByText("核对抖音登录", { exact: true })).toHaveCount(
    1,
  );
  await expect(overview.getByText(/150 毫秒/)).toBeVisible();
  await expect(
    overview.getByText("核对发布设置", { exact: true }),
  ).toBeVisible();
  await expect(overview.getByText("失败位置 · 设置下载权限")).toBeVisible();
  await expect(
    steps.getByText("click_page_control", { exact: true }),
  ).toBeHidden();
  await steps.getByText("技术详情", { exact: true }).click();
  await expect(
    steps.getByText("click_page_control", { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, "__publishCount"))).toBe(
    0,
  );
});

for (const state of ["failed", "unknown"] as const) {
  test(`发布遇到验证码时可打开原账号浏览器（${state}）`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await desktopFixture(page, true, false, false, {
      state,
      errorCode: "VERIFICATION_REQUIRED",
      logs: [],
    });
    await page.goto(`/#/publish/${fixture.artifact.id}`);
    await page.getByText("发布记录", { exact: true }).click();
    await expect(
      page.getByText("需要输入验证码", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(
        state === "unknown"
          ? /先到创作者中心核对发布结果/
          : /返回工作台重新发布/,
      ),
    ).toBeVisible();
    await page.getByRole("button", { name: "打开抖音账号浏览器" }).click();
    const browser = page.getByRole("region", { name: "抖音账号浏览器" });
    await expect(
      browser.getByRole("tab", { name: account.name }),
    ).toBeVisible();
    await browser.getByRole("button", { name: "返回工作台" }).click();
    await expect(browser).toBeHidden();
    expect(
      await page.evaluate(() => Reflect.get(window, "__publishCount")),
    ).toBe(0);
  });
}

test("发布工作区按需显示批量操作，预览和记录独立切换", async ({ page }) => {
  await desktopFixture(page);
  await page.goto("/#/publish");
  await expect(page.getByRole("button", { name: /配置批量发布/ })).toBeHidden();
  await expect(page.getByRole("textbox", { name: "搜索成片" })).toBeVisible();
  await page.screenshot({
    path: ".impeccable/review/publish-live-1440.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.goto(`/#/publish/${fixture.artifact.id}`);
  await expect(
    page.getByRole("button", { name: "配置发布", exact: true }),
  ).toBeVisible();
  await page.getByText("发布记录", { exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "这份成片的发布记录" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "配置发布", exact: true }),
  ).toBeHidden();
  await page.getByText("预览验收", { exact: true }).click();
  await expect(
    page.getByRole("button", { name: "配置发布", exact: true }),
  ).toBeEnabled();
  const player = page.locator('video[aria-label="成片预览"]');
  await expect
    .poll(() =>
      player.evaluate((video: HTMLVideoElement) => {
        const box = video.getBoundingClientRect();
        const frame = video.parentElement!.getBoundingClientRect();
        return (
          video.readyState > 0 &&
          video.controls &&
          box.top >= frame.top - 1 &&
          box.bottom <= frame.bottom + 1
        );
      }),
    )
    .toBe(true);
  await player.hover();
  await page.screenshot({
    path: ".impeccable/review/publish-detail-live-1440.png",
    fullPage: true,
    animations: "disabled",
  });
});
