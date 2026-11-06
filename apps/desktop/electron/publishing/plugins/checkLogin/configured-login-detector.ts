import type {
  AccountApiRequest,
  AccountApiResponse,
  DomInspectionInput,
  LoginCheckResult,
  LoginStatus,
  PlatformLoginContext,
  PlatformLoginDetector,
} from "../../runtime/login/contracts";
import type { PlatformId } from "../platform/register";

type JsonPath = readonly string[];

interface AccountDisplayConfig {
  avatarHosts: string[];
  avatarUrlPaths: JsonPath[];
  followersCountPaths: JsonPath[];
}

export interface PlatformLoginConfig {
  platform: PlatformId;
  homeUrl: string;
  cookieUrls: string[];
  cookieNames: string[];
  loggedOutUrls: RegExp[];
  verificationUrls: RegExp[];
  riskUrls: RegExp[];
  dom: DomInspectionInput;
  accountApi: AccountApiRequest & {
    accountIdPaths: JsonPath[];
    nicknamePaths: JsonPath[];
    success: Array<{ path: JsonPath; values: unknown[] }>;
    requireSuccess?: boolean;
    display?: AccountDisplayConfig;
    details?: AccountDisplayConfig & {
      request(accountId: string): AccountApiRequest;
    };
  };
}

export class ConfiguredPlatformLoginDetector implements PlatformLoginDetector {
  constructor(
    private readonly config: PlatformLoginConfig,
    private readonly context: PlatformLoginContext,
  ) {}

  async checkProfile(): Promise<LoginCheckResult> {
    try {
      if (await this.context.ensureProfile()) {
        return this.result("unknown", ["浏览器 Profile 可正常启动"]);
      }
    } catch {
      return this.result("profile_unavailable", [], {
        errorCode: "PROFILE_OPEN_FAILED",
        errorMessage: "本地浏览器 Profile 无法启动，请检查本地环境",
      });
    }
    return this.result("profile_unavailable", [], {
      errorCode: "PROFILE_NOT_FOUND",
      errorMessage: "本地浏览器 Profile 不存在，请先前往登录",
    });
  }

  async checkCookies(): Promise<LoginCheckResult> {
    const cookies = await this.context.getCookies(this.config.cookieUrls);
    const expected = cookies.filter((cookie) =>
      this.config.cookieNames.includes(cookie.name),
    );
    if (expected.length === 0) {
      return this.result("logged_out", ["未发现平台关键 Cookie"], {
        errorCode: "LOGIN_COOKIE_MISSING",
        errorMessage: "平台登录凭证不存在，请重新登录",
      });
    }

    const now = Date.now() / 1_000;
    const valid = expected.filter(
      (cookie) =>
        cookie.expirationDate === undefined || cookie.expirationDate > now,
    );
    if (valid.length === 0) {
      return this.result("expired", ["平台关键 Cookie 已过期"], {
        errorCode: "LOGIN_COOKIE_EXPIRED",
        errorMessage: "平台登录凭证已过期，请重新登录",
      });
    }
    return this.result("logged_in", ["平台关键 Cookie 存在且未过期"]);
  }

  async checkCurrentUrl(): Promise<LoginCheckResult> {
    try {
      const url = await this.context.openOrReusePage(this.config.homeUrl);
      return classifyUrl(this.config, url, (status, evidence, extra) =>
        this.result(status, evidence, extra),
      );
    } catch {
      return this.result("unknown", ["平台工作台页面加载失败"], {
        errorCode: "PAGE_LOAD_FAILED",
        errorMessage: "平台页面加载失败，请检查网络或代理设置",
      });
    }
  }

