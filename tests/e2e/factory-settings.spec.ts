import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createInitialWorkspace } from "../../packages/api-client/src/fixtures";

async function fixture(page: Page, large = false, miniMax = false) {
  const catalog = JSON.parse(
    readFileSync("services/cloud/video_templates.json", "utf8"),
  );
  await page.addInitScript(
    ({ workspace, catalog, large, miniMax }) => {
      const property = {
        id: "panorama-cc0-sample",
        propertyNumber: "TEST-PANORAMA-001",
        title: "内置测试房源 · 全景素材",
        community: "内置全景测试样例",
        city: "测试素材",
        district: "独立场景",
        priceCents: 0,
        areaSqm: 0,
        layout: "",
        description: "两个独立 CC0 场景，不代表同一套或真实在售房源。",
        sellingPoints: [],
        image: "/media/panoramas/lebombo.jpg",
        images: [
          "/media/panoramas/lebombo.jpg",
          "/media/panoramas/hotel_room.jpg",
        ],
        videoCount: 0,
        importStatus: "ready" as const,
        lastVerifiedAt: "",
        sample: true,
      };
      workspace.properties = [
        property,
        {
          ...property,
          id: "user-property",
          title: "本人房源联调测试",
          sample: false,
        },
      ];
      if (miniMax) {
        const source = catalog[0];
        catalog.push({
          ...source,
          id: "minimax-tour",
          name: "MiniMax 地点带看",
          production: {
            ...source.production,
            config: { ...source.production.config, videoMode: "avatar" },
            opening: { prompt: "自然中景", location: { source: "property" } },
          },
        });
      }
      if (large) {
        const first = workspace.properties[1];
        workspace.properties = Array.from({ length: 1000 }, (_, i) => ({
          ...first,
          id: "batch-property-" + i,
          title: "测试房源 " + (i + 1),
          propertyNumber: "SH" + (100 + i),
        }));
        const template = catalog[0];
        catalog.push(
          ...Array.from({ length: 100 - catalog.length }, (_, i) => ({
            ...template,
            id: "test-template-" + i,
            name: "测试模板 " + (i + 1),
          })),
        );
      }
      const state = {
        workspace,
        catalog,
        publicVoices: [
          { id: "public-zh", name: "公共讲解音色", language: "zh-CN" },
        ],
        calls: [] as { method: string; input: any }[],
        rows: [] as any[],
        batches: [] as { id: string; createdAt: string; count: number }[],
        openingClip: undefined as
          { id: string; name: string; duration: number } | undefined,
        openingPhoto: undefined as { id: string; name: string } | undefined,
      };
      Object.assign(window, {
        factorySettingsTest: state,
        desktop: {
          platform: "win32",
          mode: "test",
          request: async (method: string, args: any[] = []) => {
            if (method === "session")
              return {
                userId: "test-owner",
                sessionId: "test-session",
                name: "联调测试",
                email: "fixture@example.test",
                role: "user",
              };
            if (method === "getWorkspace")
              return structuredClone(state.workspace);
            if (method === "voice.list")
              return {
                voices: [],
                publicVoices: state.publicVoices,
                cloneEnabled: false,
                cloudEnabled: true,
              };
            if (method === "panorama.capabilities")
              return {
                templates: state.catalog.map((t: any) => ({
                  ...t,
                  opening: t.production.config.openingTemplate,
                  scene: t.production.config.sceneTemplate,
                  closing: t.production.config.closingTemplate,
                })),
                defaultConfig: {
                  templateId: "standard-tour",
                  ttsProvider: "volcengine",
                  voice: "",

                  scriptProvider: "template",
                  ...catalog[0].production.config,
                },
                ffmpeg: true,
                ffprobe: true,
                managedVoices: true,
                volcTts: true,
                ai: false,
                imageExpansion: true,
                beike: false,
                voices: [],
              };
            if (method === "panorama.state")
              return {
                drafts: [],
                jobs: [],
                properties: [],
                templates: [],
                imageTasks: [],
              };
            if (method === "panorama.source-restore") return { scenes: [] };
            state.calls.push({ method, input: args[0] });
            if (method === "beikeCli.status")
              return {
                available: false,
                configured: true,
                reason: "contract_unverified",
              };
            if (method === "updateFactoryPreferences") {
              const input = args[0];
              Object.assign(state.workspace.profile.defaults, {
                videoTemplate: {
                  id: input.templateId,
                  version: input.templateVersion,
                },
                voiceId: input.voiceId,
              });
              return state.workspace.profile.defaults;
            }
            const input = args[0] || {};
            if (method === "panorama.opening-clip-import") {
              state.openingClip = {
                id: "a".repeat(64),
                name: "开门参考.mp4",
                duration: 3,
              };
              return state.openingClip;
            }
            if (method === "panorama.opening-photo-import") {
              state.openingPhoto = { id: "b".repeat(64), name: "经纪人.jpg" };
              return state.openingPhoto;
            }
            if (method === "panorama.factory-catalog")
              return {
                templates: state.catalog.map((t: any) => ({
                  ...t,
                  config: t.production.config,
                  opening: t.production.opening ? "minimax" : undefined,
                })),
                ffmpeg: true,
                ffprobe: true,
                managedVoices: true,
                minimaxOpening: true,
                openingClip: state.openingClip,
                openingPhoto: state.openingPhoto,
                voices: [],
              };
            if (method === "panorama.factory-properties") {
              const matched = state.workspace.properties.filter(
                (p) =>
                  (!input.search || p.title.includes(input.search)) &&
                  (!input.selectedIds || input.selectedIds.includes(p.id)),
              );
              if (input.all)
                return {
                  rows: matched.map(({ id, title }) => ({ id, title })),
                };
              const offset = ((input.page || 1) - 1) * 20;
              return {
                rows: matched.slice(offset, offset + 20),
                total: matched.length,
                page: input.page || 1,
                districts: ["独立场景"],
                defaults: state.workspace.profile.defaults,
              };
            }
            if (method === "panorama.factory-list") {
              const rows = state.rows.filter(
                (row) => !input.status || row.phase === input.status,
              );
              return {
                rows,
                total: rows.length,
                page: 1,
                batches: state.batches,
                paused: false,
                interrupted: 0,
                focused: state.rows.find((row) => row.id === input.focusId),
                counts: {
                  all: state.rows.length,
                  queued: state.rows.filter((row) => row.phase === "queued")
                    .length,
                  review: state.rows.filter((row) => row.phase === "review")
                    .length,
                },
                nextReviewId: rows.find(
                  (row) => row.phase === "review" && row.id !== input.afterId,
                )?.id,
              };
            }
            if (method === "panorama.factory-create") {
              state.rows = input.pairs.map((pair: any, i: number) => {
                const p = state.workspace.properties.find(
                  (item) => item.id === pair.propertyId,
                )!;
                const t = state.catalog.find(
                  (item: any) => item.id === pair.templateId,
                );
                const id = "review-" + i;
                const openingLocations = t.production.opening && [
                  {
                    asset: "a".repeat(64) + ".jpg",
                    label: "小区入口",
                    url: "/media/panoramas/lebombo.jpg",
                  },
                  {
                    asset: "c".repeat(64) + ".jpg",
                    label: "花园",
                    url: "/media/panoramas/hotel_room.jpg",
                  },
                ];
                const config = {
                  ...t.production.config,
                  voice: state.workspace.profile.defaults.voiceId,
                  openingPhoto: t.production.opening
                    ? input.openingPhoto
                    : undefined,
                  openingLocation: openingLocations && {
                    source: "property",
                    asset: openingLocations[0].asset,
                  },
                };
                const draft = {
                  id,
                  property: p,
                  revision: 1,
                  config,
                  scenes: [],
                  segments: [
                    {
                      id: "opening",
                      kind: "opening",
                      text: "请确认这条房源文案。",
                    },
                  ],
                };
                return {
                  id,
                  revision: 1,
                  propertyTitle: p.title,
                  propertyNumber: p.propertyNumber,
                  templateName: t.name,
                  templateVersion: t.version,
                  phase: "review",
                  createdAt: new Date().toISOString(),
                  progress: 0,
                  config,
                  draft,
                  openingLocations,
                  openingLocationUrl: openingLocations?.[0].url,
                };
              });
              state.batches = [
                {
                  id: input.requestId,
                  createdAt: new Date().toISOString(),
                  count: state.rows.length,
                },
              ];
              return { batchId: input.requestId, issues: [] };
            }
            if (method === "panorama.factory-opening-location") {
              const row = state.rows.find((item) => item.id === input.id);
              row.draft.config.openingLocation.asset = input.asset;
              row.openingLocationUrl = row.openingLocations.find(
                (item: { asset: string }) => item.asset === input.asset,
              ).url;
              row.draft.revision = ++row.revision;
              return null;
            }
            if (method === "panorama.factory-detail")
              return state.rows.find((row) => row.id === input.id);
            if (method === "panorama.factory-act")
              return input.rows.map(({ id }: { id: string }) => {
                state.rows.find((row) => row.id === id).phase = "queued";
                return { id, ok: true };
              });
            if (method === "panorama.save") {
              const row = state.rows.find((item) => item.id === input.id);
              row.revision++;
              row.draft = {
                ...row.draft,
                revision: row.revision,
                segments: input.segments,
              };
              return row.draft;
            }
            throw new Error("Unexpected fixture method " + method);
          },
        },
      });
    },
    { workspace: createInitialWorkspace(), catalog, large, miniMax },
  );
}

