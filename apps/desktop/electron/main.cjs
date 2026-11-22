const {
  app,
  BrowserWindow,
  protocol,
  net,
  dialog,
  Menu,
  Tray,
} = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const productName = "AI来客";
const devPort = Number(
  (!app.isPackaged && app.commandLine.getSwitchValue("keagent-dev-port")) ||
    5173,
);
if (!Number.isInteger(devPort) || devPort < 1024 || devPort > 65535)
  throw new Error("Invalid desktop development port");
const devOrigin = `http://127.0.0.1:${devPort}`;
if (devPort !== 5173) {
  const profile = path.join(
    app.getPath("appData"),
    `KeAgent Studio Dev ${devPort}`,
  );
  fs.mkdirSync(profile, { recursive: true });
  app.setPath("userData", profile);
}
// One main process owns this userData's browser coordination and recovery journals.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}
let mainWindow;
let tray;
let closingForQuit = false;
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}
app.on("second-instance", showMainWindow);
app.on("activate", showMainWindow);
app.on("before-quit", () => {
  closingForQuit = true;
});
let releaseOrigin;
const bundledMedia = [];
if (!app.isPackaged) {
  const envFile = path.resolve(__dirname, "../../../.env.local");
  if (fs.existsSync(envFile)) {
    const values = require("node:util").parseEnv(
      fs.readFileSync(envFile, "utf8"),
    );
    for (const key of [
      "CONTROL_API_URL",
      "GO_API_URL",
      "FFMPEG_PATH",
      "FFPROBE_PATH",
    ])
      if (process.env[key] === undefined && values[key] !== undefined)
        process.env[key] = values[key];
  }
} else {
  const releaseFile = path.join(app.getAppPath(), "desktop-release.json");
  if (fs.existsSync(releaseFile)) {
    try {
      const { publicOrigin } = JSON.parse(fs.readFileSync(releaseFile, "utf8"));
      const url = new URL(publicOrigin);
      if (url.protocol !== "https:" || url.href !== `${url.origin}/`)
        throw new Error("Expected a single HTTPS origin");
      releaseOrigin = url.origin;
    } catch (cause) {
      throw new Error("安装包服务器地址配置无效", { cause });
    }
    process.env.CONTROL_API_URL ||= releaseOrigin;
    process.env.GO_API_URL ||= releaseOrigin;
    for (const [variable, binary] of [
      ["FFMPEG_PATH", "ffmpeg"],
      ["FFPROBE_PATH", "ffprobe"],
    ]) {
      const file = path.join(
        process.resourcesPath,
        "media-tools",
        binary + (process.platform === "win32" ? ".exe" : ""),
      );
      if (!fs.existsSync(file)) throw new Error(`安装包缺少媒体工具 ${binary}`);
      bundledMedia.push(file);
      process.env[variable] ||= file;
    }
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
    require("./artifact-media/dist/runtime.cjs").registerArtifactMedia(
      window,
      {
        identity: () => identity.publishingIdentity(),
        exchange,
        producer: (jobId) => identity.completedArtifactOutput(jobId),
      },
      devOrigin,
    );
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
    devOrigin,
  );
  identity.onInvalidated(() => publishing.stop());
}

function createWindow() {
  const integratedTitle = ["win32", "darwin"].includes(process.platform);
  const assets = path.join(__dirname, app.isPackaged ? "../dist" : "../public");
  const icon = path.join(assets, "keagent-icon.png");
  const window = new BrowserWindow({
    show:
      !process.argv.includes("--smoke-test") &&
      !process.argv.includes("--hidden"),
    width: 1440,
    height: 940,
    minWidth: 1080,
    minHeight: 720,
    title: productName,
    icon,
    titleBarStyle: integratedTitle ? "hidden" : "default",
    titleBarOverlay:
      process.platform === "win32"
        ? { color: "#00000000", symbolColor: "#414756", height: 28 }
        : process.platform === "darwin",
    backgroundColor: "#f6f8fb",
    webPreferences: {
      backgroundThrottling: false,
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = window;
  const trayMenu = Menu.buildFromTemplate([
    { id: "open", label: `打开 ${productName}`, click: showMainWindow },
    { type: "separator" },
    { id: "quit", label: `退出 ${productName}`, click: () => app.quit() },
  ]);
  if (integratedTitle) {
    try {
      tray = new Tray(
        process.platform === "darwin"
          ? path.join(assets, "trayTemplate.png")
          : icon,
      );
      tray.setToolTip(productName);
      tray.setContextMenu(trayMenu);
      if (process.platform === "win32") tray.on("click", showMainWindow);
    } catch (error) {
      tray?.destroy();
      tray = undefined;
      console.warn("系统托盘不可用", error.message);
    }
  }
  window.on("close", (event) => {
    if (closingForQuit) {
      // The publish or unsaved-draft dialog can still cancel this quit.
      closingForQuit = false;
    } else if (tray) {
      event.preventDefault();
      window.hide();
    }
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
    showMainWindow();
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
  else window.loadURL(devOrigin);
  if (process.argv.includes("--smoke-test")) {
    window.webContents.once("did-finish-load", async () => {
      try {
        const heading = await window.webContents.executeJavaScript(
          `new Promise((resolve, reject) => { const deadline = Date.now() + 10000; const check = () => { const heading = document.querySelector('h1, .ant-card-head-title'); if (heading) resolve(heading.textContent); else if (Date.now() > deadline) reject(new Error('Renderer did not mount')); else setTimeout(check, 100); }; check(); })`,
        );
        if (!window.getTitle().startsWith(productName))
          throw new Error("Unexpected window title: " + window.getTitle());
        if (
          !heading.includes("创作工作台") &&
          heading !== `登录 ${productName}`
        )
          throw new Error("Unexpected renderer content: " + heading);
        if (integratedTitle) {
          if (!tray || tray.isDestroyed())
            throw new Error("Missing system tray");
          trayMenu.getMenuItemById("open").click();
          if (!window.isVisible())
            throw new Error("Tray did not open the window");
          window.close();
          if (window.isDestroyed() || window.isVisible())
            throw new Error("Close did not hide to tray");
          await window.webContents.executeJavaScript(
            "new Promise(resolve => setTimeout(resolve, 100))",
          );
          trayMenu.getMenuItemById("open").click();
          if (!window.isVisible())
            throw new Error("Tray did not restore the window");
          window.close();
        }
        for (const file of bundledMedia)
          require("node:child_process").execFileSync(file, ["-version"], {
            timeout: 5000,
            windowsHide: true,
          });
        if (
          releaseOrigin &&
          process.env.CONTROL_API_URL === releaseOrigin &&
          process.env.GO_API_URL === releaseOrigin
        )
          console.log("Desktop release verified: " + releaseOrigin);
        console.log("Electron renderer verified: " + heading);
        trayMenu.getMenuItemById("quit").click();
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
  identity = require("./auth.cjs").registerAuth(
    (runId, generation) => publishing?.targetStopped(runId, generation),
    devOrigin,
    (record, generation) => publishing?.reconciled(record, generation),
  );
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
