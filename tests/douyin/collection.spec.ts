import { expect, test, type Page } from "@playwright/test";
import { createInitialWorkspace } from "../../packages/api-client/src/fixtures";
import type {
  CollectionTarget,
  CollectionRun,
  CommentDetail,
  CommentSourceState,
  MonitoredVideo,
  CollectionTargetInput,
} from "../../packages/shared-types/src/collection";

async function collectionFixture(
  page: Page,
  commentRequest?: (method: string, input: Record<string, unknown>) => unknown,
) {
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
  let contactProfile = "";
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
        return okay({
          deviceId,
          tabs: contactProfile
            ? [
                {
                  accountId: account.id,
                  title: "夹具评论者主页",
                  url: contactProfile,
                  saved: true,
                },
              ]
            : [],
          activeAccountId: contactProfile ? account.id : undefined,
          queue: { paused: false, rows: [] },
        });
      if (method === "browser.viewport") return okay(null);
      if (method === "browser.hide") {
        contactProfile = "";
        return okay(null);
      }
      if (method === "targets/list")
        return okay({
          items: [...targets.values()].filter((t) => t.state !== "archived"),
        });
      if (method === "runs/list")
        return okay({
          items: runs
            .filter((r) => !input.targetId || input.targetId === r.targetId)
            .slice(0, Number(input.limit || 20)),
        });
      if (method === "runs/get")
        return okay(runs.find((r) => r.id === input.id));
      if (method === "videos/list") return okay({ items: videos });
      if (method === "videos/get")
        return okay(videos.find((v) => v.id === input.id));
      if (method.startsWith("comments/") && commentRequest)
        return commentRequest(method, input);
      if (method === "collection.contact" && commentRequest) {
        const result = commentRequest(method, input) as {
          ok: boolean;
          data?: { profileUrl: string };
        };
        if (!result.ok) return result;
        contactProfile = result.data!.profileUrl;
        return okay({
          deviceId,
          tabs: [
            {
              accountId: account.id,
              title: "夹具评论者主页",
              url: contactProfile,
              saved: true,
            },
          ],
          activeAccountId: account.id,
          queue: { paused: false, rows: [] },
        });
      }
      if (method === "targets/create" || method === "targets/resolve-video") {
        if (method === "targets/resolve-video") {
          const url = new URL(String(input.value));
          const id =
            url.searchParams.get("modal_id") || url.pathname.split("/").at(-1);
          input = {
            ...input,
            value: "https://www.douyin.com/video/" + id,
            name: "作品 " + id,
            kind: "video",
          };
          const existing = [...targets.values()].find(
            (t) =>
              t.state !== "archived" &&
              t.value === input.value &&
              t.accountId === input.accountId,
          );
          if (existing) return okay(existing);
        }
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
    videos,
    account,
    targets,
    runs,
  };
}

