// Browser UI smoke test with injected desktop responses; no paid API calls.
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { createRequire } from "node:module";
import { readFileSync, mkdirSync } from "node:fs";
const require = createRequire(import.meta.url);
const domain = require("../apps/desktop/electron/panorama/domain.cjs");
const picture =
  "data:image/jpeg;base64," +
  readFileSync(
    "output/property-samples/beike-official-pic-verify/living-room-01.jpg",
  ).toString("base64");
mkdirSync("output/template-verification", { recursive: true });
const browser = await chromium.launch({
  executablePath:
    process.env.KEAGENT_CHROME_PATH ||
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
});
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1050 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(
    ({ config, templates, picture }) => {
      const property = {
        id: "beike-ui",
        title: "界面测试房屋",
        areaSqm: 0,
        priceCents: 0,
        layout: "3室1厅",
        description: "仅为界面夹具",
        sellingPoints: [],
      };
      const scenes = ["客厅", "卧室"].map((room, index) => ({
        id: `${index + 1}`.repeat(8) + "-1111-4111-8111-111111111111",
        asset: "a".repeat(64) + ".jpg",
        room,
        description: "",
        kind: "photo",
        yaw: 0,
        url: picture,
      }));
      let tasks = [],
        personal = [],
        drafts = [];
      window.desktop = {
        platform: "win32",
        mode: "test",
        request: async (method, args = []) => {
          const input = args[0] || {};
          if (method === "panorama.capabilities")
            return {
              ffmpeg: true,
              ffprobe: true,
              ai: false,
              volcTts: false,
              volcAvatar: false,
              managedVoices: true,
              beike: true,
              imageExpansion: true,
              voices: [],
              defaultConfig: config,
              templates,
            };
          if (method === "panorama.state")
            return {
              drafts,
              jobs: [],
              properties: [],
              imageTasks: tasks,
              templates: personal,
            };
          if (method === "panorama.beike-import")
            return {
              property,
              scenes,
              materialMode: "expand",
              panoramaAvailability: "not_exposed_by_this_interface",
            };
          if (method === "panorama.image-submit") {
            const task = {
              id: input.scene.id,
              sceneId: input.scene.id,
              status: "PENDING",
            };
            tasks.push(task);
            return task;
          }
          if (method === "panorama.image-refresh") {
            tasks = tasks.map((t) => ({ ...t, status: "SUCCEEDED" }));
            return tasks.map((t) => ({
              ...t,
              result: {
                ...scenes.find((s) => s.id === t.sceneId),
                kind: "expanded",
                approved: false,
              },
            }));
          }
          if (method === "panorama.template-save") {
            const value = {
              id: "user-33333333-3333-4333-8333-333333333333",
              name: input.name,
              version: 1,
              config: Object.fromEntries(
                Object.entries(input.config).filter(
                  ([k]) =>
                    ![
                      "templateId",
                      "materialMode",
                      "voice",
                      "avatarId",
                      "leadSceneId",
                      "coverSceneId",
                      "coverTitle",
                      "agentName",
                      "agentContact",
                    ].includes(k),
                ),
              ),
              updatedAt: new Date().toISOString(),
            };
            personal = [value];
            return value;
          }
          if (method === "panorama.generate") {
            const segments = [
              {
                id: "opening",
                kind: "opening",
                sceneId: input.config.leadSceneId || input.scenes[0].id,
                text: "这是开场审核文案",
              },
              ...input.scenes.map((s) => ({
                id: s.id,
                kind: "scene",
                sceneId: s.id,
                text: `这里是${s.room}。`,
              })),
              {
                id: "closing",
                kind: "closing",
                sceneId: input.config.leadSceneId || input.scenes[0].id,
                text: "欢迎预约实地看房。",
              },
            ];
            const value = {
              id: "draft-ui",
              revision: 1,
              property,
              scenes: input.scenes,
              config: input.config,
              segments,
              templateVersion: "1",
              createdAt: new Date().toISOString(),
            };
            drafts = [value];
            return value;
          }
          throw new Error("Unexpected UI test request: " + method);
        },
      };
    },
    { config: domain.defaultConfig, templates: domain.templates, picture },
  );
  await page.goto(
    (process.env.KEAGENT_TEST_UI_URL || "http://127.0.0.1:5189") + "/#/studio",
  );
  await page.getByRole("heading", { name: "房源视频工作流" }).waitFor();
  await page.getByText("从贝壳开放平台获取房屋素材", { exact: true }).click();
  await page.getByPlaceholder("例如：北京市").fill("北京市");
  await page.locator('input[maxlength="80"]').last().fill("测试区");
  await page.locator('input[maxlength="300"]').fill("仅为界面测试的地址");
  await page.getByRole("button", { name: "获取房屋素材", exact: true }).click();
  await page.getByRole("button", { name: "确 定", exact: true }).click();
  const generate = page.getByRole("button", { name: "生成分段文案，进入审核" });
  assert.ok(await generate.isDisabled());
  await page.getByRole("button", { name: "生成 AI 扩图", exact: true }).click();
  await page.getByRole("button", { name: "确 定", exact: true }).click();
  await page.getByRole("button", { name: "刷新扩图结果" }).click();
  for (const room of ["客厅", "卧室"]) {
    await page.locator(".template-step").filter({ hasText: room }).click();
    await page
      .getByRole("checkbox", { name: "已审核扩图结果，同意标注 AI 示意" })
      .check();
  }
  assert.ok(!(await generate.isDisabled()));
  await page.getByRole("button", { name: "上移当前空间" }).click();
  assert.match(
    await page.locator(".template-step").nth(1).innerText(),
    /1\. 卧室/,
  );
  await page.locator(".template-step").filter({ hasText: "封面" }).click();
  await page.getByRole("combobox", { name: "封面图片" }).click();
  await page
    .locator(".ant-select-dropdown")
    .getByText("客厅", { exact: true })
    .click();
  await page.getByRole("img", { name: "客厅排版预览" }).waitFor();
  await page.getByPlaceholder("界面测试房屋").fill("我的测试封面");
  await page
    .locator(".template-preview-card")
    .getByText("我的测试封面", { exact: true })
    .waitFor();
  await page.getByRole("tab", { name: "公共设置" }).click();
  await page.locator('input[type="color"]').fill("#B84E36");
  await page.getByRole("textbox", { name: "模板名称" }).fill("我的标准带看");
  await page.getByRole("button", { name: "另存模板" }).click();
  await page
    .getByText("已保存到我的模板，可在公共设置中选择", { exact: true })
    .waitFor();
  await page.getByRole("combobox", { name: "成片模板" }).click();
  await page.getByText("我的标准带看 · 我的模板 · v1", { exact: true }).click();
  await generate.click();
  await page.getByRole("tab", { name: "当前段落" }).click();
  await page.locator(".template-step").filter({ hasText: "开场" }).click();
  await page
    .getByRole("textbox", { name: "审核开场文案" })
    .fill("修改后的开场文案");
  await page
    .locator(".template-preview-caption")
    .getByText("修改后的开场文案", { exact: true })
    .waitFor();
  await page.getByText(/^1\. 房源与素材/).click();
  await page.getByPlaceholder("例如：北京市").waitFor({ state: "hidden" });
  await page.waitForTimeout(300);
  await page.screenshot({
    path: "output/template-verification/editor-wide.png",
    fullPage: true,
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    "Editor overflowed horizontally",
  );
  await page.setViewportSize({ width: 1100, height: 1000 });
  await page.screenshot({
    path: "output/template-verification/editor-compact.png",
    fullPage: true,
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    "Compact editor overflowed horizontally",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: routing/review gates, three-pane editor, ordering, cover preview, template save/apply, script editing, and responsive layout",
  );
} finally {
  await browser.close();
}
