import { expect, test } from "@playwright/test";
import { createInitialWorkspace } from "../../packages/api-client/src/fixtures";

test.use({ timezoneId: "America/Los_Angeles" });

test("桌面端可按日期查看本人服务消耗，并显示流水实际消耗", async ({ page }) => {
  const base = "http://127.0.0.1:5183";
  const requests: URL[] = [];
  let failUsage = false;
  let empty = false;
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
    if (url.pathname === "/v1/credits/usage") {
      if (failUsage) return json({ error: { message: "统计暂时不可用" } }, 503);
      return json({
        items: [
          { op: "opening", spent: 0 },
          { op: "voice_clone", spent: 0 },
          { op: "script", spent: empty ? 0 : 15 },
          { op: "tts", spent: empty ? 0 : 30 },
          { op: "image_expand", spent: 0 },
        ],
        total: empty ? 0 : 45,
      });
    }
    if (url.pathname === "/v1/credits")
      return json({
        purchased: { available: 100, held: 0 },
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
  await page.goto(base + "/#/settings/credits");
  const usage = page.getByRole("region", { name: "服务消耗", exact: true });
  await expect(usage.getByLabel("开始日期")).toHaveValue("2026-10-15");
  await expect(usage.getByLabel("结束日期")).toHaveValue("2026-11-13");
  await expect(
    usage.getByText("合计消耗 45 积分", { exact: true }),
  ).toBeVisible();
  await expect(
    usage.getByRole("row", { name: "AI 文案 15", exact: true }),
  ).toBeVisible();
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
});
