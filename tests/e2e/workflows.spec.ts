import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "林悦的创作工作台" }),
  ).toBeVisible();
});

test("房源选择跨筛选保留，取消不覆盖确认值，刷新恢复草稿", async ({ page }) => {
  await page.getByRole("link", { name: /^AI 视频工厂/ }).click();
  await page.getByRole("button", { name: /选择要生成视频的房源/ }).click();
  const dialog = page.getByRole("dialog", { name: "选择房源", exact: true });
  await dialog
    .getByRole("checkbox", { name: "仁恒滨江园", exact: true })
    .check();
  await dialog
    .getByRole("checkbox", { name: "万科翡翠滨江", exact: true })
    .check();
  await dialog.getByRole("tab", { name: /^已发布过/ }).click();
  await expect(
    dialog.getByRole("checkbox", { name: "仁恒滨江园", exact: true }),
  ).toBeChecked();
  await dialog.getByRole("button", { name: /确认选择（2）/ }).click();
  await page.getByRole("button", { name: /已选择 2 套房源/ }).click();
  await dialog.getByRole("button", { name: "清空选择", exact: true }).click();
  await dialog.getByRole("button", { name: /^取\s*消$/ }).click();
  await expect(
    page.getByRole("button", { name: /已选择 2 套房源/ }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: /已选择 2 套房源/ }),
  ).toBeVisible();
});

test("多房源独立生成、人工审核、成片与多平台草稿闭环", async ({ page }) => {
  await page.goto("/#/studio");
  await page.getByRole("button", { name: /选择要生成视频的房源/ }).click();
  const dialog = page.getByRole("dialog", { name: "选择房源", exact: true });
  for (const name of ["仁恒滨江园", "万科翡翠滨江", "绿地海珀黄浦"])
    await dialog.getByRole("checkbox", { name, exact: true }).check();
  await dialog.getByRole("button", { name: /确认选择（3）/ }).click();
  await page.getByRole("button", { name: "创建生成任务", exact: true }).click();
  await expect(page).toHaveURL(/studio\/batches\//);
  await expect(page.locator(".task-list tbody tr[data-row-key]")).toHaveCount(
    3,
  );
  await page
    .getByRole("button", { name: "审核文案", exact: true })
    .first()
    .click({ timeout: 30000 });
  await page
    .getByLabel("编辑口播内容")
    .fill("这是人工确认后的模拟房源文案，请以实际核验资料为准。");
  await page
    .getByRole("button", { name: "审核通过并继续", exact: true })
    .click();
  await page
    .getByRole("button", { name: /查看生成成果/ })
    .click({ timeout: 40000 });
  await expect(page).toHaveURL(/publish\/task-/);
  await expect(page.locator("video")).toBeVisible();
  await page
    .getByRole("button", { name: "模拟提交到抖音草稿", exact: true })
    .click();
  await expect(
    page.locator(".publish-records").getByText("平台草稿", { exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "小红书", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "模拟提交结果未知", exact: true })
    .check();
  await page
    .getByRole("button", { name: "模拟提交到小红书草稿", exact: true })
    .click();
  await page.getByRole("button", { name: "核对模拟结果", exact: true }).click();
  await expect(
    page
      .getByRole("tabpanel", { name: "小红书", exact: true })
      .locator(".publish-records")
      .getByText("平台草稿", { exact: true }),
  ).toBeVisible();
});

test("房源导入入口与后台资源维护可操作", async ({ page }) => {
  await page.getByRole("button", { name: "导入房源", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "导入房源", exact: true });
  await dialog.getByLabel("房源号列表").fill("SH900100\nSH900101\nSH900100");
  await dialog
    .getByRole("button", { name: "开始模拟导入", exact: true })
    .click();
  await expect(
    dialog.getByText("成功 2 套 · 重复 1 套 · 失败 0 套"),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.getByText("共 10 套房源")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "管理后台", exact: true }),
  ).toHaveCount(0);
  await page.goto("http://127.0.0.1:5174/#/admin/resources");
  await expect(
    page.getByRole("heading", { name: "资源管理", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /上传资源/ })).toBeVisible();
});

test("两个窗口并发导入不会相互覆盖", async ({ page, context }) => {
  const other = await context.newPage();
  await Promise.all([
    page.goto("/#/properties?import=1"),
    other.goto("/#/properties?import=1"),
  ]);
  const firstDialog = page.getByRole("dialog", {
    name: "导入房源",
    exact: true,
  });
  const secondDialog = other.getByRole("dialog", {
    name: "导入房源",
    exact: true,
  });
  await firstDialog.getByLabel("房源号列表").fill("CONCURRENT101");
  await secondDialog.getByLabel("房源号列表").fill("CONCURRENT102");
  await Promise.all([
    firstDialog.getByRole("button", { name: "开始模拟导入" }).click(),
    secondDialog.getByRole("button", { name: "开始模拟导入" }).click(),
  ]);
  await expect(
    firstDialog.getByText("成功 1 套 · 重复 0 套 · 失败 0 套"),
  ).toBeVisible();
  await expect(
    secondDialog.getByText("成功 1 套 · 重复 0 套 · 失败 0 套"),
  ).toBeVisible();
  await firstDialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.getByText("共 10 套房源")).toBeVisible();
  await other.close();
});

test("修改已完成文案后仍能查看历史成片与原发布记录", async ({ page }) => {
  await page.goto("/#/studio/tasks/task-1");
  await page.getByLabel("编辑口播内容").fill("新的模拟文案修订，请重新审核。");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await page
    .getByRole("button", { name: "保存并重新生成", exact: true })
    .click();
  await expect(
    page.getByText("文案已保存，下游内容将使用新修订重新生成"),
  ).toBeVisible();
  await page.getByRole("link", { name: "发布中心", exact: true }).click();
  await page.getByRole("link", { name: "仁恒滨江园", exact: true }).click();
  await expect(page.locator("video")).toBeVisible();
  await expect(
    page.getByText("正在查看历史成果，仅可查看并核对对应修订的发布记录。"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "模拟提交到抖音草稿", exact: true }),
  ).toBeDisabled();
  await expect(
    page.locator(".publish-records").getByText("已发布", { exact: true }),
  ).toBeVisible();
});

test("1280桌面首屏可访问视频提交入口", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/#/studio");
  const button = page.getByRole("button", {
    name: "创建生成任务",
    exact: true,
  });
  await expect(button).toBeVisible();
  const box = await button.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y + box!.height).toBeLessThanOrEqual(800);
});