async function choose(page: Page, label: string, option: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page
    .locator(".ant-select-dropdown")
    .getByText(option, { exact: true })
    .click();
}

test("MiniMax 模板要求经纪人授权，审核页可更换地点图", async ({ page }) => {
  await fixture(page, false, true);
  await page.goto("/#/studio/create");
  await page.getByRole("button", { name: "选择视频模板", exact: true }).click();
  await page
    .getByRole("checkbox", {
      name: "选择MiniMax 地点带看 · 1.0.0",
      exact: true,
    })
    .check();
  await page.getByRole("button", { name: "确认选择（1）" }).click();
  await page.getByRole("button", { name: "选择房源", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "选择本人房源联调测试", exact: true })
    .check();
  await page.getByRole("button", { name: "确认选择（1）" }).click();
  const create = page.getByRole("button", { name: "生成 1 条文案" });
  await expect(create).toBeDisabled();
  await expect(page.getByRole("button", { name: "选择参考视频" })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "选择经纪人照片" }).click();
  await expect(create).toBeDisabled();
  await page
    .getByRole("checkbox", {
      name: "我确认已获得经纪人照片和开场素材的使用授权",
    })
    .check();
  await expect(create).toBeEnabled();
  await create.click();
  await expect(
    page.getByRole("button", { name: "审核", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "审核", exact: true }).click();
  await expect(
    page.getByRole("img", { name: "开场地点图", exact: true }),
  ).toHaveAttribute("src", /lebombo/);
  await choose(page, "更换开场地点图", "2 · 花园");
  await expect(
    page.getByRole("img", { name: "开场地点图", exact: true }),
  ).toHaveAttribute("src", /hotel_room/);
  const calls = await page.evaluate(
    () => (window as any).factorySettingsTest.calls,
  );
  expect(
    calls.find((call: any) => call.method === "panorama.factory-create").input,
  ).toMatchObject({
    openingPhoto: "b".repeat(64),
    openingAuthorized: true,
    openingRecipe: true,
  });
  expect(
    calls.find((call: any) => call.method === "panorama.factory-create").input
      .openingClip,
  ).toBeUndefined();
  expect(
    calls.find(
      (call: any) => call.method === "panorama.factory-opening-location",
    ).input,
  ).toMatchObject({
    revision: 1,
    asset: "c".repeat(64) + ".jpg",
  });
});

