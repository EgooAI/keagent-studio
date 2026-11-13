import { expect, test } from "@playwright/test";
import { createInitialWorkspace } from "../../packages/api-client/src/fixtures";

test.use({ actionTimeout: 10000 });

test("删除房源可取消，卡片、表格和详情均可删除且刷新后保持", async ({
  page,
}) => {
  await page.goto("/#/properties");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const cards = page.locator(".property-card");
  await expect(cards).toHaveCount(8);
  const original = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("keagent.demo.workspace.v1")!),
  );
  await cards.first().getByRole("button", { name: "删除房源" }).click();
  const dialog = page.getByRole("dialog", { name: "删除房源？" });
  await expect(dialog).toContainText(original.properties[0].propertyNumber);
  await dialog.getByRole("button", { name: /^取\s*消$/ }).click();
  await expect(dialog).toBeHidden();
  await expect(cards).toHaveCount(8);
  for (const width of [1440, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({
      path: `.impeccable/review/property-delete-${width}.png`,
      fullPage: true,
      animations: "disabled",
    });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  }
  await cards.first().getByRole("button", { name: "删除房源" }).click();
  await dialog.getByRole("button", { name: "确认删除" }).click();
  await expect(cards).toHaveCount(7);
  await page.reload();
  await expect(cards).toHaveCount(7);
  const after = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("keagent.demo.workspace.v1")!),
  );
  expect(after.tasks).toEqual(original.tasks);
  expect(after.publishTasks).toEqual(original.publishTasks);
  expect(
    after.properties.some(
      (p: { id: string }) => p.id === original.properties[0].id,
    ),
  ).toBe(false);

  await page
    .locator(".ant-segmented-item")
    .filter({ hasText: "表格视图" })
    .click();
  await page.getByRole("button", { name: "删除房源" }).first().click();
  await dialog.getByRole("button", { name: "确认删除" }).click();
  await expect(page.getByText("共 6 套房源")).toBeVisible();
  await page.locator(".table-property").first().click();
  await expect(page).toHaveURL(/#\/properties\/property-/);
  await expect(page.getByRole("button", { name: "编辑房源" })).toBeVisible();
  await page.getByRole("button", { name: "删除房源" }).click();
  await dialog.getByRole("button", { name: "确认删除" }).click();
  await expect(page).toHaveURL(/#\/properties$/);
  await expect(page.getByText("共 5 套房源")).toBeVisible();
});

test("服务拒绝删除时保留房源并支持重试", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const state = createInitialWorkspace();
  let reject = true;
  const ids: string[] = [];
  await page.route("**/api/auth/**", (route) =>
    route.fulfill({ json: { token: "fixture-token" } }),
  );
  await page.route("**/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const headers = {
      "access-control-allow-origin": "http://127.0.0.1:5183",
      "access-control-allow-headers": "authorization,content-type",
      "access-control-allow-methods": "GET,POST,OPTIONS",
    };
    if (route.request().method() === "OPTIONS")
      return route.fulfill({ status: 204, headers });
    if (path === "/v1/session")
      return route.fulfill({
        headers,
        json: { userId: "owner", role: "user", name: "经纪人" },
      });
    if (path === "/v1/workspace")
      return route.fulfill({ headers, json: state });
    if (path === "/v1/commands/deleteProperty") {
      const [id] = route.request().postDataJSON();
      ids.push(id);
      if (reject)
        return route.fulfill({
          headers,
          status: 503,
          json: { error: { message: "暂时无法删除，请重试" } },
        });
      state.properties = state.properties.filter((p) => p.id !== id);
      return route.fulfill({ headers, json: { id } });
    }
    return route.fulfill({ headers, json: {} });
  });
  await page.goto("http://127.0.0.1:5183/#/properties");
  await page
    .locator(".property-card")
    .first()
    .getByRole("button", { name: "删除房源" })
    .click();
  const dialog = page.getByRole("dialog", { name: "删除房源？" });
  await dialog.getByRole("button", { name: "确认删除" }).click();
  await expect(
    page.getByText("暂时无法删除，请重试", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".property-card")).toHaveCount(8);
  await expect(dialog).toBeVisible();
  reject = false;
  await dialog.getByRole("button", { name: "确认删除" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".property-card")).toHaveCount(7);
  expect(ids).toEqual(["property-1", "property-1"]);
  expect(errors).toEqual([]);
});
