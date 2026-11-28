import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createInitialWorkspace } from "../../packages/api-client/src/fixtures";
import type {
  BeikeDetailResult,
  BeikeSearchResult,
} from "../../packages/shared-types/src/beike";

async function fixture(
  page: Page,
  large = false,
  withRoomFixture = false,
  withBundles = false,
  cachedBundles = false,
) {
  const catalog = JSON.parse(
    readFileSync("services/cloud/video_templates.json", "utf8"),
  );
  await page.addInitScript(
    ({
      workspace,
      catalog,
      large,
      withRoomFixture,
      withBundles,
      cachedBundles,
    }) => {
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
          city: "北京市",
          propertyNumber: "101140860601",
          sample: false,
          details: { orientation: "南" },
        },
      ];
      if (withRoomFixture) {
        const source = catalog[0];
        catalog.push({
          ...source,
          id: "uploaded-opening-tour",
          name: "经纪人开场测试模板",
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
          layout: i % 2 ? "3室2厅" : "2室1厅",
          areaSqm: i === 901 ? 90 : 80,
          priceCents: i >= 900 ? 500_000_000 : 400_000_000,
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
      let finishCatalog: () => void = () => {};
      const catalogReady = new Promise<void>((resolve) => {
        finishCatalog = resolve;
      });
      const state = {
        finishCatalog,
        workspace,
        catalog,
        aiConfigured: false,
        beikeResult: undefined as BeikeSearchResult | undefined,
        beikeDetail: undefined as BeikeDetailResult | undefined,
        beikeBrowserDetail: undefined as BeikeDetailResult | undefined,
        beikeLoggedIn: false,
        failNextPropertyNumber: "",
        failNextVrImport: false,
        spatialImports: new Set<string>(),
        publicVoices: [
          { id: "public-zh", name: "公共讲解音色", language: "zh-CN" },
        ],
        voiceCloneEnabled: false,
        creditPricing: undefined as
          { version: string; prices: Record<string, number> } | undefined,
        calls: [] as { method: string; input: any }[],
        retiredParts: [] as string[],
        rows: [] as any[],
        batches: [] as { id: string; createdAt: string; count: number }[],
        openingVideos: JSON.parse(
          sessionStorage.getItem("opening-videos") || "[]",
        ),
      };
      const mixParts = (["edit", "cover", "script"] as const).flatMap((kind) =>
        [0, 1].map((i) => ({
          id: kind + i,
          version: "1.0.0",
          name: {
            edit: ["短视频带看", "经纪人开场"],
            cover: ["醒目大标题", "品牌信息栏"],
            script: ["短视频带看口播", "逐室讲解"],
          }[kind][i],
          kind,
          available: true,
          ...(kind === "edit"
            ? {
                config: {
                  ...catalog[0].production.config,
                  aspectRatio: "9:16",
                  design: "short-tour",
                  videoMode: i ? "avatar" : "voiceover",
                },
              }
            : {}),
          ...(kind === "cover"
            ? {
                cover: {
                  kind,
                  design: i ? "standard" : "short-tour",
                  brandColor: "#FFD447",
                  imageSource: i ? "last" : "listing-frame",
                  titleSource: "opening",
                  showFacts: !i,
                },
              }
            : {}),
          ...(kind === "script" ? { language: "zh-CN" } : {}),
        })),
      );
      const ref = (id: string) => {
        const { version, name } = mixParts.find((p) => p.id === id)!;
        return { id, name, version };
      };
      const recommended = [0, 1].map((i) => ({
        id: "bundle-" + i,
        name: i ? "短视频带看 · 经纪人开场" : "短视频带看",
        version: "1.0.0",
        parts: {
          edit: ref("edit" + i),
          cover: ref("cover0"),
          script: ref("script0"),
        },
      }));
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
            if (method === "panorama.completed-outputs")
              return [
                {
                  taskId: "local-only",
                  revision: 1,
                  propertyId: "user-property",
                },
                { taskId: "shared", revision: 1, propertyId: "user-property" },
              ];
            if (method === "artifact.list")
              return {
                ok: true,
                data: {
                  items: [
                    {
                      id: "shared-artifact",
                      source: {
                        producer: "panorama",
                        taskId: "shared",
                        revision: 1,
                      },
                      content: { property: { id: "user-property" } },
                    },
                  ],
                  total: 1,
                },
              };
            if (method === "douyin.cloud" && args[0] === "records/list") {
              const items = args[1].offset
                ? [{ artifactId: "shared-artifact", state: "accepted" }]
                : [{ artifactId: "shared-artifact", state: "failed" }];
              return { ok: true, data: { items, total: 2 } };
            }
            if (method === "getWorkspace")
              return structuredClone(state.workspace);
            if (method === "credits.pricing" && state.creditPricing)
              return { ok: true, data: state.creditPricing };
            if (method === "voice.list")
              return {
                voices: [],
                publicVoices: state.publicVoices,
                cloneEnabled: state.voiceCloneEnabled,
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
                  ttsProvider: "bailian",
                  voice: "",

                  scriptProvider: "template",
                  ...catalog[0].production.config,
                },
                ffmpeg: true,
                ffprobe: true,
                managedVoices: true,
                bailianTts: true,
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
            const beikeReady = !!(state.beikeResult || state.beikeDetail);
            if (method === "beikeCli.status")
              return {
                available: beikeReady,
                configured: beikeReady,
                reason: beikeReady ? "ready" : "not_configured",
              };
            if (method === "beikeCli.search") return state.beikeResult;
            if (method === "beikeCli.detail") return state.beikeDetail;
            if (method === "beikeBrowser.detail")
              return state.beikeBrowserDetail;
            if (method === "beikeBrowser.login") state.beikeLoggedIn = true;
            if (
              method === "beikeBrowser.login" ||
              method === "beikeBrowser.check"
            )
              return { loggedIn: state.beikeLoggedIn };
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
                id: beikeReady
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
              if (state.failNextVrImport) {
                state.failNextVrImport = false;
                throw new Error("模拟导入超时");
              }
              state.spatialImports.add(input.propertyId);
              return { count: 1 };
            }
            if (method === "panorama.opening-clip-import") {
              const index = state.openingVideos.length + 1;
              const clip = {
                id: (input?.saveToLibrary ? String(index) : "a").repeat(64),
                name: input?.saveToLibrary
                  ? `保存的开场${index}.mp4`
                  : "临时开场.mp4",
                duration: 3,
                url: "/media/test-opening.mp4",
              };
              if (input?.saveToLibrary) {
                state.openingVideos.push(clip);
                sessionStorage.setItem(
                  "opening-videos",
                  JSON.stringify(state.openingVideos),
                );
              }
              return clip;
            }
            if (method === "panorama.opening-videos")
              return state.openingVideos;
            if (method.startsWith("panorama.music-")) {
              const tracks = JSON.parse(
                sessionStorage.getItem("music-tracks") || "[]",
              );
              const url = "/media/bgm-test.mp3";
              if (method === "panorama.music-tracks") {
                return [
                  {
                    id: "warm-v1",
                    name: "暖意",
                    duration: 45.2,
                    builtin: true,
                    url,
                  },
                  {
                    id: "bright-v1",
                    name: "晴日",
                    duration: 34.3,
                    builtin: true,
                    url,
                  },
                  {
                    id: "calm-v1",
                    name: "静庭",
                    duration: 53.3,
                    builtin: true,
                    url,
                  },
                  ...tracks,
                ];
              }
              const track = {
                id: "a".repeat(64) + ".mp3",
                name: "我的试听",
                duration: 45.2,
                url,
              };
              const next =
                method === "panorama.music-import"
                  ? [track]
                  : method === "panorama.music-remove"
                    ? tracks.filter(
                        (track: { id: string }) => track.id !== input.id,
                      )
                    : tracks.map((track: { id: string }) =>
                        track.id === input.id
                          ? { ...track, name: input.name }
                          : track,
                      );
              sessionStorage.setItem("music-tracks", JSON.stringify(next));
              return track;
            }
            if (method === "panorama.opening-video-remove") {
              state.openingVideos = state.openingVideos.filter(
                (clip: any) => clip.id !== input.id,
              );
              sessionStorage.setItem(
                "opening-videos",
                JSON.stringify(state.openingVideos),
              );
              return null;
            }
            if (method === "panorama.factory-catalog") {
              if (input?.cachedOnly && !cachedBundles) return null;
              if (cachedBundles && !input?.cachedOnly) await catalogReady;
              return {
                ...(withBundles
                  ? {
                      library: {
                        recommended:
                          cachedBundles && !input?.cachedOnly
                            ? [{ ...recommended[1], name: "门店新搭配" }]
                            : recommended,
                        parts: mixParts.map((part) => ({
                          ...part,
                          available: !state.retiredParts.includes(part.id),
                        })),
                        personal: JSON.parse(
                          sessionStorage.getItem("saved-mixes") || "[]",
                        ),
                      },
                    }
                  : {}),
                templates: state.catalog.map((t: any) => ({
                  ...t,
                  config: t.production.config,
                  opening: t.production.opening ? "minimax" : undefined,
                })),
                ffmpeg: true,
                ffprobe: true,
                managedVoices: true,
                voices: [],
              };
            }
            if (method === "panorama.factory-save-mix") {
              const saved = {
                id: "mine-1",
                name: input.name,
                version: "1.0.0",
                backgroundMusic: input.backgroundMusic,
                parts: Object.fromEntries(
                  Object.entries(input.parts).map(([k, v]) => [
                    k,
                    ref((v as { id: string }).id),
                  ]),
                ),
              };
              sessionStorage.setItem("saved-mixes", JSON.stringify([saved]));
              return saved;
            }
            if (method === "panorama.factory-cover-image")
              return input.last
                ? "/media/interior-2.jpg"
                : "/media/interior-1.jpg";
            if (method === "panorama.factory-properties") {
              const matched = state.workspace.properties.filter(
                (p) =>
                  (input.exactNumber === undefined ||
                    (!!input.exactNumber &&
                      p.propertyNumber === input.exactNumber)) &&
                  (!input.search || p.title.includes(input.search)) &&
                  (!input.district || p.district === input.district) &&
                  (!input.community || p.community === input.community) &&
                  (!input.layouts || input.layouts.includes(p.layout)) &&
                  (input.minPrice == null ||
                    p.priceCents / 1_000_000 >= input.minPrice) &&
                  (input.maxPrice == null ||
                    p.priceCents / 1_000_000 <= input.maxPrice) &&
                  (input.minArea == null || p.areaSqm >= input.minArea) &&
                  (input.maxArea == null || p.areaSqm <= input.maxArea) &&
                  (!input.selectedIds || input.selectedIds.includes(p.id)),
              );
              if (input.all)
                return {
                  rows: matched
                    .filter((p) => p.importStatus === "ready")
                    .map(({ id, title, propertyNumber }) => ({
                      id,
                      title,
                      propertyNumber,
                    })),
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
                const t = withBundles
                  ? state.catalog[0]
                  : state.catalog.find(
                      (item: any) => item.id === pair.templateId,
                    );
                const id = "review-" + i;
                const config = {
                  ...t.production.config,
                  ...input.renderOverrides,
                  voice: state.workspace.profile.defaults.voiceId,
                  openingVideo: input.openingVideo,
                };
                const draft = {
                  id,
                  property: p,
                  revision: 1,
                  config,
                  templateSnapshot: {
                    ...structuredClone(t),
                    ...(withBundles
                      ? {
                          cover: mixParts.find(
                            (part) =>
                              part.id ===
                              input.mixes.find(
                                (mix: any) => mix.id === pair.templateId,
                              ).parts.cover.id,
                          )?.cover,
                        }
                      : {}),
                  },
                  coverReason: pair.coverReason,
                  scenes: withRoomFixture
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
                    ...(input.openingVideo
                      ? []
                      : [
                          {
                            id: "opening",
                            kind: "opening",
                            sceneId: withRoomFixture ? "room-1" : undefined,
                            text: "请确认这条房源文案。",
                          },
                        ]),
                    ...(withRoomFixture
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
                  openingVideoUrl: input.openingVideo
                    ? "/media/test-opening.mp4"
                    : undefined,
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
                ...(input.coverReason !== undefined
                  ? { coverReason: input.coverReason }
                  : {}),
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
    {
      workspace: createInitialWorkspace(),
      catalog,
      large,
      withRoomFixture,
      withBundles,
      cachedBundles,
    },
  );
}

test("先显示本机推荐搭配，云端同步后替换已删除的搭配", async ({ page }) => {
  await fixture(page, false, false, true, true);
  await page.goto("/#/studio/create");
  const library = page.getByRole("region", { name: "搭配库" });
  const cached = library.getByRole("button", {
    name: "短视频带看，已应用",
    exact: true,
  });
  await expect(cached).toBeVisible();
  await cached.click();
  await page.evaluate(() =>
    (window as any).factorySettingsTest.finishCatalog(),
  );
  await expect(
    library.getByRole("button", { name: "门店新搭配，已应用", exact: true }),
  ).toBeVisible();
  await expect(cached).toHaveCount(0);
});

test("云端下架部件后回退到普通短视频并停用旧搭配", async ({ page }) => {
  await fixture(page, false, false, true);
  await page.goto("/#/studio/create");

  const library = page.getByRole("region", { name: "搭配库" });
  const cover = page.getByRole("button", { name: "更换封面模板" });
  await expect(
    library.getByRole("button", { name: "短视频带看，已应用", exact: true }),
  ).toBeVisible();
  await cover.click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^品牌信息栏/ })
    .click();
  await page.getByRole("button", { name: "存为我的搭配" }).click();
  await page.getByRole("textbox", { name: "搭配名称" }).fill("旧封面搭配");
  await page.getByRole("button", { name: "保存搭配", exact: true }).click();
  await expect(
    library.getByRole("button", { name: "旧封面搭配，已应用", exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: /^批次设置/ }).click();
  await page.getByRole("combobox", { name: "本批追加搭配" }).click();
  await page
    .locator(".ant-select-dropdown:visible")
    .getByText("短视频带看 · 经纪人开场", { exact: true })
    .click();
  await page.keyboard.press("Escape");

  await page.evaluate(() => {
    (window as any).factorySettingsTest.retiredParts = ["cover1", "edit1"];
  });
  await page.getByRole("button", { name: "刷新搭配" }).click();
  const retired = library.getByRole("button", {
    name: "旧封面搭配，模板已下架",
    exact: true,
  });
  await expect(retired).toBeDisabled();
  await expect(
    page.getByRole("combobox", { name: "本批追加搭配" }),
  ).toHaveCount(0);
  await library.getByText("推荐搭配", { exact: true }).click();
  await expect(
    library.getByRole("button", { name: "短视频带看，已应用", exact: true }),
  ).toBeVisible();
  await cover.click();
  await expect(
    page.getByRole("dialog").getByRole("button", { name: /^醒目大标题/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog").getByRole("button", { name: /^品牌信息栏/ }),
  ).toHaveCount(0);
});

test("声音设置展示当前声音复刻及配音价目", async ({ page }) => {
  await fixture(page);
  await page.goto("/#/settings");
  await page.evaluate(() => {
    const state = (window as any).factorySettingsTest;
    state.voiceCloneEnabled = true;
    state.creditPricing = {
      version: "v2",
      prices: { voice_clone: 240, tts_per_kilo_char: 12 },
    };
  });
  await page.getByRole("tab", { name: "声音与音色", exact: true }).click();
  await expect(
    page.getByText("复刻 240 积分／次", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/配音每千字 12 积分/)).toBeVisible();
  await page.getByRole("button", { name: "上传本人声音", exact: true }).click();
  await expect(
    page
      .getByRole("dialog", { name: "上传本人声音" })
      .getByText("复刻 240 积分／次"),
  ).toBeVisible();
});

test("推荐同款独立换三项，保存后重新打开并跨房源批量使用", async ({
  page,
}, info) => {
  await fixture(page, false, false, true);
  await page.goto("/#/studio/create");
  await expect(
    page.getByRole("button", { name: "短视频带看，已应用" }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("recommended.png") });
  await page
    .getByRole("button", { name: "短视频带看 · 经纪人开场，用同款" })
    .click();
  await expect(
    page.getByRole("button", { name: "更换剪辑模板" }),
  ).toContainText("经纪人开场");
  for (const [kind, name] of [
    ["剪辑", "短视频带看"],
    ["封面", "品牌信息栏"],
    ["文案", "逐室讲解"],
  ]) {
    await page.getByRole("button", { name: "更换" + kind + "模板" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: new RegExp("^" + name) })
      .click();
  }
  await expect(page.locator(".mix-poster")).toHaveClass(/poster-standard/);
  await expect(page.locator(".mix-poster figcaption span")).toHaveCount(0);
  const currentMix = page.getByRole("region", { name: "当前搭配" });
  await expect(
    currentMix.getByRole("combobox", { name: "选择背景音乐" }),
  ).toBeVisible();
  await choose(page, "选择背景音乐", "暖意");
  await currentMix.getByRole("slider", { name: "音乐音量" }).press("End");
  await page.getByRole("button", { name: "存为我的搭配" }).click();
  await page.getByRole("textbox", { name: "搭配名称" }).fill("周末带看");
  await page.getByRole("button", { name: "保存搭配", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "周末带看，已应用" }),
  ).toBeVisible();
  await page.reload();
  await page.getByText("我的搭配", { exact: true }).click();
  await page.getByRole("button", { name: "周末带看，用同款" }).click();
  await expect(currentMix.getByText("暖意", { exact: true })).toBeVisible();
  await expect(
    currentMix.getByRole("slider", { name: "音乐音量" }),
  ).toHaveValue("30");
  await expect(
    page.getByRole("button", { name: "更换剪辑模板" }),
  ).toContainText("短视频带看");
  await expect(
    page.getByRole("button", { name: "更换封面模板" }),
  ).toContainText("品牌信息栏");
  await expect(
    page.getByRole("button", { name: "更换文案模板" }),
  ).toContainText("逐室讲解");
  const voice = page.getByRole("combobox", { name: "批次音色" });
  await expect(
    currentMix
      .locator(".mix-row")
      .first()
      .getByRole("combobox", { name: "批次音色" }),
  ).toBeVisible();
  await voice.click();
  await page.getByText("公共讲解音色 · zh-CN", { exact: true }).click();
  await page.getByRole("button", { name: "选择房源", exact: true }).click();
  const homes = page.getByRole("dialog", { name: "选择房源" });
  await homes
    .getByRole("checkbox", { name: "选择内置测试房源 · 全景素材", exact: true })
    .check();
  await homes
    .getByRole("checkbox", { name: "选择本人房源联调测试", exact: true })
    .check();
  await homes.getByRole("button", { name: "确认选择（2）" }).click();
  await page.getByRole("button", { name: "选择图片", exact: true }).click();
  const images = page.getByRole("dialog", { name: "选择视频图片" });
  await images.getByRole("button", { name: "选择全部", exact: true }).click();
  await images.getByRole("button", { name: "下一套房源" }).click();
  await images.getByRole("button", { name: "选择全部", exact: true }).click();
  await images.getByRole("button", { name: "确认选图" }).click();
  await expect(page.locator(".mix-preview small")).toContainText(
    "末张视频素材",
  );
  await page.screenshot({ path: info.outputPath("factory-mix.png") });
  await page.getByRole("button", { name: "生成 2 条文案" }).click();
  await expect(page.getByRole("tab", { name: "制作任务" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const submitted = await page.evaluate(
    () =>
      (window as any).factorySettingsTest.calls.find(
        (c: any) => c.method === "panorama.factory-create",
      ).input,
  );
  expect(submitted.pairs).toHaveLength(2);
  expect(submitted.voiceId).toBe("public-zh");
  expect(submitted.backgroundMusic).toEqual({ id: "warm-v1", volume: 30 });
  expect(submitted.mixes).toEqual([
    {
      id: "mine-1",
      version: "1.0.0",
      parts: {
        edit: { id: "edit0", version: "1.0.0" },
        cover: { id: "cover1", version: "1.0.0" },
        script: { id: "script1", version: "1.0.0" },
      },
    },
  ]);
});

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

test("背景音乐库和新建视频共用本机曲目，默认不配乐", async ({ page }, info) => {
  await fixture(page);
  await page.route("**/media/bgm-test.mp3", (route) =>
    route.fulfill({
      path: "apps/desktop/electron/panorama/music/warm-v1.mp3",
      contentType: "audio/mpeg",
    }),
  );
  await page.goto("/#/settings/music");
  await expect(page.getByRole("heading", { name: "背景音乐库" })).toBeVisible();
  await expect(page.locator("audio")).toHaveCount(3);
  await page.getByRole("button", { name: "上传音乐" }).click();
  await expect(page.getByText("我的试听", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "改名", exact: true }).click();
  await page.getByRole("textbox", { name: "曲目名称" }).fill("带看配乐");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("带看配乐", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "修改曲目名称" })).toBeHidden();
  await page.screenshot({
    path: info.outputPath("music-library.png"),
    animations: "disabled",
  });

  await page.goto("/#/studio/create");
  await expect(page.getByText("不使用背景音乐", { exact: true })).toBeVisible();
  await selectTemplates(page, ["标准房源带看 · 1.0.0"]);
  await page.getByRole("button", { name: "选择房源", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "选择本人房源联调测试", exact: true })
    .check();
  await page.getByRole("button", { name: "确认选择（1）" }).click();
  await chooseImages(page);
  await choose(page, "选择背景音乐", "带看配乐");
  const audio = page.locator('audio[aria-label="试听 带看配乐"]');
  await expect(audio).toBeVisible();
  await expect(audio).toHaveJSProperty("volume", 0.15);
  const volume = page.getByRole("slider", { name: "音乐音量" });
  await volume.press("End");
  await expect(volume).toHaveValue("30");
  await audio.evaluate(async (element: HTMLAudioElement) => {
    await element.play();
    element.pause();
  });
  const create = page.getByRole("button", { name: "生成 1 条文案" });
  await create.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath("factory-background-music.png"),
    animations: "disabled",
  });
  await create.click();
  const submission = await page.evaluate(
    () =>
      (window as any).factorySettingsTest.calls.find(
        (c: any) => c.method === "panorama.factory-create",
      ).input,
  );
  expect(submission.backgroundMusic).toEqual({
    id: "a".repeat(64) + ".mp3",
    volume: 30,
  });
  await page.getByRole("tab", { name: "新建视频", exact: true }).click();
  await expect(page.getByText("不使用背景音乐", { exact: true })).toBeVisible();
});

test("经纪人开场每批必选，可选择本机视频库或临时上传，审核只显示带看文案", async ({
  page,
}) => {
  await fixture(page, false, true);
  await page.goto("/#/settings/appearance");
  await expect(page.getByRole("heading", { name: "开场视频库" })).toBeVisible();
  const upload = page.getByRole("button", { name: "上传并保存视频" });
  await upload.click();
  await expect(
    page.getByRole("heading", { name: "保存的开场1.mp4" }),
  ).toBeVisible();
  await upload.click();
  await expect(
    page.getByRole("heading", { name: "保存的开场2.mp4" }),
  ).toBeVisible();

  await page.goto("/#/studio/create");
  await selectTemplates(page, ["经纪人开场测试模板 · 1.0.0"]);
  async function configureBatch() {
    await page.getByRole("button", { name: "选择房源", exact: true }).click();
    await page
      .getByRole("checkbox", { name: "选择本人房源联调测试", exact: true })
      .check();
    await page.getByRole("button", { name: "确认选择（1）" }).click();
    await chooseImages(page);
  }
  await configureBatch();
  const create = page.getByRole("button", { name: "生成 1 条文案" });
  await expect(create).toBeDisabled();
  await choose(page, "选择已保存的开场视频", "保存的开场2.mp4 · 3.0 秒");
  await expect(create).toBeEnabled();
  await create.click();
  await page.getByRole("button", { name: "审核", exact: true }).click();
  await expect(page.locator('video[aria-label="开场视频"]')).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "开场介绍", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "1 · 客厅", exact: true }),
  ).toBeVisible();
  const submitted = () =>
    page.evaluate(() =>
      (window as any).factorySettingsTest.calls
        .filter((call: any) => call.method === "panorama.factory-create")
        .map((call: any) => call.input.openingVideo),
    );
  expect(await submitted()).toEqual(["2".repeat(64)]);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "审核文案" })).toBeHidden();
  await page.getByRole("tab", { name: "新建视频", exact: true }).click();
  await configureBatch();
  await expect(create).toBeDisabled();
  await page.getByRole("button", { name: "临时上传", exact: true }).click();
  await expect(page.getByText(/本次使用 临时开场.mp4/)).toBeVisible();
  await create.click();
  await expect.poll(submitted).toEqual(["2".repeat(64), "a".repeat(64)]);

  await page.goto("/#/settings/appearance");
  await expect(
    page.getByRole("heading", { name: "保存的开场2.mp4" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "临时开场.mp4" })).toHaveCount(
    0,
  );
});