  async checkPageDom(): Promise<LoginCheckResult> {
    const found = await this.context.inspectDom(this.config.dom);
    const risk = found.riskSelectors.length + found.riskTexts.length;
    if (risk > 0) {
      return this.result(
        "risk_controlled",
        ["页面出现平台风控或账号异常提示"],
        {
          errorCode: "PLATFORM_RISK_CONTROLLED",
          errorMessage: "平台触发风控或账号异常，请前往平台处理",
        },
      );
    }
    const verification =
      found.verificationSelectors.length + found.verificationTexts.length;
    if (verification > 0) {
      return this.result(
        "verification_required",
        ["页面要求短信、扫码、滑块或安全验证"],
        {
          errorCode: "LOGIN_VERIFICATION_REQUIRED",
          errorMessage: "平台要求人工验证，请前往平台完成验证",
        },
      );
    }

    const loggedIn =
      found.loggedInSelectors.length +
      found.loggedInTexts.length +
      found.localStorageKeys.length;
    const loggedOut =
      found.loggedOutSelectors.length + found.loggedOutTexts.length;
    if (loggedIn > 0 && loggedOut > 0) {
      return this.result("unknown", ["页面同时出现已登录和未登录特征"], {
        errorCode: "DOM_SIGNAL_CONFLICT",
        errorMessage: "平台页面状态不一致，请打开页面确认后重试",
      });
    }
    if (loggedIn > 0) {
      return {
        ...this.result("logged_in", [
          found.localStorageKeys.length > 0
            ? "页面和本地存储存在已登录特征"
            : "页面存在头像、账号信息或发布入口",
        ]),
        nickname: found.nickname,
      };
    }
    if (loggedOut > 0) {
      return this.result(
        "logged_out",
        ["页面出现登录按钮、二维码或手机号登录入口"],
        {
          errorCode: "LOGIN_DOM_LOGGED_OUT",
          errorMessage: "平台页面显示未登录，请重新登录",
        },
      );
    }
    return this.result("unknown", ["页面未找到稳定的登录状态特征"], {
      errorCode: "DOM_SIGNAL_MISSING",
      errorMessage: "无法从平台页面确认登录状态",
    });
  }

  async checkAccountApi(): Promise<LoginCheckResult> {
    let response: AccountApiResponse;
    try {
      response = await this.context.requestAccountApi(
        getAccountApiRequest(this.config),
        5_000,
      );
    } catch {
      return this.result("unknown", ["当前用户接口请求失败"], {
        errorCode: "ACCOUNT_API_FAILED",
        errorMessage: "平台账号接口暂时不可用",
      });
    }
    if (response.status === 401) {
      return this.result("expired", ["当前用户接口拒绝了本地登录凭证"], {
        errorCode: "ACCOUNT_API_UNAUTHORIZED",
        errorMessage: "平台服务端不再认可当前登录凭证",
      });
    }
    if (response.status === 403) {
      return this.result("unknown", ["当前用户接口请求被平台拒绝"], {
        errorCode: "ACCOUNT_API_FORBIDDEN",
        errorMessage: "平台账号接口请求被拒绝，请打开平台页面后重试",
      });
    }
    if (!response.ok) {
      return this.result("unknown", ["当前用户接口返回异常状态"], {
        errorCode: "ACCOUNT_API_FAILED",
        errorMessage: "平台账号接口暂时不可用",
      });
    }

    const accountId = firstString(
      response.body,
      this.config.accountApi.accountIdPaths,
    );
    const nickname = firstString(
      response.body,
      this.config.accountApi.nicknamePaths,
    );
    const success = this.config.accountApi.success.some(({ path, values }) =>
      values.some((value) => Object.is(readPath(response.body, path), value)),
    );
    const accepted = this.config.accountApi.requireSuccess
      ? success
      : Boolean(accountId || nickname) || success;
    if (!accepted) {
      return this.result("unknown", ["当前用户接口响应无法确认账号身份"], {
        errorCode: "ACCOUNT_API_UNRECOGNIZED",
        errorMessage: "平台账号接口响应无法识别",
      });
    }
    let displayBody = response.body;
    let display = this.config.accountApi.display;
    if (accountId && this.config.accountApi.details) {
      try {
        const detailsResponse = await this.context.requestAccountApi(
          this.config.accountApi.details.request(accountId),
          5_000,
        );
        if (detailsResponse.ok) {
          displayBody = detailsResponse.body;
          display = this.config.accountApi.details;
        }
      } catch {
        // 展示数据是尽力补充项，详情接口故障不能推翻主接口确认的登录事实。
      }
    }
    return {
      ...this.result("logged_in", ["平台服务端确认当前账号已登录"]),
      accountId: accountId ?? this.context.profile.accountId,
      nickname,
      avatarUrl: display
        ? firstAvatarUrl(
            displayBody,
            display.avatarUrlPaths,
            display.avatarHosts,
          )
        : undefined,
      followersCount: display
        ? firstFollowersCount(displayBody, display.followersCountPaths)
        : undefined,
    };
  }

