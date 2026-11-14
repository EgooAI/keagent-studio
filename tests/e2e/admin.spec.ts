import { expect, test, type Page } from "@playwright/test";
import type {
  AdminAIConfig,
  AdminAIManagement,
  AdminAIProbe,
  AdminAIService,
  AdminAudit,
  AdminDevice,
  AdminTaskSummary,
  AdminUser,
  ProductionConfig,
  ProductionTemplatePreview,
  Resource,
} from "../../packages/shared-types/src/index";
import { defaultProduction } from "../../apps/admin/src/ProductionTemplateEditor";

const adminBase = process.env.KEAGENT_ADMIN_TEST_URL || "http://127.0.0.1:5174";

const admin = {
  userId: "admin",
  sessionId: "session-private",
  name: "系统管理员",
  email: "admin@example.test",
  role: "admin",
};
const config: ProductionConfig = {
  propertyIds: ["property"],
  videoMode: "voiceover",
  voiceId: "voice",
  promptTemplate: { id: "prompt", version: "1" },
  videoTemplate: { id: "video", version: "1" },
  styleTemplate: { id: "style", version: "1" },
  coverTemplate: { id: "cover", version: "1" },
  requireScriptReview: true,
  aspectRatio: "9:16",
  outputResolution: "1080p",
};

