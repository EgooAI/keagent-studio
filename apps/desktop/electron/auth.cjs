const { ipcMain, safeStorage, app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function registerAuth() {
  const base = process.env.CONTROL_API_URL || "http://127.0.0.1:18080";
  const origin = new URL(base);
  if (
    origin.protocol !== "https:" &&
    !(origin.protocol === "http:" && origin.hostname === "127.0.0.1")
  )
    throw new Error("认证服务必须使用 HTTPS");
  const file = path.join(app.getPath("userData"), "identity.enc");
  let token = "";
  let deviceId = "";
  const installationFile = path.join(
    app.getPath("userData"),
    "installation-id",
  );
  const installation = fs.existsSync(installationFile)
    ? fs.readFileSync(installationFile, "utf8")
    : crypto.randomUUID();
  if (!fs.existsSync(installationFile))
    fs.writeFileSync(installationFile, installation, { mode: 0o600 });
  function clear() {
    token = "";
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
  async function request(route, body) {
    const response = await fetch(base + route, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin.origin,
        ...(deviceId ? { "X-Keagent-Device": deviceId } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(65000),
    });
    const next = response.headers.get("set-auth-token");
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 401) clear();
      throw new Error(data.error?.message || data.message || "服务请求失败");
    }
    if (next && token) {
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
      return (await request("/api/session")).data;
    }
    if (!token) throw new Error("请重新登录");
    if (method === "session") {
      const result = await request("/api/session");
      await request("/v1/devices/register", {
        id: deviceId,
        name: require("node:os").hostname(),
        platform: process.platform,
      });
      return result.data;
    }
    if (method === "logout") {
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
