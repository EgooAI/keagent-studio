export interface SessionUser {
  userId: string;
  sessionId: string;
  name: string;
  email: string;
  role: string;
}
declare global {
  interface Window {
    desktop?: {
      platform: string;
      mode: string;
      request: (method: string, args?: unknown[]) => Promise<unknown>;
    };
  }
}
function serviceBaseURL(value: string) {
  const base = value.replace(/\/$/, "");
  if (!base || (base.startsWith("/") && !base.startsWith("//"))) return base;
  const url = new URL(base);
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      ))
  )
    throw new Error("服务地址必须使用 HTTPS 或本机回环 HTTP");
  return base;
}
export const authBaseURL = serviceBaseURL(
  import.meta.env?.VITE_AUTH_API_URL || "",
);
const businessBaseURL = serviceBaseURL(
  import.meta.env?.VITE_GO_API_URL || "http://127.0.0.1:18081",
);
let accessToken = "";
let accessExpires = 0;
let tokenRequest: Promise<string> | undefined;
let identityGeneration = 0;

export function clearAccessToken() {
  identityGeneration++;
  accessToken = "";
  accessExpires = 0;
  tokenRequest = undefined;
}

async function getAccessToken(): Promise<string> {
  if (accessToken && Date.now() < accessExpires) return accessToken;
  if (tokenRequest) return tokenRequest;
  const generation = identityGeneration;
  const pending = serviceRequest<{ token: string }>("/api/auth/token").then(
    (data) => {
      if (generation !== identityGeneration)
        throw new Error("登录状态已变更，请重新登录");
      if (typeof data.token !== "string" || !data.token)
        throw new Error("服务器未返回 Access Token");
      accessToken = data.token;
      // Renew 30 seconds before the SDK's five-minute token lifetime.
      accessExpires = Date.now() + 270000;
      return accessToken;
    },
  );
  tokenRequest = pending;
  try {
    return await pending;
  } finally {
    if (tokenRequest === pending) tokenRequest = undefined;
  }
}

export async function serviceRequest<T>(
  path: string,
  body?: unknown,
): Promise<T> {
  if (!path.startsWith("/v1/") && !path.startsWith("/api/"))
    throw new Error("无效的服务路径");
  const business = path.startsWith("/v1/");
  const generation = identityGeneration;
  const send = (token: string) =>
    fetch((business ? businessBaseURL : authBaseURL) + path, {
      method: body === undefined ? "GET" : "POST",
      credentials: business ? "omit" : "include",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(65000),
    });
  const token = business ? await getAccessToken() : "";
  if (generation !== identityGeneration) throw new Error("请重新登录");
  let response = await send(token);
  if (
    business &&
    response.status === 401 &&
    generation === identityGeneration
  ) {
    await response.body?.cancel();
    if (accessToken === token) accessToken = "";
    const next = await getAccessToken();
    if (generation !== identityGeneration) throw new Error("请重新登录");
    response = await send(next);
  }
  const data = await response.json().catch(() => {
    if (response.ok) throw new Error("服务返回无效数据");
    return {};
  });
  if (generation !== identityGeneration) throw new Error("请重新登录");
  if (!response.ok) {
    if (response.status === 401 && generation === identityGeneration) {
      clearAccessToken();
      window.dispatchEvent(new Event("keagent:unauthorized"));
    }
    throw new Error(data.error?.message || data.message || "请求失败");
  }
  return data as T;
}
export async function authRequest<T>(
  method: string,
  args: unknown[] = [],
): Promise<T> {
  if (window.desktop?.request)
    return (await window.desktop.request(method, args)) as T;
  if (
    [
      "voice.list",
      "voice.create",
      "voice.refresh",
      "voice.preview",
      "voice.remove",
    ].includes(method)
  )
    return serviceRequest<T>(`/v1/voices/${method.slice(6)}`, args[0] ?? {});
  if (method === "session") return serviceRequest<T>("/v1/session");
  if (method === "login" || method === "logout") {
    clearAccessToken();
    try {
      return await serviceRequest<T>(
        method === "login" ? "/api/auth/sign-in/email" : "/api/auth/sign-out",
        method === "login" ? args[0] : {},
      );
    } finally {
      clearAccessToken();
    }
  }
  throw new Error("未知身份操作");
}