test("封面预览随机文案沿用到审核，可换一句并保存", async ({ page }) => {
  await fixture(page, false, false, true);
  await page.goto("/#/studio/create?propertyId=user-property");
  const preview = page.locator(".mix-preview svg[role=img] text").nth(1);
  await expect(preview).toBeVisible();
  const previewReason = (await preview.textContent())!;
  const reasons: string[] = JSON.parse(
    readFileSync("apps/desktop/electron/production/cover-reasons.json", "utf8"),
  );
  expect(reasons).toContain(previewReason);
  await page.getByRole("button", { name: "选择图片", exact: true }).click();
  const images = page.getByRole("dialog", { name: "选择视频图片" });
  await images.getByRole("button", { name: "选择全部", exact: true }).click();
  await images.getByRole("button", { name: "确认选图" }).click();
  await expect(preview).toHaveText(previewReason);
  await page.getByRole("button", { name: "生成 1 条文案" }).click();
  await page.getByRole("button", { name: "审核", exact: true }).click();
  const reason = page.getByRole("textbox", { name: "封面售卖原因" });
  await expect(reason).toHaveValue(previewReason);
  await page.getByRole("button", { name: "换一句", exact: true }).click();
  await expect(reason).not.toHaveValue(previewReason);
  await reason.fill("");
  await expect(
    page.getByRole("button", { name: "确认并下一条" }),
  ).toBeDisabled();
  await reason.fill("换房方便照顾爸妈");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "保存修改", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "审核", exact: true }).click();
  await expect(reason).toHaveValue("换房方便照顾爸妈");
  await page.getByRole("button", { name: "确认并下一条" }).click();
  await expect(reason).toHaveCount(0);
});

