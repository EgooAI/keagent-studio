import { expect, test, type Page } from "@playwright/test";

const adminBase = process.env.KEAGENT_ADMIN_TEST_URL || "http://127.0.0.1:5174";

async function fixture(page: Page) {
  const requests: URL[] = [];
  const state = { failUsage: false, empty: false, historicalExpansion: 0 };
  await page.route("**/api/auth/**", (route) =>
    route.fulfill({ json: { token: "fixture-access-token" } }),
  );
  await page.route("**/v1/**", (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    const headers = {
      "access-control-allow-origin": adminBase,
      "access-control-allow-headers": "authorization,content-type",
      "access-control-allow-methods": "GET,OPTIONS",
    };
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, headers, json: body });
    if (route.request().method() === "OPTIONS")
      return route.fulfill({ status: 204, headers });
    if (url.pathname === "/v1/session")
      return json({ userId: "admin", name: "测试管理员", role: "admin" });
    if (url.pathname === "/v1/admin/credits/usage") {
      if (state.failUsage) return json({ message: "统计暂时不可用" }, 503);
      return json({
        items: [
          { op: "opening", spent: 0 },
          { op: "voice_clone", spent: 0 },
          { op: "script", spent: state.empty ? 0 : 15 },
          { op: "tts", spent: state.empty ? 0 : 30 },
          ...(state.historicalExpansion > 0
            ? [{ op: "image_expand", spent: state.historicalExpansion }]
            : []),
        ],
        total: (state.empty ? 0 : 45) + state.historicalExpansion,
      });
    }
    if (url.pathname === "/v1/admin/credits/list") {
      if (url.searchParams.has("ownerId"))
        return json({
          ownerId: "u1",
          lots: [],
          ledger: [
            {
              kind: "capture",
              amount: 0,
              op: "script",
              refId: "文案任务",
              metadata: { spent: 15 },
              createdAt: "2026-11-13T04:00:00Z",
            },
            {
              kind: "hold",
              amount: -20,
              op: "script",
              refId: "文案任务",
              createdAt: "2026-11-13T03:00:00Z",
            },
          ],
        });
      return json({
        items: [
          {
            ownerId: "u1",
            name: "测试用户",
            purchasedAvailable: 85,
            purchasedHeld: 0,
            grantedAvailable: 0,
            grantedHeld: 0,
          },
        ],
        total: 1,
      });
    }
    return json({});
  });
  return { requests, state };
}

test.use({ timezoneId: "America/Los_Angeles" });

test("服务消耗按北京时间默认最近30天，支持范围、空结果和失败重试", async ({
  page,
}) => {
  const { requests, state } = await fixture(page);
  await page.clock.setFixedTime(new Date("2026-11-12T16:30:00Z"));
  await page.goto(adminBase + "/#/admin/credits");
  await expect(page.getByRole("tab", { name: "服务消耗" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByLabel("开始日期")).toHaveValue("2026-10-15");
  await expect(page.getByLabel("结束日期")).toHaveValue("2026-11-13");
  await expect(
    page.getByText("合计消耗 45 积分", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("row", { name: "AI 文案 15", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("row", { name: "MiniMax 开场 0", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("AI 扩图", { exact: false })).toHaveCount(0);

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByLabel("开始日期")).toBeInViewport();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: `.impeccable/review/credits-${width}.png`,
      fullPage: true,
      animations: "disabled",
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByLabel("开始日期").fill("2026-11-13");
  await expect
    .poll(() =>
      requests.some(
        (url) =>
          url.pathname.endsWith("/credits/usage") &&
          url.searchParams.get("from") === "2026-11-13" &&
          url.searchParams.get("to") === "2026-11-13",
      ),
    )
    .toBeTruthy();
  await page.getByLabel("开始日期").fill("2026-11-14");
  await expect(page.getByText("开始日期不能晚于结束日期")).toBeVisible();
  await expect(page.getByRole("button", { name: /^刷\s*新$/ })).toBeDisabled();
  await page.getByLabel("开始日期").fill("");
  await expect(page.getByText("请选择开始和结束日期")).toBeVisible();
  expect(
    requests.some((url) => url.searchParams.get("from") === "2026-11-14"),
  ).toBe(false);

  state.empty = true;
  await page.getByLabel("开始日期").fill("2026-11-01");
  await expect(
    page.getByText("该时间范围内暂无已结算消耗，合计 0 积分"),
  ).toBeVisible();
  state.failUsage = true;
  await page.getByRole("button", { name: /^刷\s*新$/ }).click();
  await expect(page.getByText("服务消耗加载失败")).toBeVisible();
  await expect(
    page.getByText("该时间范围内暂无已结算消耗，合计 0 积分"),
  ).toBeHidden();
  state.failUsage = false;
  state.empty = false;
  await page.getByRole("button", { name: /^重\s*试$/ }).click();
  await expect(
    page.getByText("合计消耗 45 积分", { exact: true }),
  ).toBeVisible();

  state.historicalExpansion = 8;
  await page.getByRole("button", { name: /^刷\s*新$/ }).click();
  await expect(
    page.getByRole("row", { name: "AI 扩图（已下线） 8", exact: true }),
  ).toBeVisible();
});

test("积分流水分别显示真实消耗和余额变动", async ({ page }) => {
  await fixture(page);
  await page.goto(adminBase + "/#/admin/credits");
  await page.getByRole("tab", { name: "用户余额", exact: true }).click();
  await page.getByRole("button", { name: /^明\s*细$/ }).click();
  const drawer = page.getByRole("dialog", { name: "积分明细" });
  await expect(
    drawer.getByRole("columnheader", { name: "实际消耗" }),
  ).toBeVisible();
  const capture = drawer.getByRole("row").filter({ hasText: "capture" });
  await expect(capture.getByRole("cell").nth(1)).toHaveText("0");
  await expect(capture.getByRole("cell").nth(2)).toHaveText("15");
  const hold = drawer.getByRole("row").filter({ hasText: "hold" });
  await expect(hold.getByRole("cell").nth(1)).toHaveText("-20");
  await expect(hold.getByRole("cell").nth(2)).toHaveText("—");
  await page.screenshot({
    path: ".impeccable/review/credits-ledger.png",
    fullPage: true,
    animations: "disabled",
  });
});
