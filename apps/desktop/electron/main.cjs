const { app, BrowserWindow, protocol, net, dialog } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
if (!app.isPackaged) {
  const envFile = path.resolve(__dirname, "../../../.env.local");
  if (require("node:fs").existsSync(envFile)) {
    const values = require("node:util").parseEnv(
      require("node:fs").readFileSync(envFile, "utf8"),
    );
    for (const key of [
      "CONTROL_API_URL",
      "GO_API_URL",
      "FFMPEG_PATH",
      "FFPROBE_PATH",
      "VOLC_VIDEO_ALLOWED_HOSTS",
    ])
      if (process.env[key] === undefined && values[key] !== undefined)
        process.env[key] = values[key];
  }
}
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

let publishing;
let identity;
function returnWindowSetup(window) {
  const routes = {
    getAsset: "/v1/media-assets/get",
    getArtifact: "/v1/artifacts/get",
    getHandoff: "/v1/artifact-handoffs/get",
    registerAsset: "/v1/media-assets/register",
    createArtifact: "/v1/artifacts/create",
    createHandoff: "/v1/artifact-handoffs/create",
    reportAvailability: "/v1/media-assets/availability",
  };
  const exchange = Object.fromEntries(
    Object.entries(routes).map(([name, route]) => [
      name,
      (input) =>
        identity.businessRequest(
          route,
          ["getAsset", "getArtifact", "getHandoff"].includes(name)
            ? { id: input }
            : input,
        ),
    ]),
  );
  const artifactMedia =
    require("./artifact-media/dist/runtime.cjs").registerArtifactMedia(window, {
      identity: () => identity.publishingIdentity(),
      exchange,
      producer: (jobId) => identity.completedArtifactOutput(jobId),
    });
  identity.setArchiveOutput((output, expected) =>
    artifactMedia.service.register(output, expected),
  );
  publishing = require("./publishing/dist/runtime.cjs").registerPublishing(
    window,
    {
      identity: () => identity.publishingIdentity(),
      request: (route, input) => identity.businessRequest(route, input),
      exchange,
      resolver: artifactMedia.registry,
    },
  );
  identity.onInvalidated(() => publishing.stop());
}

function createWindow() {
  const window = new BrowserWindow({
    show:
      !process.argv.includes("--smoke-test") &&
      !process.argv.includes("--hidden"),
    width: 1440,
    height: 940,
    minWidth: 1080,
    minHeight: 720,
    title: "KeAgent Studio",
    backgroundColor: "#f6f8fb",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.removeMenu();
  returnWindowSetup(window);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    const target = new URL(url);
    const current = new URL(window.webContents.getURL());
    if (
      target.protocol !== current.protocol ||
      target.hostname !== current.hostname ||
      target.port !== current.port
    )
      event.preventDefault();
  });
  window.webContents.on("will-prevent-unload", (event) => {
    const choice = dialog.showMessageBoxSync(window, {
      type: "question",
      buttons: ["继续编辑", "放弃修改并关闭"],
      defaultId: 0,
      cancelId: 0,
      message: "还有未保存的文案修改",
      detail: "关闭会丢弃尚未保存的修改。",
    });
    if (choice === 1) event.preventDefault();
  });
  if (app.isPackaged || process.argv.includes("--built"))
    window.loadURL("keagent://app/index.html");
  else window.loadURL("http://127.0.0.1:5173");
  if (process.argv.includes("--smoke-test")) {
    window.webContents.once("did-finish-load", async () => {
      try {
        const heading = await window.webContents.executeJavaScript(
          `new Promise((resolve, reject) => { const deadline = Date.now() + 10000; const check = () => { const heading = document.querySelector('h1, .ant-card-head-title'); if (heading) resolve(heading.textContent); else if (Date.now() > deadline) reject(new Error('Renderer did not mount')); else setTimeout(check, 100); }; check(); })`,
        );
        if (!heading.includes("创作工作台") && !heading.includes("登录"))
          throw new Error("Unexpected renderer content: " + heading);
        console.log("Electron renderer verified: " + heading);
        app.quit();
      } catch (error) {
        console.error(error.message);
        app.exit(1);
      }
    });
    window.webContents.once("did-fail-load", () => app.exit(1));
    setTimeout(() => app.exit(1), 30000).unref();
  }
}

app.whenReady().then(() => {
  identity = require("./auth.cjs").registerAuth();
  protocol.handle("keagent", async (request) => {
    const url = new URL(request.url);
    if (url.hostname === "douyin") {
      try {
        const response = await net.fetch(
          pathToFileURL(await publishing.media(url)).toString(),
        );
        const headers = new Headers(response.headers);
        headers.set("Cache-Control", "no-store");
        return new Response(response.body, {
          status: response.status,
          headers,
        });
      } catch {
        return new Response("Media unavailable", { status: 403 });
      }
    }
    if (url.hostname === "media") {
      try {
        const response = await net.fetch(
          pathToFileURL(await identity.media(request.url)).toString(),
        );
        const headers = new Headers(response.headers);
        headers.set("Cache-Control", "no-store");
        return new Response(response.body, {
          status: response.status,
          headers,
        });
      } catch {
        return new Response("Media unavailable", { status: 403 });
      }
    }
    const root = path.resolve(__dirname, "../dist");
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return new Response("Bad path", { status: 400 });
    }
    const target = path.resolve(root, "." + pathname);
    const relative = path.relative(root, target);
    if (
      url.hostname !== "app" ||
      relative.startsWith("..") ||
      path.isAbsolute(relative)
    )
      return new Response("Forbidden", { status: 403 });
    try {
      const response = await net.fetch(pathToFileURL(target).toString());
      const headers = new Headers(response.headers);
      headers.set(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: keagent://media keagent://douyin https://*.ljcdn.com; media-src 'self' blob: keagent://media keagent://douyin; connect-src 'self'; object-src 'none'; base-uri 'self'",
      );
      return new Response(response.body, { status: response.status, headers });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
  createWindow();
});
app.on("window-all-closed", () => app.quit());
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