test("短视频带看审核可单独保存两行开场封面标题", async ({ page }) => {
  await fixture(page);
  await page.goto("/#/studio/create?propertyId=user-property");
  await page.evaluate(() => {
    const property = (window as any).factorySettingsTest.workspace
      .properties[1];
    property.community = "测试小区";
    property.sellingPoints = ["南北通透", "低楼层"];
  });
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
  const defaultTitle = "测试小区\n南北通透";
  await expect(title).toHaveValue(defaultTitle);
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

  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "审核", exact: true }).click();
  await expect(title).toHaveValue(value);
  await title.clear();
  await save.click();
  await expect(title).toHaveValue(defaultTitle);
  await expect(save).toBeDisabled();
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
  expect(saves[0].input.config.coverTitle ?? "").toBe("");
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

test("从制作素材保存 VR 链接后自动导入，已有全景图时入口置灰", async ({
  page,
}) => {
  await fixture(page);
  const copiedLinks: string[] = [];
  await page.exposeFunction("recordCopiedLink", (link: string) => {
    copiedLinks.push(link);
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: (window as any).recordCopiedLink },
    });
  });
  await page.goto("/#/properties/user-property");
  await page.getByRole("tab", { name: "制作素材" }).click();
  await expect(page.getByText("0 张 VR 全景图", { exact: true })).toBeVisible();
  const copyListing = page.getByRole("button", { name: "获取房源 VR 链接" });
  await copyListing.click();
  await expect(
    page.getByText("已复制房源网页，可在浏览器打开查看 VR"),
  ).toBeVisible();
  expect(copiedLinks).toEqual([
    "https://m.ke.com/bj/ershoufang/101140860601.html",
  ]);
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
  const addLink = page.getByRole("button", { name: "添加房源 VR 链接" });
  await addLink.click();
  const dialog = page.getByRole("dialog", { name: "添加房源 VR 链接" });
  const link = dialog.getByRole("textbox", { name: "VR 看房链接" });
  const save = dialog.getByRole("button", { name: "保存并导入" });
  await expect(link).toHaveValue("");
  await save.click();
  await expect(dialog.getByText("请输入 VR 看房链接")).toBeVisible();

  await page.evaluate(() => {
    (window as any).factorySettingsTest.failNextVrImport = true;
  });
  await link.fill("https://realsee.cn/example");
  await save.click();
  await expect(dialog.getByRole("alert")).toContainText(
    "链接已保存，全景图导入失败（模拟导入超时）",
  );
  await expect(link).toHaveValue("https://realsee.cn/example");
  await expect(save).toBeEnabled();

  await save.click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("img", { name: "房源图片 1", exact: true }),
  ).toHaveAttribute("src", "/media/interior-1.jpg");
  await expect(page.getByText("1 张 VR 全景图", { exact: true })).toBeVisible();
  await expect(addLink).toBeDisabled();
  await expect(copyListing).toBeEnabled();
  const { details, requests } = await page.evaluate(() => {
    const { workspace, calls } = (window as any).factorySettingsTest;
    return {
      details: workspace.properties.find((p: any) => p.id === "user-property")
        .details,
      requests: calls.filter(
        (call: any) =>
          call.method === "updateProperty" ||
          call.method === "panorama.property-vr-import",
      ),
    };
  });
  expect(details).toEqual({
    orientation: "南",
    vrUrl: "https://realsee.cn/example",
  });
  expect(requests).toEqual([
    { method: "updateProperty", input: "user-property" },
    {
      method: "panorama.property-vr-import",
      input: { propertyId: "user-property" },
    },
    {
      method: "panorama.property-vr-import",
      input: { propertyId: "user-property" },
    },
  ]);
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
  await expect(
    page.getByRole("button", { name: "添加房源 VR 链接" }),
  ).toBeDisabled();
});

