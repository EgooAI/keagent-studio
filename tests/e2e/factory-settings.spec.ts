import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createInitialWorkspace } from "../../packages/api-client/src/fixtures";
import type { BeikeSearchResult } from "../../packages/shared-types/src/beike";

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
          details: { vrUrl: "https://realsee.cn/example" },
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
        aiConfigured: false,
        beikeResult: undefined as BeikeSearchResult | undefined,
        failNextPropertyNumber: "",
        spatialImports: new Set<string>(),
        publicVoices: [
          { id: "public-zh", name: "公共讲解音色", language: "zh-CN" },
        ],
        calls: [] as { method: string; input: any }[],
        rows: [] as any[],
        batches: [] as { id: string; createdAt: string; count: number }[],
        openingClip: undefined as
          { id: string; name: string; duration: number } | undefined,
        openingPhoto: undefined as { id: string; name: string } | undefined,
        openingBackground: undefined as
          { id: string; name: string; asset: string } | undefined,
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
                ai: state.aiConfigured,
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
            if (method === "panorama.source-restore")
              return {
                scenes: state.spatialImports.has(args[0]?.propertyId)
                  ? [
                      {
                        id: "vr-0",
                        room: "VR 客厅",
                        url: "/media/interior-1.jpg",
                      },
                    ]
                  : [],
              };
            state.calls.push({ method, input: args[0] });
            if (method === "beikeCli.status")
              return {
                available: !!state.beikeResult,
                configured: !!state.beikeResult,
                reason: state.beikeResult ? "ready" : "not_configured",
              };
            if (method === "beikeCli.search") return state.beikeResult;
            const input = args[0] || {};
            if (method === "createProperty") {
              if (
                state.failNextPropertyNumber &&
                input.propertyNumber === state.failNextPropertyNumber
              ) {
                state.failNextPropertyNumber = "";
                throw new Error("模拟保存失败");
              }
              const saved = {
                ...property,
                ...input,
                id: state.beikeResult
                  ? "beike-" + input.propertyNumber
                  : "new-property",
                sample: false,
              };
              workspace.properties.push(saved);
              return structuredClone(saved);
            }
            if (method === "updateProperty") {
              const saved = workspace.properties.find((p) => p.id === args[0])!;
              return structuredClone(Object.assign(saved, args[1]));
            }
            if (method === "panorama.property-vr-import") {
              const saved = workspace.properties.find(
                (p) => p.id === input.propertyId,
              );
              if (!saved?.details?.vrUrl?.startsWith("https://realsee.cn/"))
                throw new Error("不支持的 VR 链接");
              state.spatialImports.add(input.propertyId);
              return { count: 1 };
            }
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
            if (method === "panorama.opening-background-import") {
              state.openingBackground = {
                id: "d".repeat(64),
                name: "小区入口.jpg",
                asset: "d".repeat(64) + ".jpg",
              };
              return state.openingBackground;
            }
            if (method === "panorama.opening-materials")
              return {
                photo: state.openingPhoto && {
                  ...state.openingPhoto,
                  url: "/media/interior-1.jpg",
                },
                background: state.openingBackground && {
                  ...state.openingBackground,
                  url: "/media/interior-2.jpg",
                },
              };
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
                openingBackground: state.openingBackground,
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
            if (method === "panorama.factory-materials") {
              if ((state as any).materialError)
                throw new Error("素材读取失败，请重试");
              return {
                scenes: Array.from(
                  { length: (state as any).materialCount ?? 2 },
                  (_, i) => ({
                    id: `${input.propertyId}-scene-${i + 1}`,
                    room: `空间 ${i + 1}`,
                    url:
                      i % 2
                        ? "/media/panoramas/hotel_room.jpg"
                        : "/media/panoramas/lebombo.jpg",
                  }),
                ),
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
                  ...input.renderOverrides,
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
                  templateSnapshot: structuredClone(t),
                  scenes: miniMax
                    ? [
                        {
                          id: "room-1",
                          room: "客厅",
                          yaw: 0,
                          direction: 1,
                          url: "/media/interior-1.jpg",
                          ...(config.cameraMode === "spatial" && {
                            spatial: {
                              workId: "fixture-work",
                              panoIndex: 0,
                              targetPanoIndex: 1,
                              targets: [
                                { index: 1, label: "餐厅" },
                                { index: 2, label: "走廊" },
                              ],
                            },
                          }),
                        },
                      ]
                    : [],
                  segments: [
                    {
                      id: "opening",
                      kind: "opening",
                      sceneId: miniMax ? "room-1" : undefined,
                      text: "请确认这条房源文案。",
                    },
                    ...(miniMax
                      ? [
                          {
                            id: "room-1",
                            kind: "scene",
                            sceneId: "room-1",
                            text: "这里是客厅。",
                          },
                        ]
                      : []),
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
                config: input.config,
                segments: input.segments,
                scenes: input.scenes || row.draft.scenes,
              };
              row.config = row.draft.config;
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

async function selectTemplates(page: Page, names: string[]) {
  await page.getByRole("button", { name: "选择视频模板", exact: true }).click();
  for (const name of names)
    await page
      .getByRole("checkbox", { name: "选择" + name, exact: true })
      .check();
  await page
    .getByRole("button", { name: `确认选择（${names.length}）`, exact: true })
    .click();
}

async function chooseImages(page: Page, count = 1) {
  await page.getByRole("button", { name: "选择视频图片", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "选择视频图片",
    exact: true,
  });
  for (let i = 0; i < count; i++) {
    await dialog.getByRole("button", { name: "选择全部", exact: true }).click();
    if (i < count - 1)
      await dialog.getByRole("button", { name: "下一套房源" }).click();
  }
  await dialog.getByRole("button", { name: "确认选图", exact: true }).click();
}

test("选图限制为 2–7 张，支持预览、重选、失败重试和窄窗口", async ({
  page,
}, testInfo) => {
  await fixture(page);
  await page.goto("/#/studio/create?propertyId=user-property");
  await page.evaluate(() => {
    (window as any).factorySettingsTest.materialCount = 14;
  });
  await page.getByRole("button", { name: "选择视频模板", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "选择标准房源带看 · 1.0.0", exact: true })
    .check();
  await page.getByRole("button", { name: "确认选择（1）" }).click();
  const create = page.getByRole("button", { name: "生成 1 条文案" });
  await expect(create).toBeDisabled();
  await page.getByRole("button", { name: "选择视频图片", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "选择视频图片",
    exact: true,
  });
  const confirm = dialog.getByRole("button", { name: "确认选图", exact: true });
  await expect(dialog.getByRole("checkbox")).toHaveCount(14);
  await expect(
    dialog.getByRole("button", { name: "选择全部", exact: true }),
  ).toBeDisabled();
  await expect(confirm).toBeDisabled();
  await dialog
    .getByRole("checkbox", { name: "1. 空间 1", exact: true })
    .check();
  await expect(confirm).toBeDisabled();
  for (let i = 2; i <= 7; i++)
    await dialog
      .getByRole("checkbox", { name: `${i}. 空间 ${i}`, exact: true })
      .check();
  await expect(confirm).toBeEnabled();
  await expect(
    dialog.getByRole("checkbox", { name: "8. 空间 8", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("img", { name: "空间 1", exact: true }).click();
  await expect(page.locator(".ant-image-preview")).toBeVisible();
  await page.keyboard.press("Escape");
  for (const width of [1440, 600]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: testInfo.outputPath(`image-selection-${width}.png`),
      animations: "disabled",
    });
  }
  await confirm.click();
  await expect(create).toBeEnabled();
  await page.getByRole("button", { name: "选择视频图片", exact: true }).click();
  await expect(dialog.getByRole("checkbox", { checked: true })).toHaveCount(7);
  await dialog
    .getByRole("checkbox", { name: "1. 空间 1", exact: true })
    .uncheck();
  await dialog
    .getByRole("checkbox", { name: "8. 空间 8", exact: true })
    .check();
  await confirm.click();
  await create.click();
  const input = await page.evaluate(
    () =>
      (window as any).factorySettingsTest.calls.find(
        (c: any) => c.method === "panorama.factory-create",
      ).input,
  );
  expect(input.sceneIdsByProperty["user-property"]).toEqual(
    Array.from({ length: 7 }, (_, i) => `user-property-scene-${i + 2}`),
  );
});

test("素材不足或读取失败时不能确认选图", async ({ page }) => {
  await fixture(page);
  await page.goto("/#/studio/create?propertyId=user-property");
  await page.getByRole("button", { name: "选择视频模板", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "选择标准房源带看 · 1.0.0", exact: true })
    .check();
  await page.getByRole("button", { name: "确认选择（1）" }).click();
  await page.evaluate(() => {
    Object.assign((window as any).factorySettingsTest, {
      materialError: true,
      materialCount: 1,
    });
  });
  await page.getByRole("button", { name: "选择视频图片", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "选择视频图片",
    exact: true,
  });
  await expect(dialog.getByRole("button", { name: /重\s*试/ })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "确认选图" })).toBeDisabled();
  await page.evaluate(() => {
    (window as any).factorySettingsTest.materialError = false;
  });
  await dialog.getByRole("button", { name: /重\s*试/ }).click();
  await expect(
    dialog.getByText("至少需要 2 张全景图，请先补充素材。", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("checkbox").check();
  await expect(dialog.getByRole("button", { name: "确认选图" })).toBeDisabled();
  await dialog.getByRole("button", { name: /取\s*消/, exact: true }).click();
  await expect(
    page.getByRole("button", { name: "生成 1 条文案" }),
  ).toBeDisabled();
});

test("MiniMax 模板要求经纪人授权，审核页可更换地点图和镜头角度", async ({
  page,
}) => {
  await fixture(page, false, true);
  await page.goto("/#/settings/appearance");
  await expect(page.getByRole("heading", { name: "形象与背景" })).toBeVisible();
  await page
    .getByRole("button", { name: "上传经纪人照片", exact: true })
    .click();
  await expect(
    page.getByRole("img", { name: "经纪人照片", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "上传开场背景图", exact: true })
    .click();
  await expect(
    page.getByRole("img", { name: "开场背景图", exact: true }),
  ).toBeVisible();
  for (const width of [1440, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({
      path: test.info().outputPath("opening-materials-" + width + ".png"),
    });
  }
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
  await expect(
    page.getByRole("link", { name: "设置经纪人照片与背景" }),
  ).toHaveAttribute("href", "#/settings/appearance");
  await expect(create).toBeDisabled();
  await page
    .getByRole("checkbox", {
      name: "我确认已获得经纪人照片和开场素材的使用授权",
    })
    .check();
  await chooseImages(page);
  await expect(create).toBeEnabled();
  await create.click();
  await expect(
    page.getByRole("button", { name: "审核", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "审核", exact: true }).click();
  await expect(
    page.getByRole("img", { name: "开场地点图", exact: true }),
  ).toHaveAttribute("src", /lebombo/);
  const openingRow = page.locator(".factory-review-segment").filter({
    has: page.getByRole("textbox", { name: "开场介绍", exact: true }),
  });
  await expect(
    openingRow.getByRole("img", { name: "开场地点图", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "1 · 客厅", exact: true }),
  ).toHaveCount(1);
  const angle = page.getByRole("spinbutton", { name: "1 · 客厅镜头起始角度" });
  const save = page.getByRole("button", { name: "保存修改", exact: true });
  await expect(save).toBeDisabled();
  await angle.fill("150");
  await expect(save).toBeEnabled();
  await angle.fill("0");
  await expect(save).toBeDisabled();
  await angle.fill("150");
  await choose(page, "1 · 客厅镜头方向", "向左");
  await page
    .getByRole("textbox", { name: "开场介绍", exact: true })
    .fill(
      "今天我们来到了测试小区，带大家看看这套两居室，跟我一起进去了解一下。",
    );
  for (const width of [1440, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({
      path: test.info().outputPath("opening-review-" + width + ".png"),
    });
  }
  await choose(page, "更换开场地点图", "2 · 花园");
  await expect(
    page.getByRole("img", { name: "开场地点图", exact: true }),
  ).toHaveAttribute("src", /hotel_room/);
  await expect(angle).toHaveValue("150");
  const calls = await page.evaluate(
    () => (window as any).factorySettingsTest.calls,
  );
  expect(
    calls.find((call: any) => call.method === "panorama.factory-create").input,
  ).toMatchObject({
    openingPhoto: "b".repeat(64),
    openingBackground: "d".repeat(64),
    openingAuthorized: true,
    openingRecipe: true,
  });
  expect(
    calls.find((call: any) => call.method === "panorama.save").input.scenes,
  ).toEqual([
    expect.objectContaining({ id: "room-1", yaw: 150, direction: -1 }),
  ]);
  expect(
    calls.find((call: any) => call.method === "panorama.factory-create").input
      .openingClip,
  ).toBeUndefined();
  expect(
    calls.find(
      (call: any) => call.method === "panorama.factory-opening-location",
    ).input,
  ).toMatchObject({
    revision: 2,
    asset: "c".repeat(64) + ".jpg",
  });
});

test("短视频带看审核可单独保存两行开场封面标题", async ({ page }) => {
  await fixture(page);
  await page.goto("/#/studio/create?propertyId=user-property");
  await page.getByRole("button", { name: "选择视频模板", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "选择短视频带看 · 1.0.0", exact: true })
    .check();
  await page.getByRole("button", { name: "确认选择（1）" }).click();
  await chooseImages(page);
  await page.getByRole("button", { name: "生成 1 条文案" }).click();
  await page.getByRole("button", { name: "审核", exact: true }).click();
  const title = page.getByRole("textbox", {
    name: "开场／封面标题",
    exact: true,
  });
  const save = page.getByRole("button", { name: "保存修改", exact: true });
  await expect(save).toBeDisabled();
  const value = "崇文门西大街\n南北通透 · 低楼层";
  await title.fill(value);
  await expect(save).toBeEnabled();
  await save.click();
  await expect(save).toBeDisabled();
  await expect(title).toHaveValue(value);
  const input = await page.evaluate(
    () =>
      (window as any).factorySettingsTest.calls.find(
        (call: any) => call.method === "panorama.save",
      ).input,
  );
  expect(input.config.coverTitle).toBe(value);
  expect(input.segments[0].text).toBe("请确认这条房源文案。");
});

test("制作参数默认跟随模板，清空或越界不能生成，恢复后省略覆盖参数", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/#/studio/create?propertyId=user-property");
  await selectTemplates(page, ["短视频带看 · 1.1.0"]);
  await chooseImages(page);
  const speed = page.getByRole("spinbutton", {
    name: "批次镜头速度",
    exact: true,
  });
  const rate = page.getByRole("spinbutton", {
    name: "批次配音语速",
    exact: true,
  });
  const sweep = page.getByRole("spinbutton", {
    name: "批次最大转角",
    exact: true,
  });
  const create = page.getByRole("button", {
    name: "生成 1 条文案",
    exact: true,
  });
  await expect(speed).toHaveValue("36");
  await expect(rate).toHaveValue("1.1");
  await expect(sweep).toHaveValue("180");
  await speed.fill("46");
  await rate.focus();
  await expect(speed).toHaveValue("46");
  await expect(create).toBeDisabled();
  await speed.fill("");
  await expect(create).toBeDisabled();
  await page.getByRole("button", { name: "恢复模板值", exact: true }).click();
  await expect(speed).toHaveValue("36");
  await expect(create).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath("batch-pacing.png") });
  await create.click();
  const state = await page.evaluate(() => (window as any).factorySettingsTest);
  expect(
    state.calls.find((call: any) => call.method === "panorama.factory-create")
      .input,
  ).not.toHaveProperty("renderOverrides");
  expect(state.rows[0].draft.config).toMatchObject({
    speed: 36,
    rate: 1.1,
    maxSweep: 180,
  });
});

test("批次只覆盖改过的制作参数，多模板仍保留各自默认值", async ({ page }) => {
  await fixture(page);
  await page.goto("/#/studio/create?propertyId=user-property");
  await selectTemplates(page, ["标准房源带看 · 1.0.0", "短视频带看 · 1.1.0"]);
  await expect(
    page.getByText(
      "自定义值用于本批所有模板；未修改的项分别沿用各模板默认值。",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("spinbutton", { name: "批次镜头速度", exact: true }),
  ).toHaveValue("");
  await page
    .getByRole("spinbutton", { name: "批次配音语速", exact: true })
    .fill("1.3");
  await page.getByRole("tab", { name: "制作任务", exact: true }).click();
  await page.getByRole("tab", { name: "新建视频", exact: true }).click();
  await expect(
    page.getByRole("spinbutton", { name: "批次配音语速", exact: true }),
  ).toHaveValue("1.3");
  await chooseImages(page);
  await page
    .getByRole("button", { name: "生成 2 条文案", exact: true })
    .click();
  const state = await page.evaluate(() => (window as any).factorySettingsTest);
  expect(
    state.calls.find((call: any) => call.method === "panorama.factory-create")
      .input.renderOverrides,
  ).toEqual({ rate: 1.3 });
  expect(
    state.rows.map((row: any) => ({
      speed: row.draft.config.speed,
      rate: row.draft.config.rate,
      maxSweep: row.draft.config.maxSweep,
    })),
  ).toEqual([
    { speed: 4, rate: 1.3, maxSweep: 100 },
    { speed: 36, rate: 1.3, maxSweep: 180 },
  ]);
  expect(
    state.rows.map(
      (row: any) => row.draft.templateSnapshot.production.config.rate,
    ),
  ).toEqual([1, 1.1]);
});

test("审核制作参数支持保存、离开提醒、恢复模板与确认持久化", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/#/studio/create?propertyId=user-property");
  await selectTemplates(page, ["短视频带看 · 1.1.0"]);
  await page
    .getByRole("spinbutton", { name: "批次镜头速度", exact: true })
    .fill("20");
  await page
    .getByRole("spinbutton", { name: "批次配音语速", exact: true })
    .fill("1.4");
  await page
    .getByRole("spinbutton", { name: "批次最大转角", exact: true })
    .fill("120");
  await chooseImages(page);
  await page
    .getByRole("button", { name: "生成 1 条文案", exact: true })
    .click();
  await page.getByRole("button", { name: "审核", exact: true }).click();
  const speed = page.getByRole("spinbutton", {
    name: "任务镜头速度",
    exact: true,
  });
  const rate = page.getByRole("spinbutton", {
    name: "任务配音语速",
    exact: true,
  });
  const sweep = page.getByRole("spinbutton", {
    name: "任务最大转角",
    exact: true,
  });
  const save = page.getByRole("button", { name: "保存修改", exact: true });
  const confirm = page.getByRole("button", {
    name: "确认并下一条",
    exact: true,
  });
  await expect(speed).toHaveValue("20");
  await expect(rate).toHaveValue("1.4");
  await expect(sweep).toHaveValue("120");
  await expect(save).toBeDisabled();
  await rate.fill("");
  await expect(save).toBeDisabled();
  await expect(confirm).toBeDisabled();
  await rate.fill("1.5");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "任务修改尚未保存", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "返回编辑", exact: true }).click();
  await expect(rate).toHaveValue("1.5");
  await save.click();
  await expect(save).toBeDisabled();
  await expect(rate).toHaveValue("1.5");
  await page.getByRole("button", { name: "恢复模板值", exact: true }).click();
  await expect(speed).toHaveValue("36");
  await expect(rate).toHaveValue("1.1");
  await expect(sweep).toHaveValue("180");
  await page.screenshot({
    path: test.info().outputPath("task-pacing-review.png"),
  });
  await confirm.click();
  await page.getByRole("button", { name: "详情", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "当前任务详情", exact: true })
      .getByLabel("任务制作参数", { exact: true }),
  ).toHaveText("配音语速 1.1 倍 · 镜头速度 36°/秒 · 最大转角 180°");
  const state = await page.evaluate(() => (window as any).factorySettingsTest);
  expect(
    state.calls.find((call: any) => call.method === "panorama.factory-create")
      .input.renderOverrides,
  ).toEqual({ speed: 20, rate: 1.4, maxSweep: 120 });
  const saves = state.calls.filter(
    (call: any) => call.method === "panorama.save",
  );
  expect(saves[0].input.config).toMatchObject({
    speed: 20,
    rate: 1.5,
    maxSweep: 120,
  });
  expect(saves[1].input.config).toMatchObject({
    speed: 36,
    rate: 1.1,
    maxSweep: 180,
  });
  expect(
    state.calls.find((call: any) => call.method === "panorama.factory-act")
      .input,
  ).toMatchObject({
    action: "confirm",
    rows: [{ id: "review-0", revision: 3 }],
  });
  expect(state.rows[0].draft.templateSnapshot.production.config).toMatchObject({
    speed: 36,
    rate: 1.1,
    maxSweep: 180,
  });
});

test("空间走动审核可单独保存目标拍摄点并隐藏旋转方向", async ({ page }) => {
  await fixture(page, false, true);
  await page.goto("/#/settings/appearance");
  await page
    .getByRole("button", { name: "上传经纪人照片", exact: true })
    .click();
  await page.goto("/#/studio/create?propertyId=user-property");
  await page.getByRole("button", { name: "选择视频模板", exact: true }).click();
  await page
    .getByRole("checkbox", {
      name: "选择空间走动带看 · 经纪人开场 · 1.0.0",
      exact: true,
    })
    .check();
  await page.getByRole("button", { name: "确认选择（1）" }).click();
  await expect(
    page.getByRole("spinbutton", { name: "批次镜头速度", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("spinbutton", { name: "批次最大转角", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("spinbutton", { name: "批次配音语速", exact: true }),
  ).toHaveValue("1.1");
  await page
    .getByRole("checkbox", {
      name: "我确认已获得经纪人照片和开场素材的使用授权",
    })
    .check();
  await chooseImages(page);
  await page.getByRole("button", { name: "生成 1 条文案" }).click();
  await page.getByRole("button", { name: "审核", exact: true }).click();
  await expect(
    page.getByRole("spinbutton", { name: "任务镜头速度", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("spinbutton", { name: "任务最大转角", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("spinbutton", { name: "任务配音语速", exact: true }),
  ).toHaveValue("1.1");
  await expect(
    page.getByRole("combobox", { name: "1 · 客厅镜头方向" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("spinbutton", { name: "1 · 客厅镜头起始角度" }),
  ).toBeVisible();
  const save = page.getByRole("button", { name: "保存修改", exact: true });
  await expect(save).toBeDisabled();
  await choose(page, "1 · 客厅走向拍摄点", "走廊");
  await expect(save).toBeEnabled();
  await save.click();
  await expect(save).toBeDisabled();
  const input = await page.evaluate(
    () =>
      (window as any).factorySettingsTest.calls.find(
        (call: any) => call.method === "panorama.save",
      ).input,
  );
  expect(input.scenes[0]).toMatchObject({
    yaw: 0,
    direction: 1,
    spatial: { workId: "fixture-work", panoIndex: 0, targetPanoIndex: 2 },
  });
  expect(input.config.cameraMode).toBe("spatial");
});

test("内置房源没有核验日期时仍可查看素材", async ({ page }) => {
  await fixture(page);
  await page.goto("/#/properties/panorama-cc0-sample");
  await expect(page.getByText("资料核验 未提供")).toBeVisible();
  await page.getByRole("tab", { name: "制作素材", exact: true }).click();
  await expect(page.getByRole("heading", { name: "房源素材" })).toBeVisible();
});

test("房源制作素材可导入 VR 空间并刷新图库", async ({ page }) => {
  await fixture(page);
  await page.goto("/#/properties/user-property");
  await page.getByRole("tab", { name: "制作素材" }).click();
  await expect(
    page.getByRole("button", { name: "添加 VR 全景图" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "添加户型图／参考图" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "添加房源照片" })).toHaveCount(
    0,
  );
  await expect(page.getByText(/AI 扩图|生成 AI 扩图/)).toHaveCount(0);
  await page.getByRole("button", { name: "导入 VR 空间", exact: true }).click();
  await expect(
    page.getByRole("img", { name: "房源图片 1", exact: true }),
  ).toHaveAttribute("src", "/media/interior-1.jpg");
  await expect(page.getByText("1 张 VR 全景图", { exact: true })).toBeVisible();
  const request = await page.evaluate(() =>
    (window as any).factorySettingsTest.calls.find(
      (call: any) => call.method === "panorama.property-vr-import",
    ),
  );
  expect(request.input).toEqual({ propertyId: "user-property" });
});

test("保存新增或更换的 VR 链接自动导入对应房源", async ({ page }) => {
  await fixture(page);
  await page.goto("/#/properties");
  await page.getByRole("button", { name: "手动添加", exact: true }).click();
  const form = page.getByRole("dialog");
  for (const [label, value] of Object.entries({
    房源标题: "全景房源",
    房源号: "VR-123",
    小区名称: "全景小区",
    "总价（万元）": "200",
    "建筑面积（平方米）": "80",
    "VR 看房链接": "https://realsee.cn/first",
  }))
    await form.getByLabel(label, { exact: true }).fill(value);
  await form.getByRole("button", { name: "保存房源" }).click();
  await expect(page).toHaveURL(/properties\/new-property$/);
  await page.getByRole("tab", { name: "制作素材" }).click();
  await expect(page.getByText("1 张 VR 全景图", { exact: true })).toBeVisible();

  for (const [label, value] of [
    ["朝向", "南"],
    ["VR 看房链接", "https://realsee.cn/second"],
    ["VR 看房链接", "https://example.com/unsupported"],
    ["VR 看房链接", ""],
  ]) {
    await page.getByRole("button", { name: "编辑房源" }).click();
    await form.getByLabel(label, { exact: true }).fill(value);
    await form.getByRole("button", { name: "保存修改" }).click();
    await expect(form).toHaveCount(0);
    if (value.endsWith("unsupported"))
      await expect(page.getByText(/房源已保存，全景图导入失败/)).toBeVisible();
  }
  const imports = await page.evaluate(() =>
    (window as any).factorySettingsTest.calls
      .filter((c: any) => c.method === "panorama.property-vr-import")
      .map((c: any) => c.input.propertyId),
  );
  expect(imports).toEqual(["new-property", "new-property", "new-property"]);
  await expect(page.getByText("1 张 VR 全景图", { exact: true })).toBeVisible();
});

test("贝壳未配置时可从正式房源导入切换到手动添加", async ({ page }) => {
  await fixture(page);
  await page.goto("/#/properties?import=1");
  const dialog = page.getByRole("dialog", { name: "从贝壳找房", exact: true });
  await expect(dialog.getByRole("status")).toHaveText(
    "云端尚未配置贝壳 CLI，暂不能自动找房。",
  );
  await expect(
    dialog.getByRole("button", { name: "开始模拟导入" }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "手动添加房源" }).click();
  await expect(
    page.getByRole("dialog", { name: "手动添加房源", exact: true }),
  ).toBeVisible();
});

test("贝壳跨预算勾选按结果城市导入，重试仅提交失败房源", async ({ page }) => {
  await fixture(page);
  await page.goto("/#/properties");
  await page.evaluate(() => {
    const house = {
      id: "BJ-01",
      community: "望京西园",
      title: "两居",
      layout: "2室1厅",
      totalPriceWan: 480,
      unitPrice: 60000,
      areaSqm: 80,
      orientation: "南",
      district: "朝阳",
    };
    const beikeResult: BeikeSearchResult = {
      city: "北京市",
      query: "两居 500万以内",
      strictBudgetWan: 500,
      totalRecalled: 2,
      returned: 2,
      conditions: [],
      houses: [house],
      overBudget: [
        { ...house, id: "BJ-02", community: "望京新城", totalPriceWan: 520 },
      ],
    };
    Object.assign((window as any).factorySettingsTest, {
      beikeResult,
      failNextPropertyNumber: "BJ-02",
    });
  });
  await page.getByRole("button", { name: "导入房源" }).click();
  const dialog = page.getByRole("dialog", { name: "从贝壳找房" });
  const query = dialog.getByRole("textbox", { name: "搜索条件" });
  await query.fill("两居 500万以内");
  await query.press("Enter");
  const withinBudget = dialog.getByRole("checkbox", { name: /望京西园/ });
  const overBudget = dialog.getByRole("checkbox", { name: /望京新城/ });
  await withinBudget.check();
  await overBudget.check();
  await expect(withinBudget).toBeChecked();
  await dialog.getByRole("textbox", { name: "城市" }).fill("上海");
  await dialog.getByRole("button", { name: "导入选中（2）" }).click();
  await expect(withinBudget).not.toBeChecked();
  await expect(overBudget).toBeChecked();
  await dialog.getByRole("button", { name: "导入选中（1）" }).click();
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
  const attempts = await page.evaluate(() =>
    (window as any).factorySettingsTest.calls
      .filter((call: any) => call.method === "createProperty")
      .map(({ input }: any) => [input.propertyNumber, input.city]),
  );
  expect(attempts).toEqual([
    ["BJ-01", "北京市"],
    ["BJ-02", "北京市"],
    ["BJ-02", "北京市"],
  ]);
});

test("新视频继续使用已保存的制作偏好", async ({ page }) => {
  await fixture(page);
  await page.goto("/#/settings");
  await page.evaluate(() => {
    Object.assign(
      (window as any).factorySettingsTest.workspace.profile.defaults,
      {
        videoTemplate: { id: "standard-tour", version: "1.0.0" },
        voiceId: "public-zh",
      },
    );
  });
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
  await chooseImages(page);
  await page.getByRole("button", { name: "生成 1 条文案" }).click();
  await page.getByRole("button", { name: "审核", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "开场介绍", exact: true }),
  ).toBeVisible();
  const calls = await page.evaluate(
    () => (window as any).factorySettingsTest.calls,
  );
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

test("设置只展示制作服务状态，支持刷新和旧链接", async ({ page }, testInfo) => {
  await fixture(page);
  await page.goto("/#/settings/profile");
  await expect(page).toHaveURL(/#\/settings\/account$/);
  await expect(page.getByRole("tab", { name: "经纪人资料" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "默认生成配置" })).toHaveCount(0);
  await page.getByRole("tab", { name: "制作服务状态", exact: true }).click();
  await expect(page).toHaveURL(/#\/settings\/service-status$/);
  await expect(
    page.getByRole("heading", { name: "制作服务状态", exact: true }),
  ).toBeVisible();
  const panel = page.getByRole("tabpanel", { name: "制作服务状态" });
  await expect(panel.getByText("AI 扩图")).toHaveCount(0);
  await expect(panel.getByRole("combobox")).toHaveCount(0);
  await expect(
    panel.getByRole("cell", { name: /AI 文案.*未配置/ }),
  ).toBeVisible();
  await expect(
    panel.getByRole("cell", { name: /云端配音.*已配置/ }),
  ).toBeVisible();
  await expect(panel.getByText("本机合成工具：已就绪")).toBeVisible();

  await page.evaluate(() => {
    (window as any).factorySettingsTest.aiConfigured = true;
  });
  await panel.getByRole("button", { name: "刷新状态" }).click();
  await expect(
    panel.getByRole("cell", { name: /AI 文案.*已配置/ }),
  ).toBeVisible();

  await page.goto("/#/settings/defaults");
  await expect(page).toHaveURL(/#\/settings\/service-status$/);
  for (const width of [1440, 600]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(panel.getByText("贝壳房源接入")).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: testInfo.outputPath(`service-status-${width}.png`),
      animations: "disabled",
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
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
  await chooseImages(page, 21);
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
