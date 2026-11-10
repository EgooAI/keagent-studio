import assert from "node:assert/strict";
import { loadEnvFile } from "node:process";
import { Pool } from "pg";

loadEnvFile(".env.local");
const authURL = process.env.BETTER_AUTH_URL;
const goURL = process.env.GO_API_URL || "http://127.0.0.1:18081";
const databaseURL = new URL(process.env.DATABASE_URL);
if (
  new URL(authURL).origin !== "http://127.0.0.1:18080" ||
  new URL(goURL).origin !== "http://127.0.0.1:18081" ||
  databaseURL.hostname !== "127.0.0.1" ||
  databaseURL.port !== "55432" ||
  databaseURL.pathname !== "/keagent"
)
  throw new Error("管理联调仅允许本项目本机服务与独立数据库");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prefix = `admin-check-${crypto.randomUUID()}`;
const email = `${prefix}@example.test`;
const password = crypto.randomUUID();
const accessTokens = new Map();
const sessionCookies = new Map();
const resourceIds = [];
let userId;
let admin;
async function request(path, session, body) {
  const business = path.startsWith("/v1/");
  let token = session;
  if (business && session) {
    if (!accessTokens.has(session)) {
      const exchange = await request("/api/auth/token", session);
      assert.equal(exchange.status, 200);
      accessTokens.set(session, exchange.data.token);
    }
    token = accessTokens.get(session);
  }
  const response = await fetch((business ? goURL : authURL) + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://127.0.0.1:5174",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(!business && sessionCookies.has(session)
        ? { Cookie: sessionCookies.get(session) }
        : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    data: await response.json(),
    token: response.headers.get("set-auth-token"),
    cookie: response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; "),
  };
}
async function login(email, password) {
  const result = await request("/api/auth/sign-in/email", null, {
    email,
    password,
  });
  assert.equal(result.status, 200, "账号登录失败");
  assert.ok(result.token);
  sessionCookies.set(result.token, result.cookie);
  return result.token;
}
async function ok(path, session = admin, body) {
  const result = await request(path, session, body);
  assert.equal(result.status, 200, `${path}: ${JSON.stringify(result.data)}`);
  return result.data;
}
try {
  admin = await login(
    process.env.BOOTSTRAP_ADMIN_EMAIL,
    process.env.BOOTSTRAP_ADMIN_PASSWORD,
  );
  userId = (
    await ok("/api/auth/admin/create-user", admin, {
      name: prefix,
      email,
      password,
      role: "user",
    })
  ).user.id;
  const session = await login(email, password);
  const workspace = await ok("/v1/workspace", session);
  const property = {
    id: `${prefix}-property`,
    propertyNumber: prefix,
    title: "管理联调房源",
    city: "上海",
    district: "浦东",
    community: "隔离测试小区",
    layout: "两室一厅",
    priceCents: 300000000,
    areaSqm: 90,
    description: "仅用于自动验证",
    image: "",
    images: [],
    sellingPoints: [],
    videoCount: 0,
    importStatus: "ready",
    lastVerifiedAt: new Date().toISOString(),
  };
  const tasks = Array.from({ length: 123 }, (_, i) => ({
    id: `${prefix}-task-${String(i).padStart(3, "0")}`,
    batchId: `${prefix}-batch`,
    propertyId: property.id,
    propertySnapshot: property,
    configSnapshot: workspace.draft,
    status: "failed",
    stage: "script",
    progress: 0,
    error: "隔离测试：配置缺项",
    script: `隔离测试文案 ${i}`,
    scriptRevision: 1,
    productionRevision: 1,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  }));
  await pool.query(
    "UPDATE keagent_workspace SET payload=jsonb_set(payload,'{tasks}',$2::jsonb) WHERE owner_id=$1",
    [userId, JSON.stringify(tasks)],
  );
  await pool.query(
    `INSERT INTO keagent_device(id,owner_id,session_id,name,platform,seen_at)
    SELECT $1||'-device-'||lpad(n::text,3,'0'),$2,'isolated-session',$1||' 设备 '||n,'win32',
      '2026-01-01'::timestamptz+n*interval '1 second' FROM generate_series(0,122) n`,
    [prefix, userId],
  );
  await pool.query(
    "INSERT INTO keagent_device(id,owner_id,session_id,name,platform) VALUES($1,$2,'isolated-session',$1,'test')",
    [`${prefix}-orphan`, `${prefix}-missing-user`],
  );

  const kinds = [
    "users",
    "devices",
    "resources",
    "tasks",
    "audit",
    "auth-audit",
  ];
  for (const kind of kinds) {
    assert.equal(
      (await request(`/v1/admin/${kind}/list`, session)).status,
      403,
    );
    const page = await ok(`/v1/admin/${kind}/list?limit=20&offset=0`);
    assert.ok(Array.isArray(page.items));
    assert.ok(Number.isInteger(page.total));
    assert.equal(page.limit, 20);
    assert.equal(page.offset, 0);
  }
  const users = await ok(
    `/v1/admin/users/list?q=${encodeURIComponent(email)}&role=user&banned=false`,
  );
  assert.equal(users.total, 1);
  assert.equal(users.items[0].id, userId);
  for (const kind of ["devices", "tasks"]) {
    const path = `/v1/admin/${kind}/list?ownerId=${userId}&limit=100&offset=`;
    const first = await ok(path + "0");
    const last = await ok(path + "100");
    assert.equal(first.total, 123);
    assert.equal(first.items.length, 100);
    assert.equal(last.items.length, 23);
    assert.equal(
      new Set([...first.items, ...last.items].map((x) => x.id)).size,
      123,
    );
    assert.deepEqual(first, await ok(path + "0"), "分页排序应稳定");
    assert.equal(first.items[0].owner.email, email);
    if (kind === "tasks") {
      assert.equal(first.items[0].propertyTitle, property.title);
      assert.equal(first.items[0].script, undefined, "列表不能包含长文案");
    }
  }
  const orphan = await ok(
    `/v1/admin/devices/list?ownerId=${prefix}-missing-user`,
  );
  assert.equal(orphan.items[0].owner, null);
  const detail = await ok(`/v1/admin/tasks/${tasks[0].id}`);
  assert.equal(detail.task.script, tasks[0].script);
  assert.equal(detail.owner.email, email);
  assert.equal(
    (await request(`/v1/admin/tasks/${prefix}-not-found`, admin)).status,
    404,
  );
  for (const kind of ["devices", "resources", "tasks", "audit"])
    assert.ok(Array.isArray(await ok(`/v1/admin/${kind}`)), "保留旧数组接口");
  for (const query of ["limit=101", "limit=0", "offset=-1"])
    assert.ok(
      [400, 422].includes(
        (await request(`/v1/admin/tasks/list?${query}`, admin)).status,
      ),
    );

  const resource = {
    name: prefix,
    type: "prompt",
    version: "1",
    description: "目录验证",
    category: "联调",
    thumbnail: "",
    compatibleModes: ["voiceover"],
    sizeMb: 0,
    published: false,
  };
  const created = await ok("/v1/admin/resources", admin, resource);
  resourceIds.push(created.id);
  const saved = { ...resource, id: created.id, description: "已编辑草稿" };
  await ok("/v1/admin/resources", admin, saved);
  await ok("/v1/admin/resources", admin, { ...saved, published: true });
  assert.equal(
    (
      await request("/v1/admin/resources", admin, {
        ...saved,
        published: true,
        description: "禁止覆盖",
      })
    ).status,
    409,
  );
  await ok("/v1/admin/resources", admin, { ...saved, published: false });
  const unpublished = await ok(
    `/v1/admin/resources/list?q=${prefix}&state=unpublished`,
  );
  assert.equal(unpublished.total, 1);
  for (let i = 0; i < 5; i++) {
    const raceId = `${prefix}-race-${i}`;
    resourceIds.push(raceId);
    const published = {
      ...resource,
      id: raceId,
      name: `${prefix} 发布版本 ${i}`,
      version: "published-v1",
      published: true,
    };
    const overwrite = {
      ...resource,
      id: raceId,
      name: `${prefix} 覆盖版本 ${i}`,
      version: "overwritten-v2",
      published: false,
    };
    const [publishResult, overwriteResult] = await Promise.all([
      request("/v1/admin/resources", admin, published),
      request("/v1/admin/resources", admin, overwrite),
    ]);
    assert.equal(publishResult.status, 200, "并发首次发布应成功");
    assert.ok([200, 409].includes(overwriteResult.status));
    const rows = await ok(
      `/v1/admin/resources/list?q=${encodeURIComponent(raceId)}`,
    );
    assert.equal(rows.total, 1);
    const stored = rows.items[0];
    assert.equal(stored.name, published.name, "已发布模板不能被并发创建覆盖");
    assert.equal(stored.version, published.version);
    assert.equal(stored.publishedOnce, true);
    assert.equal(stored.published, true);
  }
  const resourceLog = await ok(`/v1/admin/audit/list?targetId=${created.id}`);
  assert.ok(resourceLog.items.length >= 4);
  assert.ok(
    resourceLog.items.every(
      (entry) => entry.actor?.email === process.env.BOOTSTRAP_ADMIN_EMAIL,
    ),
  );
  assert.deepEqual(
    new Set(resourceLog.items.map((entry) => entry.action)),
    new Set([
      "resource.create",
      "resource.update",
      "resource.publish",
      "resource.unpublish",
    ]),
  );
  const testDeviceId = `${prefix}-device-000`;
  await ok("/v1/admin/devices/revoke", admin, { id: testDeviceId });
  const deviceLog = await ok(`/v1/admin/audit/list?targetId=${testDeviceId}`);
  assert.equal(deviceLog.items[0].action, "device.revoke");
  const authLog = await ok(`/v1/admin/auth-audit/list?targetId=${userId}`);
  assert.ok(authLog.items.some((entry) => entry.target?.email === email));
  const overview = await ok("/v1/admin/overview");
  assert.ok(overview.failedTasks >= 123);
  assert.ok(overview.devices >= 123);
  const ai = await ok("/v1/admin/ai-config");
  assert.deepEqual(ai.services.map((service) => service.id).sort(), [
    "beike",
    "expansion",
    "opening",
    "script",
    "tts",
    "voice-clone",
  ]);
  const publicData = JSON.stringify({
    users,
    detail,
    resourceLog,
    authLog,
    ai,
  });
  assert.doesNotMatch(
    publicData,
    /"(?:password|token|sessionId|privateKey|secretAccessKey)"\s*:/i,
  );
  for (const key of [
    "AI_API_KEY",
    "VOLC_TTS_API_KEY",
    "MINIMAX_API_KEY",
    "BETTER_AUTH_SECRET",
  ])
    if (process.env[key])
      assert.ok(!publicData.includes(process.env[key]), `${key} 不应回显`);

  await ok("/api/auth/admin/set-user-password", admin, {
    userId,
    newPassword: password + "-reset",
  });
  const passwordLog = await ok(`/v1/admin/auth-audit/list?targetId=${userId}`);
  assert.ok(passwordLog.items.some((entry) => entry.target?.email === email));
  await ok("/api/auth/admin/revoke-user-sessions", admin, { userId });
  assert.equal((await request("/v1/workspace", session)).status, 401);
  const nextSession = await login(email, password + "-reset");
  await ok("/v1/workspace", nextSession);
  await ok("/api/auth/admin/ban-user", admin, {
    userId,
    banReason: "隔离测试",
  });
  assert.ok(
    [401, 403].includes((await request("/v1/workspace", nextSession)).status),
  );
  await ok("/api/auth/admin/unban-user", admin, { userId });
  console.log(
    "PASS: 管理分页跨100条、组合筛选、关联/缺失关联、任务详情、模板版本、日志、安全与即时撤权",
  );
} finally {
  if (userId) {
    await pool.query("DELETE FROM keagent_audit WHERE target_id=$1", [
      `${prefix}-device-000`,
    ]);
    await pool.query(
      "DELETE FROM keagent_device WHERE owner_id=$1 OR owner_id=$2",
      [userId, `${prefix}-missing-user`],
    );
    await pool.query("DELETE FROM keagent_workspace WHERE owner_id=$1", [
      userId,
    ]);
    if (resourceIds.length) {
      await pool.query(
        "DELETE FROM keagent_audit WHERE target_id=ANY($1::text[])",
        [resourceIds],
      );
      await pool.query(
        "DELETE FROM keagent_resource WHERE id=ANY($1::text[])",
        [resourceIds],
      );
    }
    if (admin) await request("/api/auth/admin/remove-user", admin, { userId });
  }
  if (admin) await request("/api/auth/sign-out", admin, {});
  await pool.end();
}
