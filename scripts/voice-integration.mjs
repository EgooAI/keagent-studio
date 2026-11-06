import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { loadEnvFile } from "node:process";
import { tmpdir } from "node:os";
loadEnvFile(".env.local");
assert.equal(
  new URL(process.env.BETTER_AUTH_URL).origin,
  "http://127.0.0.1:18080",
  "Local development only",
);
const require = createRequire(import.meta.url);
const { _electron, chromium } = require(
  require.resolve("playwright", {
    paths: [dirname(require.resolve("@playwright/test"))],
  }),
);
const output = resolve("output/voice-review");
await mkdir(output, { recursive: true });
const credentials = {
  email: process.env.DEV_USER_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL,
  password:
    process.env.DEV_USER_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD,
};
async function login(page, account = credentials) {
  await page.getByLabel("邮箱", { exact: true }).fill(account.email);
  await page.getByLabel("密码", { exact: true }).fill(account.password);
  await page.locator('button[type="submit"]').click();
  await page
    .getByRole("button", { name: "退出登录", exact: true })
    .waitFor({ timeout: 30000 });
}
function sampleWAV(seconds = 12) {
  const length = seconds * 48000;
  const data = Buffer.alloc(44 + length);
  data.write("RIFF");
  data.writeUInt32LE(36 + length, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(24000, 24);
  data.writeUInt32LE(48000, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(length, 40);
  for (let i = 0; i < length / 2; i++)
    data.writeInt16LE(
      Math.round(Math.sin((i * 440 * 2 * Math.PI) / 24000) * 5000),
      44 + i * 2,
    );
  return data;
}
const profile = await mkdtemp(resolve(tmpdir(), "keagent-voice-check-"));
const electron = await _electron.launch({
  executablePath: require("electron"),
  args: [
    resolve("apps/desktop/electron/main.cjs"),
    "--built",
    "--hidden",
    `--user-data-dir=${profile}`,
  ],
  env: { ...process.env },
});
let activePage;
try {
  const page = await electron.firstWindow();
  activePage = page;
  await login(page);
  await page.getByRole("link", { name: "设置", exact: true }).click();
  await page.getByRole("tab", { name: "声音与音色", exact: true }).click();
  await page
    .getByRole("heading", { name: "我的专属音色", exact: true })
    .waitFor();
  const catalog = await page.evaluate(() =>
    window.desktop.request("voice.list"),
  );
  if (!catalog.cloneEnabled) {
    await page.getByText("声音复刻尚未开通", { exact: true }).waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "上传本人声音", exact: true })
        .isDisabled(),
      true,
    );
    // Verify the larger IPC/HTTP envelope reaches the backend, without calling a paid provider.
    const result = await page.evaluate(async (audio) => {
      try {
        await window.desktop.request("voice.create", [
          {
            name: "Upload envelope check",
            language: "zh-CN",
            authorized: true,
            format: "wav",
            audio,
            requestKey: crypto.randomUUID(),
          },
        ]);
        return "unexpected success";
      } catch (error) {
        return error.message;
      }
    }, sampleWAV(25).toString("base64"));
    assert.match(result, /尚未开通声音复刻/);
  }
  assert.ok(Array.isArray(catalog.publicVoices));
  assert.equal(catalog.cloudVoice, undefined);
  await page.getByRole("tab", { name: "人物形象", exact: true }).click();
  await page
    .getByRole("heading", { name: "我的人物形象", exact: true })
    .waitFor();
  const avatars = await page.evaluate(() =>
    window.desktop.request("avatar.list"),
  );
  if (!avatars.uploadEnabled)
    assert.equal(
      await page
        .getByRole("button", { name: "上传本人照片", exact: true })
        .isDisabled(),
      true,
    );
  await page.screenshot({ path: resolve(output, "own-photo-required.png") });
  await electron.evaluate(() => {
    const original = globalThis.fetch;
    globalThis.fetch = (...args) =>
      String(args[0]).endsWith("/v1/voices/list")
        ? Promise.resolve(
            Response.json({
              cloneEnabled: true,
              cloudEnabled: false,
              publicVoices: [],
              voices: [
                {
                  id: "fixture-owned-voice",
                  name: "工厂音色选择夹具",
                  language: "zh-CN",
                  status: "ready",
                  createdAt: new Date().toISOString(),
                },
              ],
            }),
          )
        : original(...args);
  });
  await page.getByRole("link", { name: "AI 视频工厂", exact: true }).click();
  const provider = page
    .locator(".ant-form-item")
    .filter({ has: page.getByText("配音服务", { exact: true }) });
  await provider.getByRole("combobox").click();
  await page.getByText("我的专属音色", { exact: true }).last().click();
  await page.getByText("工厂音色选择夹具", { exact: true }).waitFor();
  await page.screenshot({
    path: resolve(output, "factory-personal-voice-fixture.png"),
  });
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  console.log(
    "PASS: real Electron login, admin-managed voice catalog, >1MB upload envelope, missing-config and required-photo UI; factory personal-voice selection uses a catalog fixture",
  );
} catch (error) {
  if (activePage) {
    await activePage
      .screenshot({ path: resolve(output, "failure.png") })
      .catch(() => {});
    console.log((await activePage.locator("body").innerText()).slice(-2500));
    console.log(
      await activePage.locator("audio").evaluateAll((elements) =>
        elements.map((audio) => ({
          src: audio.src,
          ready: audio.readyState,
          error: audio.error?.message,
        })),
      ),
    );
  }
  throw error;
} finally {
  await electron.close();
  assert.ok(profile.startsWith(resolve(tmpdir(), "keagent-voice-check-")));
  await rm(profile, { recursive: true, force: true });
}