async function fixture(page: Page) {
  const users: AdminUser[] = Array.from({ length: 123 }, (_, i) => ({
    id: `user-${i}`,
    name: `经纪人${String(i).padStart(3, "0")}`,
    email: `broker${i}@example.test`,
    role: "user",
    banned: false,
    createdAt: "2026-11-01T04:00:00Z",
  }));
  const owner = users[122];
  const devices: AdminDevice[] = [
    {
      id: "device-1",
      ownerId: owner.id,
      owner,
      name: "门店工作电脑",
      platform: "win32",
      revoked: false,
      lastSeenAt: "2026-11-06T02:00:00Z",
    },
  ];
  const task: AdminTaskSummary = {
    id: "task-1",
    ownerId: owner.id,
    owner,
    propertyId: "property",
    propertyTitle: "滨江三房",
    propertyNumber: "SH20261106",
    batchId: "batch-1",
    videoMode: "voiceover",
    stage: "script",
    status: "failed",
    progress: 0,
    createdAt: "2026-11-06T01:00:00Z",
    error: "文案服务缺少配置，请联系管理员",
  };
  const resources: Resource[] = [
    {
      id: "draft",
      name: "门店通用口播",
      type: "prompt",
      category: "通用",
      description: "只维护目录元数据",
      version: "1",
      thumbnail: "",
      compatibleModes: ["voiceover"],
      sizeMb: 0,
      published: false,
      publishedOnce: false,
      installed: false,
      downloadStatus: "idle",
      downloadProgress: 0,
    },
    {
      id: "published",
      name: "在架视频模板",
      type: "video",
      category: "简约",
      description: "已发布版本不可修改",
      version: "1.0.0",
      thumbnail: "",
      compatibleModes: ["voiceover", "avatar"],
      sizeMb: 0,
      published: true,
      publishedOnce: true,
      installed: false,
      downloadStatus: "idle",
      downloadProgress: 0,
      previewed: true,
      production: {
        schemaVersion: 1,
        config: {
          ...defaultProduction.config,
          cameraMode: undefined,
          openingTemplate: "一起看看{title}。",
          sceneTemplate: "这里是{room}。",
          closingTemplate: "欢迎预约实地看房。",
        },
      },
    },
  ];
  const services: AdminAIService[] = ["script", "tts", "opening"].map(
    (id, i) => ({
      id: id as AdminAIService["id"],
      label: ["文案生成", "语音配音", "MiniMax 开场"][i],
      purpose: ["生成房源讲解文案", "将文案转换为配音", "生成经纪人露脸开场"][
        i
      ],
      provider: ["DeepSeek", "火山引擎", "MiniMax"][i],
      model: i ? "" : "deepseek-flash",
      endpoint: i ? "" : "https://api.deepseek.com",
      state: "incomplete",
      missing: [["AI_API_KEY", "VOLC_TTS_API_KEY", "MINIMAX_API_KEY"][i]],
      issues: [],
      note: "配置检查不验证供应商连接或付费调用",
    }),
  );
  const logs: AdminAudit[] = [
    {
      id: "log-1",
      actorId: "admin",
      actor: { id: "admin", name: admin.name, email: admin.email },
      targetId: owner.id,
      target: owner,
      targetLabel: owner.name,
      action: "admin.create-user",
      status: "succeeded",
      operationId: "operation-1",
      createdAt: "2026-11-06T00:00:00Z",
      details: { name: owner.name },
    },
  ];
  const requests: string[] = [];
  const familyIds = new Map<string, string>();
  const family = (resource: Resource) =>
    familyIds.get(resource.id) || `${resource.type}:${resource.name}`;
  const previews = new Map<string, ProductionTemplatePreview>();
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const state = {
    deny: false,
    revokeFailures: 0,
    deviceFailures: 0,
    slowUsers: false,
    failedTasks: 1,
  };
  await page.route("**/api/auth/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, json: body });
    if (path.endsWith("/token")) return json({ token: "fixture-access-token" });
    if (route.request().method() === "GET" && path.endsWith("/get-user")) {
      const userId = new URL(route.request().url()).searchParams.get("id");
      return json(users.find((user) => user.id === userId) || users[0]);
    }
    const body = route.request().postDataJSON() || {};
    writes.push({ path, body });
    if (path.endsWith("/set-user-password")) return json({ status: true });
    if (path.endsWith("/revoke-user-sessions")) {
      if (state.revokeFailures-- > 0)
        return json({ message: "会话撤销暂时失败" }, 503);
      return json({ success: true });
    }
    const user = users.find((user) => user.id === body.userId);
    if (path.endsWith("/ban-user") && user) user.banned = true;
    if (path.endsWith("/unban-user") && user) user.banned = false;
    return json({ user, success: true });
  });
  await page.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    requests.push(url.pathname + url.search);
    const cors = {
      "access-control-allow-origin": adminBase,
      "access-control-allow-headers": "authorization,content-type",
      "access-control-allow-methods": "GET,POST,OPTIONS",
    };
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, headers: cors, json: body });
    if (route.request().method() === "OPTIONS")
      return route.fulfill({ status: 204, headers: cors });
    if (url.pathname === "/v1/session")
      return json({ ...admin, role: state.deny ? "user" : "admin" });
    if (url.pathname === "/v1/admin/douyin/summary")
      return json({ total: 0, states: {} });
    if (url.pathname === "/v1/admin/douyin/health")
      return json({ failures: 0, incident: false, pendingEmails: 0 });
    if (url.pathname === "/v1/admin/douyin/settings")
      return json({ operationsEmail: "", smtpConfigured: false });
    if (url.pathname === "/v1/admin/overview")
      return json({
        users: 123,
        devices: 1,
        publishedResources: 1,
        failedTasks: state.failedTasks,
        recentFailedTasks: state.failedTasks ? [task] : [],
        services,
      });
    if (url.pathname === "/v1/admin/ai-config")
      return json({
        configured: false,
        model: "deepseek-flash",
        baseURL: "https://api.deepseek.com",
        note: "不回显密钥",
        checkedAt: "2026-11-06T02:00:00Z",
        services,
      });
    if (url.pathname === "/v1/admin/tasks/task-1")
      return json({
        ownerId: owner.id,
        owner,
        task: {
          ...task,
          propertySnapshot: {
            id: "property",
            title: task.propertyTitle,
            propertyNumber: task.propertyNumber,
            community: "滨江小区",
            layout: "三室两厅",
            areaSqm: 100,
            priceCents: 300000000,
            description: "已核验资料",
          },
          configSnapshot: config,
          script: "这是仅在详情显示的完整文案",
          scriptRevision: 1,
          productionRevision: 1,
        },
      });
    if (url.pathname === "/v1/admin/resources/versions") {
      const resource = resources.find(
        ({ id }) => id === url.searchParams.get("id"),
      )!;
      return json(
        resources.filter((item) => family(item) === family(resource)).reverse(),
      );
    }
    if (
      url.pathname === "/v1/admin/resources/preview" &&
      route.request().method() === "GET"
    )
      return json(previews.get(url.searchParams.get("id") || "") || null);
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      writes.push({ path: url.pathname, body });
      if (url.pathname.endsWith("/devices/revoke")) {
        if (state.deviceFailures-- > 0)
          return json({ error: { message: "解绑暂时失败，请重试" } }, 503);
        devices[0].revoked = true;
        return json({ id: devices[0].id });
      }
      if (url.pathname.endsWith("/resources")) {
        const existing = resources.find((resource) => resource.id === body.id);
        if (existing) {
          if (
            body.production &&
            JSON.stringify(body.production) !==
              JSON.stringify(existing.production)
          ) {
            existing.previewed = false;
            previews.delete(existing.id);
          }
          Object.assign(existing, body, {
            publishedOnce: existing.publishedOnce || body.published,
          });
          if (body.published) {
            for (const other of resources) {
              if (other !== existing && family(other) === family(existing))
                other.published = false;
            }
          }
        } else {
          const source = resources.find(
            (resource) => resource.id === body.versionOf,
          );
          resources.push({ ...resources[0], ...body, id: "new-resource" });
          if (source) familyIds.set("new-resource", family(source));
        }
        return json({ id: existing?.id || "new-resource" });
      }
      if (url.pathname.endsWith("/resources/preview")) {
        const resource = resources.find((item) => item.id === body.id)!;
        resource.previewed = true;
        const preview: ProductionTemplatePreview = {
          template: { ...resource, production: resource.production! },
          segments: [
            {
              id: "opening",
              text: "一起看看示例小区两居室。建筑面积约80平方米。",
            },
            { id: "preview-1", text: "这里是客厅。原图展示客厅的空间布局。" },
            { id: "preview-2", text: "这是另一张室内照片。" },
            {
              id: "closing",
              text: "欢迎预约实地看房，具体情况以现场核验为准。",
            },
          ],
        };
        previews.set(resource.id, preview);
        return json(preview);
      }
    }
    const kind = url.pathname.split("/").at(-2);
    let items: object[] = [];
    const q = url.searchParams.get("q")?.toLowerCase();
    if (kind === "users") {
      if (state.slowUsers && !q)
        await new Promise((resolve) => setTimeout(resolve, 500));
      items = users.filter(
        (user) =>
          (!q || `${user.name} ${user.email}`.toLowerCase().includes(q)) &&
          (!url.searchParams.has("banned") ||
            String(user.banned) === url.searchParams.get("banned")),
      );
    } else if (kind === "devices") items = devices;
    else if (kind === "tasks") items = [task];
    else if (kind === "resources") {
      const current = new Map<string, Resource>();
      const type = url.searchParams.get("type");
      for (const resource of resources) {
        if (type && resource.type !== type) continue;
        if (
          url.searchParams.get("productionOnly") === "true" &&
          (resource.type !== "video" || !resource.production)
        )
          continue;
        if (resource.published || !current.get(family(resource))?.published)
          current.set(family(resource), resource);
      }
      items = [...current.values()].filter(
        (resource) => !q || resource.name.includes(q),
      );
    } else if (kind === "auth-audit" || kind === "audit")
      items = logs.map((log) =>
        kind === "audit"
          ? { ...log, action: "resources", status: undefined }
          : log,
      );
    const limit = Number(url.searchParams.get("limit") || 20);
    const offset = Number(url.searchParams.get("offset") || 0);
    return json({
      items: items.slice(offset, offset + limit),
      total: items.length,
      limit,
      offset,
    });
  });
  return { users, owner, task, resources, requests, writes, state };
}

