import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createInitialWorkspace } from "../../packages/api-client/src/fixtures";

async function fixture(page: Page) {
  const catalog = JSON.parse(
    readFileSync("services/cloud/video_templates.json", "utf8"),
  );
  await page.addInitScript(
    ({ workspace, catalog }) => {
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
      const state = {
        workspace,
        catalog,
        publicVoices: [
          { id: "public-zh", name: "公共讲解音色", language: "zh-CN" },
        ],
        calls: [] as { method: string; input: any }[],
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
            if (method === "avatar.list")
              return {
                avatars: [
                  { id: "own-avatar", name: "本人测试形象", status: "ready" },
                ],
                uploadEnabled: true,
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
                  avatarId: "",
                  scriptProvider: "template",
                  ...catalog[0].production.config,
                },
                ffmpeg: true,
                ffprobe: true,
                managedVoices: true,
                volcTts: true,
                ai: false,
                volcAvatar: true,
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
            if (method === "updateFactoryPreferences") {
              const input = args[0];
              Object.assign(state.workspace.profile.defaults, {
                videoTemplate: {
                  id: input.templateId,
                  version: input.templateVersion,
                },
                voiceId: input.voiceId,
                avatarId: input.avatarId,
              });
              return state.workspace.profile.defaults;
            }
            if (method === "panorama.prepare")
              return {
                id: "sample-draft",
                revision: 1,
                property: state.workspace.properties.find(
                  (p) => p.id === args[0].propertyId,
                ),
                sample: args[0].propertyId === "panorama-cc0-sample",
                confirmation: "whole",
                config: args[0].config,
                templateVersion: args[0].templateVersion,
                scenes: [
                  {
                    id: "scene-1",
                    room: "独立测试场景",
                    description: "",
                    asset: "test.jpg",
                    yaw: 0,
                    kind: "panorama",
                    url: property.image,
                  },
                ],
                segments: [
                  {
                    id: "opening",
                    kind: "opening",
                    sceneId: "scene-1",
                    text: "这是内置测试房源。",
                  },
                  {
                    id: "scene-1",
                    kind: "scene",
                    sceneId: "scene-1",
                    text: "介绍原全景素材。",
                  },
                  {
                    id: "closing",
                    kind: "closing",
                    sceneId: "scene-1",
                    text: "测试结束。",
                  },
                ],
              };
            throw new Error("Unexpected fixture method " + method);
          },
        },
      });
    },
    { workspace: createInitialWorkspace(), catalog },
  );
}

async function choose(page: Page, label: string, option: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page
    .locator(".ant-select-dropdown")
    .getByText(option, { exact: true })
    .click();
}

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
  await choose(page, "默认本人形象", "本人测试形象");
  await page.getByRole("button", { name: "保存默认配置", exact: true }).click();
  await expect(
    page.getByText("默认制作配置已保存，新视频将使用这些偏好", { exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: /^AI 视频工厂/ }).click();
  await expect(
    page.getByRole("heading", { name: "AI 视频工厂", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator(".factory-selection")
      .getByText("标准房源带看 · 1.0.0", { exact: true }),
  ).toBeVisible();
  await choose(page, "选择房源", "本人房源联调测试");
  await expect(
    page.getByRole("textbox", { name: "第 1 张图片文案", exact: true }),
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
    avatarId: "own-avatar",
  });
  expect(
    calls.find((c: any) => c.method === "panorama.prepare").input,
  ).toMatchObject({
    propertyId: "user-property",
    templateVersion: "1.0.0",
    config: {
      voice: "public-zh",
      ttsProvider: "volcengine",
      avatarId: "own-avatar",
    },
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