test("目标建改启停、单作品观察、重新进入后的历史及已核验作品", async ({
  page,
}) => {
  const fixture = await collectionFixture(page);
  await page.goto("/#/leads");
  await page.getByRole("button", { name: "从视频获取评论" }).click();
  const initialForm = page.getByRole("dialog", { name: "从视频获取评论" });
  await expect(
    initialForm.getByRole("textbox", { name: "作品链接" }),
  ).toBeVisible();
  await initialForm.getByRole("button", { name: /^取\s*消$/ }).click();
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
    .getByRole("button", { name: /展开|expand/i })
    .click();
  await refresh("runs/list");
  await expect(page.getByText("12345", { exact: true })).toHaveCount(2);
  await expect(page.getByText("受控测试作者", { exact: true })).toBeVisible();
  await expect(page.getByText("可见", { exact: true })).toBeVisible();
  await expect(
    page
      .getByRole("row")
      .filter({ hasText: "已更新的视频" })
      .getByRole("button", { name: "评论明细" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "已核验作品" }).click();
  const work = page.getByRole("row").filter({ hasText: "夹具作品" });
  await expect(work).toBeVisible();
  await refresh("videos/list");
  await expect(work).toContainText("https://www.douyin.com/video/12345");
  await expect(work).toContainText("受控测试作者");
  await expect(work).toContainText("可见");
});

test("快捷入口仅需作品与账号，复用目标和运行，刷新后自动进入核验作品", async ({
  page,
}) => {
  const workId = "7700000000000000001";
  const canonical = "https://www.douyin.com/video/" + workId;
  const fixture = await collectionFixture(page, (method) => {
    expect(method).toBe("comments/list");
    return {
      ok: true,
      data: {
        items: [],
        sourceState: "unconfigured",
        coverage: "unknown",
        canAnalyze: false,
        canContact: false,
      },
    };
  });
  await page.goto("/#/leads");
  const shortcut = page.getByRole("button", { name: "从视频获取评论" });
  async function submit(url: string) {
    await shortcut.click();
    const dialog = page.getByRole("dialog", { name: "从视频获取评论" });
    await expect(dialog.getByLabel("目标名称")).toHaveCount(0);
    await dialog.getByRole("textbox", { name: "作品链接" }).fill(url);
    await dialog.getByRole("button", { name: "核验作品" }).click();
  }
  await submit(canonical);
  const comments = page.getByRole("dialog", { name: "评论明细" });
  await expect(comments).toContainText("作品 ID " + workId);
  await expect(comments).toContainText("尚未接入这条作品的获准评论来源");
  expect(fixture.targets.size).toBe(1);
  expect(fixture.runKeys).toHaveLength(1);
  await comments.getByRole("button", { name: /close|关闭/i }).click();
  const target = [...fixture.targets.values()][0];
  target.name = "我保存的作品";
  const existing = {
    ...fixture.runs[0],
    id: "already-observing",
    state: "running" as CollectionRun["state"],
    verifiedWorkId: undefined,
    endedAt: undefined,
  };
  fixture.runs.unshift(existing);
  await submit("https://www.douyin.com/user/test?modal_id=" + workId);
  await expect(page.getByText("作品核验成功后将打开评论明细。")).toBeVisible();
  await page.reload();
  await expect(page.getByText("作品核验成功后将打开评论明细。")).toBeVisible();
  Object.assign(existing, {
    state: "succeeded",
    verifiedWorkId: workId,
    endedAt: existing.startedAt,
  });
  await expect(comments).toContainText("作品 ID " + workId);
  expect(fixture.targets.size).toBe(1);
  expect(target.name).toBe("我保存的作品");
  expect(fixture.runKeys).toHaveLength(1);
  await comments.getByRole("button", { name: /close|关闭/i }).click();
  target.state = "paused";
  await submit(canonical);
  await expect(page.getByRole("dialog")).toContainText("作品目标已暂停");
  expect(fixture.runKeys).toHaveLength(1);
});

test("获准来源的评论明细可同步、重试、分页和重开，撤回授权后隐藏明细", async ({
  page,
}) => {
  const workId = "23456";
  // Verify the text sent to the clipboard without overwriting the host clipboard.
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (value: string) => {
          sessionStorage.setItem("test-copy", value);
        },
      },
    }),
  );
  const time = "2026-11-14T08:00:00Z";
  const root: CommentDetail = {
    id: "stored-1",
    comment_id: "comment-1",
    parent_comment_id: null,
    comment_text: "测试主评论：想租两居室",
    commenter_name: "同名测试用户",
    commenter_profile: "https://www.douyin.com/user/test-only",
    comment_time: time,
    like_count: 0,
    reply_count: 1,
    truncated: false,
    firstSeenAt: time,
    lastSeenAt: time,
    updatedAt: time,
  };
  const reply: CommentDetail = {
    ...root,
    id: "stored-2",
    comment_id: "comment-2",
    parent_comment_id: "comment-1",
    comment_text: "测试回复",
    commenter_profile: null,
    comment_time: null,
    like_count: null,
    reply_count: 0,
    truncated: true,
  };
  let sourceState: CommentSourceState = "unconfigured";
  let synced = false;
  let allowFollowup = false;
  let contactEnabled = false;
  const keys: string[] = [];
  const fixture = await collectionFixture(page, (method, input) => {
    expect(input.workId).toBe(workId);
    expect(input.accountId).toBe(fixture.account.id);
    if (method === "comments/analyze" || method === "collection.contact") {
      expect(input.id).toBe(root.id);
      expect(allowFollowup).toBe(true);
      if (method === "comments/analyze")
        return {
          ok: true,
          data: {
            intent: "rent",
            evidence: "想租两居室",
            draft: "请问你想了解哪个区域的两居室？",
          },
        };
      if (!contactEnabled)
        return {
          ok: false,
          error: { status: 403, message: "当前联系授权不可用" },
        };
      return { ok: true, data: { profileUrl: root.commenter_profile } };
    }
    if (method === "comments/sync") {
      expect(sourceState).toBe("active");
      keys.push(String(input.requestKey));
      if (keys.length === 1)
        return { ok: false, error: { status: 503, message: "同步连接中断" } };
      synced = true;
      if (keys.length === 3) root.like_count = 7;
      return {
        ok: true,
        data: {
          readCount: 2,
          addedCount: keys.length === 2 ? 2 : 0,
          updatedCount: keys.length === 3 ? 1 : 0,
          coverage: "partial",
          syncedAt: time,
        },
      };
    }
    expect(method).toBe("comments/list");
    const available = sourceState === "active" && synced;
    if (input.cursor) expect(input.cursor).toBe("next-page");
    return {
      ok: true,
      data: {
        sourceState,
        canAnalyze: allowFollowup,
        canContact: allowFollowup,
        sourceLabel: "授权样例（测试）",
        coverage: available ? "partial" : "unknown",
        lastSyncedAt: available ? time : undefined,
        items: available ? [input.cursor ? reply : root] : [],
        nextCursor: available && !input.cursor ? "next-page" : undefined,
      },
    };
  });
  fixture.videos.push({
    id: workId,
    title: "评论测试作品",
    targetUrl: "https://www.douyin.com/video/" + workId,
    author: {
      name: "受控作者",
      url: "https://www.douyin.com/user/test-author",
    },
    accountId: fixture.account.id,
    deviceId: fixture.account.deviceId,
    lastRunId: "test-run",
    lastObservedAt: time,
    panelStatus: "visible",
  });
  await page.goto("/#/leads");
  await page.getByRole("tab", { name: "已核验作品" }).click();
  await page
    .getByRole("row")
    .filter({ hasText: workId })
    .getByRole("button", { name: "评论明细" })
    .click();
  const dialog = page.getByRole("dialog");
  const sync = dialog.getByRole("button", { name: "同步评论" });
  const refresh = dialog.getByRole("button", { name: "刷新记录" });
  await expect(dialog).toContainText("作品 ID 23456 · 受控作者");
  await expect(dialog).toContainText("上次观察评论区：可见");
  await expect(dialog).toContainText("尚未接入这条作品的获准评论来源");
  await expect(sync).toHaveCount(0);
  sourceState = "active";
  await refresh.click();
  await expect(dialog).toContainText("尚未同步评论");
  await sync.click();
  await expect(dialog).toContainText("同步连接中断");
  await sync.click();
  await expect(dialog).toContainText("最近同步仅覆盖部分评论");
  expect(keys).toHaveLength(2);
  expect(keys[0]).toEqual(keys[1]);
  const main = dialog.getByRole("row").filter({ hasText: "测试主评论" });
  await expect(
    main.getByRole("cell", { name: "0", exact: true }),
  ).toBeVisible();
  await main.getByRole("button").click();
  await expect(
    dialog.getByText(root.commenter_profile!, { exact: true }),
  ).toBeVisible();
  await expect(dialog).toContainText("最近变更");
  await expect(
    dialog.getByRole("button", { name: "AI 分析意图" }),
  ).toBeDisabled();
  await expect(dialog).toContainText("来源未授权人工联系");
  allowFollowup = true;
  await refresh.click();
  const analyze = dialog.getByRole("button", { name: "AI 分析意图" });
  await analyze.click();
  await expect(dialog).toContainText("评论意图 · 租房");
  await expect(dialog).toContainText("原文依据：想租两居室");
  const draft = dialog.getByRole("textbox", { name: "私信草稿" });
  await draft.fill("修改后的测试草稿");
  await dialog.getByRole("button", { name: "复制草稿" }).click();
  expect(await page.evaluate(() => sessionStorage.getItem("test-copy"))).toBe(
    "修改后的测试草稿",
  );
  const open = dialog.getByRole("button", { name: "打开主页 · 人工私信" });
  await open.click();
  await expect(dialog).toContainText("当前联系授权不可用");
  await dialog.getByRole("button", { name: "加载更多评论" }).click();
  const child = dialog.getByRole("row").filter({ hasText: "测试回复" });
  await expect(child).toContainText("回复 同名测试用户 · comment-1");
  await expect(child).toContainText("正文已截断");
  await expect(
    child.getByRole("cell", { name: "未知", exact: true }),
  ).toBeVisible();
  await expect(
    child.getByRole("cell", { name: "0", exact: true }),
  ).toBeVisible();
  await child.getByRole("button").click();
  await expect(dialog.getByText("comment-2", { exact: true })).toBeVisible();
  await expect(dialog).toContainText("评论正文已截断，无法分析完整意图。");
  await expect(dialog).toContainText("该评论未提供公开主页。");
  await sync.click();
  await expect(
    main.getByRole("cell", { name: "7", exact: true }),
  ).toBeVisible();
  expect(keys).toHaveLength(3);
  expect(keys[2]).not.toEqual(keys[1]);
  await page.reload();
  await expect(dialog).toContainText("作品 ID 23456 · 受控作者");
  await expect(
    main.getByRole("cell", { name: "7", exact: true }),
  ).toBeVisible();
  await main.getByRole("button").click();
  contactEnabled = true;
  await open.click();
  await expect(dialog).toHaveCount(0);
  const workspace = page.getByRole("region", { name: "抖音账号浏览器" });
  await expect(workspace).toContainText(root.commenter_profile!);
  await workspace.getByRole("button", { name: "返回工作台" }).click();
  await page
    .getByRole("row")
    .filter({ hasText: workId })
    .getByRole("button", { name: "评论明细" })
    .click();
  sourceState = "revoked";
  await refresh.click();
  await expect(dialog).toContainText("评论授权已撤回");
  await expect(main).toHaveCount(0);
  await expect(sync).toHaveCount(0);
});