test("内置房源没有核验日期时仍可查看素材", async ({ page }) => {
  await fixture(page);
  await page.goto("/#/properties/panorama-cc0-sample");
  await expect(page.getByText("资料核验 未提供")).toBeVisible();
  await page.getByRole("tab", { name: "制作素材", exact: true }).click();
  await expect(page.getByRole("heading", { name: "房源素材" })).toBeVisible();
});

test("正式房源导入显示贝壳联调状态并可切换到手动添加", async ({ page }) => {
  await fixture(page);
  await page.goto("/#/properties?import=1");
  const dialog = page.getByRole("dialog", { name: "导入房源", exact: true });
  await expect(
    dialog.getByText("贝壳 CLI 已配置，房源返回格式仍待联调验证。"),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "开始模拟导入" }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "手动添加房源" }).click();
  await expect(
    page.getByRole("dialog", { name: "手动添加房源", exact: true }),
  ).toBeVisible();
});

test("设置读取后台模板和公共音色，保存后新视频使用相同默认值", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/#/settings/defaults");
  await expect(
    page.getByRole("combobox", { name: "默认视频模板", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "提示词模板", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("生成文案后需要人工审核", { exact: true }),
  ).toHaveCount(0);
  await choose(page, "默认视频模板", "标准房源带看 · 1.0.0");
  await choose(page, "默认音色", "公共讲解音色 · 公共音色");
  await page.getByRole("button", { name: "保存默认配置", exact: true }).click();
  await expect(
    page.getByText("默认制作配置已保存，新视频将使用这些偏好", { exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: /^AI 视频工厂/ }).click();
  await page.getByRole("tab", { name: "新建视频", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "AI 视频工厂", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "模板 1 个", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "选择房源", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "选择本人房源联调测试", exact: true })
    .check();
  await page.getByRole("button", { name: "确认选择（1）" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).factorySettingsTest.rows.length),
    )
    .toBe(0);
  await page.getByRole("button", { name: "生成 1 条文案" }).click();
  await page.getByRole("button", { name: "审核", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "开场介绍", exact: true }),
  ).toBeVisible();
  const calls = await page.evaluate(
    () => (window as any).factorySettingsTest.calls,
  );
  expect(
    calls.find((c: any) => c.method === "updateFactoryPreferences").input,
  ).toEqual({
    templateId: "standard-tour",
    templateVersion: "1.0.0",
    voiceId: "public-zh",
  });
  expect(
    calls.find((c: any) => c.method === "panorama.factory-create").input,
  ).toMatchObject({
    pairs: [
      {
        propertyId: "user-property",
        templateId: "standard-tour",
        version: "1.0.0",
      },
    ],
  });
  await page.screenshot({
    path: "output/template-verification/settings-to-factory.png",
    fullPage: true,
    animations: "disabled",
  });
});

