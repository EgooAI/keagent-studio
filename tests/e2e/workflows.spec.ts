import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "林悦的创作工作台" }),
  ).toBeVisible();
});

test("网页提示使用桌面客户端，并保留房源入口", async ({ page }) => {
  await page.goto("/#/studio");
  await expect(
    page.getByRole("heading", { name: "AI 视频工厂", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("请在桌面客户端制作视频", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /条文案/ })).toHaveCount(0);
  await expect(page.locator("video")).toHaveCount(0);
  await page.getByRole("link", { name: "管理房源与素材", exact: true }).click();
  await expect(page).toHaveURL(/properties/);
});

test("房源导入入口可操作，客户端不暴露后台入口", async ({ page }) => {
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
});

test("手动新增和编辑使用同一份完整房源资料", async ({ page }) => {
  await page.goto("/#/properties");
  await page.getByRole("button", { name: "手动添加", exact: true }).click();
  const add = page.getByRole("dialog", { name: "手动添加房源" });
  for (const [label, value] of Object.entries({
    房源标题: "手动录入两居",
    房源号: "MANUAL-01",
    小区名称: "联调小区",
    城市: "北京",
    "区县／商圈": "朝阳区",
    "总价（万元）": "320.12",
    "建筑面积（平方米）": "80",
    户型: "2 室 1 厅",
    楼层: "中层／共 18 层",
    朝向: "南北",
    交易属性: "满五唯一",
    房源说明: "有独立厨房",
    房源卖点: "双阳台\n采光好",
    "VR 看房链接": "https://example.com/vr",
  })) {
    await add.getByLabel(label, { exact: true }).fill(value);
  }
  await add.getByRole("button", { name: "保存房源" }).click();
  await expect(page.getByRole("heading", { name: "联调小区" })).toBeVisible();
  await expect(page.getByText("中层／共 18 层")).toBeVisible();
  await expect(page.getByText("双阳台", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "制作素材", exact: true }).click();
  await expect(page.getByText("0 张制作图片")).toBeVisible();
  await page.getByRole("tab", { name: "房源资料", exact: true }).click();
  await page.getByRole("button", { name: "编辑房源" }).click();
  const edit = page.getByRole("dialog", { name: "编辑房源资料" });
  await expect(edit.getByLabel("总价（万元）")).toHaveValue("320.12");
  await expect(edit.getByLabel("VR 看房链接")).toHaveValue(
    "https://example.com/vr",
  );
  await edit.getByLabel("朝向").fill("东南");
  await edit.getByLabel("楼层").clear();
  await edit.getByRole("button", { name: "保存修改" }).click();
  await expect(page.getByText("东南", { exact: true })).toBeVisible();
  await expect(page.getByText("中层／共 18 层")).toHaveCount(0);
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
    page.getByRole("button", { name: "配置发布", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.locator(".publish-records").getByText("已发布", { exact: true }),
  ).toBeVisible();
});

test("演示成片在弹窗配置发布并保留平台记录", async ({ page }) => {
  await page.goto("/#/publish/task-1");
  await expect(page.getByRole("textbox", { name: "发布标题" })).toHaveCount(0);
  await page.getByRole("button", { name: "配置发布", exact: true }).click();
  const config = page.getByRole("dialog", { name: /配置模拟发布/ });
  await config.getByRole("textbox", { name: "发布标题" }).fill("演示弹窗标题");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(config.getByRole("textbox", { name: "发布标题" })).toHaveValue(
    "演示弹窗标题",
  );
  await config
    .getByRole("button", { name: "模拟提交到抖音草稿", exact: true })
    .click();
  await expect(config).toBeHidden();
  await expect(
    page.locator(".publish-records").getByText("演示弹窗标题"),
  ).toBeVisible();
});

test("线索筛选与详情一致，切换页签保留未提交的话术", async ({ page }) => {
  await page.goto("/#/leads");
  await page.getByRole("tab", { name: "跟进话术", exact: true }).click();
  await page
    .getByRole("textbox", { name: "跟进话术", exact: true })
    .fill("保留这条待确认话术");
  await page.getByRole("tab", { name: "需求详情", exact: true }).click();
  await page.getByRole("tab", { name: "跟进话术", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "跟进话术", exact: true }),
  ).toHaveValue("保留这条待确认话术");
  await page.getByRole("textbox", { name: "搜索线索" }).fill("不存在的客户-ux");
  await expect(page.getByText("没有符合条件的线索")).toBeVisible();
  await expect(page.getByText("选择一条线索查看详情")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "跟进状态" })).toHaveCount(0);
  await page.getByRole("textbox", { name: "搜索线索" }).clear();
  await page.getByRole("tab", { name: "跟进话术", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "跟进话术", exact: true }),
  ).toHaveValue("保留这条待确认话术");
  await page.getByRole("tab", { name: /^跟进记录/ }).click();
  await page
    .getByRole("textbox", { name: "跟进备注" })
    .fill("下周再联系，尚未添加记录");
  const firstName = await page
    .locator(".leads-workspace > section:last-child h2")
    .innerText();
  await page.locator(".lead-list-item").nth(1).click();
  await expect(page.getByRole("textbox", { name: "跟进备注" })).toHaveValue("");
  await page.getByRole("textbox", { name: "搜索线索" }).fill(firstName);
  await expect(page.getByRole("textbox", { name: "跟进备注" })).toHaveValue(
    "下周再联系，尚未添加记录",
  );
});

test("用户端各页面在桌面与窄窗口保留可见导航且不横向溢出", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const width of [1440, 1280, 600]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of [
      "dashboard",
      "properties",
      "properties/property-1",
      "leads",
      "settings/profile",
      "settings/theme",
      "publish",
      "publish/task-1",
      "studio/tasks/task-2",
    ]) {
      await page.goto("/#/" + route);
      await expect(page.locator("h1")).toBeVisible();
      await expect(
        page.getByRole("link", { name: "房源中心", exact: true }).first(),
      ).toBeVisible();
      await page.screenshot({
        path: `.impeccable/review/${route.replaceAll("/", "-")}-${width}.png`,
        fullPage: true,
        animations: "disabled",
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
        `${route} at ${width}px`,
      ).toBe(true);
    }
  }
  expect(errors).toEqual([]);
});