test("AI 服务只有一个配置入口，原样保存保留测试结果", async ({ page }) => {
  await fixture(page);
  const labels = {
    script: "多模态文案",
    tts: "火山配音",
    opening: "MiniMax 开场",
    "voice-clone": "声音复刻",
    beike: "贝壳取材",
    "beike-cli": "贝壳找房",
  } satisfies Record<AdminAIService["id"], string>;
  const stamp = new Date().toISOString();
  const management: AdminAIManagement[] = Object.entries(labels).map(
    ([id, label]) => ({
      group: id,
      summary: {
        id: id as AdminAIService["id"],
        label,
        purpose: label,
        provider: "测试供应商",
        model: "vision-test",
        endpoint: "https://api.example.com",
        state: "configured",
        missing: [],
        issues: [],
        note: "",
      },
      fields: [
        { key: "AI_MODEL", label: "模型名", kind: "text" },
        { key: "AI_API_KEY", label: "API Key", kind: "secret" },
      ],
      revision: 3,
      active: {
        version: 3,
        source: "managed",
        activatedAt: stamp,
        locked: false,
        fields: { AI_MODEL: "vision-active" },
        secrets: { AI_API_KEY: true },
        test: null,
      },
      candidate: null,
      canActivate: false,
    }),
  );
  const script = management[0];
  script.active.test = {
    id: "previous-test",
    service: "script",
    version: 3,
    mode: "sample",
    status: "passed",
    createdAt: stamp,
    finishedAt: stamp,
    steps: [],
  };
  const data: AdminAIConfig = {
    configured: true,
    model: "vision-active",
    baseURL: "https://api.example.com",
    note: "",
    checkedAt: stamp,
    services: management.map((r) => r.summary),
    management,
    voices: [],
    writable: true,
  };
  const writes: { path: string; input: Record<string, unknown> }[] = [];
  await page.route(
    /\/v1\/admin\/ai-config(?:\/[^?]*)?(?:\?.*)?$/,
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      const headers = {
        "access-control-allow-origin": adminBase,
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "authorization, content-type",
      };
      if (route.request().method() === "OPTIONS")
        return route.fulfill({ status: 204, headers });
      if (path.endsWith("/ai-config"))
        return route.fulfill({ json: data, headers });
      const input = route.request().postDataJSON();
      writes.push({ path, input });
      if (path.endsWith("/save")) {
        const saved = script.candidate ?? script.active;
        if (
          input.fields.AI_MODEL === saved.fields.AI_MODEL &&
          !input.fields.AI_API_KEY
        )
          return route.fulfill({ json: { changed: false }, headers });
        script.revision++;
        script.candidate = {
          version: script.revision,
          fields: {
            AI_MODEL: input.fields.AI_MODEL,
          },
          secrets: { AI_API_KEY: true },
          test: null,
          missing: [],
          issues: [],
        };
        script.canActivate = false;
      }
      if (path.endsWith("/test") && script.candidate) {
        script.candidate.test = {
          id: input.requestId,
          service: "script",
          version: script.candidate.version,
          mode: input.mode,
          status: input.mode === "connection" ? "passed" : "running",
          createdAt: stamp,
          finishedAt: null,
          steps: [],
        };
      }
      if (path.endsWith("/activate") && script.candidate) {
        script.revision++;
        script.active = { ...script.active, ...script.candidate };
        script.candidate = null;
        script.canActivate = false;
      }
      return route.fulfill({ json: {}, headers });
    },
  );
  await page.goto(adminBase + "/#/admin/ai");
  const table = page.getByRole("table");
  await expect(table.getByRole("row")).toHaveCount(7);
  const manage = page.getByRole("button", { name: "管理多模态文案" });
  for (const width of [1440, 1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(manage).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: `output/ai-config-ui/list-${width}.png`,
      animations: "disabled",
    });
  }
  await manage.click();
  const configDialog = page.getByRole("dialog", {
    name: "多模态文案",
    exact: true,
  });
  await expect(configDialog).toBeVisible();
  await expect(configDialog.getByLabel("API Key", { exact: true })).toHaveValue(
    "",
  );
  await page.screenshot({
    path: "output/ai-config-ui/dialog-390.png",
    animations: "disabled",
  });
  await configDialog
    .getByLabel("模型名", { exact: true })
    .fill("vision-candidate");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "放弃未保存的修改？" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(configDialog.getByLabel("模型名", { exact: true })).toHaveValue(
    "vision-candidate",
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  const save = configDialog.getByRole("button", {
    name: "保存配置",
    exact: true,
  });
  const enable = configDialog.getByRole("button", {
    name: "启用配置",
    exact: true,
  });
  const runSample = configDialog.getByRole("button", {
    name: "运行真实样例",
    exact: true,
  });
  const scriptRow = table.getByRole("row", { name: /多模态文案/ });
  await save.click();
  await expect(scriptRow.getByText("待测试", { exact: true })).toBeVisible();
  await expect(configDialog.getByText("未测试", { exact: true })).toBeVisible();
  expect(script.active.fields.AI_MODEL).toBe("vision-active");
  await configDialog
    .getByRole("button", { name: "检查连通性", exact: true })
    .click();
  await expect(
    configDialog.getByText("连通性通过", { exact: true }),
  ).toBeVisible();
  await expect(enable).toBeDisabled();
  await runSample.click();
  const sampleDialog = page.getByRole("dialog", {
    name: "测试多模态文案",
    exact: true,
  });
  await expect(sampleDialog).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await sampleDialog
    .getByRole("button", { name: "返回配置", exact: true })
    .click();
  await expect(configDialog).toBeVisible();
  await runSample.click();
  await sampleDialog
    .getByRole("button", { name: "确认运行测试", exact: true })
    .click();
  await expect(configDialog.getByText("测试中", { exact: true })).toBeVisible();
  expect(writes.at(-1)?.input).toMatchObject({
    mode: "sample",
    version: 4,
    confirmed: true,
  });
  const probe = script.candidate?.test as AdminAIProbe;
  expect(probe.status).toBe("running");
  await page.reload();
  await expect(configDialog.getByText("测试中", { exact: true })).toBeVisible();
  probe.status = "failed";
  probe.message = "供应商鉴权失败，请检查凭证";
  await expect(configDialog.getByText(probe.message)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(manage).toBeFocused();
  await expect(scriptRow.getByText("待测试", { exact: true })).toBeVisible();
  await expect(scriptRow.getByText("测试失败")).toBeVisible();
  await manage.click();
  await runSample.click();
  await page.getByRole("button", { name: "确认运行测试", exact: true }).click();
  await expect(configDialog.getByText("测试中", { exact: true })).toBeVisible();
  const retry = script.candidate?.test as AdminAIProbe;
  retry.status = "passed";
  retry.finishedAt = stamp;
  script.canActivate = true;
  await expect(enable).toBeEnabled();
  await save.click();
  await expect(page.getByText("配置未改动", { exact: true })).toBeVisible();
  await expect(enable).toBeEnabled();
  await expect(
    configDialog.getByText("样例通过", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "output/ai-config-ui/dialog-1440.png",
    animations: "disabled",
  });
  await enable.click();
  await page.getByRole("button", { name: "确认启用", exact: true }).click();
  await expect(scriptRow.getByText("已启用", { exact: true })).toBeVisible();
  await expect(enable).toHaveCount(0);
  await expect(configDialog.getByText("版本记录", { exact: true })).toHaveCount(
    0,
  );
  expect(script.active.fields.AI_MODEL).toBe("vision-candidate");
});

