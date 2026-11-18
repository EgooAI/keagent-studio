import { expect, test } from "@playwright/test";
import { createInitialWorkspace } from "../../packages/api-client/src/fixtures";

test.use({ timezoneId: "America/Los_Angeles" });

test("桌面侧栏显示可用积分并直达兑换，也可按日期查看实际消耗", async ({
  page,
}) => {
  const base = "http://127.0.0.1:5183";
  const requests: URL[] = [];
  let failUsage = false;
  let empty = false;
  let purchased = 100;
  await page.clock.setFixedTime(new Date("2026-11-12T16:30:00Z"));
  await page.route("**/api/auth/**", (route) =>
    route.fulfill({ json: { token: "fixture-token" } }),
  );
  await page.route("**/v1/**", (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    const headers = {
      "access-control-allow-origin": base,
      "access-control-allow-headers": "authorization,content-type",
      "access-control-allow-methods": "GET,POST,OPTIONS",
    };
    const json = (body: unknown, status = 200) =>
      route.fulfill({ headers, json: body, status });
    if (route.request().method() === "OPTIONS")
      return route.fulfill({ status: 204, headers });
    if (url.pathname === "/v1/session")
      return json({ userId: "u1", name: "测试用户", role: "user" });
    if (url.pathname === "/v1/workspace") return json(createInitialWorkspace());
    if (url.pathname === "/v1/credits/packs")
      return json({
        instructions: "联系试点运营领取兑换码",
        typicalVideoCredits: 150,
        packs: [
          { id: "starter", enabled: true, credits: 300 },
          { id: "regular", enabled: true, credits: 1500, priceFen: 9900 },
        ],
      });
    if (url.pathname === "/v1/credits/usage") {
      if (failUsage) return json({ error: { message: "统计暂时不可用" } }, 503);
      return json({
        items: [
          { op: "opening", spent: 0 },
          { op: "voice_clone", spent: 0 },
          { op: "script", spent: empty ? 0 : 15 },
          { op: "tts", spent: empty ? 0 : 30 },
        ],
        total: empty ? 0 : 45,
      });
    }
    if (url.pathname === "/v1/credits/activity")
      return json({
        hasMore: false,
        ...(url.searchParams.get("taskId") === "video-1"
          ? { totalSpent: 10, estimate: { credits: 15, version: "v3" } }
          : {}),
        items: [
          {
            id: "charge-1",
            taskId: "video-1",
            batchId: "batch-1",
            op: "tts",
            stage: "tts",
            state: "captured",
            unit: "kilo_char",
            quantity: 2,
            characters: 1500,
            unitPrice: 10,
            priceVersion: "v4",
            spent: 10,
            held: 0,
            released: 10,
            releaseReason: "unused",
            createdAt: "2026-11-13T04:00:00Z",
          },
        ],
      });
    if (url.pathname === "/v1/credits/redeem") {
      purchased += 20;
      return json({ amount: 20 });
    }
    if (url.pathname === "/v1/credits")
      return json({
        purchased: { available: purchased, held: 20 },
        granted: { available: 50, held: 0 },
        ledger: [
          {
            kind: "capture",
            amount: 0,
            op: "script",
            metadata: { spent: 15 },
            createdAt: "2026-11-13T04:00:00Z",
          },
          {
            kind: "hold",
            amount: -20,
            op: "script",
            createdAt: "2026-11-13T03:00:00Z",
          },
        ],
      });
    return json({});
  });
  await page.goto(base + "/#/dashboard");
  const sidebar = page.getByRole("complementary");
  const userMenu = sidebar.getByRole("button", { name: "用户菜单" });
  const redeemLink = sidebar.getByRole("link", { name: "积分兑换" });
  await expect(userMenu).toHaveAccessibleDescription(/可用积分\s*150/);
  await page.setViewportSize({ width: 600, height: 900 });
  await expect(userMenu.getByText("150", { exact: true })).toBeVisible();
  await redeemLink.click();
  await expect(page).toHaveURL(/#\/settings\/credits$/);
  await expect(redeemLink).toHaveAttribute("aria-current", "page");
  const packs = page.getByRole("region", { name: "试点积分包" });
  await expect(packs.getByText("约 2 条普通房源视频")).toBeVisible();
  await expect(packs.getByText("约 10 条普通房源视频")).toBeVisible();
  await expect(packs.getByText(/MiniMax 开场单独计费/)).toBeVisible();
  await expect(packs.getByText("联系试点运营领取兑换码")).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("textbox", { name: "兑换码" }).fill("TEST-CREDIT-CODE");
  await page.getByRole("button", { name: /^兑\s*换$/ }).click();
  await expect(userMenu).toHaveAccessibleDescription(/可用积分\s*170/);

  const usage = page.getByRole("region", { name: "服务消耗", exact: true });
  await expect(usage.getByLabel("开始日期")).toHaveValue("2026-10-15");
  await expect(usage.getByLabel("结束日期")).toHaveValue("2026-11-13");
  await expect(
    usage.getByText("合计消耗 45 积分", { exact: true }),
  ).toBeVisible();
  await expect(
    usage.getByRole("row", { name: "AI 文案 15", exact: true }),
  ).toBeVisible();
  await expect(usage.getByText("AI 扩图", { exact: false })).toHaveCount(0);
  await expect(usage.getByText(/仅统计你的实际消耗/)).toBeVisible();
  for (const width of [1440, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.screenshot({
      path: `.impeccable/review/desktop-credits-${width}.png`,
      fullPage: true,
      animations: "disabled",
    });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  }
  const ledger = page
    .getByRole("table")
    .filter({ has: page.getByRole("columnheader", { name: "实际消耗" }) });
  await ledger.scrollIntoViewIfNeeded();
  const capture = ledger
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name: "消耗", exact: true }) });
  await expect(capture.getByRole("cell").nth(1)).toHaveText("+0");
  await expect(capture.getByRole("cell").nth(2)).toHaveText("15");
  await expect(capture.getByRole("cell").nth(3)).toHaveText("AI 文案");
  await usage.getByLabel("开始日期").fill("2026-11-13");
  await expect
    .poll(() =>
      requests.some(
        (url) =>
          url.pathname === "/v1/credits/usage" &&
          url.searchParams.get("from") === "2026-11-13" &&
          url.searchParams.get("to") === "2026-11-13",
      ),
    )
    .toBeTruthy();
  await usage.getByLabel("开始日期").fill("2026-11-14");
  await expect(usage.getByText("开始日期不能晚于结束日期")).toBeVisible();
  await expect(
    usage.getByRole("button", { name: "刷新服务消耗" }),
  ).toBeDisabled();
  await usage.getByLabel("开始日期").fill("");
  await expect(usage.getByText("请选择开始和结束日期")).toBeVisible();
  empty = true;
  await usage.getByLabel("开始日期").fill("2026-11-01");
  await expect(
    usage.getByText("该时间范围内暂无已结算消耗，合计 0 积分"),
  ).toBeVisible();
  failUsage = true;
  await usage.getByRole("button", { name: "刷新服务消耗" }).click();
  await expect(usage.getByText("服务消耗加载失败")).toBeVisible();
  failUsage = false;
  empty = false;
  await usage.getByRole("button", { name: /^重\s*试$/ }).click();
  await expect(
    usage.getByText("合计消耗 45 积分", { exact: true }),
  ).toBeVisible();
  expect(requests.some((url) => url.pathname.startsWith("/v1/admin/"))).toBe(
    false,
  );

  const activity = page.getByRole("region", { name: "任务账单" });
  await activity.getByRole("link", { name: "任务 video-1" }).click();
  await expect(page).toHaveURL(/#\/settings\/credits\?taskId=video-1$/);
  await expect(
    activity.getByText("视频任务账单", { exact: true }),
  ).toBeVisible();
  await expect(
    activity.getByText(/当前已结算 10 积分.*预估 15 积分/),
  ).toBeVisible();
  await expect(activity.getByText(/1,500 字符.*2 千字符/)).toBeVisible();
  await expect(activity.getByText("价目 v4")).toBeVisible();
  await expect(activity.getByText(/退回 10 积分.*未使用/)).toBeVisible();
  await expect
    .poll(() =>
      requests.some(
        (url) =>
          url.pathname === "/v1/credits/activity" &&
          url.searchParams.get("taskId") === "video-1",
      ),
    )
    .toBeTruthy();
});
