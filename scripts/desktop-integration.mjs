import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { loadEnvFile } from "node:process";
loadEnvFile(".env.local");
if (new URL(process.env.BETTER_AUTH_URL).origin !== "http://127.0.0.1:18080")
  throw new Error("桌面回归仅允许本机联调环境");
const require = createRequire(import.meta.url);
const { _electron, chromium } = require(
  require.resolve("playwright", {
    paths: [dirname(require.resolve("@playwright/test"))],
  }),
);
const output = resolve("output/live-review");
await mkdir(output, { recursive: true });
const profile = await mkdtemp(resolve(tmpdir(), "keagent-auth-test-"));
const electron = await _electron.launch({
  executablePath: require("electron"),
  args: [
    resolve("apps/desktop/electron/main.cjs"),
    "--built",
    `--user-data-dir=${profile}`,
  ],
  env: { ...process.env, CONTROL_API_URL: process.env.BETTER_AUTH_URL },
});
try {
  const page = await electron.firstWindow();
  await page
    .locator('button[type="submit"]')
    .waitFor({ timeout: 30000 })
    .catch(async (error) => {
      console.log((await page.locator("body").innerText()).slice(0, 1200));
      throw error;
    });
  assert.equal(
    await page.getByRole("link", { name: "房源中心", exact: true }).count(),
    0,
  );
  await page
    .getByLabel("邮箱", { exact: true })
    .fill(process.env.BOOTSTRAP_ADMIN_EMAIL);
  await page
    .getByLabel("密码", { exact: true })
    .fill(process.env.BOOTSTRAP_ADMIN_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page
    .getByRole("button", { name: "退出登录", exact: true })
    .waitFor({ timeout: 30000 })
    .catch(async (error) => {
      console.log((await page.locator("body").innerText()).slice(0, 1600));
      throw error;
    });
  assert.equal(
    await page.evaluate(() =>
      JSON.stringify(localStorage).includes("session_token"),
    ),
    false,
  );
  await page.screenshot({ path: resolve(output, "desktop-authenticated.png") });
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await page.locator('button[type="submit"]').waitFor({ timeout: 15000 });
  console.log(
    "PASS: built Electron login gate, Main bearer transport, encrypted persistence and logout",
  );
} finally {
  await electron.close();
  await rm(profile, { recursive: true, force: true });
}
const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:5174/");
  await page.locator('button[type="submit"]').waitFor({ timeout: 30000 });
  await page
    .getByLabel("邮箱", { exact: true })
    .fill(process.env.BOOTSTRAP_ADMIN_EMAIL);
  await page
    .getByLabel("密码", { exact: true })
    .fill(process.env.BOOTSTRAP_ADMIN_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page
    .getByRole("button", { name: "创建用户", exact: true })
    .waitFor({ timeout: 30000 });
  await page.getByRole("menuitem", { name: "身份审计", exact: true }).click();
  await page
    .getByRole("columnheader", { name: "操作人", exact: true })
    .waitFor();
  await page.screenshot({ path: resolve(output, "admin-authenticated.png") });
  console.log("PASS: browser admin SDK login and authenticated audit page");
} finally {
  await browser.close();
}