test("贝壳未配置时可从正式房源导入切换到手动添加", async ({ page }) => {
  await fixture(page);
  await page.goto("/#/properties?import=1");
  const dialog = page.getByRole("dialog", { name: "从贝壳找房", exact: true });
  await expect(dialog.getByRole("status")).toHaveText("云端尚未配置贝壳 CLI。");
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
      query: "望京 两居 500万以内",
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
  const city = dialog.getByRole("combobox", { name: "城市" });
  const location = dialog.getByRole("textbox", { name: "区域、商圈或小区" });
  const layout = dialog.getByRole("combobox", { name: /户型/ });
  const maxPrice = dialog.getByRole("textbox", { name: /最高总价/ });
  const search = dialog.getByRole("button", { name: "搜索房源" });
  const searches = () =>
    page.evaluate(() =>
      (window as any).factorySettingsTest.calls
        .filter((call: any) => call.method === "beikeCli.search")
        .map((call: any) => call.input),
    );

  await expect(city).toHaveValue("北京");
  await expect(dialog.getByText("按房源号查询", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("贝壳房源号", { exact: true })).toHaveCount(0);
  await expect(location).toHaveValue("");
  await dialog.getByRole("button", { name: "望京 · 两居 · 500万以内" }).click();
  await expect(location).toHaveValue("望京");
  await expect(dialog.getByText("两居", { exact: true })).toBeVisible();
  await expect(maxPrice).toHaveValue("500");
  await dialog.getByRole("button", { name: "望京", exact: true }).click();
  await expect(maxPrice).toHaveValue("");
  await expect(dialog.getByText("不限", { exact: true })).toBeVisible();
  expect(await searches()).toEqual([]);

  await search.click();
  const withinBudget = dialog.getByRole("checkbox", { name: /望京西园/ });
  const overBudget = dialog.getByRole("checkbox", { name: /望京新城/ });
  await expect(withinBudget).toBeVisible();
  expect(await searches()).toEqual([{ city: "北京", query: "望京" }]);

  await layout.click();
  await page.getByRole("option", { name: "两居", exact: true }).click();
  await maxPrice.fill("500万元");
  await search.click();
  await expect(
    page.getByText("最高总价请输入大于 0 的数字，例如 500"),
  ).toBeVisible();
  expect(await searches()).toHaveLength(1);

  await maxPrice.fill("５００");
  await location.press("Enter");
  await expect.poll(searches).toEqual([
    { city: "北京", query: "望京" },
    { city: "北京", query: "望京 两居 500万以内" },
  ]);
  await expect(overBudget).toHaveAccessibleName(/超预算/);
  await withinBudget.check();
  await overBudget.check();
  await expect(withinBudget).toBeChecked();
  await city.click();
  await page.getByRole("option", { name: "上海", exact: true }).click();
  await expect(city).toHaveValue("上海");
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

test("贝壳按房源号查询并确认导入精确匹配的房源", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await fixture(page);
  await page.goto("/#/properties");
  const id = "101138285186";
  const house = {
    id,
    title: "大西洋新城E区 2室1厅 77㎡ 540万",
    community: "大西洋新城E区",
    district: "望京",
    totalPriceWan: 540,
    unitPrice: 70000,
    areaSqm: 77,
    layout: "2室1厅1厨2卫",
    orientation: "南,西北",
    builtYear: "2010年",
    status: "在售",
  };
  await page.evaluate(
    (detail: BeikeDetailResult) => {
      (window as any).factorySettingsTest.beikeDetail = detail;
    },
    { city: "北京市", returned: 1, houses: [house] },
  );
  await page.getByRole("button", { name: "导入房源" }).click();
  const dialog = page.getByRole("dialog", { name: "从贝壳找房" });
  await dialog.getByText("按房源号查询", { exact: true }).click();
  const field = dialog.getByLabel("贝壳房源号", { exact: true });
  const submit = dialog.getByRole("button", { name: "查询房源" });
  const add = dialog.getByRole("button", { name: "导入这套房源" });
  const calls = (method: string) =>
    page.evaluate(
      (method) =>
        (window as any).factorySettingsTest.calls
          .filter((call: any) => call.method === method)
          .map((call: any) => call.input),
      method,
    );

  await field.fill("101,102");
  await submit.click();
  await expect(page.getByText("请输入一个纯数字的贝壳房源号")).toBeVisible();
  expect(await calls("beikeCli.detail")).toEqual([]);

  await field.fill("101138285187");
  await submit.click();
  await expect(
    dialog.getByText("未找到该房源，请核对城市和贝壳房源号。"),
  ).toBeVisible();
  await expect(add).toHaveCount(0);

  await field.fill(" １０１１３８２８５１８６ ");
  await field.press("Enter");
  await expect(dialog.getByRole("status")).toHaveText(`房源号 ${id} · 在售`);
  await expect(
    dialog.getByRole("checkbox", { name: /大西洋新城E区/ }),
  ).toBeChecked();
  expect(await calls("beikeCli.detail")).toEqual([
    { city: "北京", ids: ["101138285187"] },
    { city: "北京", ids: [id] },
  ]);
  expect(await calls("createProperty")).toEqual([]);

  await add.click();
  await expect(page.getByText("已导入 1 套贝壳房源")).toBeVisible();
  await expect(add).toHaveCount(0);
  expect(await calls("createProperty")).toEqual([
    expect.objectContaining({
      propertyNumber: id,
      title: house.title,
      city: "北京市",
      priceCents: 540_000_000,
      areaSqm: 77,
      details: expect.objectContaining({
        buildingAge: "2010年",
        listingStatus: "在售",
      }),
    }),
  ]);
  await dialog
    .getByRole("button", { name: "关闭", exact: true })
    .last()
    .click();
  await expect(page.getByText(house.title, { exact: true })).toBeVisible();
});

test("贝壳同一房源经两种方式导入后共用详情展示", async ({ page }) => {
  await fixture(page);
  const house = {
    id: "108403741204",
    title: "新燕花园",
    community: "新燕花园",
    district: "天河区",
    totalPriceWan: 238,
    areaSqm: 73,
    layout: "2室2厅1卫",
    orientation: "西南",
    transaction: "满五年",
  };
  const cli = {
    city: "广州",
    returned: 1,
    houses: [{ ...house, highlights: "满五年/地铁" }],
  };
  const browser = {
    city: "广州",
    returned: 1,
    houses: [
      {
        ...house,
        description: house.transaction,
        sellingPoints: ["满五年", "地铁"],
        vrUrl: "https://open.realsee.com/ke/demo/",
      },
    ],
  };
  const summaries: string[] = [];
  for (const source of ["贝壳 CLI", "贝壳浏览器"]) {
    await page.goto("/#/properties");
    await page.evaluate(
      ({ cli, browser }) => {
        Object.assign((window as any).factorySettingsTest, {
          beikeDetail: cli,
          beikeBrowserDetail: browser,
        });
      },
      { cli, browser },
    );
    await page.getByRole("button", { name: "导入房源" }).click();
    const dialog = page.getByRole("dialog", { name: "从贝壳找房" });
    await dialog.getByText("按房源号查询", { exact: true }).click();
    await dialog.getByText(source, { exact: true }).click();
    await dialog.getByLabel("城市", { exact: true }).fill("广州");
    await dialog.getByLabel("贝壳房源号", { exact: true }).fill(house.id);
    await dialog.getByRole("button", { name: "查询房源", exact: true }).click();
    await dialog.getByRole("button", { name: "导入这套房源" }).click();
    await expect(page.getByText("已导入 1 套贝壳房源")).toBeVisible();
    await dialog
      .getByRole("button", { name: "关闭", exact: true })
      .last()
      .click();
    await page
      .locator('a[href="#/properties/beike-' + house.id + '"]')
      .first()
      .click();
    const sheet = page.locator(".property-info-sheet");
    await expect(sheet).toContainText("新燕花园");
    await expect(sheet.getByText("VR 看房链接", { exact: true })).toHaveCount(
      source === "贝壳浏览器" ? 1 : 0,
    );
    summaries.push(
      (await sheet.innerText())
        .replace("VR 看房链接", "")
        .replace(/\s+/g, " ")
        .trim(),
    );
    await page.reload();
  }
  expect(summaries[1]).toEqual(summaries[0]);
});

test("贝壳浏览器从平台账号检查登录，CLI 未配置时也能按房源号导入 VR", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/#/settings/platforms");
  const account = page.getByRole("region", { name: "贝壳账号" });
  await account.getByRole("button", { name: "检查贝壳登录状态" }).click();
  await expect(account.getByText("未登录", { exact: true })).toBeVisible();
  await account.getByRole("button", { name: "登录贝壳账号" }).click();
  await expect(account.getByText("已登录", { exact: true })).toBeVisible();
  await page.goto("/#/properties?import=1");
  const id = "101141001564";
  const links = {
    vrUrl: "https://open.realsee.com/ke/demo/",
    listingUrl: `https://m.ke.com/bj/ershoufang/${id}.html`,
  };
  await page.evaluate(
    ({ id, links }) => {
      (window as any).factorySettingsTest.beikeBrowserDetail = {
        city: "北京",
        returned: 1,
        houses: [
          {
            id,
            title: "浏览器测试房源",
            description: "网页核心卖点",
            sellingPoints: ["满五年", "精装修"],
            transaction: "抵押信息：无抵押",
            community: "测试小区",
            totalPriceWan: 480,
            areaSqm: 59.48,
            layout: "3室1厅",
            ...links,
          },
        ],
      };
    },
    { id, links },
  );
  const dialog = page.getByRole("dialog", { name: "从贝壳找房" });
  await dialog.getByRole("button", { name: "使用浏览器按房源号查询" }).click();
  await dialog.getByLabel("贝壳房源号", { exact: true }).fill(id);
  await dialog.getByRole("button", { name: "查询房源", exact: true }).click();
  await expect(dialog.getByText(/含 VR 看房链接/)).toBeVisible();
  await dialog.getByRole("button", { name: "导入这套房源" }).click();
  const calls = await page.evaluate(
    () => (window as any).factorySettingsTest.calls,
  );
  expect(calls).toContainEqual({
    method: "beikeBrowser.detail",
    input: { city: "北京", number: id },
  });
  expect(calls).toContainEqual({
    method: "createProperty",
    input: expect.objectContaining({
      propertyNumber: id,
      description: "网页核心卖点",
      sellingPoints: ["满五年", "精装修"],
      details: expect.objectContaining({
        ...links,
        transactionAttributes: "抵押信息：无抵押",
      }),
    }),
  });
  await page.evaluate(() => {
    const state = (window as any).factorySettingsTest;
    const saved = state.workspace.properties.find(
      (item: { id: string }) => item.id === "new-property",
    );
    saved.description = "手动填写的说明";
    saved.sellingPoints = ["自定义卖点"];
    delete saved.details.transactionAttributes;
  });
  await dialog.getByRole("button", { name: "查询房源", exact: true }).click();
  await dialog.getByRole("button", { name: "补全已有房源" }).click();
  await expect(page.getByText("已补全房源资料")).toBeVisible();
  const saved = await page.evaluate(() =>
    (window as any).factorySettingsTest.workspace.properties.find(
      (item: { id: string }) => item.id === "new-property",
    ),
  );
  expect(saved.description).toBe("手动填写的说明");
  expect(saved.sellingPoints).toEqual(["自定义卖点", "满五年", "精装修"]);
  expect(saved.details.transactionAttributes).toBe("抵押信息：无抵押");
  await dialog
    .getByRole("button", { name: "关闭", exact: true })
    .last()
    .click();
  await page.locator('a[href="#/properties/new-property"]').first().click();
  await expect(page.locator(".property-unit-price")).toHaveText(
    "单价约 80,699 元／平方米",
  );
  await expect(
    page.getByText("抵押信息：无抵押", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("VR 看房链接", { exact: true })).toBeVisible();
  await expect(page.getByText("查看贝壳页面资料")).toHaveCount(0);
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
    panel.getByRole("cell", { name: /百炼配音.*已配置/ }),
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

test("房源中心移除库内条件栏，视频工厂保留选房筛选", async ({ page }) => {
  await fixture(page, true);
  await page.goto("/#/properties");
  await expect(page.getByText("共 1000 套房源")).toBeVisible();
  await expect(page.getByText("按房源号查找", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("spinbutton", { name: "最高总价" })).toHaveCount(
    0,
  );
  await page
    .locator(".property-card")
    .filter({ has: page.getByText("房源号 SH100", { exact: true }) })
    .getByRole("link", { name: "创建视频" })
    .click();
  await expect(page.getByText("房源号 SH100", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "房源 1 套" }).click();
  const dialog = page.getByRole("dialog", { name: "选择房源" });
  await dialog.getByText("按房源号查找", { exact: true }).click();
  await dialog.getByRole("textbox", { name: "完整房源号" }).fill("SH1000");
  await expect(dialog.getByText("符合条件 1 项")).toBeVisible();
  await dialog.getByRole("button", { name: "只制作这套" }).click();
  await expect(page.getByText("房源号 SH1000", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "房源 1 套" }).click();
  await dialog.getByRole("spinbutton", { name: "最低总价" }).fill("500");
  await dialog.getByRole("spinbutton", { name: "最小面积" }).fill("90");
  await expect(dialog.getByText("符合条件 1 项")).toBeVisible();
  await expect(dialog.getByText("SH1001", { exact: false })).toBeVisible();
  await dialog.getByRole("button", { name: "全选筛选结果" }).click();
  await dialog.getByRole("button", { name: "确认选择（2）" }).click();
  await page.getByText("核对已选房源号（2 套）").click();
  await expect(page.locator(".property-number-review li")).toHaveText([
    /SH1000/,
    /SH1001/,
  ]);
});

test("房源卡片、列表和发布分类按真实成片去重并读取历史发布记录", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/#/properties");
  const card = page
    .locator(".property-card")
    .filter({ hasText: "本人房源联调测试" });
  await expect(card).toContainText("已生成 2 条视频");
  await expect(card).toContainText("已发布过");
  await page.getByRole("button", { name: /^已发布过\s*1$/ }).click();
  await expect(page.locator(".property-card")).toHaveCount(1);
  await page
    .locator(".ant-segmented-item")
    .filter({ hasText: "表格视图" })
    .click();
  const row = page.getByRole("row").filter({ hasText: "101140860601" });
  await expect(row).toContainText("已生成 2 条视频");
  await expect(row).toContainText("已发布过");
});
