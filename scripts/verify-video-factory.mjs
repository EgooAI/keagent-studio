// Isolated browser verification of the simple user flow; all desktop responses
// are test fixtures. No paid provider calls or actual publishing.
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const domain = require("../apps/desktop/electron/panorama/domain.cjs");
const catalog = require("../services/cloud/video_templates.json");
const templates = catalog.map((t) => ({
  ...t,
  opening: t.production.config.openingTemplate,
  scene: t.production.config.sceneTemplate,
  closing: t.production.config.closingTemplate,
}));
const picture =
  "data:image/jpeg;base64," +
  readFileSync(
    "output/property-samples/beike-official-pic-verify/living-room-01.jpg",
  ).toString("base64");
mkdirSync("output/factory-verification", { recursive: true });
const browser = await chromium.launch({
  executablePath:
    process.env.KEAGENT_CHROME_PATH ||
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
});
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(
    ({ defaults, templates, picture }) => {
      const property = {
        id: "factory-house",
        title: "整套房源制作测试",
        description: "仅用于界面测试",
        areaSqm: 0,
        priceCents: 0,
        layout: "",
        sellingPoints: [],
        images: [],
      };
      const empty = { ...property, id: "empty-house", title: "缺少素材的房源" };
      const scenes = ["客厅", "卧室"].map((room, index) => ({
        id: `${index + 1}`.repeat(8) + "-1111-4111-8111-111111111111",
        asset: "a".repeat(64) + ".jpg",
        room,
        description: "",
        kind: "photo",
        yaw: 0,
        url: picture,
      }));
      const calls = [];
      window.factoryTestCalls = calls;
      let drafts = [],
        jobs = [];
      window.desktop = {
        platform: "win32",
        mode: "test",
        artifactMedia: {
          request: async (method, input) => {
            calls.push({ method, input });
            return { ok: true, data: { id: "artifact-factory-test" } };
          },
        },
        request: async (method, args = []) => {
          const input = args[0] || {};
          if (method === "panorama.capabilities")
            return {
              ffmpeg: true,
              ffprobe: true,
              managedVoices: false,
              ai: false,
              voices: [{ name: "Test voice", language: "zh-CN" }],
              defaultConfig: defaults,
              templates,
            };
          if (method === "panorama.state")
            return {
              drafts,
              jobs,
              properties: [property, empty],
              templates: [],
              imageTasks: [],
            };
          calls.push({ method, input });
          if (method === "panorama.prepare") {
            await new Promise((resolve) => setTimeout(resolve, 450));
            if (input.propertyId === empty.id)
              throw new Error("这套房源还没有制作图片，请先到房源详情补充素材");
            const segments = [
              {
                id: "opening",
                kind: "opening",
                sceneId: scenes[0].id,
                text: "为您介绍这套房源。",
              },
              ...scenes.map((s, i) => ({
                id: s.id,
                kind: "scene",
                sceneId: s.id,
                text: `第${i + 1}张图片的介绍文案。`,
              })),
              {
                id: "closing",
                kind: "closing",
                sceneId: scenes[0].id,
                text: "欢迎预约实地看房。",
              },
            ];
            const draft = {
              id: "factory-draft",
              revision: 1,
              confirmation: "whole",
              templateVersion: "1",
              createdAt: new Date().toISOString(),
              property,
              scenes,
              segments,
              config: { ...input.config, materialMode: "panorama" },
            };
            drafts = [draft];
            return structuredClone(draft);
          }
          if (method === "panorama.save") {
            const draft = {
              ...drafts[0],
              revision: 2,
              segments: input.segments,
              config: input.config,
            };
            drafts = [draft];
            return structuredClone(draft);
          }
          if (method === "panorama.start") {
            if (input.confirmed !== true)
              throw new Error("Missing overall confirmation");
            const job = {
              ...drafts[0],
              id: "factory-job",
              draftId: "factory-draft",
              draftRevision: drafts[0].revision,
              status: "running",
              stage: "images",
              progress: 12,
            };
            jobs = [job];
            setTimeout(() => {
              jobs = [
                {
                  ...job,
                  status: "succeeded",
                  stage: "cover",
                  progress: 100,
                  duration: 13,
                  coverUrl: picture,
                  videoUrl: "/media/demo-property.mp4",
                },
              ];
            }, 900);
            return structuredClone(job);
          }
          if (method === "panorama.export") return true;
          throw new Error("Unexpected factory request " + method);
        },
      };
    },
    { defaults: domain.defaultConfig, templates, picture },
  );
  const base = process.env.KEAGENT_TEST_UI_URL || "http://127.0.0.1:5189";
  await page.goto(base + "/#/studio");
  await page
    .getByRole("heading", { name: "AI 视频工厂", exact: true })
    .waitFor();
  assert.equal(await page.getByRole("tab").count(), 0);
  assert.equal(await page.getByRole("checkbox").count(), 0);
  assert.equal(await page.locator(".template-layout").count(), 0);
  await page.screenshot({
    path: "output/factory-verification/choose.png",
    fullPage: true,
  });
  await page.getByRole("combobox", { name: "选择视频模板" }).click();
  await page
    .locator(".ant-select-dropdown")
    .getByText("简洁介绍 · 1.0.0", { exact: true })
    .click();
  await page.getByRole("combobox", { name: "选择房源", exact: true }).click();
  await page
    .getByRole("combobox", { name: "选择房源", exact: true })
    .fill("整套房源制作测试");
  await page
    .locator(".ant-select-dropdown")
    .getByText("整套房源制作测试", { exact: true })
    .click();
  await page.getByRole("heading", { name: "正在为这套房源准备文案" }).waitFor();
  await page.getByRole("textbox", { name: "第 1 张图片文案" }).waitFor();
  assert.equal(await page.locator(".factory-image-script").count(), 2);
  assert.match(
    await page.getByRole("textbox", { name: "第 1 张图片文案" }).inputValue(),
    /第1张/,
  );
  assert.match(
    await page.getByRole("textbox", { name: "第 2 张图片文案" }).inputValue(),
    /第2张/,
  );
  let calls = await page.evaluate(() => window.factoryTestCalls);
  assert.equal(calls.filter((c) => c.method === "panorama.prepare").length, 1);
  assert.equal(calls[0].input.config.templateId, "concise");
  assert.equal(calls[0].input.templateVersion, "1.0.0");
  assert.equal(calls.filter((c) => c.method === "panorama.start").length, 0);
  await page
    .getByRole("textbox", { name: "第 2 张图片文案" })
    .fill("这是我修改后的第二张图片介绍。");
  await page.getByRole("heading", { name: "AI 视频工厂", exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "output/factory-verification/ready.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1100, height: 950 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await page.screenshot({
    path: "output/factory-verification/ready-compact.png",
    fullPage: true,
  });
  await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find((b) =>
      b.textContent.includes("确认文案，开始生成"),
    );
    button.click();
    button.click();
  });
  await page.getByRole("heading", { name: "正在把这套房源变成视频" }).waitFor();
  await page.getByRole("region", { name: "生成的视频" }).waitFor();
  await page.getByRole("button", { name: "保存到发布中心" }).click();
  await page.getByRole("link", { name: "前往发布中心" }).waitFor();
  calls = await page.evaluate(() => window.factoryTestCalls);
  assert.equal(calls.filter((c) => c.method === "panorama.start").length, 1);
  assert.equal(
    calls.find((c) => c.method === "panorama.save").input.segments[2].text,
    "这是我修改后的第二张图片介绍。",
  );
  assert.equal(calls.filter((c) => c.method === "producer.register").length, 1);
  assert.equal(
    calls.some((c) => c.method === "panorama.image-submit"),
    false,
  );
  await page.getByRole("heading", { name: "AI 视频工厂", exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForFunction(
    () => document.querySelector("video")?.readyState >= 2,
  );
  await page.screenshot({
    path: "output/factory-verification/finished.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "再制作一条" }).click();
  await page.getByRole("combobox", { name: "选择房源", exact: true }).click();
  await page
    .getByRole("combobox", { name: "选择房源", exact: true })
    .fill("缺少素材的房源");
  await page
    .locator(".ant-select-dropdown")
    .getByText("缺少素材的房源", { exact: true })
    .click();
  await page
    .getByText("这套房源还没有制作图片，请先到房源详情补充素材", {
      exact: true,
    })
    .waitFor();
  assert.ok(await page.getByRole("link", { name: "查看房源素材" }).isVisible());
  assert.deepEqual(errors, []);
  console.log(
    "PASS: two choices, automatic ordered scripts, one confirmation, edited text, duplicate-click protection, completion, publishing registration, missing-material recovery and responsive layout",
  );
} finally {
  await browser.close();
}