test("后台下架模板和音色后可刷新看到失效偏好，正式设置不显示演示重置", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/#/settings/defaults");
  await choose(page, "默认视频模板", "标准房源带看 · 1.0.0");
  await choose(page, "默认音色", "公共讲解音色 · 公共音色");
  await page.getByRole("button", { name: "保存默认配置", exact: true }).click();
  await expect(
    page.getByText("默认制作配置已保存，新视频将使用这些偏好", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    (window as any).factorySettingsTest.catalog = [];
    (window as any).factorySettingsTest.publicVoices = [];
  });
  await page
    .getByRole("button", { name: "刷新管理员配置", exact: true })
    .click();
  await expect(
    page.getByText("部分旧偏好已失效", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "保存默认配置", exact: true }).click();
  await expect(
    page.getByText("默认模板已下架，请重新选择或清空", { exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "本地存储", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "重置演示数据", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText(
      "账号资料与创作偏好保存在业务服务；制作素材、文案、配音和成片保存在本机，并按登录账号隔离。",
      { exact: true },
    ),
  ).toBeVisible();
});

test("批量选择跨页保留，审核弹窗支持连续处理和调整窗口", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await fixture(page, true);
  await page.goto("/#/studio/create");
  await expect(
    page.getByRole("button", { name: "选择房源", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "选择房源", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "选择房源" });
  await expect(picker.getByText("符合条件 1000 项")).toBeVisible();
  await picker.getByRole("checkbox", { name: "全选本页" }).check();
  await picker.getByText("2", { exact: true }).click();
  await picker
    .getByRole("checkbox", { name: "选择测试房源 21", exact: true })
    .check();
  await picker.getByRole("button", { name: "确认选择（21）" }).click();
  await page.getByRole("button", { name: "选择视频模板", exact: true }).click();
  const templates = page.getByRole("dialog", { name: "选择视频模板" });
  await expect(templates.getByText("符合条件 100 项")).toBeVisible();
  await templates
    .getByRole("textbox", { name: "搜索模板" })
    .fill("标准房源带看");
  await templates
    .getByRole("checkbox", { name: "选择标准房源带看 · 1.0.0", exact: true })
    .check();
  await templates.getByRole("button", { name: "确认选择（1）" }).click();
  await page.getByRole("button", { name: "生成 21 条文案" }).click();
  await expect(
    page.getByRole("button", { name: "审核", exact: true }),
  ).toHaveCount(21);
  const taskTable = page.locator(".factory-task-table .ant-table-body");
  const visibleRows = await taskTable.evaluate((table) => {
    const bounds = table.getBoundingClientRect();
    return [...table.querySelectorAll(".ant-table-row")].filter((row) => {
      const rect = row.getBoundingClientRect();
      return (
        rect.top >= bounds.top &&
        rect.bottom <= Math.min(bounds.bottom, window.innerHeight)
      );
    }).length;
  });
  expect(visibleRows).toBeGreaterThanOrEqual(8);
  await page.getByRole("button", { name: "审核", exact: true }).first().click();
  const detail = page.getByRole("dialog", { name: "审核文案" });
  await detail
    .getByRole("textbox", { name: "开场介绍" })
    .fill("已审核的第一条文案。");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "返回编辑", exact: true }).click();
  await expect(detail.getByRole("textbox", { name: "开场介绍" })).toHaveValue(
    "已审核的第一条文案。",
  );
  await detail.getByRole("button", { name: "确认并下一条" }).click();
  await expect(
    detail.getByRole("heading", { name: "测试房源 2", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "审核", exact: true }),
  ).toHaveCount(20);
  await page.screenshot({
    path: "output/template-verification/factory-1280.png",
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(
    detail.getByRole("heading", { name: "测试房源 2", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".factory-detail-pane")).toHaveCount(0);
  await page.screenshot({
    path: "output/template-verification/factory-1440.png",
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await expect(detail).toBeHidden();
  await expect(
    page
      .getByRole("row")
      .filter({
        has: page.getByRole("button", { name: "测试房源 1", exact: true }),
      })
      .getByRole("button", { name: "详情" }),
  ).toBeFocused();
});

test("任务和创建分开，切换保留批次选择，房源链接直接打开创建", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/#/studio");
  await expect(
    page.getByRole("tab", { name: "制作任务", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("button", { name: "选择房源", exact: true }),
  ).toBeHidden();
  await page.screenshot({
    path: ".impeccable/review/studio-tasks-1440.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("tab", { name: "新建视频", exact: true }).click();
  await page.getByRole("button", { name: "选择房源", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "选择本人房源联调测试", exact: true })
    .check();
  await page.getByRole("button", { name: "确认选择（1）" }).click();
  await page.getByRole("tab", { name: "制作任务", exact: true }).click();
  await page.getByRole("tab", { name: "新建视频", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "房源 1 套", exact: true }),
  ).toBeVisible();
  for (const width of [1440, 1280, 600]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({
      path: `.impeccable/review/studio-create-${width}.png`,
      fullPage: true,
      animations: "disabled",
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
  }
  await page.goto("/#/studio/create?propertyId=user-property");
  await expect(
    page.getByRole("tab", { name: "新建视频", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("button", { name: "房源 1 套", exact: true }),
  ).toBeVisible();
});
