// Exercise the real main-process and preload entry points without using a WeChat account.
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const { mkdir, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { registerPublishing } = require(
  path.resolve("apps/desktop/electron/publishing/dist/runtime.cjs"),
);
const root = process.env.CHANNELS_TEST_ROOT;
assert.ok(root, "Start with scripts/channels-host-integration.mjs");
app.setPath("userData", root);

async function main() {
  await app.whenReady();
  const host = "https://host.example";
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.resolve("apps/desktop/electron/preload.cjs"),
    },
  });
  session.defaultSession.protocol.handle(
    "https",
    () =>
      new Response("<title>账号测试</title>", {
        headers: { "content-type": "text/html" },
      }),
  );
  await window.loadURL(host);
  const identity = {
    userId: "test-user",
    deviceId: "test-device",
    generation: 1,
  };
  const accounts = new Map();
  const calls = [];
  const login = Promise.withResolvers();
  const qrReady = Promise.withResolvers();
  const verified = Promise.withResolvers();
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  const file = path.join(root, "wechat_verification_qr.png");
  await writeFile(file, png);
  let currentId = "fixture@finder";
  const result = () => ({
    platform: "channels",
    status: "logged_in",
    accountId: currentId,
    nickname: "夹具视频号",
    checkedAt: new Date().toISOString(),
    evidence: [],
  });
  const service = registerPublishing(
    window,
    {
      identity: async () => identity,
      exchange: {},
      request: async (route, input) => {
        if (route.endsWith("/accounts/list"))
          return { items: [...accounts.values()] };
        if (
          !route.endsWith("/accounts/bind") &&
          !route.endsWith("/accounts/update")
        )
          throw new Error(route);
        const account = {
          ...accounts.get(input.id),
          deviceId: identity.deviceId,
          ...input,
        };
        accounts.set(input.id, account);
        return account;
      },
      channelsChrome: async (job, signal, events = {}) => {
        signal.throwIfAborted();
        calls.push(job.action);
        const bundledProfile = path.join(
          path.dirname(job.profileDir),
          "chromium-profile",
        );
        await mkdir(bundledProfile, { recursive: true });
        await writeFile(path.join(bundledProfile, "Local State"), "{}");
        if (job.action === "check") return result();
        if (job.action === "login") {
          events.opened();
          await login.promise;
          return result();
        }
        assert.equal(job.action, "publish");
        assert.equal(job.expectedAccountId, currentId);
        events.verification(file);
        qrReady.resolve();
        try {
          await verified.promise;
          await events.beforeSubmit();
        } finally {
          events.verification(undefined);
        }
      },
    },
    host,
  );
  const request = (method, input = {}) =>
    window.webContents.executeJavaScript(
      "window.desktop.publishing.request(" +
        JSON.stringify(method) +
        "," +
        JSON.stringify(input) +
        ")",
    );
  const ipc = async (method, input) => {
    const reply = await request(method, input);
    assert.equal(reply.ok, true, JSON.stringify(reply));
    return reply.data;
  };

  try {
    const { id } = await ipc("account.add", { platform: "channels" });
    assert.deepEqual((await ipc("state")).channelsLoginAccountIds, [id]);
    assert.equal(window.contentView.children.length, 0);
    login.resolve();
    const end = Date.now() + 5000;
    while ((await ipc("state")).channelsLoginAccountIds.length) {
      if (Date.now() > end) throw new Error("扫码完成后未保存账号");
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(accounts.get(id).platformUserId, currentId);
    assert.equal(accounts.get(id).savedProfile, true);

    await ipc("account.open", { accountId: id });
    await ipc("account.check", { accountId: id });
    assert.deepEqual(calls, ["login", "check", "check"]);
    currentId = "another@finder";
    const changed = await request("account.save", { accountId: id });
    assert.equal(changed.ok, false);
    assert.equal(changed.error.code, "ACCOUNT_CHANGED");
    currentId = accounts.get(id).platformUserId;

    const requestKey = "test-request";
    let submissions = 0;
    const publish = service.publisher.ports.publish(
      id,
      {
        platform: "channels",
        accountId: id,
        requestKey,
        title: "测试样片",
        description: "",
        hashtags: [],
      },
      { video: "fixture.mp4" },
      new AbortController().signal,
      { run: (_key, _name, work) => work() },
      async () => {
        submissions++;
      },
      () => {},
    );
    await qrReady.promise;
    const state = await ipc("state");
    assert.equal(state.channelsVerificationAccountId, id);
    assert.deepEqual(state.channelsLoginAccountIds, []);
    assert.equal(window.contentView.children.length, 0);
    assert.equal(submissions, 0);
    const record = {
      accountId: id,
      state: "running",
      platform: "channels",
      requestKey,
    };
    service.publisher.active = { ...record, requestKey: "other" };
    assert.equal(
      (await request("channels.verification", { accountId: id })).ok,
      false,
    );
    service.publisher.active = record;
    const { image } = await ipc("channels.verification", { accountId: id });
    assert.equal(image, "data:image/png;base64," + png.toString("base64"));
    verified.resolve();
    await publish;
    assert.equal(submissions, 1);
    assert.equal(calls.at(-1), "publish");
    assert.equal((await ipc("state")).channelsVerificationAccountId, undefined);
    assert.equal(
      (await request("channels.verification", { accountId: id })).ok,
      false,
    );
    console.log(
      "视频号桌面主进程通过扫码绑定、后台复用、错号拦截及当前任务实名回交检查",
    );
  } finally {
    service.publisher.active = undefined;
    service.stop();
  }
}

main()
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
