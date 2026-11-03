const { ipcMain, safeStorage, app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function registerAuth() {
  const base = (
    process.env.CONTROL_API_URL || "http://127.0.0.1:18080"
  ).replace(/\/$/, "");
  const apiBase = (process.env.GO_API_URL || "http://127.0.0.1:18081").replace(
    /\/$/,
    "",
  );
  const origin = new URL(base);
  for (const address of [origin, new URL(apiBase)]) {
    if (
      address.username ||
      address.password ||
      (address.protocol !== "https:" &&
        !(
          address.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(address.hostname)
        ))
    )
      throw new Error("服务地址必须使用 HTTPS 或本机回环 HTTP");
  }
  const file = path.join(app.getPath("userData"), "identity.enc");
  let token = "";
  let deviceId = "";
  let accessToken = "";
  let accessExpires = 0;
  let tokenRequest;
  let identityGeneration = 0;
  const installationFile = path.join(
    app.getPath("userData"),
    "installation-id",
  );
  const installation = fs.existsSync(installationFile)
    ? fs.readFileSync(installationFile, "utf8")
    : crypto.randomUUID();
  if (!fs.existsSync(installationFile))
    fs.writeFileSync(installationFile, installation, { mode: 0o600 });
  function clearAccess() {
    identityGeneration++;
    accessToken = "";
    accessExpires = 0;
    tokenRequest = undefined;
  }
  function clear() {
    clearAccess();
    token = "";
    deviceId = "";
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  function save() {
    if (!safeStorage.isEncryptionAvailable())
      throw new Error("系统凭据保护不可用，无法保存登录");
    const temp = file + ".tmp";
    fs.writeFileSync(
      temp,
      safeStorage.encryptString(JSON.stringify({ token, deviceId })),
      { mode: 0o600 },
    );
    fs.renameSync(temp, file);
  }
  if (fs.existsSync(file) && safeStorage.isEncryptionAvailable()) {
    try {
      const saved = JSON.parse(
        safeStorage.decryptString(fs.readFileSync(file)),
      );
      token = saved.token;
      deviceId = saved.deviceId;
    } catch {
      clear();
    }
  }
  async function getAccessToken() {
    if (accessToken && Date.now() < accessExpires) return accessToken;
    if (tokenRequest) return tokenRequest;
    const generation = identityGeneration;
    const pending = request("/api/auth/token").then(({ data }) => {
      if (generation !== identityGeneration) throw new Error("请重新登录");
      if (typeof data.token !== "string" || !data.token)
        throw new Error("服务器未返回 Access Token");
      accessToken = data.token;
      // Renew 30 seconds before the SDK's five-minute token lifetime.
      accessExpires = Date.now() + 270000;
      return accessToken;
    });
    tokenRequest = pending;
    try {
      return await pending;
    } finally {
      if (tokenRequest === pending) tokenRequest = undefined;
    }
  }
  async function request(route, body, retry = true) {
    const business = route.startsWith("/v1/");
    const generation = identityGeneration;
    const credential = business ? await getAccessToken() : token;
    if (generation !== identityGeneration) throw new Error("请重新登录");
    const response = await fetch((business ? apiBase : base) + route, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...(!business ? { Origin: origin.origin } : {}),
        ...(business && deviceId ? { "X-Keagent-Device": deviceId } : {}),
        ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(65000),
    });
    if (generation !== identityGeneration) {
      await response.body?.cancel();
      throw new Error("请重新登录");
    }
    if (business && response.status === 401 && retry) {
      await response.body?.cancel();
      if (accessToken === credential) accessToken = "";
      return request(route, body, false);
    }
    const next = response.headers.get("set-auth-token");
    const data = await response.json().catch(() => {
      if (response.ok) throw new Error("服务返回无效数据");
      return {};
    });
    if (generation !== identityGeneration) throw new Error("请重新登录");
    if (!response.ok) {
      if (response.status === 401) clear();
      throw new Error(data.error?.message || data.message || "服务请求失败");
    }
    if (!business && next && token) {
      token = next;
      save();
    }
    return { data, next };
  }
  const commands = new Set([
    "saveDraft",
    "importProperties",
    "createProperty",
    "updateProperty",
    "createBatch",
    "saveScript",
    "approveScript",
    "regenerateScript",
    "retryTask",
    "cancelTask",
    "createPublish",
    "reconcilePublish",
    "downloadResource",
    "createLeadAnalysis",
    "suggestReply",
    "updateLead",
    "addFollowup",
    "updateProfile",
    "addVoice",
    "addAvatar",
    "updateVoice",
    "updateAvatar",
    "removeVoice",
    "removeAvatar",
    "connectAccount",
    "disconnectAccount",
  ]);
  ipcMain.handle("identity:request", async (event, method, args = []) => {
    const url = new URL(event.senderFrame.url);
    const trusted =
      app.isPackaged || process.argv.includes("--built")
        ? url.protocol === "keagent:" && url.hostname === "app"
        : url.origin === "http://127.0.0.1:5173";
    if (
      !trusted ||
      event.senderFrame !== event.sender.mainFrame ||
      !Array.isArray(args) ||
      JSON.stringify(args).length > 1048576
    )
      throw new Error("非法桌面请求");
    if (method === "login") {
      const input = args[0];
      if (
        !input ||
        typeof input.email !== "string" ||
        typeof input.password !== "string"
      )
        throw new Error("请输入邮箱和密码");
      clear();
      const result = await request("/api/auth/sign-in/email", {
        email: input.email,
        password: input.password,
      });
      if (!result.next) throw new Error("服务器未返回有效凭据");
      token = result.next;
      const identity = (await request("/api/session")).data;
      deviceId = crypto
        .createHash("sha256")
        .update(`${installation}:${identity.userId}`)
        .digest("hex");
      try {
        await request("/v1/devices/register", {
          id: deviceId,
          name: require("node:os").hostname(),
          platform: process.platform,
        });
        save();
      } catch (error) {
        try {
          await request("/api/auth/sign-out", {});
        } finally {
          clear();
        }
        throw error;
      }
      return (await request("/v1/session")).data;
    }
    if (!token) throw new Error("请重新登录");
    if (method === "session") {
      await request("/v1/devices/register", {
        id: deviceId,
        name: require("node:os").hostname(),
        platform: process.platform,
      });
      return (await request("/v1/session")).data;
    }
    if (method === "logout") {
      clearAccess();
      try {
        await request("/api/auth/sign-out", {});
      } finally {
        clear();
      }
      return null;
    }
    if (method === "getWorkspace") return (await request("/v1/workspace")).data;
    if (!commands.has(method)) throw new Error("此桌面能力未开放");
    return (await request(`/v1/commands/${method}`, args)).data;
  });
}
module.exports = { registerAuth };