const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  const voices = [];
  const avatars = [];
  let creates = 0;
  const preview = sampleWAV(1).toString("base64");
  const photo = Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 32;
      canvas.height = 32;
      const context = canvas.getContext("2d");
      context.fillStyle = "#722ed1";
      context.fillRect(0, 0, 32, 32);
      return canvas.toDataURL("image/png").split(",")[1];
    }),
    "base64",
  );
  await page.route("**/v1/avatars/*", async (route) => {
    const operation = new URL(route.request().url()).pathname.split("/").at(-1);
    const input = route.request().postDataJSON();
    if (operation === "list")
      return route.fulfill({ json: { avatars, uploadEnabled: true } });
    if (operation === "create") {
      assert.equal(input.authorized, true);
      assert.equal(input.photo, photo.toString("base64"));
      const avatar = {
        id: "fixture-own-photo",
        name: input.name,
        status: "ready",
        createdAt: new Date().toISOString(),
      };
      avatars.push(avatar);
      return route.fulfill({ json: avatar });
    }
    if (operation === "preview")
      return route.fulfill({
        json: { photo: photo.toString("base64"), mime: "image/png" },
      });
    throw new Error("Unexpected avatar fixture operation " + operation);
  });
  await page.route("**/v1/voices/*", async (route) => {
    const operation = new URL(route.request().url()).pathname.split("/").at(-1);
    const input = route.request().postDataJSON();
    if (operation === "list")
      return route.fulfill({
        json: {
          voices,
          cloneEnabled: true,
          cloudEnabled: true,
          publicVoices: [
            { id: "fixture-public", name: "公共音色夹具", language: "zh-CN" },
          ],
        },
      });
    if (operation === "create") {
      creates++;
      assert.equal(input.authorized, true);
      assert.equal(input.format, "wav");
      assert.ok(input.audio.length > 1000);
      assert.ok(input.requestKey);
      const voice = {
        id: "fixture-owned-voice",
        name: input.name,
        language: input.language,
        status: "processing",
        createdAt: new Date().toISOString(),
      };
      voices.push(voice);
      return route.fulfill({ json: voice });
    }
    if (operation === "refresh") {
      voices[0].status = "ready";
      return route.fulfill({ json: voices[0] });
    }
    if (operation === "preview" || operation === "preview-public")
      return route.fulfill({ json: { audio: preview, mime: "audio/wave" } });
    throw new Error("Unexpected fixture operation " + operation);
  });
  await page.goto("http://127.0.0.1:5173/");
  await login(page);
  await page.getByRole("link", { name: "设置", exact: true }).click();
  await page.getByRole("tab", { name: "声音与音色", exact: true }).click();
  await page.getByRole("combobox", { name: "公共音色", exact: true }).click();
  await page.getByText("公共音色夹具", { exact: true }).last().click();
  await page.getByRole("button", { name: "试听公共音色", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector("audio")?.readyState >= 2,
  );
  await page.getByRole("button", { name: "上传本人声音", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator("input.ant-input").fill("夹具验证音色");
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "own-recording.wav",
    mimeType: "audio/wav",
    buffer: sampleWAV(),
  });
  await dialog
    .getByRole("button", { name: "own-recording.wav", exact: true })
    .waitFor();
  await dialog.getByRole("checkbox").check();
  await dialog
    .getByRole("button", { name: "提交声音复刻", exact: true })
    .click();
  await page.getByText("正在复刻", { exact: true }).waitFor();
  assert.equal(creates, 1);
  await page.getByRole("button", { name: "刷新状态", exact: true }).click();
  await page.getByText("可使用", { exact: true }).waitFor();
  await page.getByRole("button", { name: "试听本人音色", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector("audio")?.readyState >= 2,
  );
  await page.screenshot({
    path: resolve(output, "personal-voice-fixture.png"),
  });
  await page.getByRole("tab", { name: "人物形象", exact: true }).click();
  await page.getByRole("button", { name: "上传本人照片", exact: true }).click();
  const photoDialog = page.getByRole("dialog");
  await photoDialog.locator("input.ant-input").fill("本人照片上传夹具");
  await photoDialog.locator('input[type="file"]').setInputFiles({
    name: "own-photo.png",
    mimeType: "image/png",
    buffer: photo,
  });
  await photoDialog.getByRole("checkbox").check();
  await photoDialog
    .getByRole("button", { name: "保存本人形象", exact: true })
    .click();
  await page.getByText("照片已保存", { exact: true }).waitFor();
  await page.getByRole("button", { name: "查看本人照片", exact: true }).click();
  await page
    .getByRole("img", { name: "本人上传的形象照片", exact: true })
    .waitFor();
  await page.screenshot({
    path: resolve(output, "uploaded-own-photo-fixture.png"),
  });
  await page.getByRole("dialog").locator("button.ant-modal-close").click();
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  console.log(
    "PASS: browser fixtures exercise public-voice playback, recording upload/status, and own-photo upload/preview (no paid calls)",
  );
  const admin = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  const presets = [];
  await admin.route("**/v1/admin/voices", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: presets });
    const input = route.request().postDataJSON();
    const prior = presets.find((item) => item.id === input.id);
    const voice = {
      ...input,
      id: input.id || "fixture-managed-preset",
      publishedOnce: prior?.publishedOnce || !!input.enabled,
    };
    if (prior) Object.assign(prior, voice);
    else presets.push(voice);
    return route.fulfill({ json: voice });
  });
  await admin.goto("http://127.0.0.1:5174/#/admin/ai?tab=voices");
  await login(admin, {
    email: process.env.BOOTSTRAP_ADMIN_EMAIL,
    password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
  });
  await admin.goto("http://127.0.0.1:5174/#/admin/ai?tab=voices");
  await admin.getByRole("tab", { name: "公共音色", exact: true }).click();
  await admin
    .getByRole("button", { name: "新增公共音色", exact: true })
    .click();
  const editor = admin.getByRole("dialog");
  await editor.getByLabel("音色名称", { exact: true }).fill("后台公共音色夹具");
  await editor
    .getByLabel("火山公共音色编号", { exact: true })
    .fill("zh_female_fixture");
  await editor.getByRole("button", { name: "确 定" }).click();
  const row = admin.getByRole("row").filter({ hasText: "后台公共音色夹具" });
  await row.getByRole("button", { name: /^上\s*架$/ }).click();
  await row.getByText("已上架", { exact: true }).waitFor();
  await row.getByRole("button", { name: /^编\s*辑$/ }).click();
  assert.equal(
    await admin
      .getByRole("dialog")
      .getByLabel("火山公共音色编号", { exact: true })
      .isDisabled(),
    true,
  );
  await admin.getByRole("dialog").locator("button.ant-modal-close").click();
  await admin.getByRole("dialog").waitFor({ state: "hidden" });
  await row.getByRole("button", { name: /下\s*架/ }).click();
  await row.getByText("未上架", { exact: true }).waitFor();
  await admin.screenshot({
    path: resolve(output, "admin-public-voices-fixture.png"),
  });
  await admin.getByRole("button", { name: "退出登录", exact: true }).click();
  console.log(
    "PASS: admin UI fixtures cover catalog creation, publish/unpublish and immutable published provider fields",
  );
} catch (error) {
  const lastPage = browser
    .contexts()
    .flatMap((context) => context.pages())
    .at(-1);
  if (lastPage) {
    await lastPage
      .screenshot({ path: resolve(output, "browser-failure.png") })
      .catch(() => {});
    console.log((await lastPage.locator("body").innerText()).slice(-3000));
  }
  throw error;
} finally {
  await browser.close();
}
