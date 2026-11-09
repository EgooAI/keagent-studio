import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { ArtifactHandoff } from "../../packages/shared-types/src/artifact";
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
async function desktopFixture(
  page: Page,
  resolverAvailable = true,
  unknown = false,
  pending = false,
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
    }) => {
      if (pending) fixture.artifact.review.state = "pending";
      let records: Record<string, unknown>[] = unknown
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
            },
          ]
        : [];
      let activeRecord: unknown;
      const okay = (data: unknown) => ({ ok: true, data });
      Object.assign(window, {
        __publishCount: 0,
        __source: fixture,
        __restores: 0,
        __restoreWrong: false,
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
            if (method === "artifact.get") return okay(fixture.artifact);
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
            if (method === "artifactHandoff.create") return okay(fixture);
            if (method === "douyin.cloud") {
              const op = args[0],
                input = args[1] as Record<string, unknown>;
              if (op === "accounts/list") return okay({ items: [account] });
              if (op === "records/list")
                return okay({ items: records, total: records.length });
              if (op === "records/reconcile") {
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
              return okay(
                fixture.assets.find((asset) => asset.id === input.assetId),
              );
            },
          },
          publishing: {
            subscribe: () => () => {},
            request: async (method: string, input: Record<string, unknown>) => {
              if (method === "state")
                return okay({
                  deviceId: fixture.deviceId,
                  resolverAvailable,
                  tabs: [],
                  activeRecord,
                });
              if (method === "preview")
                return okay({
                  video: "/media/demo-property.mp4",
                  cover: "/media/interior-1.jpg",
                });
              if (method === "cover.select")
                return okay({
                  ref: "f".repeat(32),
                  url: "/media/interior-2.jpg",
                });
              if (method === "publish.start") {
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
    },
  );
}
test("fixture UI receives an approved artifact, edits consumer fields and shows a submission receipt", async ({
  page,
}) => {
  await desktopFixture(page);
  await page.goto("/#/publish");
  await page.getByRole("link", { name: "查看成片与发布" }).click();
  await page.getByRole("button", { name: "接收这份成片", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "已接收该版本" }),
  ).toBeVisible();
  await page.getByLabel("发布账号").click();
  await page.getByText(account.name, { exact: true }).click();
  await page.getByLabel("标题", { exact: true }).fill("抖音独立标题");
  await page.getByLabel("正文", { exact: true }).fill("只修改发布文案");
  await page.getByRole("button", { name: "选择本地 JPG / PNG" }).click();
  await expect(page.getByAltText("本次发布封面")).toBeVisible();
  await page.getByRole("button", { name: /立即发布到抖音$/ }).click();
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
test("missing production resolver clearly blocks actual publishing", async ({
  page,
}) => {
  await desktopFixture(page, false);
  await page.goto(`/#/publish/${fixture.artifact.id}`);
  await expect(
    page.getByText("等待制作侧文件解析器", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /立即发布到抖音$/ }),
  ).toBeDisabled();
});

test("a registered pending output requires preview and explicit review before receiving", async ({
  page,
}) => {
  await desktopFixture(page, true, false, true);
  await page.goto(`/#/publish/${fixture.artifact.id}`);
  await expect(
    page.getByRole("button", { name: "接收这份成片", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "验收通过", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "验证文件并预览" }).click();
  await page.getByRole("button", { name: "验收通过", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "确认成片验收通过？" });
  await confirmation
    .getByRole("button", { name: "验收通过", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "撤回验收", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "接收这份成片", exact: true }),
  ).toBeEnabled();
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
  await page.getByRole("button", { name: "恢复视频文件", exact: true }).click();
  await expect(
    page.getByText("所选文件与验收版本不一致，请选择原始文件", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { __restoreWrong: boolean }).__restoreWrong = false;
  });
  await page.getByRole("button", { name: "恢复视频文件", exact: true }).click();
  expect(
    await page.evaluate(
      () => (window as unknown as { __restores: number }).__restores,
    ),
  ).toBe(1);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __source: ArtifactHandoff }).__source.artifact
          .review,
    ),
  ).toEqual(fixture.artifact.review);
});

test("a new acceptance revision clears the old handoff and permits a fresh explicit receipt", async ({
  page,
}) => {
  await desktopFixture(page);
  await page.goto(`/#/publish/${fixture.artifact.id}`);
  await page.getByRole("button", { name: "接收这份成片", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "已接收该版本" }),
  ).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { __source: ArtifactHandoff }).__source.artifact
      .review.revision++;
  });
  await page.getByRole("button", { name: "选择本地 JPG / PNG" }).click();
  await expect(
    page.getByRole("button", { name: "接收这份成片", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "接收这份成片", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "已接收该版本" }),
  ).toBeVisible();
});
test("an unknown result is resolved explicitly in the artifact detail", async ({
  page,
}) => {
  await desktopFixture(page, true, true);
  await page.goto(`/#/publish/${fixture.artifact.id}`);
  await page.getByRole("button", { name: "记录核对结果" }).click();
  await page.getByRole("button", { name: "确认未发布", exact: true }).click();
  await page
    .getByRole("button", { name: "我已核对，确认未发布", exact: true })
    .click();
  await expect(page.getByText("用户人工核对", { exact: true })).toBeVisible();
  await expect(
    page.getByText("你已确认该视频未发布，可以重新操作。", { exact: true }),
  ).toBeVisible();
});
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
