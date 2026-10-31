import assert from "node:assert/strict";
import { loadEnvFile } from "node:process";
loadEnvFile(".env.local");
const base = process.env.BETTER_AUTH_URL;
if (new URL(base).origin !== "http://127.0.0.1:18080")
  throw new Error("联调脚本仅允许本项目本机环境");
async function request(path, token, body) {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://127.0.0.1:5174",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  return {
    status: response.status,
    data,
    token: response.headers.get("set-auth-token"),
  };
}
const login = async (email, password) => {
  const r = await request("/api/auth/sign-in/email", null, { email, password });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.token);
  return r.token;
};
const admin = await login(
  process.env.BOOTSTRAP_ADMIN_EMAIL,
  process.env.BOOTSTRAP_ADMIN_PASSWORD,
);
assert.equal((await request("/v1/workspace")).status, 401);
const suffix = crypto.randomUUID();
const users = [];
for (const name of ["Alice", "Bob"]) {
  const email = `${name.toLowerCase()}-${suffix}@example.test`;
  const password = crypto.randomUUID();
  const created = await request("/api/auth/admin/create-user", admin, {
    name,
    email,
    password,
    role: "user",
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  users.push({
    id: created.data.user.id,
    email,
    token: await login(email, password),
  });
}
const [a, b] = users;
assert.equal((await request("/v1/admin/devices", a.token)).status, 403);
assert.equal(
  (await request("/v1/workspace", a.token)).data.properties.length,
  0,
);
const property = await request("/v1/commands/createProperty", a.token, [
  {
    title: "联调房源",
    community: "测试小区",
    propertyNumber: suffix,
    areaSqm: 90,
    priceCents: 300000000,
  },
]);
assert.equal(property.status, 200, JSON.stringify(property.data));
assert.equal(
  (await request("/v1/workspace", b.token)).data.properties.length,
  0,
);
assert.equal(
  (
    await request("/v1/commands/updateProperty", b.token, [
      property.data.id,
      { title: "越权" },
    ])
  ).status,
  404,
);
const config = (await request("/v1/workspace", a.token)).data.draft;
for (const kind of ["video", "style", "prompt", "cover"]) {
  const resource = {
    name: "联调资源 " + kind,
    type: kind,
    version: "1",
    description: "",
    category: "联调",
    thumbnail: "",
    compatibleModes: ["voiceover", "avatar"],
    sizeMb: 0,
    published: true,
  };
  const r = await request("/v1/admin/resources", admin, resource);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  config[kind + "Template"] = { id: r.data.id, version: "1" };
}
assert.equal(
  (await request("/v1/workspace", a.token)).data.resources.length >= 4,
  true,
);
config.propertyIds = [property.data.id];
const batch = await request("/v1/commands/createBatch", a.token, [
  config,
  suffix,
]);
assert.equal(batch.status, 200, JSON.stringify(batch.data));
assert.equal(
  (await request("/v1/commands/createBatch", a.token, [config, suffix])).data
    .id,
  batch.data.id,
);
let workspace;
for (let i = 0; i < 12; i++) {
  workspace = (await request("/v1/workspace", a.token)).data;
  if (workspace.tasks[0]?.status === "failed") break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
assert.equal(workspace.tasks[0].status, "failed");
assert.match(workspace.tasks[0].error, /未配置/);
const device = await request("/v1/devices/register", a.token, {
  name: "联调设备",
  platform: "test",
});
assert.equal(device.status, 200);
assert.equal(
  (await request("/v1/admin/devices/revoke", admin, { id: device.data.id }))
    .status,
  200,
);
assert.equal(
  (
    await request("/v1/devices/register", a.token, {
      id: device.data.id,
      name: "联调设备",
      platform: "test",
    })
  ).status,
  403,
);
assert.equal(
  (
    await request("/api/auth/admin/ban-user", admin, {
      userId: a.id,
      banReason: "联调验证",
    })
  ).status,
  200,
);
assert.equal((await request("/v1/workspace", a.token)).status, 401);
assert.equal(
  (
    await request("/api/auth/admin/revoke-user-sessions", admin, {
      userId: b.id,
    })
  ).status,
  200,
);
assert.equal((await request("/v1/workspace", b.token)).status, 401);
console.log(
  "PASS: SDK login/admin, Go identity, ownership, resource sync, batch idempotency, AI unconfigured, device revoke, user ban and session revoke",
);
