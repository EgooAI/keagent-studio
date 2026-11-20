import { expect, test, type Page } from "@playwright/test";
import { createInitialWorkspace } from "../../packages/api-client/src/fixtures";

async function openDesktop(page: Page, initial = "online") {
  await page.clock.install();
  await page.addInitScript(
    ({ workspace, initial }) => {
      const session = {
        userId: "user",
        sessionId: "session",
        name: "内测",
        email: "test@example.test",
        role: "user",
      };
      window.desktop = {
        mode: "authenticated",
        platform: "win32",
        async request(method) {
          if (method === "getWorkspace") return workspace;
          if (method !== "session") return { ok: true, data: {} };
          const state = document.documentElement.dataset;
          state.polls = String(Number(state.polls || 0) + 1);
          const result = state.result ?? initial;
          if (result === "offline") throw new Error("fetch failed");
          if (result === "unavailable")
            return { error: { status: 503, message: "服务暂不可用" } };
          if (result === "revoked")
            return { error: { status: 403, message: "设备已解绑" } };
          if (state.result === "slow")
            await new Promise((resolve) =>
              window.addEventListener("test:release", resolve, { once: true }),
            );
          return session;
        },
      };
    },
    { workspace: createInitialWorkspace(), initial },
  );
  await page.goto("http://127.0.0.1:5183/#/dashboard");
}

test("桌面会话在短暂断网后保留工作台，失效后停在登录页", async ({ page }) => {
  await openDesktop(page);
  const sidebar = page.locator(".sidebar");
  await expect(sidebar).toBeVisible();
  // A remount would discard unsaved component state as well as this marker.
  await sidebar.evaluate((el) => el.setAttribute("data-original", "yes"));
  const tick = async (result: string) => {
    const previous = await page.evaluate((value) => {
      document.documentElement.dataset.result = value;
      return Number(document.documentElement.dataset.polls);
    }, result);
    await page.clock.fastForward(15_000);
    await expect
      .poll(() =>
        page.evaluate(() => Number(document.documentElement.dataset.polls)),
      )
      .toBe(previous + 1);
  };
  await tick("offline");
  await expect(sidebar).toHaveAttribute("data-original", "yes", {
    timeout: 2000,
  });
  await tick("unavailable");
  await expect(sidebar).toHaveAttribute("data-original", "yes");
  await tick("online");
  await expect(sidebar).toHaveAttribute("data-original", "yes");
  await tick("slow");
  const pending = await page.locator("html").getAttribute("data-polls");
  await page.clock.fastForward(30_000);
  await expect(page.locator("html")).toHaveAttribute("data-polls", pending!);
  await page.evaluate(() => window.dispatchEvent(new Event("test:release")));
  await tick("revoked");
  const login = page.getByRole("heading", { name: "登录 KeAgent Studio" });
  await expect(login).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.dataset.result = "online";
  });
  await page.clock.fastForward(30_000);
  await expect(login).toBeVisible();
  // A deliberate sign-in starts monitoring again, including transient failures.
  await page.evaluate(() => {
    document.documentElement.dataset.result = "unavailable";
  });
  await page.getByLabel("邮箱").fill("user@example.test");
  await page.getByLabel("密码", { exact: true }).fill("fixture-password");
  await page.getByRole("button", { name: /^登\s*录$/ }).click();
  await expect(page.getByText("暂时无法连接登录服务，正在重试…")).toBeVisible();
  await tick("online");
  await expect(sidebar).toBeVisible();
});

test("启动时服务不可用会等待验证，用户退出后忽略迟到的会话响应", async ({
  page,
}) => {
  await openDesktop(page, "unavailable");
  await expect(page.getByText("暂时无法连接登录服务，正在重试…")).toBeVisible();
  await expect(page.locator(".sidebar, .login-panel")).toHaveCount(0);
  await page.evaluate(() => {
    document.documentElement.dataset.result = "online";
  });
  await page.clock.fastForward(15_000);
  await expect(page.locator(".sidebar")).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.dataset.result = "slow";
  });
  await page.clock.fastForward(15_000);
  await page.getByRole("button", { name: "用户菜单" }).click();
  await page.getByRole("menuitem", { name: "退出登录" }).click();
  const login = page.getByRole("heading", { name: "登录 KeAgent Studio" });
  await expect(login).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.dataset.result = "online";
    window.dispatchEvent(new Event("test:release"));
  });
  await page.clock.fastForward(30_000);
  await expect(login).toBeVisible();
});
