import type { LoginCheckReason, LoginCheckResult } from "../login/contracts";
import type { PlatformId } from "../../plugins/platform/register";

export interface ProfileKey {
  workspaceId: string;
  accountId: string;
}

export type ProxyMode = "direct" | "system" | "fixed_servers";

// 应用内通用浏览器标签的 account_id 前缀：不绑定任何平台，按 workspace 隔离，
// 固定走系统网络（跟随系统/代理软件），与账号管理的平台 Profile 代理无关。
// 每个网页标签用唯一 account_id（`web-<n>`）独立跟踪，互不覆盖。
export const WEB_ACCOUNT_PREFIX = "web-";

export interface ProxyOptions {
  proxyMode?: ProxyMode;
  proxyRules?: string;
}

export interface OpenProfileOptions extends ProxyOptions {
  platform?: PlatformId;
  url?: string;
}

export interface BrowserState {
  profile: ProfileKey | null;
  title: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  saved: boolean;
}

export interface BrowserApi {
  getState(): Promise<BrowserState>;
  getLoginStatuses(): Promise<LoginCheckResult[]>;
  getLocalPlatforms(workspaceId: string): Promise<PlatformId[]>;
  openProfile(
    profile: ProfileKey,
    options?: OpenProfileOptions,
  ): Promise<BrowserState>;
  activateProfile(profile: ProfileKey): Promise<BrowserState>;
  checkLogin(
    profile: ProfileKey,
    platform: PlatformId,
    reason: Extract<LoginCheckReason, "startup" | "manual">,
    proxyOptions?: ProxyOptions,
  ): Promise<LoginCheckResult>;
  saveProfile(): Promise<BrowserState>;
  closeProfile(profile: ProfileKey): Promise<void>;
  hideBrowser(): Promise<void>;
  openLink(url: string): Promise<BrowserState>;
  navigate(url: string): Promise<BrowserState>;
  goBack(): Promise<BrowserState>;
  goForward(): Promise<BrowserState>;
  reload(): Promise<BrowserState>;
  onStateChange(listener: (state: BrowserState) => void): () => void;
  onLoginStatusChange(listener: (result: LoginCheckResult) => void): () => void;
}

export type RuntimeErrorReporter = (
  event: string,
  message: string,
  error: unknown,
  fields?: Readonly<Record<string, unknown>>,
) => void;
