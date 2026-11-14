import { expect, test, type Page } from "@playwright/test";
import { createInitialWorkspace } from "../../packages/api-client/src/fixtures";
import type {
  CollectionTarget,
  CollectionRun,
  MonitoredVideo,
  CollectionTargetInput,
} from "../../packages/shared-types/src/collection";

async function collectionFixture(page: Page) {
  const deviceId = "collection-test-device";
  const account = {
    id: "a".repeat(32),
    name: "夹具抖音账号",
    deviceId,
    loginStatus: "logged_in",
  };
  const targets = new Map<string, CollectionTarget>();
  const runs: CollectionRun[] = [];
  const videos: MonitoredVideo[] = [];
  const runKeys: string[] = [];
  const reads: string[] = [];
  let rejectStart = false;
  const time = "2026-11-14T08:00:00Z";
  await page.exposeFunction(
    "collectionTestRequest",
    (method: string, input: Record<string, unknown> = {}) => {
      const okay = (data: unknown) => ({ ok: true, data });
      if (method.endsWith("/list")) reads.push(method);
      if (method === "accounts/list") return okay({ items: [account] });
      if (method === "state")
        return okay({ deviceId, tabs: [], queue: { paused: false, rows: [] } });
      if (method === "targets/list")
        return okay({
          items: [...targets.values()].filter((t) => t.state !== "archived"),
        });
      if (method === "runs/list")
        return okay({
          items: runs.filter(
            (r) => !input.targetId || input.targetId === r.targetId,
          ),
        });
      if (method === "videos/list") return okay({ items: videos });
      if (method === "targets/create") {
        const target: CollectionTarget = {
          ...(input as unknown as CollectionTargetInput),
          id: "target-" + targets.size,
          deviceId,
          state: "active",
          version: 1,
          createdAt: time,
          updatedAt: time,
        };
        targets.set(target.id, target);
        return okay(target);
      }
      const target = targets.get(String(input.id ?? input.targetId));
      if (!target || input.expectedVersion !== target.version)
        throw new Error("目标版本不匹配");
      if (method === "collection.start") {
        runKeys.push(String(input.requestKey));
        if (rejectStart) {
          rejectStart = false;
          return {
            ok: false,
            error: { status: 503, message: "测试网络暂时中断" },
          };
        }
        if (target.kind !== "video" || target.state !== "active")
          throw new Error("不可执行的目标");
        const id = target.value.split("/").at(-1)!;
        const author = {
          name: "受控测试作者",
          url: "https://www.douyin.com/user/test-author",
        };
        const run: CollectionRun = {
          id: "run-" + runs.length,
          targetId: target.id,
          targetName: target.name,
          targetVersion: target.version,
          targetUrl: target.value,
          inputWorkId: id,
          accountId: account.id,
          deviceId,
          state: "succeeded",
          panelStatus: "visible",
          createdAt: time,
          startedAt: time,
          endedAt: time,
          verifiedWorkId: id,
          title: "夹具作品",
          author,
        };
        runs.unshift(run);
        videos.unshift({
          id,
          title: run.title,
          author,
          targetUrl: run.targetUrl,
          lastRunId: run.id,
          lastObservedAt: time,
          accountId: account.id,
          deviceId,
          panelStatus: run.panelStatus,
        });
        return okay(run);
      }
      const states: Record<string, CollectionTarget["state"]> = {
        "targets/pause": "paused",
        "targets/resume": "active",
        "targets/archive": "archived",
      };
      if (method === "targets/update") Object.assign(target, input);
      else if (states[method]) target.state = states[method];
      else throw new Error("Unexpected operation " + method);
      if (target.state === "archived")
        runs
          .filter((r) => r.targetId === target.id)
          .forEach((r) => {
            r.targetArchived = true;
          });
      target.version++;
      return okay(target);
    },
  );
  await page.addInitScript(
    ({ workspace }) => {
      const call = (
        window as unknown as {
          collectionTestRequest: (
            method: string,
            input?: unknown,
          ) => Promise<unknown>;
        }
      ).collectionTestRequest;
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
    failNextStart: () => {
      rejectStart = true;
    },
    runKeys,
    reads,
  };
}

test("目标建改启停、单作品观察、重新进入后的历史及已核验作品", async ({
  page,
}) => {
  const fixture = await collectionFixture(page);
  await page.goto("/#/leads");
  async function refresh(operation: string) {
    const count = () =>
      fixture.reads.filter((read) => read === operation).length;
    const previous = count();
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await expect.poll(count).toBeGreaterThan(previous);
  }
  async function create(name: string, kind: string, value: string) {
    await page.getByRole("button", { name: "新建目标", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新建目标" });
    await dialog.getByLabel("目标名称").fill(name);
    if (kind !== "单条视频") {
      await dialog.getByRole("combobox", { name: "目标类型" }).click();
      await page.getByText(kind, { exact: true }).last().click();
    }
    await dialog
      .getByRole("textbox", {
        name:
          kind === "单条视频"
            ? "作品链接"
            : kind === "博主主页"
              ? "主页链接"
              : "关键词",
      })
      .fill(value);
    await dialog.getByRole("combobox", { name: "本机执行账号" }).click();
    await page
      .locator(".ant-select-dropdown:visible")
      .getByText("夹具抖音账号", { exact: true })
      .click();
    await dialog.getByRole("button", { name: /^保\s*存$/ }).click();
    await expect(dialog).toBeHidden();
    return page.getByRole("row").filter({ hasText: name });
  }
  const video = await create(
    "房源视频",
    "单条视频",
    "https://www.douyin.com/video/12345",
  );
  await video.getByRole("button", { name: "编辑" }).click();
  const editing = page.getByRole("dialog", { name: "编辑目标" });
  await editing.getByLabel("目标名称").fill("已更新的视频");
  await editing.getByRole("button", { name: /^保\s*存$/ }).click();
  const row = page.getByRole("row").filter({ hasText: "已更新的视频" });
  await row.getByRole("button", { name: "暂停" }).click();
  await expect(row.getByRole("button", { name: "手动观察" })).toBeDisabled();
  await row.getByRole("button", { name: "恢复" }).click();
  fixture.failNextStart();
  await row.getByRole("button", { name: "手动观察" }).click();
  await expect(page.getByText("测试网络暂时中断")).toBeVisible();
  await row.getByRole("button", { name: "手动观察" }).click();
  await expect(page.getByRole("tab", { name: "运行历史" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByText("可见", { exact: true })).toBeVisible();
  expect(fixture.runKeys).toHaveLength(2);
  expect(fixture.runKeys[0]).toBe(fixture.runKeys[1]);
  await page.getByRole("tab", { name: "目标管理" }).click();
  const creator = await create(
    "主页意向",
    "博主主页",
    "https://www.douyin.com/user/test-author",
  );
  const keyword = await create("搜索意向", "关键词", "某品牌");
  for (const target of [creator, keyword]) {
    await expect(target.getByText("仅保存目标")).toBeVisible();
    await expect(target.getByRole("button", { name: "手动观察" })).toHaveCount(
      0,
    );
  }
  await row.getByRole("button", { name: "删除" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^删\s*除$/ })
    .click();
  await expect(row).toHaveCount(0);
  await page.reload();
  await page.getByRole("tab", { name: "运行历史" }).click();
  await expect(
    page.getByRole("row").filter({ hasText: "已更新的视频" }),
  ).toContainText("已完成");
  await expect(page.getByText("目标已删除", { exact: true })).toBeVisible();
  await page
    .getByRole("row")
    .filter({ hasText: "已更新的视频" })
    .getByRole("button")
    .click();
  await refresh("runs/list");
  await expect(page.getByText("12345", { exact: true })).toHaveCount(2);
  await expect(page.getByText("受控测试作者", { exact: true })).toBeVisible();
  await expect(page.getByText("可见", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "已核验作品" }).click();
  const work = page.getByRole("row").filter({ hasText: "夹具作品" });
  await expect(work).toBeVisible();
  await refresh("videos/list");
  await expect(work).toContainText("https://www.douyin.com/video/12345");
  await expect(work).toContainText("受控测试作者");
  await expect(work).toContainText("可见");
});
