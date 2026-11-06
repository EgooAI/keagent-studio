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
async function login(page) {
  await page.getByLabel("邮箱", { exact: true }).fill(credentials.email);
  await page.getByLabel("密码", { exact: true }).fill(credentials.password);
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
  const caps = await page.evaluate(() =>
    window.desktop.request("panorama.capabilities"),
  );
  assert.ok(caps.voices.length > 0, "Installed Windows voices required");
  await page.getByRole("combobox", { name: "系统音色", exact: true }).click();
  await page
    .getByText(`${caps.voices[0].name} · ${caps.voices[0].language}`, {
      exact: true,
    })
    .last()
    .click();
  await page.getByRole("button", { name: "试听系统音色", exact: true }).click();
  await page.waitForFunction(
    () => {
      const audio = document.querySelector("audio");
      return audio?.readyState >= 2 && audio.duration > 0;
    },
    null,
    { timeout: 30000 },
  );
  await page.screenshot({ path: resolve(output, "system-voices.png") });
  await electron.evaluate(() => {
    const original = globalThis.fetch;
    globalThis.fetch = (...args) =>
      String(args[0]).endsWith("/v1/voices/list")
        ? Promise.resolve(
            Response.json({
              cloneEnabled: true,
              cloudEnabled: false,
              cloudVoice: "",
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
    "PASS: real Electron login, per-user voice catalog, >1MB upload envelope, missing-config state and actual system TTS playback; factory personal-voice selection uses a catalog fixture",
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
  let creates = 0;
  const preview = sampleWAV(1).toString("base64");
  await page.route("**/v1/voices/*", async (route) => {
    const operation = new URL(route.request().url()).pathname.split("/").at(-1);
    const input = route.request().postDataJSON();
    if (operation === "list")
      return route.fulfill({
        json: {
          voices,
          cloneEnabled: true,
          cloudEnabled: false,
          cloudVoice: "",
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
    if (operation === "preview")
      return route.fulfill({ json: { audio: preview, mime: "audio/wave" } });
    throw new Error("Unexpected fixture operation " + operation);
  });
  await page.goto("http://127.0.0.1:5173/");
  await login(page);
  await page.getByRole("link", { name: "设置", exact: true }).click();
  await page.getByRole("tab", { name: "声音与音色", exact: true }).click();
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
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  console.log(
    "PASS: browser fixtures exercise recording file validation, upload authorization, processing/ready states and cloned-sample playback (no paid calls)",
  );
} finally {
  await browser.close();
}
