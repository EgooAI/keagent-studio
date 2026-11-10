import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { loadEnvFile } from "node:process";
import { setTimeout as delay } from "node:timers/promises";
loadEnvFile(".env.local");
if (new URL(process.env.BETTER_AUTH_URL).origin !== "http://127.0.0.1:18080")
  throw new Error("Only local integration is allowed");
const require = createRequire(import.meta.url);
const { _electron } = require(
  require.resolve("playwright", {
    paths: [dirname(require.resolve("@playwright/test"))],
  }),
);
const output = resolve("output/panorama-desktop-review");
await mkdir(output, { recursive: true });
const profile = await mkdtemp(resolve(output, "profile-"));
const electron = await _electron.launch({
  executablePath: require("electron"),
  args: [
    resolve("apps/desktop/electron/main.cjs"),
    "--built",
    "--hidden",
    `--user-data-dir=${profile}`,
  ],
  env: { ...process.env, CONTROL_API_URL: process.env.BETTER_AUTH_URL },
});
try {
  const page = await electron.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page
    .getByLabel("邮箱", { exact: true })
    .fill(process.env.BOOTSTRAP_ADMIN_EMAIL);
  await page
    .getByLabel("密码", { exact: true })
    .fill(process.env.BOOTSTRAP_ADMIN_PASSWORD);
  await page.locator('button[type="submit"]').click();
  // This isolated Electron process uses a catalog and test tone fixture. Never
  // call paid speech providers from a media/rendering regression test.
  await electron.evaluate(() => {
    const original = globalThis.fetch;
    globalThis.fetch = (...args) => {
      const url = String(args[0]);
      if (url.endsWith("/v1/voices/list"))
        return Promise.resolve(
          Response.json({
            cloudEnabled: true,
            cloneEnabled: false,
            voices: [],
            publicVoices: [
              {
                id: "fixture-test-tone",
                name: "媒体回归测试音",
                language: "zh-CN",
              },
            ],
          }),
        );
      if (url.endsWith("/v1/panorama/capabilities"))
        return Promise.resolve(
          Response.json({
            ai: false,
            volcTts: true,
            minimaxOpening: false,
            managedVoices: true,
          }),
        );
      if (url.endsWith("/v1/panorama/tts")) {
        const pcm = Buffer.alloc(48000);
        for (let i = 0; i < 24000; i++)
          pcm.writeInt16LE(
            Math.round(Math.sin((i * 440 * 2 * Math.PI) / 24000) * 3000),
            i * 2,
          );
        return Promise.resolve(Response.json({ pcm: pcm.toString("base64") }));
      }
      if (
        /\/v1\/panorama\/(script|opening-submit|opening-query)$/.test(url)
      )
        throw new Error(
          "Paid provider calls are forbidden in the media regression",
        );
      return original(...args);
    };
  });
  await page.getByRole("link", { name: /^AI 视频工厂/ }).click();
  await page.getByRole("heading", { name: "全景视频工作流" }).waitFor();
  await page.getByRole("button", { name: "使用 CC0 测试素材" }).click();
  await page.locator(".ant-popconfirm-buttons .ant-btn-primary").click();
  await page.getByLabel("空间 1 名称", { exact: true }).waitFor();
  assert.equal(
    await page
      .locator(".panorama-scene img")
      .evaluateAll((images) =>
        images.every((i) => i.complete && i.naturalWidth === 8192),
      ),
    true,
  );
  await page.getByRole("button", { name: "生成分段文案，进入审核" }).click();
  await page.getByLabel("审核开场文案").waitFor();
  await page.getByLabel("审核开场文案").fill("这是全景工作流测试。");
  await page.getByLabel("审核空间文案").nth(0).fill("第一个独立测试空间。");
  await page.getByLabel("审核空间文案").nth(1).fill("第二个独立测试空间。");
  await page.getByLabel("审核结尾文案").fill("本片仅用于开发测试。");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await page.getByText("文案与制作配置已保存", { exact: true }).waitFor();
  await page.screenshot({
    path: resolve(output, "desktop-editor.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1080, height: 800 });
  await page.screenshot({
    path: resolve(output, "compact-editor.png"),
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    ),
    false,
  );
  await page
    .getByRole("button", { name: "确认文案并制作", exact: true })
    .click();
  let state;
  for (let attempt = 0; attempt < 180; attempt++) {
    state = await page.evaluate(() => window.desktop.request("panorama.state"));
    if (state.jobs[0] && state.jobs[0].status !== "running") break;
    await delay(1000);
  }
  assert.equal(state.jobs[0].status, "succeeded", state.jobs[0].error);
  const video = page.locator("video.panorama-video");
  await video.waitFor();
  await page.waitForFunction(
    () => document.querySelector("video.panorama-video")?.readyState >= 1,
  );
  assert.ok(
    await video.evaluate(
      (element) => element.duration > 1 && element.videoWidth === 720,
    ),
  );
  await page.setViewportSize({ width: 1440, height: 940 });
  await page.screenshot({
    path: resolve(output, "desktop-result.png"),
    fullPage: true,
  });
  const localPath = resolve(
    profile,
    "panorama",
    new URL(state.jobs[0].videoUrl).pathname.slice(1),
  );
  const copied = resolve(output, "desktop-generated.mp4");
  await writeFile(copied, await readFile(localPath));
  const result = {
    audio: "Synthetic test tone fixture; no paid TTS or MiniMax requests",
    jobId: state.jobs[0].id,
    duration: state.jobs[0].duration,
    video: copied,
    pageErrors: errors,
  };
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(output, "result.json"),
    JSON.stringify(result, null, 2),
  );
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await page.getByLabel("邮箱", { exact: true }).waitFor();
  assert.equal(
    await electron.evaluate(
      async ({ net }, url) => (await net.fetch(url)).status,
      state.jobs[0].videoUrl,
    ),
    403,
  );
  console.log(JSON.stringify(result));
} finally {
  const page = await electron.firstWindow().catch(() => null);
  await page?.evaluate(() => window.desktop.request("logout")).catch(() => {});
  await electron.close();
}