test("管理入口职责明确，真实路由和旧入口可恢复", async ({ page }) => {
  await fixture(page);
  const menus = [
    ["dashboard", "管理工作台"],
    ["users", "用户与设备"],
    ["resources", "公共模板"],
    ["tasks", "云端任务"],
    ["ai", "AI 服务"],
    ["audit", "操作记录"],
    ["credits", "积分管理"],
    ["douyin", "抖音发布"],
    ["settings", "设置"],
  ];
  await page.goto(adminBase);
  await expect(page).toHaveURL(/#\/admin\/dashboard$/);
  await expect(
    page.getByRole("heading", { name: "管理工作台", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("menuitem")).toHaveText(
    menus.map(([, label]) => label),
  );
  for (const [route, label] of menus) {
    await page.goto(adminBase + "/#/admin/" + route);
    await expect(
      page.getByRole("heading", { name: label, exact: true }),
    ).toBeVisible();
    await expect(page.locator(".admin-page-heading p")).not.toBeEmpty();
  }
  await page.goto(adminBase + "/#/admin/devices");
  await expect(page).toHaveURL(/admin\/users\?tab=devices/);
  await expect(
    page.getByRole("tab", { name: "设备", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("columnheader", { name: /^最近活动/ }),
  ).toBeVisible();
  await expect(page.getByText("Windows", { exact: true })).toBeVisible();
  await page.goto(adminBase + "/#/admin/auth-audit");
  await expect(page).toHaveURL(/admin\/audit\?tab=account/);
  await page.goto(adminBase + "/#/admin/ai-config");
  await expect(page).toHaveURL(/admin\/ai$/);
});

test("工作台指标跳转到筛选结果，近期失败任务直达详情", async ({ page }) => {
  const { task, state } = await fixture(page);
  await page.goto(adminBase);
  await expect(
    page.getByRole("heading", { name: "1 项任务待排查" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "查看任务", exact: true }),
  ).toHaveAttribute("href", "#/admin/tasks?status=failed");
  const serviceIssues = page.getByRole("region", { name: "AI 配置缺项" });
  await expect(
    serviceIssues.getByRole("link", { name: "文案生成" }),
  ).toHaveAttribute("href", "#/admin/ai?service=script");
  const metrics = page.getByRole("region", { name: "业务指标" });
  await expect(metrics.getByRole("link", { name: /用户账号/ })).toHaveAttribute(
    "href",
    "#/admin/users",
  );
  await expect(
    metrics.getByRole("link", { name: /已绑定设备/ }),
  ).toHaveAttribute("href", "#/admin/users?tab=devices&revoked=false");
  await expect(
    metrics.getByRole("link", { name: /已上架模板/ }),
  ).toHaveAttribute("href", "#/admin/resources?state=published");
  await metrics.getByRole("link", { name: /失败任务/ }).click();
  await expect(page).toHaveURL(/admin\/tasks\?status=failed/);
  await page.goBack();
  const failed = page.getByRole("region", { name: "近期失败任务" });
  await failed.getByRole("link", { name: task.propertyTitle }).click();
  await expect(
    page.getByRole("dialog", { name: "云端任务详情" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "生成配置快照" }),
  ).toBeVisible();

  state.failedTasks = 0;
  await page.goto(adminBase + "/#/admin/dashboard");
  await expect(page.getByText("目前没有失败的云端任务。")).toBeVisible();
  await expect(failed.getByText("暂无失败任务")).toBeVisible();
});

test("旧外观链接进入设置，刷新后保留主题", async ({ page }) => {
  await fixture(page);
  await page.goto(adminBase + "/#/admin/users?appearance=1");
  await expect(page).toHaveURL(/admin\/settings\?tab=appearance/);
  await expect(page.getByRole("tab", { name: "外观" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("radio", { name: "雾蓝" })).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute(
    "data-palette",
    "mist-blue",
  );
  await page.getByText("经典蓝", { exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-palette", "blue");
  await page.reload();
  await expect(page.getByRole("radio", { name: "经典蓝" })).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-palette", "blue");
});

test("服务端分页可查第123位用户，搜索和刷新保留URL", async ({ page }) => {
  const data = await fixture(page);
  await page.goto(adminBase + "/#/admin/users?limit=20&offset=120");
  await expect(
    page.locator(`tr[data-row-key="${data.owner.id}"]`),
  ).toContainText(data.owner.email);
  await page.reload();
  await expect(
    page.locator(`tr[data-row-key="${data.owner.id}"]`),
  ).toContainText(data.owner.email);
  await expect(page).toHaveURL(/offset=120/);
  await page.goto(
    `${adminBase}/#/admin/users?q=${data.owner.email}&role=user&banned=false`,
  );
  await expect(page.locator("tr[data-row-key]")).toHaveCount(1);
  await expect
    .poll(() =>
      data.requests.some(
        (request) =>
          request.includes("users/list") &&
          request.includes("q=broker122") &&
          request.includes("role=user") &&
          request.includes("banned=false"),
      ),
    )
    .toBeTruthy();
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    "fixture-access-token",
  );
});

test("任务摘要显示关联信息，详情链接和返回可恢复", async ({ page }) => {
  const data = await fixture(page);
  await page.goto(adminBase + "/#/admin/tasks");
  await expect(
    page.getByText(data.task.propertyTitle, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", {
      name: new RegExp(data.owner.email.replaceAll(".", "\\.")),
    }),
  ).toBeVisible();
  await expect(
    page.getByText("这是仅在详情显示的完整文案", { exact: true }),
  ).toHaveCount(0);
  await page.goto(adminBase + "/#/admin/tasks?taskId=task-1");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByText("这是仅在详情显示的完整文案", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("这是仅在详情显示的完整文案", { exact: true }),
  ).toBeVisible();
});

test("普通用户不会挂载管理查询", async ({ page }) => {
  const data = await fixture(page);
  data.state.deny = true;
  await page.goto(adminBase + "/#/admin/dashboard");
  await expect(
    page.getByText("当前账号没有管理权限", { exact: true }),
  ).toBeVisible();
  expect(
    data.requests.filter((request) => request.startsWith("/v1/admin/")),
  ).toHaveLength(0);
});

test("快速切页时，迟到的用户查询不会覆盖任务列表", async ({ page }) => {
  const data = await fixture(page);
  data.state.slowUsers = true;
  const pendingUsers = page.waitForResponse(
    (response) =>
      response.url().includes("/users/list") && !response.url().includes("q="),
  );
  await page.goto(adminBase + "/#/admin/users");
  await expect
    .poll(() =>
      data.requests.some((request) =>
        request.startsWith("/v1/admin/users/list"),
      ),
    )
    .toBeTruthy();
  await page.getByRole("menuitem", { name: "云端任务", exact: true }).click();
  await pendingUsers;
  await expect(
    page.getByRole("heading", { name: "云端任务", exact: true }),
  ).toBeVisible();
  await expect(page.locator('tr[data-row-key="task-1"]')).toBeVisible();
  await expect(page.locator('tr[data-row-key="user-0"]')).toHaveCount(0);
});

test("模板目录只显示当前版本，编辑页可更新、启用和切回旧版本", async ({
  page,
}) => {
  const data = await fixture(page);
  await page.goto(adminBase + "/#/admin/resources");
  const published = page.locator('tr[data-row-key="published"]');
  await published.getByRole("button", { name: "在架视频模板" }).click();
  await expect(page.getByRole("heading", { name: "版本记录" })).toBeVisible();
  await expect(page.getByLabel("模板名称", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "返回模板目录" }).click();
  await published
    .getByRole("button", { name: "更新版本", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "编辑新版本" })).toBeVisible();
  await page.getByLabel("版本号", { exact: true }).fill("1.0.0");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(
    page.getByText("此模板已使用该版本号", { exact: true }),
  ).toBeVisible();
  expect(
    data.writes.filter((write) => write.path.endsWith("/resources")),
  ).toHaveLength(0);
  await page.getByLabel("版本号", { exact: true }).fill("2.0.0");
  await page.getByLabel("模板名称", { exact: true }).fill("门店新版带看");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "编辑版本草稿" }),
  ).toBeVisible();
  const saved = data.writes.find((write) => write.path.endsWith("/resources"));
  expect(saved?.body).toMatchObject({
    name: "门店新版带看",
    version: "2.0.0",
    published: false,
    versionOf: "published",
  });
  expect(saved?.body.id).toBeUndefined();
  await page.getByRole("button", { name: "返回模板目录" }).click();
  await expect(published).toBeVisible();
  const newRow = page.locator('tr[data-row-key="new-resource"]');
  await expect(newRow).toHaveCount(0);
  await published
    .getByRole("button", { name: "更新版本", exact: true })
    .click();
  await expect(page.getByLabel("版本号", { exact: true })).toHaveValue("2.0.0");
  await page.getByRole("button", { name: "预览校验", exact: true }).click();
  await page
    .getByRole("dialog", { name: "制作模板预览校验" })
    .getByRole("button", { name: "关闭" })
    .click();
  await page.getByRole("button", { name: "启用版本", exact: true }).click();
  await page.getByRole("button", { name: "确认启用", exact: true }).click();
  await expect(
    page.getByText("已启用版本 2.0.0", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "返回模板目录" }).click();
  await expect(newRow).toBeVisible();
  await expect(published).toHaveCount(0);
  await newRow.getByRole("button", { name: "门店新版带看" }).click();
  await expect(page.getByRole("heading", { name: "版本记录" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("combobox", { name: "查看模板版本" }).click();
  await page
    .getByRole("option", { name: "1.0.0 · 已下架", exact: true })
    .click();
  await expect(page.getByLabel("模板名称", { exact: true })).toHaveValue(
    "在架视频模板",
  );
  await page.getByRole("button", { name: "启用版本", exact: true }).click();
  await page.getByRole("button", { name: "确认启用", exact: true }).click();
  await expect(
    page.getByText("已启用版本 1.0.0", { exact: true }),
  ).toBeVisible();
});

test("公共模板可上传 MiniMax 固定背景图并在预览中核对", async ({ page }) => {
  const data = await fixture(page);
  await page.goto(adminBase + "/#/admin/resources");
  await page.getByRole("button", { name: "新建模板草稿", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "新建模板草稿",
    exact: true,
  });
  const choose = async (label: string, value: string) => {
    await dialog
      .getByRole("combobox", { name: new RegExp(label + "$") })
      .click();
    await page
      .locator(".ant-select-dropdown:visible")
      .getByText(value, { exact: true })
      .click();
  };
  await dialog.getByLabel("模板名称", { exact: true }).fill("小区开场模板");
  await choose("视频表现", "经纪人开场露脸");
  await choose("开场方式", "MiniMax H3 生成");
  await expect(dialog.getByText("随房源取图", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("画面提示词", { exact: true })).toHaveValue(
    /边走边介绍房源/,
  );
  await choose("开场背景图", "上传固定背景图");
  await dialog
    .getByLabel("画面提示词", { exact: true })
    .fill("经纪人站在入口，自然中景。");
  await dialog.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(
    dialog.getByText("请上传模板固定背景图", { exact: true }),
  ).toBeVisible();
  await dialog
    .getByLabel("上传固定背景图")
    .setInputFiles("apps/desktop/public/media/interior-1.jpg");
  await expect(
    dialog.getByRole("img", { name: "模板固定背景图预览" }),
  ).toBeVisible();
  for (const width of [1440, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await dialog.getByLabel("上传固定背景图").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: test.info().outputPath("minimax-background-" + width + ".png"),
      animations: "disabled",
    });
  }
  await dialog.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(
    (
      data.writes.find((write) => write.path.endsWith("/resources"))?.body
        .production as typeof defaultProduction | undefined
    )?.opening,
  ).toEqual({
    prompt: "经纪人站在入口，自然中景。",
    location: { source: "fixed", image: expect.stringMatching(/^\/9j\//) },
  });
  const row = page.getByRole("row").filter({
    has: page.getByRole("button", { name: "小区开场模板", exact: true }),
  });
  await row.getByRole("button", { name: "预览校验", exact: true }).click();
  const preview = page.getByRole("dialog", {
    name: "制作模板预览校验",
    exact: true,
  });
  await expect(
    preview.getByRole("img", { name: "模板固定背景图", exact: true }),
  ).toBeVisible();
  await expect(
    preview.getByText("经纪人站在入口，自然中景。", { exact: true }),
  ).toBeVisible();
});

test("空间镜头模板隐藏旋转参数并保留配置完整性", async ({ page }) => {
  const data = await fixture(page);
  await page.goto(adminBase + "/#/admin/resources");
  await page.getByRole("button", { name: "新建模板草稿", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "新建模板草稿",
    exact: true,
  });
  await dialog.getByLabel("模板名称", { exact: true }).fill("空间走动带看配置");
  await dialog
    .getByLabel("适用说明", { exact: true })
    .fill("使用已导入的真实三维空间。");
  await dialog.getByLabel("室内镜头", { exact: true }).click();
  await page
    .locator(".ant-select-dropdown")
    .getByText("真实空间走动", { exact: true })
    .click();
  await expect(
    dialog.getByLabel("镜头速度（度/秒）", { exact: true }),
  ).toBeHidden();
  await expect(dialog.getByLabel("镜头方向", { exact: true })).toBeHidden();
  await expect(
    dialog.getByLabel("单镜头最大幅度（度）", { exact: true }),
  ).toBeHidden();
  await dialog.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(
    data.writes.find((write) => write.path.endsWith("/resources"))?.body
      .production,
  ).toMatchObject({
    config: {
      cameraMode: "spatial",
      speed: 4,
      direction: 1,
      maxSweep: 100,
    },
  });
});

test("完整视频模板通过参数表单保存，预览后才允许上架", async ({ page }) => {
  const data = await fixture(page);
  await page.goto(adminBase + "/#/admin/resources?type=prompt");
  await expect(
    page.getByRole("button", { name: "在架视频模板" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "门店通用口播" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("combobox", { name: "模板类型" })).toHaveCount(0);
  await page.getByRole("button", { name: "添加规则", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "视频模板添加规则", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("2. 结构与素材处理固定", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("dialog", { name: "视频模板添加规则", exact: true })
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await page.getByRole("button", { name: "新建模板草稿", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "新建模板草稿",
    exact: true,
  });
  await expect(dialog.getByLabel("模板类型")).toHaveCount(0);
  await dialog.getByLabel("模板名称", { exact: true }).fill("门店房源带看");
  await dialog
    .getByLabel("适用说明", { exact: true })
    .fill("适合完整介绍一套房源。");
  await expect(dialog.getByLabel("逐图文案规则", { exact: true })).toHaveValue(
    defaultProduction.scriptRules.scene,
  );
  await dialog
    .getByLabel("整片文案规则", { exact: true })
    .fill("围绕已核实卖点自然讲解。");
  await dialog.getByLabel("品牌色", { exact: true }).fill("#336699");
  await dialog.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(dialog).toBeHidden();
  const saved = data.writes.find((write) => write.path.endsWith("/resources"));
  expect(saved?.body).toMatchObject({
    type: "video",
    version: "1.0.0",
    compatibleModes: ["voiceover"],
    production: {
      schemaVersion: 2,
      config: {
        brandColor: "#336699",
      },
      scriptRules: { overall: "围绕已核实卖点自然讲解。" },
    },
  });
  expect(saved?.body).not.toHaveProperty("production.config.cameraMode");
  const row = page.locator('tr[data-row-key="new-resource"]');
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "门店房源带看" }).click();
  await expect(
    page.getByRole("button", { name: "启用版本", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "预览校验", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "制作模板预览校验", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("多模态模型根据示例图片生成文案，供检查图文对应和版式。", {
      exact: true,
    }),
  ).toBeVisible();
  const previewRequest = data.writes.find((write) =>
    write.path.endsWith("/resources/preview"),
  );
  expect(previewRequest?.body.images).toEqual([
    expect.objectContaining({
      id: "preview-1",
      jpeg: expect.stringMatching(/^\/9j\//),
    }),
    expect.objectContaining({
      id: "preview-2",
      jpeg: expect.stringMatching(/^\/9j\//),
    }),
  ]);
  await page.screenshot({
    path: "output/template-verification/admin-preview.png",
    fullPage: true,
    animations: "disabled",
  });
  await page
    .getByRole("dialog", { name: "制作模板预览校验", exact: true })
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await page.reload();
  await page.getByRole("button", { name: "预览校验", exact: true }).click();
  const preview = page.getByRole("dialog", {
    name: "制作模板预览校验",
    exact: true,
  });
  await expect(
    preview.getByText("这是另一张室内照片。", { exact: true }),
  ).toBeVisible();
  expect(
    data.writes.filter(({ path }) => path.endsWith("/resources/preview")),
  ).toHaveLength(1);
  await preview.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByLabel("品牌色", { exact: true }).fill("#112233");
  await expect(
    page.getByRole("button", { name: "预览校验", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "启用版本", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "预览校验", exact: true }).click();
  await expect(preview).toBeVisible();
  expect(
    data.writes.filter(({ path }) => path.endsWith("/resources/preview")),
  ).toHaveLength(2);
  await preview.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "启用版本", exact: true }).click();
  await page.getByRole("button", { name: "确认启用", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "停用版本", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("模板名称", { exact: true })).toBeDisabled();
});

test("密码重置部分成功后跨主页面仍保留提醒，重试不重复修改密码", async ({
  page,
}) => {
  const data = await fixture(page);
  data.state.revokeFailures = 1;
  await page.goto(adminBase + "/#/admin/users");
  await page
    .locator('tr[data-row-key="user-0"]')
    .getByRole("button", { name: "重置密码", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "重置密码并强制退出",
    exact: true,
  });
  await expect(dialog).toContainText("broker0@example.test");
  await dialog
    .getByLabel("新密码", { exact: true })
    .fill("New-password-12345!");
  await dialog
    .getByLabel("确认新密码", { exact: true })
    .fill("New-password-12345!");
  await dialog
    .getByRole("button", { name: "确认重置并强制退出", exact: true })
    .click();
  await expect(
    page.getByText("密码已更改，但强制退出未完成", { exact: true }),
  ).toBeVisible();
  expect(
    data.writes.filter((write) => write.path.endsWith("/set-user-password")),
  ).toHaveLength(1);
  await page.getByRole("menuitem", { name: "公共模板", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "公共模板", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("密码已更改，但强制退出未完成", { exact: true }),
  ).toBeVisible();
  await page.getByRole("menuitem", { name: "用户与设备", exact: true }).click();
  await expect(
    page.getByText("密码已更改，但强制退出未完成", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "重试强制退出", exact: true }).click();
  await expect(
    page.getByText("密码已更改，但强制退出未完成", { exact: true }),
  ).toHaveCount(0);
  expect(
    data.writes.filter((write) => write.path.endsWith("/revoke-user-sessions")),
  ).toHaveLength(2);
  expect(
    data.writes.filter((write) => write.path.endsWith("/set-user-password")),
  ).toHaveLength(1);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    "New-password-12345!",
  );
});

test("会话失效立即关闭停用确认，不保留旧管理操作", async ({ page }) => {
  const data = await fixture(page);
  await page.goto(adminBase + "/#/admin/users");
  await page
    .locator('tr[data-row-key="user-0"]')
    .getByRole("button", { name: "停用", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "停用该用户并强制退出？",
    exact: true,
  });
  await expect(dialog).toContainText("broker0@example.test");
  await page.evaluate(() =>
    window.dispatchEvent(new Event("keagent:unauthorized")),
  );
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("登录管理后台", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "确认停用", exact: true }),
  ).toHaveCount(0);
  expect(data.writes).toHaveLength(0);
});

test("操作记录搜索在切换来源和清除筛选时移除隐藏条件", async ({ page }) => {
  const data = await fixture(page);
  await page.goto(adminBase + "/#/admin/audit?tab=business");
  const search = page.getByLabel("搜索操作对象", { exact: true });
  await search.fill("门店模板");
  await search.press("Enter");
  await expect(page).toHaveURL(/[?&]q=/);
  await expect
    .poll(() =>
      data.requests.some(
        (request) =>
          request.startsWith("/v1/admin/audit/list") && request.includes("q="),
      ),
    )
    .toBeTruthy();
  await page.getByRole("tab", { name: "账号操作", exact: true }).click();
  await expect(page).not.toHaveURL(/[?&]q=/);
  await expect(
    page.getByRole("tab", { name: "账号操作", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "业务操作", exact: true }).click();
  await search.fill("第二次搜索");
  await search.press("Enter");
  await expect(page).toHaveURL(/[?&]q=/);
  await page.getByRole("button", { name: "清除筛选", exact: true }).click();
  await expect(page).not.toHaveURL(/[?&]q=/);
});

test("设备解绑先确认，失败保留对话框并允许重试", async ({ page }) => {
  const data = await fixture(page);
  data.state.deviceFailures = 1;
  await page.goto(adminBase + "/#/admin/users?tab=devices");
  await page.getByRole("button", { name: "解绑设备", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "解绑该设备？",
    exact: true,
  });
  await expect(dialog).toContainText("门店工作电脑");
  await expect(dialog).toContainText(data.owner.email);
  expect(data.writes).toHaveLength(0);
  await dialog.getByRole("button", { name: "确认解绑", exact: true }).click();
  await expect(
    page.getByText("解绑暂时失败，请重试", { exact: true }),
  ).toBeVisible();
  await expect(dialog).toBeVisible();
  const retry = dialog.getByRole("button", { name: /确认解绑$/ });
  await expect(retry).not.toHaveClass(/ant-btn-loading/);
  await retry.click();
  await expect(dialog).toBeHidden();
  await expect(
    page
      .locator('tr[data-row-key="device-1"]')
      .getByRole("button", { name: "解绑设备", exact: true }),
  ).toBeDisabled();
  expect(
    data.writes.filter((write) => write.path.endsWith("/devices/revoke")),
  ).toHaveLength(2);
});
