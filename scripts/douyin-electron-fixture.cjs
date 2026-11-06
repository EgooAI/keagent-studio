// All platform domains below are intercepted inside dedicated test Sessions. No real publishing.
const { app, BrowserWindow, protocol } = require("electron");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  crypto = require("node:crypto"),
  assert = require("node:assert/strict");
const root =
  process.env.DOUYIN_TEST_ROOT ||
  fs.mkdtempSync(path.join(os.tmpdir(), "keagent-douyin-electron-"));
app.setPath("userData", root);
protocol.registerSchemesAsPrivileged([
  {
    scheme: "keagent",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);
const hash = (data) => crypto.createHash("sha256").update(data).digest("hex");
app.whenReady().then(async () => {
  const windows = [];
  try {
    const project = path.resolve(__dirname, "..");
    const { registerArtifactMedia } = require(
      path.join(
        project,
        "apps/desktop/electron/artifact-media/dist/runtime.cjs",
      ),
    );
    const { registerPublishing } = require(
      path.join(project, "apps/desktop/electron/publishing/dist/runtime.cjs"),
    );
    protocol.handle(
      "keagent",
      () =>
        new Response(
          "<!doctype html><html><body><h1>Controlled integration surface</h1></body></html>",
          { headers: { "Content-Type": "text/html" } },
        ),
    );
    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(project, "apps/desktop/electron/preload.cjs"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    windows.push(window);
    const fixture = JSON.parse(
      fs.readFileSync(
        path.join(
          project,
          "packages/shared-types/fixtures/artifact-handoff.v1.json",
        ),
        "utf8",
      ),
    );
    const video = fs.readFileSync(
      path.join(project, "apps/desktop/public/media/demo-property.mp4"),
    );
    const cover = fs.readFileSync(
      path.join(project, "apps/desktop/public/media/interior-1.jpg"),
    );
    const controlledVideo = path.join(root, "test-video.mp4"),
      controlledCover = path.join(root, "test-cover.jpg");
    fs.writeFileSync(controlledVideo, video);
    fs.writeFileSync(controlledCover, cover);
    for (const asset of fixture.assets) {
      const bytes = asset.kind === "video" ? video : cover;
      asset.byteSize = bytes.length;
      asset.sha256 = hash(bytes);
    }
    const accounts = new Map(),
      records = new Map(),
      requests = [];
    let submits = 0;
    let dropTerminal = true;
    const sessions = [];
    let generation = 1;
    const testBase = process.env.ARTIFACT_EXCHANGE_TEST_URL;
    async function testAPI(route, input) {
      assert.ok(
        testBase &&
          new URL(testBase).hostname === "127.0.0.1" &&
          new URL(testBase).protocol === "http:",
      );
      const body = JSON.stringify(input);
      const actor = {
        userId: fixture.ownerId,
        deviceId: fixture.deviceId,
        sessionId: "registry-integration-session",
        role: "admin",
        timestamp: Math.floor(Date.now() / 1000),
        nonce: crypto.randomBytes(16).toString("hex"),
      };
      const encoded = Buffer.from(JSON.stringify(actor)).toString("base64url");
      const signature = crypto
        .createHmac("sha256", process.env.ARTIFACT_EXCHANGE_TEST_SECRET)
        .update(`POST\n${route}\n${encoded}\n${hash(Buffer.from(body))}`)
        .digest("hex");
      const response = await fetch(testBase + route, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Keagent-Context": encoded,
          "X-Keagent-Signature": signature,
        },
        body,
      });
      const value = await response.json();
      if (!response.ok)
        throw Object.assign(
          new Error(value.error?.message || "Integration API failed"),
          { status: response.status, code: value.error?.code },
        );
      return value;
    }
    const dependencies = {
      identity: async () => ({
        userId: fixture.ownerId,
        deviceId: fixture.deviceId,
        generation,
      }),
      exchange: {
        getHandoff: async () => structuredClone(fixture),
        getArtifact: async () => structuredClone(fixture.artifact),
        getAsset: async (id) =>
          structuredClone(fixture.assets.find((asset) => asset.id === id)),
      },
      request: async (route, input = {}) => {
        const op = route.replace("/v1/douyin/", "");
        if (op === "accounts/list") return { items: [...accounts.values()] };
        if (op === "accounts/bind" || op === "accounts/update") {
          const account = {
            ...accounts.get(input.id),
            ...input,
            deviceId: fixture.deviceId,
            lastCheckedAt: new Date().toISOString(),
          };
          accounts.set(input.id, account);
          return account;
        }
        if (op === "records/create") {
          const prior = records.get(input.requestKey);
          if (prior) return { record: prior, created: false };
          const record = {
            ...input,
            id: "e".repeat(32),
            ownerId: fixture.ownerId,
            deviceId: fixture.deviceId,
            artifactId: fixture.artifact.id,
            state: "running",
            progress: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            logs: [],
          };
          records.set(input.requestKey, structuredClone(record));
          return { record, created: true };
        }
        if (op === "records/report") {
          if (input.state === "accepted" && dropTerminal) {
            dropTerminal = false;
            throw new Error("Controlled lost terminal acknowledgment");
          }
          records.set(input.requestKey, structuredClone(input));
          return structuredClone(input);
        }
        if (op === "records/heartbeat") return {};
        throw new Error("Unexpected controlled cloud operation");
      },
      configureSession: async (session) => {
        sessions.push(session);
        await session.cookies.set({
          url: "https://creator.douyin.com/",
          name: "sessionid",
          value: "explicit-test-cookie",
          expirationDate: Date.now() / 1000 + 3600,
        });
        session.protocol.handle("https", async (request) => {
          const url = new URL(request.url);
          requests.push(url.pathname + url.search);
          const json = (value) =>
            new Response(JSON.stringify(value), {
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "https://creator.douyin.com",
                "Access-Control-Allow-Credentials": "true",
              },
            });
          if (url.pathname.includes("user/info"))
            return json({
              status_code: 0,
              douyin_user_verify_info: {
                douyin_unique_id: "controlled-public-id",
                nick_name: "集成测试抖音账号",
              },
            });
          if (url.pathname.includes("upload/auth/v5"))
            return json({
              status_code: 0,
              auth: JSON.stringify({
                AccessKeyID: "fixture-ak",
                SecretAccessKey: "fixture-sk",
                SessionToken: "fixture-session",
              }),
            });
          if (url.searchParams.get("Action") === "ApplyUploadInner")
            return json({
              Result: {
                Vid: "fixture-video",
                InnerUploadAddress: {
                  UploadNodes: [
                    {
                      UploadHost: "tos-integration.volces.com",
                      SessionKey: "fixture-upload-session",
                      StoreInfos: [
                        { StoreUri: "test-video", Auth: "fixture-upload-auth" },
                      ],
                    },
                  ],
                },
              },
            });
          if (url.searchParams.get("Action") === "CommitUploadInner")
            return json({
              Result: {
                Results: [
                  {
                    Vid: "fixture-video",
                    Meta: { Width: 720, Height: 1280 },
                    PosterUri: "fixture-poster",
                  },
                ],
              },
            });
          if (url.searchParams.get("Action") === "ApplyImageUpload")
            return json({
              Result: {
                UploadAddress: {
                  StoreInfos: [
                    {
                      UploadHost: "tos-integration.volces.com",
                      StoreUri: "test-cover",
                    },
                  ],
                },
              },
            });
          if (url.searchParams.get("Action") === "CommitImageUpload")
            return json({ Result: {} });
          if (url.searchParams.get("phase") === "init")
            return json({ data: { uploadid: "controlled-multipart-id" } });
          if (url.searchParams.has("phase"))
            return json({
              code: 2000,
              data: { key: "controlled-upload", crc32: "1" },
            });
          if (url.pathname === "/test-cover") return new Response("ok");
          if (url.pathname.includes("fast_detect"))
            return json({ status: 0, status_code: 0 });
          if (url.pathname.includes("create_v2")) {
            submits++;
            return json({ status_code: 0, aweme_id: "123456789012345" });
          }
          if (url.hostname !== "creator.douyin.com")
            throw new Error("Unexpected fixture host");
          return new Response(
            '<!doctype html><html><body><div class="avatar"><img alt="avatar"></div><a href="/creator-micro/content/manage">内容管理</a></body></html>',
            { headers: { "Content-Type": "text/html" } },
          );
        });
      },
    };
    if (testBase) {
      dependencies.exchange.getAsset = (id) =>
        testAPI("/v1/media-assets/get", { id });
      dependencies.exchange.getArtifact = (id) =>
        testAPI("/v1/artifacts/get", { id });
      dependencies.exchange.getHandoff = (id) =>
        testAPI("/v1/artifact-handoffs/get", { id });
      dependencies.request = async (route, input) => {
        if (
          route.endsWith("records/report") &&
          input.state === "accepted" &&
          dropTerminal
        ) {
          dropTerminal = false;
          throw new Error("Controlled lost terminal acknowledgment");
        }
        const value = await testAPI(route, input);
        if (route.endsWith("records/create"))
          records.set(input.requestKey, structuredClone(value.record));
        if (route.endsWith("records/report"))
          records.set(input.requestKey, structuredClone(value));
        return value;
      };
    }
    const assetRequests = new Map();
    dependencies.exchange.registerAsset = async (input) => {
      if (assetRequests.has(input.requestKey))
        return structuredClone(assetRequests.get(input.requestKey));
      const index = input.kind === "video" ? 0 : 1;
      const { requestKey, fileToken, ...metadata } = input;
      const asset = {
        ...fixture.assets[index],
        ...metadata,
        location: { kind: "local", deviceId: fixture.deviceId, fileToken },
      };
      if (testBase)
        Object.assign(asset, await testAPI("/v1/media-assets/register", input));
      fixture.assets[index] = asset;
      assetRequests.set(requestKey, asset);
      return structuredClone(asset);
    };
    dependencies.exchange.createArtifact = async (input) => {
      fixture.artifact = {
        ...fixture.artifact,
        source: input.source,
        content: input.content,
        assets: input.assets,
        review: { state: "pending", revision: 1 },
      };
      if (testBase)
        fixture.artifact = await testAPI("/v1/artifacts/create", input);
      return structuredClone(fixture.artifact);
    };
    dependencies.exchange.reportAvailability = async (input) => {
      if (testBase) return testAPI("/v1/media-assets/availability", input);
      const asset = fixture.assets.find((value) => value.id === input.id);
      asset.availability = {
        ...asset.availability,
        state: input.state,
        revision: asset.availability.revision + 1,
      };
      return structuredClone(asset);
    };
    const library = registerArtifactMedia(window, {
      identity: dependencies.identity,
      exchange: dependencies.exchange,
      producer: async (jobId) => ({
        source: { producer: "panorama", taskId: jobId, revision: 1 },
        content: structuredClone(fixture.artifact.content),
        files: { video: controlledVideo, cover: controlledCover },
        sample: false,
      }),
    });
    dependencies.resolver = library.registry;
    const service = registerPublishing(window, dependencies);
    await window.loadURL("keagent://app/integration.html");
    const call = (method, input = {}) =>
      window.webContents.executeJavaScript(
        `window.desktop.publishing.request(${JSON.stringify(method)},${JSON.stringify(input)})`,
      );
    const registered = await window.webContents.executeJavaScript(
      'window.desktop.artifactMedia.request("producer.register",{jobId:"11111111-1111-4111-8111-111111111111"})',
    );
    assert.equal(registered.ok, true, JSON.stringify(registered));
    assert.equal(registered.data.review.state, "pending");
    assert.equal(assetRequests.size, 2);
    assert.ok(!JSON.stringify(registered).includes(root));
    const replay = await window.webContents.executeJavaScript(
      'window.desktop.artifactMedia.request("producer.register",{jobId:"11111111-1111-4111-8111-111111111111"})',
    );
    assert.equal(replay.data.id, registered.data.id);
    assert.equal(assetRequests.size, 2);
    const resolved = await library.registry.resolve(
      fixture.assets.find((asset) => asset.kind === "video"),
    );
    assert.notEqual(resolved.absolutePath, controlledVideo);
    // The explicit reviewer action is represented by the controlled exchange here; UI tests exercise its confirmation dialog.
    if (testBase) {
      fixture.artifact = await testAPI("/v1/artifacts/review", {
        id: fixture.artifact.id,
        expectedRevision: fixture.artifact.review.revision,
        state: "approved",
      });
      Object.assign(
        fixture,
        await testAPI("/v1/artifact-handoffs/create", {
          requestKey: "registry-integration-handoff-001",
          artifactId: fixture.artifact.id,
          expectedReviewRevision: fixture.artifact.review.revision,
        }),
      );
    } else fixture.artifact.review = { state: "approved", revision: 2 };
    const state = await call("state");
    assert.equal(state.ok, true);
    assert.equal(state.data.resolverAvailable, true);
    const added = await call("account.add");
    assert.equal(added.ok, true, JSON.stringify(added));
    const accountId = added.data.id;
    const saved = await call("account.save", { accountId });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal(saved.data.loginStatus, "logged_in");
    assert.equal(saved.data.platformUserId, "controlled-public-id");
    const nativeView = window.contentView.children.find(
      (view) => view.webContents,
    );
    assert.ok(nativeView);
    assert.equal(
      await nativeView.webContents.executeJavaScript("typeof window.desktop"),
      "undefined",
    );
    assert.equal(nativeView.webContents.getLastWebPreferences().sandbox, true);
    const added2 = await call("account.add");
    assert.equal(added2.ok, true);
    assert.notEqual(sessions[0].getStoragePath(), sessions[1].getStoragePath());
    const input = {
      requestKey: "electron-publish-fixture-0001",
      handoffId: fixture.id,
      accountId,
      title: "集成测试视频",
      description: "仅测试适配器",
      hashtags: ["测试"],
    };
    const started = await call("publish.start", input);
    assert.equal(started.ok, true, JSON.stringify(started));
    await service.publisher.idle();
    assert.equal(
      service.publisher.active.state,
      "accepted",
      JSON.stringify(service.publisher.active),
    );
    assert.equal(submits, 1);
    await call("publish.start", input);
    assert.equal(submits, 1);
    assert.ok(requests.some((value) => value.includes("ApplyUploadInner")));
    assert.ok(requests.some((value) => value.includes("CommitImageUpload")));
    const publicState = await call("state");
    assert.equal(records.get(input.requestKey).state, "accepted");
    const interrupted = {
      ...records.get(input.requestKey),
      requestKey: "interrupted-publish-key-001",
      id: "2".repeat(32),
      state: "submitting",
      externalId: undefined,
      url: undefined,
      resultSource: undefined,
    };
    if (testBase) {
      const created = await dependencies.request("/v1/douyin/records/create", {
        ...input,
        requestKey: interrupted.requestKey,
      });
      interrupted.id = created.record.id;
      await dependencies.request("/v1/douyin/records/report", interrupted);
    }
    records.set(interrupted.requestKey, interrupted);
    const ownerFolder = crypto
      .createHash("sha256")
      .update(`${fixture.ownerId}:${fixture.deviceId}`)
      .digest("hex");
    const pendingRoot = path.join(root, "douyin", ownerFolder, "pending");
    fs.mkdirSync(pendingRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pendingRoot, `${interrupted.id}.json`),
      JSON.stringify(interrupted),
    );
    await call("state");
    assert.equal(records.get(interrupted.requestKey).state, "unknown");
    assert.equal(submits, 1);
    assert.ok(!JSON.stringify(publicState).includes("fixture-sk"));
    assert.ok(!JSON.stringify(publicState).includes(root));
    const hostile = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(project, "apps/desktop/electron/preload.cjs"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    windows.push(hostile);
    await hostile.loadURL("data:text/html,<h1>Untrusted surface</h1>");
    const denied = await hostile.webContents.executeJavaScript(
      'window.desktop.publishing.request("state",{})',
    );
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, "FORBIDDEN");
    generation++;
    service.stop();
    assert.equal((await call("state")).data.tabs.length, 0);
    service.stop();
    for (const win of windows) win.destroy();
    console.log(
      "Hidden Electron verified: real file registration + probing + resolver, explicit review, isolated login, intercepted upload + cover + single submit and recovery.",
    );
    app.exit(0);
  } catch (error) {
    for (const win of windows) if (!win.isDestroyed()) win.destroy();
    console.error(error);
    app.exit(1);
  }
});