  private result(
    status: LoginStatus,
    evidence: string[],
    extra: Pick<LoginCheckResult, "errorCode" | "errorMessage"> = {},
  ): LoginCheckResult {
    return {
      status,
      platform: this.config.platform,
      accountId: this.context.profile.accountId,
      evidence,
      checkedAt: new Date().toISOString(),
      ...extra,
    };
  }
}

export function getAccountApiRequest(
  config: PlatformLoginConfig,
): AccountApiRequest {
  const accountApi = config.accountApi;
  return {
    url: accountApi.url,
    method: accountApi.method,
    responseType: accountApi.responseType,
    headers: accountApi.headers,
    referrer: accountApi.referrer,
    reuseRecentUrl: accountApi.reuseRecentUrl,
    reuseRecentHeaders: accountApi.reuseRecentHeaders,
    reuseRecentHeadersFromUrl: accountApi.reuseRecentHeadersFromUrl,
    jsonBodyFromCookie: accountApi.jsonBodyFromCookie,
  };
}

export function isAbnormalUrl(
  config: PlatformLoginConfig,
  value: string,
): boolean {
  return (
    matches(config.loggedOutUrls, value) ||
    matches(config.verificationUrls, value) ||
    matches(config.riskUrls, value)
  );
}

function classifyUrl(
  config: PlatformLoginConfig,
  url: string,
  makeResult: (
    status: LoginStatus,
    evidence: string[],
    extra?: Pick<LoginCheckResult, "errorCode" | "errorMessage">,
  ) => LoginCheckResult,
): LoginCheckResult {
  if (matches(config.riskUrls, url)) {
    return makeResult("risk_controlled", ["当前 URL 进入平台风控页面"], {
      errorCode: "RISK_URL_DETECTED",
      errorMessage: "平台进入风控页面，请人工处理",
    });
  }
  if (matches(config.verificationUrls, url)) {
    return makeResult("verification_required", ["当前 URL 进入身份验证页面"], {
      errorCode: "VERIFICATION_URL_DETECTED",
      errorMessage: "平台要求人工验证，请前往平台完成验证",
    });
  }
  if (matches(config.loggedOutUrls, url)) {
    return makeResult("logged_out", ["当前 URL 进入登录或认证页面"], {
      errorCode: "LOGIN_URL_DETECTED",
      errorMessage: "平台已跳转到登录页面",
    });
  }
  return makeResult("unknown", ["当前 URL 未进入登录、验证或风控页面"]);
}

function matches(patterns: RegExp[], value: string): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function firstString(value: unknown, paths: JsonPath[]): string | undefined {
  for (const path of paths) {
    const candidate = readPath(value, path);
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim().slice(0, 200);
    }
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return String(candidate);
    }
  }
  return undefined;
}

function firstAvatarUrl(
  value: unknown,
  paths: JsonPath[],
  allowedHosts: string[],
): string | undefined {
  for (const path of paths) {
    const candidate = readPath(value, path);
    if (typeof candidate !== "string" || candidate.length > 4_096) {
      continue;
    }
    try {
      const url = new URL(candidate);
      if (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        allowedHosts.some(
          (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
        )
      ) {
        return url.href;
      }
    } catch {
      // 外部接口字段不可信；无效 URL 直接忽略并保留昵称占位头像。
    }
  }
  return undefined;
}

function firstFollowersCount(
  value: unknown,
  paths: JsonPath[],
): number | undefined {
  for (const path of paths) {
    const candidate = readPath(value, path);
    const count =
      typeof candidate === "number"
        ? candidate
        : typeof candidate === "string" && /^\d+$/.test(candidate)
          ? Number(candidate)
          : Number.NaN;
    if (Number.isSafeInteger(count) && count >= 0) {
      return count;
    }
  }
  return undefined;
}

function readPath(value: unknown, path: JsonPath): unknown {
  let current = value;
  for (const segment of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
