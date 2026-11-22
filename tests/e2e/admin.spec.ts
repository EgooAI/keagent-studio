import { expect, test, type Page } from "@playwright/test";
import type {
  AdminAIConfig,
  AdminAIManagement,
  AdminAIProbe,
  AdminAIService,
  AdminAudit,
  AdminDevice,
  AdminPublicVoice,
  AdminTaskSummary,
  AdminUser,
  CatalogTemplate,
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
  const { language, ...editConfig } = defaultProduction.config;
  const catalogParts: {
    name: string;
    type: Resource["type"];
    definition: CatalogTemplate;
  }[] = [
    {
      name: "全景运镜",
      type: "style",
      definition: { kind: "edit", config: editConfig },
    },
    {
      name: "品牌封面",
      type: "cover",
      definition: {
        kind: "cover",
        design: "standard",
        brandColor: "#167D8D",
        imageSource: "first",
        titleSource: "opening",
        showFacts: true,
      },
    },
    {
      name: "卖点先行",
      type: "prompt",
      definition: {
        kind: "script",
        language,
        scriptRules: defaultProduction.scriptRules,
      },
    },
  ];
  for (const part of catalogParts) {
    resources.push({
      ...resources[0],
      ...part,
      id: part.definition.kind,
      version: "1.0.0",
      published: true,
      publishedOnce: true,
      previewed: true,
    });
  }
  const services: AdminAIService[] = ["script", "tts", "opening"].map(
    (id, i) => ({
      id: id as AdminAIService["id"],
      label: ["文案生成", "语音配音", "MiniMax 开场"][i],
      purpose: ["生成房源讲解文案", "将文案转换为配音", "生成经纪人露脸开场"][
        i
      ],
      provider: ["DeepSeek", "阿里云百炼", "MiniMax"][i],
      model: ["deepseek-flash", "qwen-audio-3.1-tts-plus", ""][i],
      endpoint: i ? "" : "https://api.deepseek.com",
      state: "incomplete",
      missing: [
        ["AI_API_KEY"],
        ["DASHSCOPE_API_KEY", "DASHSCOPE_WORKSPACE_ID"],
        ["MINIMAX_API_KEY"],
      ][i],
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
    if (url.pathname === "/v1/admin/resources/parts")
      return json(
        resources
          .filter(
            (r) =>
              r.published && r.definition && r.definition.kind !== "bundle",
          )
          .map((r) => ({
            id: r.id,
            name: r.name,
            version: r.version,
            kind: r.definition!.kind,
          })),
      );
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
      if (url.pathname.endsWith("/resources/delete")) {
        const resource = resources.find((item) => item.id === body.id)!;
        const remaining = resources.filter(
          (item) => family(item) !== family(resource),
        );
        resources.splice(0, resources.length, ...remaining);
        return json({ id: resource.id });
      }
      if (url.pathname.endsWith("/resources")) {
        const existing = resources.find((resource) => resource.id === body.id);
        if (existing) {
          if (
            (body.definition &&
              JSON.stringify(body.definition) !==
                JSON.stringify(existing.definition)) ||
            (body.production &&
              JSON.stringify(body.production) !==
                JSON.stringify(existing.production))
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
          const id = resources.some((r) => r.id === "new-resource")
            ? "new-resource-" + resources.length
            : "new-resource";
          resources.push({ ...resources[0], ...body, id });
          if (source) familyIds.set(id, family(source));
          return json({ id });
        }
        return json({ id: existing?.id || "new-resource" });
      }
      if (url.pathname.endsWith("/resources/preview")) {
        const resource = resources.find((item) => item.id === body.id)!;
        resource.previewed = true;
        const preview: ProductionTemplatePreview = {
          template: {
            ...resource,
            production: resource.production || defaultProduction,
          },
          definition: resource.definition,
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
        if (resource.definition?.kind === "cover") {
          preview.cover = resource.definition;
          preview.segments = [];
        }
        if (resource.definition?.kind === "bundle") {
          const coverId = resource.definition.parts.cover.id;
          const cover = resources.find((r) => r.id === coverId)?.definition;
          if (cover?.kind === "cover") preview.cover = cover;
        }
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
        if (
          resource.definition?.kind !==
          (url.searchParams.get("catalog") || undefined)
        )
          continue;
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

test("旧版云端暂停语音管理并提示更新", async ({ page }) => {
  const { requests, task } = await fixture(page);
  const management = (
    [
      ["script", "多模态文案", "DeepSeek", "deepseek-flash", "script"],
      ["tts", "火山配音", "火山引擎", "seed-tts-2.0", "speech"],
      ["voice-clone", "声音复刻", "火山引擎", "seed-icl-2.0", "speech"],
    ] as const
  ).map(([id, label, provider, model, group]): AdminAIManagement => ({
    group,
    summary: {
      id,
      label,
      provider,
      model,
      purpose: "",
      endpoint: "",
      state: "configured",
      missing: [],
      issues: [],
      note: "",
    },
    revision: 2,
    fields: [
      {
        key: id === "script" ? "AI_API_KEY" : "VOLC_TTS_API_KEY",
        label: "API Key",
        kind: "secret",
      },
    ],
    active: {
      version: 1,
      source: "managed",
      activatedAt: null,
      locked: false,
      fields: {},
      secrets: {},
      test: null,
    },
    candidate: {
      version: 2,
      fields: {},
      secrets: {},
      test: null,
      missing: [],
      issues: [],
    },
    canActivate: true,
  }));
  const services = management.map((row) => row.summary);
  const headers = {
    "access-control-allow-origin": adminBase,
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
  };
  await page.route(/\/v1\/admin\/(ai-config|overview)(\?.*)?$/, (route) => {
    if (route.request().method() === "OPTIONS")
      return route.fulfill({ status: 204, headers });
    return route.fulfill({
      headers,
      json: route.request().url().includes("/overview")
        ? {
            users: 123,
            devices: 1,
            publishedResources: 1,
            failedTasks: 1,
            recentFailedTasks: [task],
            services,
          }
        : { management, services, writable: true, voices: [] },
    });
  });

  const upgrade = page.getByText("云端语音服务需要更新");
  await page.goto(adminBase + "/#/admin/dashboard");
  await expect(upgrade).toBeVisible();
  await expect(page.getByText(/各项配置已齐全/)).toHaveCount(0);
  await expect(page.getByText(/火山配音|火山引擎/)).toHaveCount(0);

  // A saved link from the former configuration cannot open its obsolete editor.
  await page.goto(adminBase + "/#/admin/ai?service=voice-clone");
  await expect(upgrade).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "管理声音复刻" })).toHaveCount(
    0,
  );
  await expect(page.getByText(/火山配音|火山引擎/)).toHaveCount(0);
  await expect(page.getByText("待启用配置 · 可启用")).toHaveCount(0);
  await page.getByRole("button", { name: "管理多模态文案" }).click();
  const scriptDialog = page.getByRole("dialog", { name: "多模态文案" });
  await expect(scriptDialog).toBeVisible();
  await scriptDialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(scriptDialog).not.toBeVisible();
  await page.getByRole("tab", { name: "公共音色" }).click();
  await expect(upgrade).toBeVisible();
  await expect(page.getByRole("button", { name: "新增公共音色" })).toHaveCount(
    0,
  );
  expect(requests.some((path) => path.includes("/v1/admin/voices"))).toBe(
    false,
  );
});

test("公共音色使用百炼模型，历史音色只能查看", async ({ page }) => {
  await fixture(page);
  const legacyVoice: AdminPublicVoice = {
    id: "legacy-existing",
    name: "历史配音",
    speakerId: "legacy-example",
    resourceId: "legacy-resource",
    language: "zh-CN",
    enabled: false,
    publishedOnce: true,
  };
  const retiredFlashVoice: AdminPublicVoice = {
    ...legacyVoice,
    id: "builtin-public-zh-qwen-plus",
    name: "公共讲解女声 · 温怀清",
    speakerId: "wenhuaiqing_v3.1",
    resourceId: "qwen-audio-3.1-tts-plus",
    retired: true,
  };
  await page.route("**/v1/admin/voices", async (route) => {
    const headers = {
      "access-control-allow-origin": adminBase,
      "access-control-allow-headers": "authorization,content-type",
      "access-control-allow-methods": "GET,POST,OPTIONS",
    };
    if (route.request().method() === "OPTIONS")
      return route.fulfill({ status: 204, headers });
    return route.fulfill({ json: [legacyVoice, retiredFlashVoice], headers });
  });
  await page.goto(adminBase + "/#/admin/ai?tab=voices");
  const legacy = page.getByRole("row", { name: /历史配音/ });
  await expect(legacy.getByText("已停用")).toBeVisible();
  await expect(legacy.getByRole("button")).toHaveCount(0);
  const retired = page.getByRole("row", { name: /温怀清/ });
  await expect(retired.getByText("已停用")).toBeVisible();
  await expect(retired.getByRole("button")).toHaveCount(0);
  await page.getByRole("button", { name: "新增公共音色" }).click();
  const dialog = page.getByRole("dialog", { name: "新增公共音色" });
  await dialog.getByLabel("音色名称").fill("公共讲解");
  await dialog.getByLabel("百炼公共音色编号").fill("longanlingxin_v3.1");
  const model = dialog.getByLabel("合成模型");
  await expect(model).toHaveValue("qwen-audio-3.1-tts-plus");
  await expect(model).not.toBeEditable();
  const save = page.waitForRequest(
    (request) =>
      request.url().endsWith("/v1/admin/voices") && request.method() === "POST",
  );
  await dialog.getByRole("button", { name: "确 定" }).click();
  expect((await save).postDataJSON()).toMatchObject({
    speakerId: "longanlingxin_v3.1",
    resourceId: "qwen-audio-3.1-tts-plus",
    enabled: false,
  });
  await expect(dialog).toBeHidden();
});

async function aiConfigFixture(page: Page) {
  await fixture(page);
  const labels = {
    script: "多模态文案",
    tts: "百炼配音",
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
      verification: null,
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
  const tts = management[1];
  tts.group = "bailian-speech";
  tts.summary.provider = "阿里云百炼";
  tts.summary.model = "qwen-audio-3.1-tts-plus";
  tts.fields = [
    { key: "DASHSCOPE_API_KEY", label: "共享 API Key", kind: "secret" },
    { key: "DASHSCOPE_WORKSPACE_ID", label: "业务空间 ID", kind: "text" },
  ];
  tts.active.fields = { DASHSCOPE_WORKSPACE_ID: "llm-keagent" };
  tts.active.secrets = { DASHSCOPE_API_KEY: true };
  tts.active.test = { ...script.active.test, id: "tts-sample", service: "tts" };
  tts.candidate = {
    version: 4,
    fields: tts.active.fields,
    secrets: tts.active.secrets,
    test: null,
    missing: [],
    issues: [],
  };
  tts.ttsTestPassed = true;
  tts.reusedTtsTestAt = stamp;
  const clone = management.find((row) => row.summary.id === "voice-clone")!;
  clone.group = tts.group;
  clone.summary.provider = tts.summary.provider;
  clone.summary.model = tts.summary.model;
  clone.fields = [
    ...tts.fields,
    {
      key: "DASHSCOPE_VOICE_CLONE_ENABLED",
      label: "启用声音复刻",
      kind: "toggle",
    },
  ];
  clone.active.fields = {
    ...tts.active.fields,
    DASHSCOPE_VOICE_CLONE_ENABLED: false,
  };
  clone.active.secrets = tts.active.secrets;
  clone.summary.state = "incomplete";
  clone.summary.missing = ["DASHSCOPE_VOICE_CLONE_ENABLED"];
  clone.candidate = {
    ...tts.candidate,
    fields: { ...tts.candidate.fields, DASHSCOPE_VOICE_CLONE_ENABLED: true },
  };
  const beikeCLI = management.find((row) => row.summary.id === "beike-cli")!;
  beikeCLI.summary.state = "missing";
  beikeCLI.summary.missing = ["BEIKE_MCP_API_KEY"];
  beikeCLI.fields = [
    { key: "BEIKE_MCP_API_KEY", label: "MCP API Key", kind: "secret" },
    {
      key: "BEIKE_CLI_PATH",
      label: "CLI 可执行文件路径（可选，留空自动检测）",
      kind: "text",
    },
  ];
  beikeCLI.revision = 1;
  beikeCLI.active = {
    version: 0,
    source: "environment",
    activatedAt: null,
    locked: false,
    fields: { BEIKE_CLI_PATH: "" },
    secrets: { BEIKE_MCP_API_KEY: false },
    test: {
      id: "beike-active-sample",
      service: "beike-cli",
      version: 0,
      mode: "sample",
      status: "failed",
      createdAt: stamp,
      finishedAt: stamp,
      steps: [{ name: "检查已保存的配置", state: "failed" }],
      message: "缺少配置：BEIKE_MCP_API_KEY",
    },
  };
  beikeCLI.candidate = {
    version: 1,
    fields: { BEIKE_CLI_PATH: "" },
    secrets: { BEIKE_MCP_API_KEY: true },
    test: null,
    missing: [],
    issues: [],
  };
  const data: AdminAIConfig = {
    configured: true,
    model: "vision-active",
    baseURL: "https://api.example.com",
    note: "",
    checkedAt: stamp,
    services: management.map((r) => r.summary),
    management,
    voices: [{ id: "public-test", name: "公共讲解女声 · 龙安灵心" }],
    writable: true,
  };
  const writes: { path: string; input: Record<string, unknown> }[] = [];
  const probes = new Map<string, AdminAIProbe>();
  let verification: {
    probe: AdminAIProbe;
    rows: typeof management;
    fields: AdminAIManagement["active"]["fields"];
    secrets: AdminAIManagement["active"]["secrets"];
  } | null = null;
  function finishVerification(status: "passed" | "failed", message?: string) {
    if (!verification) throw new Error("预期存在验证任务");
    const { probe, rows, fields, secrets } = verification;
    probe.status = status;
    probe.finishedAt = stamp;
    probe.message = message;
    if (status === "failed") return;
    for (const row of rows) {
      row.revision = probe.version + 1;
      row.active = {
        version: probe.version,
        source: "managed",
        activatedAt: stamp,
        locked: false,
        fields,
        secrets,
        test: row.summary.id === probe.service ? probe : null,
      };
      row.candidate = null;
      row.summary.state =
        row.summary.id === "voice-clone" &&
        fields.DASHSCOPE_VOICE_CLONE_ENABLED !== true
          ? "incomplete"
          : "configured";
      row.summary.missing = [];
    }
  }
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
      if (route.request().method() === "GET" && path.endsWith("/test")) {
        const id = new URL(route.request().url()).searchParams.get("id") ?? "";
        const probe = probes.get(id);
        if (!probe) throw new Error("收到意外的任务状态请求");
        return route.fulfill({ json: probe, headers });
      }
      const input = route.request().postDataJSON();
      writes.push({ path, input });
      const row = management.find(
        ({ summary }) => summary.id === input.service,
      );
      if (!row) throw new Error("收到意外的 AI 服务请求");
      if (path.endsWith("/verify-enable")) {
        expect(input.revision).toBe(row.revision);
        expect(input.confirmed).toBe(true);
        const saved = input.useSaved ? row.candidate : row.active;
        if (!saved) throw new Error("收到意外的已保存配置请求");
        if (input.useSaved) expect(input.fields).toBeUndefined();
        const fields = { ...saved.fields };
        const secrets = { ...saved.secrets };
        for (const { key, kind } of row.fields) {
          const value = input.fields?.[key];
          if (kind === "secret") {
            if (value) secrets[key] = true;
          } else if (value !== undefined) {
            fields[key] = value;
          }
        }
        const service =
          row.group === tts.group
            ? fields.DASHSCOPE_VOICE_CLONE_ENABLED
              ? "voice-clone"
              : "tts"
            : row.summary.id;
        const probe: AdminAIProbe = {
          id: input.requestId,
          service,
          version: row.revision + 1,
          mode: service === "voice-clone" ? "training" : "sample",
          status: "running",
          createdAt: stamp,
          finishedAt: null,
          steps: [],
        };
        const rows = management.filter((item) => item.group === row.group);
        verification = { probe, rows, fields, secrets };
        probes.set(probe.id, probe);
        for (const item of rows) {
          item.revision = probe.version;
          item.verification = probe;
        }
        return route.fulfill({ json: probe, headers });
      }
      if (path.endsWith("/test")) {
        expect(input.version).toBe(row.active.version);
        row.active.test = {
          id: input.requestId,
          service: row.summary.id,
          version: row.active.version,
          mode: input.mode,
          status: "passed",
          createdAt: stamp,
          finishedAt: stamp,
          steps: [],
        };
        probes.set(row.active.test.id, row.active.test);
        return route.fulfill({ json: row.active.test, headers });
      }
      throw new Error("收到意外的 AI 管理接口请求");
    },
  );
  return { beikeCLI, clone, script, tts, writes, finishVerification };
}

test("旧服务响应和直达链接均不再显示 MiniMax 配置入口", async ({ page }) => {
  const { writes } = await aiConfigFixture(page);
  await page.goto(adminBase + "/#/admin/dashboard");
  const issues = page.getByRole("region", { name: "AI 配置缺项" });
  await expect(issues.getByRole("link", { name: "文案生成" })).toBeVisible();
  await expect(issues.getByText(/MiniMax/)).toHaveCount(0);

  await page.goto(adminBase + "/#/admin/ai?service=opening");
  const services = page.getByRole("region", { name: "AI 服务配置" });
  await expect(
    services.getByRole("button", { name: "管理多模态文案" }),
  ).toBeVisible();
  await expect(services.getByText(/MiniMax/)).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await services.getByRole("button", { name: "管理多模态文案" }).click();
  await expect(
    page.getByRole("dialog", { name: "多模态文案", exact: true }),
  ).toBeVisible();
  expect(writes).toEqual([]);
});

test("贝壳找房沿用已保存的密钥并在换密钥失败时保留生效配置", async ({
  page,
}) => {
  const { beikeCLI, finishVerification, writes } = await aiConfigFixture(page);
  await page.goto(adminBase + "/#/admin/ai?service=beike-cli");
  const status = page.getByRole("dialog", { name: "贝壳找房", exact: true });
  await expect(status.getByText("未设置", { exact: true })).toBeVisible();
  await expect(status.getByRole("radio")).toHaveCount(0);
  await expect(status.getByLabel("MCP API Key", { exact: true })).toHaveCount(
    0,
  );
  await status.getByRole("button", { name: "设置密钥", exact: true }).click();

  const setup = page.getByRole("dialog", { name: "设置密钥", exact: true });
  await expect(
    setup.getByText("已保存，待验证", { exact: true }),
  ).toBeVisible();
  await expect(setup.getByLabel("MCP API Key", { exact: true })).toHaveValue(
    "",
  );
  await setup.getByRole("button", { name: "验证并启用", exact: true }).click();
  await expect
    .poll(() => writes.at(-1))
    .toMatchObject({
      path: "/v1/admin/ai-config/verify-enable",
      input: {
        service: "beike-cli",
        useSaved: true,
        revision: 1,
        confirmed: true,
      },
    });
  expect(beikeCLI.active.secrets.BEIKE_MCP_API_KEY).toBe(false);
  expect(writes.at(-1)?.input).not.toHaveProperty("fields");
  finishVerification("passed");
  await expect(status.getByText("已启用", { exact: true })).toBeVisible();
  expect(beikeCLI.candidate).toBeNull();
  const previous = beikeCLI.active;
  const revision = beikeCLI.revision;

  await status.getByRole("button", { name: "更换密钥", exact: true }).click();
  const replacement = page.getByRole("dialog", {
    name: "更换密钥",
    exact: true,
  });
  const key = replacement.getByLabel("MCP API Key", { exact: true });
  const verify = replacement.getByRole("button", {
    name: "验证并启用",
    exact: true,
  });
  await expect(key).toHaveValue("");
  await key.fill("rejected-fixture-key");
  await verify.click();
  await expect
    .poll(() => writes.at(-1))
    .toMatchObject({
      path: "/v1/admin/ai-config/verify-enable",
      input: {
        service: "beike-cli",
        fields: { BEIKE_MCP_API_KEY: "rejected-fixture-key" },
        revision,
      },
    });
  const failure = "贝壳拒绝此密钥，请检查后重试";
  finishVerification("failed", failure);
  await expect(replacement.getByText(failure, { exact: true })).toBeVisible();
  expect(beikeCLI.active).toBe(previous);
  expect(beikeCLI.candidate).toBeNull();
  const retryRevision = beikeCLI.revision;

  await key.fill("replacement-fixture-key");
  await verify.click();
  await expect
    .poll(() => writes.at(-1))
    .toMatchObject({
      path: "/v1/admin/ai-config/verify-enable",
      input: {
        service: "beike-cli",
        fields: { BEIKE_MCP_API_KEY: "replacement-fixture-key" },
        revision: retryRevision,
      },
    });
  finishVerification("passed");
  await expect(status.getByText("已启用", { exact: true })).toBeVisible();
  await expect(status.getByText("replacement-fixture-key")).toHaveCount(0);
  await status
    .getByRole("button", { name: "测试当前连接", exact: true })
    .click();
  await expect
    .poll(() => writes.at(-1))
    .toMatchObject({
      path: "/v1/admin/ai-config/test",
      input: {
        service: "beike-cli",
        mode: "connection",
        version: retryRevision + 1,
      },
    });
  await expect(status.getByText("连通性通过", { exact: true })).toBeVisible();
});

test("百炼语音保持一个配置入口并验证共享密钥", async ({ page }) => {
  const { clone, tts, finishVerification, writes } =
    await aiConfigFixture(page);
  await page.goto(adminBase + "/#/admin/ai");
  const table = page.getByRole("table");
  await expect(table.getByRole("rowheader")).toHaveCount(4);
  await expect(table.getByRole("button", { name: "管理百炼语音" })).toHaveCount(
    1,
  );
  await expect(table.getByRole("button", { name: "管理声音复刻" })).toHaveCount(
    0,
  );
  await page.goto(adminBase + "/#/admin/ai?service=voice-clone");
  const speech = page.getByRole("dialog", { name: "百炼语音", exact: true });
  await expect(speech.getByRole("radio")).toHaveCount(0);

  await speech
    .getByRole("button", { name: "测试配音样例", exact: true })
    .click();
  const sample = page.getByRole("dialog", {
    name: "测试百炼配音",
    exact: true,
  });
  const voice = sample.getByRole("combobox", { name: "测试用公共音色" });
  await voice.press("ArrowDown");
  await voice.press("Enter");
  await expect(
    sample.getByTitle("公共讲解女声 · 龙安灵心", { exact: true }),
  ).toBeVisible();
  await sample
    .getByRole("button", { name: "确认运行测试", exact: true })
    .click();
  await expect(speech).toBeVisible();
  expect(writes.at(-1)).toMatchObject({
    path: "/v1/admin/ai-config/test",
    input: {
      service: "tts",
      mode: "sample",
      version: 3,
      sample: { voiceId: "public-test" },
    },
  });

  await speech.getByRole("button", { name: "更换密钥", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "更换密钥", exact: true });
  await expect(editor.getByLabel("共享 API Key", { exact: true })).toHaveValue(
    "",
  );
  await expect(editor.getByLabel("业务空间 ID", { exact: true })).toHaveValue(
    "llm-keagent",
  );
  await expect(
    editor.getByRole("switch", { name: "启用声音复刻", exact: true }),
  ).toBeChecked();
  await editor.locator('input[type="file"]').setInputFiles({
    name: "training.wav",
    mimeType: "audio/wav",
    buffer: Buffer.from("mock training audio"),
  });
  await editor.getByRole("checkbox").check();
  await editor.getByRole("button", { name: "验证并启用", exact: true }).click();
  await expect
    .poll(() => writes.at(-1))
    .toMatchObject({
      path: "/v1/admin/ai-config/verify-enable",
      input: {
        service: "voice-clone",
        useSaved: true,
        confirmed: true,
        sample: {
          format: "wav",
          audio: Buffer.from("mock training audio").toString("base64"),
        },
      },
    });
  expect(clone.active.fields.DASHSCOPE_VOICE_CLONE_ENABLED).toBe(false);
  finishVerification("passed");
  await expect(speech).toBeVisible();
  await expect(
    speech.getByRole("button", { name: "测试复刻训练", exact: true }),
  ).toBeEnabled();
  expect(clone.active.fields.DASHSCOPE_VOICE_CLONE_ENABLED).toBe(true);
  expect(clone.active.version).toBe(tts.active.version);
  expect(clone.candidate).toBeNull();
});

test("文案配置验证期间保留生效模型并在验证通过后更新", async ({ page }) => {
  const { script, finishVerification, writes } = await aiConfigFixture(page);
  await page.goto(adminBase + "/#/admin/ai?service=script");
  const status = page.getByRole("dialog", { name: "多模态文案", exact: true });
  for (const width of [1440, 1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(status).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  }
  await status.getByRole("button", { name: "更换密钥", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "更换密钥", exact: true });
  const model = editor.getByLabel("模型名", { exact: true });
  await expect(model).toHaveValue("vision-active");
  await editor
    .getByLabel("API Key", { exact: true })
    .fill("script-fixture-key");
  await model.fill("vision-updated");
  await page.setViewportSize({ width: 1440, height: 900 });
  await editor.getByRole("button", { name: "验证并启用", exact: true }).click();
  await expect
    .poll(() => writes.at(-1))
    .toMatchObject({
      path: "/v1/admin/ai-config/verify-enable",
      input: {
        service: "script",
        revision: 3,
        confirmed: true,
        fields: {
          AI_MODEL: "vision-updated",
          AI_API_KEY: "script-fixture-key",
        },
        sample: { images: [expect.any(String), expect.any(String)] },
      },
    });
  expect(script.active.fields.AI_MODEL).toBe("vision-active");
  await page.reload();
  await expect(
    status.getByText("正在验证提交的配置", { exact: true }),
  ).toBeVisible();
  await expect(
    status.getByText("vision-active", { exact: true }),
  ).toBeVisible();
  await expect(
    status.getByRole("button", { name: "更换密钥", exact: true }),
  ).toBeDisabled();
  expect(writes).toHaveLength(1);
  finishVerification("passed");
  await expect(
    status.getByText("vision-updated", { exact: true }),
  ).toBeVisible();
  await expect(status.getByText("script-fixture-key")).toHaveCount(0);
  await status
    .getByRole("button", { name: "测试当前连接", exact: true })
    .click();
  await expect
    .poll(() => writes.at(-1))
    .toMatchObject({
      path: "/v1/admin/ai-config/test",
      input: { service: "script", version: 4, mode: "connection" },
    });
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
  await expect(page).toHaveTitle("AI来客 · 管理后台");
  await expect(
    page.getByRole("link", { name: "AI来客 · 管理后台" }).locator("img"),
  ).toHaveJSProperty("naturalWidth", 128);
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute(
    "href",
    /keagent-icon\.png$/,
  );
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
    metrics.getByRole("link", { name: /已上架推荐搭配/ }),
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

test("公共模板可独立发布封面并与已上架的剪辑和文案组合", async ({ page }) => {
  const data = await fixture(page);
  await page.goto(adminBase + "/#/admin/resources");
  await expect(
    page.getByRole("heading", { name: "推荐搭配", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "封面模板", exact: true }).click();
  await page.getByRole("button", { name: "新建封面模板" }).click();
  const form = page.getByRole("dialog", { name: "新建封面模板" });
  await form.getByLabel("模板名称", { exact: true }).fill("门店统一封面");
  await form.getByLabel("封面品牌色").fill("#336699");
  await form.getByLabel("封面标题来源").click();
  await page
    .locator(".ant-select-dropdown:visible")
    .getByText("使用房源标题", { exact: true })
    .click();
  await expect(form.locator("figure")).toContainText("示例小区两居室");
  await expect(form.getByLabel("文案语言")).toHaveCount(0);
  await form.getByRole("button", { name: "保存草稿" }).click();
  await expect(
    page.getByRole("button", { name: "启用版本", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "预览校验", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "制作模板预览校验" });
  await expect(drawer.locator("figure")).toContainText("示例小区两居室");
  await expect(drawer.getByText("剪辑版式示意", { exact: true })).toHaveCount(
    0,
  );
  await drawer.getByRole("button", { name: "关闭" }).click();
  await page.getByRole("button", { name: "启用版本", exact: true }).click();
  await page.getByRole("button", { name: "确认启用", exact: true }).click();
  await page.getByRole("button", { name: "返回模板目录" }).click();
  await page.getByRole("button", { name: "推荐搭配", exact: true }).click();
  await page.getByRole("button", { name: "新建推荐搭配" }).click();
  const bundle = page.getByRole("dialog", { name: "新建推荐搭配" });
  await bundle.getByLabel("模板名称", { exact: true }).fill("门店带看");
  for (const [label, option] of [
    ["剪辑模板", "全景运镜"],
    ["封面模板", "门店统一封面"],
    ["文案模板", "卖点先行"],
  ]) {
    await bundle.getByLabel(label, { exact: true }).click();
    await page
      .getByRole("option", { name: option + " · v1.0.0", exact: true })
      .click();
  }
  await bundle.getByRole("button", { name: "保存草稿" }).click();
  await expect(
    page.getByRole("heading", { name: "门店带看", exact: true }),
  ).toBeVisible();
  expect(
    data.writes.filter((w) => w.path.endsWith("/resources")).at(-1)?.body,
  ).toMatchObject({
    definition: {
      kind: "bundle",
      parts: {
        edit: { id: "edit", version: "1.0.0" },
        cover: { id: "new-resource", version: "1.0.0" },
        script: { id: "script", version: "1.0.0" },
      },
    },
  });
  await page.getByRole("button", { name: "预览校验", exact: true }).click();
  await expect(drawer.getByText("剪辑版式示意", { exact: true })).toBeVisible();
  await expect(drawer.locator("figure")).toContainText("示例小区两居室");
  await expect(
    drawer.getByText("这是另一张室内照片。", { exact: true }),
  ).toBeVisible();
  await drawer.getByRole("button", { name: "关闭" }).click();
  await page.getByRole("button", { name: "启用版本", exact: true }).click();
  await page.getByRole("button", { name: "确认启用", exact: true }).click();
  await page.getByRole("button", { name: "返回模板目录" }).click();
  await expect(
    page.getByRole("row").filter({ hasText: "门店带看" }),
  ).toContainText("门店统一封面");
  await page.getByRole("button", { name: "门店带看", exact: true }).click();
  await page.getByRole("button", { name: "复制搭配", exact: true }).click();
  const copy = page.getByRole("dialog", { name: "复制为新搭配" });
  await expect(copy.getByLabel("模板名称", { exact: true })).toHaveValue(
    "门店带看（副本）",
  );
  await copy.getByLabel("封面模板", { exact: true }).click();
  await page
    .getByRole("option", { name: "品牌封面 · v1.0.0", exact: true })
    .click();
  await copy.getByRole("button", { name: "保存草稿" }).click();
  await expect(
    page.getByRole("heading", { name: "门店带看（副本）", exact: true }),
  ).toBeVisible();
  const cloned = data.writes
    .filter((w) => w.path.endsWith("/resources"))
    .at(-1)?.body;
  expect(cloned).toMatchObject({
    definition: {
      parts: {
        edit: { id: "edit" },
        script: { id: "script" },
        cover: { id: "cover" },
      },
    },
  });
  expect(cloned).not.toHaveProperty("versionOf");
});

test("剪辑和文案编辑器各自只提交本类制作规则", async ({ page }) => {
  const data = await fixture(page);
  await page.goto(adminBase + "/#/admin/resources?catalog=edit");
  await page.getByRole("button", { name: "新建剪辑模板", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "新建剪辑模板" });
  await edit.getByLabel("模板名称", { exact: true }).fill("门店竖屏");
  await expect(edit.getByLabel("逐图文案规则")).toHaveCount(0);
  await edit.getByRole("button", { name: "保存草稿" }).click();
  await page.getByRole("button", { name: "返回模板目录" }).click();
  const savedEdit = data.writes.find((w) =>
    w.path.endsWith("/resources"),
  )?.body;
  expect(savedEdit).toMatchObject({
    definition: {
      kind: "edit",
      config: { aspectRatio: "9:16", maxSweep: 100 },
    },
  });
  expect(savedEdit).not.toHaveProperty("definition.config.language");
  await page.getByRole("button", { name: "文案模板", exact: true }).click();
  await page.getByRole("button", { name: "新建文案模板", exact: true }).click();
  const script = page.getByRole("dialog", { name: "新建文案模板" });
  await script.getByLabel("模板名称", { exact: true }).fill("轻松口播");
  await script
    .getByLabel("逐图文案规则")
    .fill("每个空间讲一个可以看见的特点。");
  await expect(script.getByLabel("画幅", { exact: true })).toHaveCount(0);
  await script.getByRole("button", { name: "保存草稿" }).click();
  await expect(
    page.getByRole("heading", { name: "轻松口播", exact: true }),
  ).toBeVisible();
  expect(
    data.writes.filter((w) => w.path.endsWith("/resources")).at(-1)?.body,
  ).toMatchObject({
    definition: {
      kind: "script",
      language: "zh-CN",
      scriptRules: { scene: "每个空间讲一个可以看见的特点。" },
    },
  });
});

test("模板目录只显示当前版本，编辑页可更新、启用和切回旧版本", async ({
  page,
}) => {
  const data = await fixture(page);
  await page.goto(adminBase + "/#/admin/resources");
  await page.getByRole("button", { name: "旧版完整模板", exact: true }).click();
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

test("删除公共模板需要确认，成功后从目录移除", async ({ page }) => {
  const data = await fixture(page);
  await page.goto(adminBase + "/#/admin/resources?catalog=legacy");
  const row = page.locator('tr[data-row-key="published"]');
  const remove = row.getByRole("button", { name: "删除模板", exact: true });
  const dialog = page.getByRole("dialog", { name: "删除「在架视频模板」？" });

  await remove.click();
  await dialog.getByRole("button", { name: /^取\s*消$/ }).click();
  await expect(row).toBeVisible();
  expect(data.writes).toHaveLength(0);

  await remove.click();
  await dialog.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(page.getByText("模板已删除", { exact: true })).toBeVisible();
  await expect(row).toHaveCount(0);
  expect(data.writes).toEqual([
    { path: "/v1/admin/resources/delete", body: { id: "published" } },
  ]);
});

test("公共模板可配置本机经纪人开场视频", async ({ page }) => {
  const data = await fixture(page);
  await page.goto(adminBase + "/#/admin/resources?catalog=legacy");
  await page.getByRole("button", { name: "新建模板草稿", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "新建模板草稿",
    exact: true,
  });
  await dialog.getByLabel("模板名称", { exact: true }).fill("小区开场模板");
  await dialog.getByRole("combobox", { name: /视频表现$/ }).click();
  await page
    .locator(".ant-select-dropdown:visible")
    .getByText("经纪人开场视频", { exact: true })
    .click();
  await expect(dialog.getByText(/制作时由用户选择本机开场视频/)).toBeVisible();
  await dialog.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(dialog).toBeHidden();
  const production = data.writes.find((write) =>
    write.path.endsWith("/resources"),
  )?.body.production as typeof defaultProduction | undefined;
  expect(production?.config.videoMode).toBe("avatar");
  expect(production?.opening).toBeUndefined();
});

test("空间镜头模板隐藏旋转参数并保留配置完整性", async ({ page }) => {
  const data = await fixture(page);
  await page.goto(adminBase + "/#/admin/resources?catalog=legacy");
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
  await page.goto(adminBase + "/#/admin/resources?catalog=legacy&type=prompt");
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
  const password = "Tst-8Pwd";
  await dialog.getByLabel("新密码", { exact: true }).fill(password);
  await dialog.getByLabel("确认新密码", { exact: true }).fill(password);
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
    password,
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
  await expect(
    page.getByText("登录 AI来客管理后台", { exact: true }),
  ).toBeVisible();
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
