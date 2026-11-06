import type { ProfileKey } from "../browser/contracts";
import type { PlatformId } from "../../plugins/platform/register";

export type LoginStatus =
  | "logged_in"
  | "logged_out"
  | "expired"
  | "verification_required"
  | "risk_controlled"
  | "profile_unavailable"
  | "unknown";

export type LoginCheckStep =
  "profile" | "cookies" | "current_url" | "account_api" | "page_dom";

export type LoginCheckReason =
  | "startup"
  | "manual"
  | "profile_save"
  | "task_creation"
  | "task_execution"
  | "background"
  | "navigation"
  | "task_failure";

export interface LoginCheckResult {
  status: LoginStatus;
  platform: PlatformId;
  /** 本地 Profile 标识；与平台公开账号 ID 不同。 */
  profileId?: string;
  workspaceId?: string;
  /** 平台公开账号 ID；平台未返回时可能回退为本地 Profile 标识。 */
  accountId?: string;
  nickname?: string;
  avatarUrl?: string;
  followersCount?: number;
  evidence: string[];
  checkedAt: string;
  errorCode?: string;
  errorMessage?: string;
  checks?: Partial<Record<LoginCheckStep, LoginCheckResult>>;
}

export interface PlatformLoginDetector {
  checkProfile(): Promise<LoginCheckResult>;
  checkCookies(): Promise<LoginCheckResult>;
  checkCurrentUrl(): Promise<LoginCheckResult>;
  checkPageDom(): Promise<LoginCheckResult>;
  checkAccountApi(): Promise<LoginCheckResult>;
}

export interface CookieMetadata {
  name: string;
  expirationDate?: number;
}

export interface DomInspectionInput {
  loggedInSelectors: string[];
  loggedOutSelectors: string[];
  verificationSelectors: string[];
  riskSelectors: string[];
  loggedInTexts: string[];
  loggedOutTexts: string[];
  verificationTexts: string[];
  riskTexts: string[];
  localStorageKeys: string[];
  nicknameSelectors?: string[];
  nicknameTextPatterns?: string[];
}

export interface DomInspectionResult {
  loggedInSelectors: string[];
  loggedOutSelectors: string[];
  verificationSelectors: string[];
  riskSelectors: string[];
  loggedInTexts: string[];
  loggedOutTexts: string[];
  verificationTexts: string[];
  riskTexts: string[];
  localStorageKeys: string[];
  nickname?: string;
}

export interface AccountApiResponse {
  body: unknown;
  ok: boolean;
  status: number;
}

export interface AccountApiRequest {
  url: string;
  method?: "GET" | "POST";
  responseType?: "json" | "text";
  headers?: Record<string, string>;
  referrer?: string;
  reuseRecentUrl?: boolean;
  reuseRecentHeaders?: string[];
  reuseRecentHeadersFromUrl?: string;
  jsonBodyFromCookie?: {
    field: string;
    cookieNames: string[];
  };
}

export interface PlatformLoginContext {
  profile: ProfileKey;
  ensureProfile(): Promise<boolean>;
  getCookies(urls: string[]): Promise<CookieMetadata[]>;
  openOrReusePage(url: string): Promise<string>;
  inspectDom(input: DomInspectionInput): Promise<DomInspectionResult>;
  requestAccountApi(
    request: AccountApiRequest,
    timeoutMs: number,
  ): Promise<AccountApiResponse>;
}

export class LoginBlockedError extends Error {
  constructor(readonly result: LoginCheckResult) {
    super(result.errorMessage ?? "平台账号登录状态不可用于发布");
    this.name = "LoginBlockedError";
  }
}
