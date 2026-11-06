import type { ProfileKey, ProxyMode, ProxyOptions } from "./contracts";

const PROFILE_SEGMENT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SENSITIVE_BROWSER_URL_KEYS = new Set([
  "access_token",
  "auth_token",
  "code",
  "session",
  "session_id",
  "ticket",
  "token",
]);

export function normalizeProfileKey(value: ProfileKey): ProfileKey {
  return {
    workspaceId: requireProfileSegment(value.workspaceId, "Workspace ID"),
    accountId: requireProfileSegment(value.accountId, "Account ID"),
  };
}

export function normalizeHttpUrl(value: string): string {
  const input = value.trim();
  if (!input) {
    throw new Error("URL is required");
  }

  const withProtocol = /^[a-z][a-z\d+.-]*:/i.test(input)
    ? input
    : `https://${input}`;
  const url = new URL(withProtocol);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Browser URL must use http or https");
  }
  if (url.username || url.password) {
    throw new Error("Browser URL must not contain credentials");
  }
  return url.toString();
}

export function isAllowedBrowserUrl(value: string): boolean {
  try {
    normalizeHttpUrl(value);
    return true;
  } catch {
    return false;
  }
}

export function publicBrowserUrl(value: string): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_BROWSER_URL_KEYS.has(key.toLowerCase())) {
        url.searchParams.delete(key);
      }
    }
    // OAuth-style fragments can carry credentials too. Preserve ordinary SPA
    // routes, but never project a credential-bearing fragment to Renderer.
    const decodedHash = decodeURIComponent(url.hash);
    if (
      [...SENSITIVE_BROWSER_URL_KEYS].some((key) =>
        new RegExp(`(?:^|[&#?])${key}=`, "iu").test(decodedHash),
      )
    ) {
      url.hash = "";
    }
    // The address bar needs location only. Never project arbitrary platform signatures.
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}

export function normalizeBrowserUserAgent(
  value: string,
  targetUrl?: string,
): string {
  const hostname = targetUrl ? new URL(targetUrl).hostname : "";
  if (hostname === "kuaishou.com" || hostname.endsWith(".kuaishou.com")) {
    // ponytail: 快手当前只兼容 Chrome 142；平台兼容当前 Chromium 后删除此单点覆盖。
    return value.replace(/Chrome\/[^\s]+/, "Chrome/142.0.0.0");
  }
  return value;
}

export function normalizeProxyRules(value?: string): string | undefined {
  const proxyRules = value?.trim();
  if (!proxyRules) {
    return undefined;
  }
  if (
    proxyRules.length > 2_048 ||
    /[\r\n\0]/.test(proxyRules) ||
    proxyRules.includes("@")
  ) {
    throw new Error("Proxy rules are invalid");
  }
  return proxyRules;
}

export function normalizeProxyOptions(value: ProxyOptions = {}): {
  proxyMode: ProxyMode;
  proxyRules?: string;
} {
  const proxyRules = normalizeProxyRules(value.proxyRules);
  const proxyMode =
    value.proxyMode ?? (proxyRules ? "fixed_servers" : "direct");
  if (proxyMode === "fixed_servers" && !proxyRules) {
    throw new Error("Custom proxy rules are required");
  }
  if (proxyMode !== "fixed_servers" && proxyRules) {
    throw new Error("Proxy rules require custom proxy mode");
  }
  return { proxyMode, proxyRules };
}

function requireProfileSegment(value: string, name: string): string {
  const segment = value.trim();
  if (!PROFILE_SEGMENT_PATTERN.test(segment)) {
    throw new Error(
      `${name} must use 1-64 lowercase letters, numbers, underscores, or hyphens`,
    );
  }
  return segment;
}
