import type { ProfileKey, RuntimeErrorReporter } from "../browser/contracts";
import type { PlatformId } from "../../plugins/platform/register";
import {
  LoginBlockedError,
  type LoginCheckReason,
  type LoginCheckResult,
  type LoginCheckStep,
  type PlatformLoginDetector,
} from "./contracts";

type DetectorFactory = (
  profile: ProfileKey,
  platform: PlatformId,
) => PlatformLoginDetector;

const STEP_ORDER: LoginCheckStep[] = [
  "profile",
  "cookies",
  "current_url",
  "account_api",
  "page_dom",
];

export const PUBLISH_LOGIN_RESULT_MAX_AGE_MS = 5 * 60 * 1_000;
const STARTUP_REDIRECT_SETTLE_MS = 1_500;

export class LoginDetectionService {
  private readonly results = new Map<string, LoginCheckResult>();
  private readonly inFlight = new Map<string, Promise<LoginCheckResult>>();

  constructor(
    private readonly createDetector: DetectorFactory,
    private readonly onResult: (
      result: LoginCheckResult,
      reason: LoginCheckReason,
    ) => void,
    private readonly onError: RuntimeErrorReporter,
    private readonly stepTimeoutMs = 8_000,
    private readonly startupRedirectSettleMs = STARTUP_REDIRECT_SETTLE_MS,
  ) {}

  getResults(): LoginCheckResult[] {
    return [...this.results.values()];
  }

  check(
    profile: ProfileKey,
    platform: PlatformId,
    reason: LoginCheckReason,
  ): Promise<LoginCheckResult> {
    const key = resultKey(profile, platform);
    const recent = this.results.get(key);
    if (
      reason === "navigation" &&
      recent &&
      Date.now() - Date.parse(recent.checkedAt) < 2_000
    ) {
      return Promise.resolve(recent);
    }
    const pending = this.inFlight.get(key);
    if (pending) {
      return pending;
    }

    const check = this.run(profile, platform, reason).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, check);
    return check;
  }

  async requireLoggedIn(
    profile: ProfileKey,
    platform: PlatformId,
    reason: "task_creation" | "task_execution",
  ): Promise<LoginCheckResult> {
    const recent = this.results.get(resultKey(profile, platform));
    const recentAgeMs = recent
      ? Date.now() - Date.parse(recent.checkedAt)
      : Number.NaN;
    if (
      recent?.status === "logged_in" &&
      recentAgeMs >= 0 &&
      recentAgeMs <= PUBLISH_LOGIN_RESULT_MAX_AGE_MS
    ) {
      this.onResult(recent, reason);
      return recent;
    }
    const result = await this.check(profile, platform, reason);
    if (result.status !== "logged_in") {
      throw new LoginBlockedError(result);
    }
    return result;
  }

  private async run(
    profile: ProfileKey,
    platform: PlatformId,
    reason: LoginCheckReason,
  ): Promise<LoginCheckResult> {
    const detector = this.createDetector(profile, platform);
    const methods: Record<LoginCheckStep, () => Promise<LoginCheckResult>> = {
      profile: () => detector.checkProfile(),
      cookies: () => detector.checkCookies(),
      current_url: () => detector.checkCurrentUrl(),
      account_api: () => detector.checkAccountApi(),
      page_dom: () => detector.checkPageDom(),
    };
    const checks: Partial<Record<LoginCheckStep, LoginCheckResult>> = {};

    for (const step of STEP_ORDER) {
      checks[step] = await this.runStep(
        platform,
        profile.accountId,
        step,
        methods[step],
        step === "account_api" ? 2 : 1,
      );
      if (
        reason === "startup" &&
        step === "current_url" &&
        checks.cookies?.status === "logged_in" &&
        checks.current_url?.status === "logged_out"
      ) {
        // 冷启动页面可能先落到登录路由，再由有效 Session 恢复并跳回工作台；只等待并重查一次。
        await new Promise((resolve) =>
          setTimeout(resolve, this.startupRedirectSettleMs),
        );
        checks.current_url = await this.runStep(
          platform,
          profile.accountId,
          step,
          methods[step],
          1,
        );
      }
      if (
        step === "profile" &&
        (checks.profile?.status === "profile_unavailable" ||
          Boolean(checks.profile?.errorCode))
      ) {
        break;
      }
      if (
        step === "current_url" &&
        (checks.current_url?.status === "verification_required" ||
          checks.current_url?.status === "risk_controlled")
      ) {
        // 验证和风控页面不再请求账号接口，避免在敏感状态下制造额外流量。
        break;
      }
    }

    const result = mergeLoginChecks(platform, profile.accountId, checks);
    result.profileId = profile.accountId;
    result.workspaceId = profile.workspaceId;
    this.results.set(resultKey(profile, platform), result);
    this.onResult(result, reason);
    return result;
  }

  private async runStep(
    platform: PlatformId,
    accountId: string,
    step: LoginCheckStep,
    check: () => Promise<LoginCheckResult>,
    attempts: number,
  ): Promise<LoginCheckResult> {
    let lastResult: LoginCheckResult | undefined;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        lastResult = await withTimeout(check(), this.stepTimeoutMs);
      } catch (error) {
        this.onError(
          "platform_login_check_failed",
          "Platform login signal check failed",
          error,
          { account_id: accountId, platform, stage: step },
        );
        lastResult = result(platform, accountId, "unknown", [], {
          errorCode:
            error instanceof LoginCheckTimeoutError
              ? "LOGIN_CHECK_TIMEOUT"
              : "LOGIN_CHECK_FAILED",
          errorMessage:
            error instanceof LoginCheckTimeoutError
              ? "登录状态检测超时，请稍后重试"
              : "登录状态检测失败，请稍后重试",
        });
      }

      if (
        attempt === attempts ||
        (lastResult.errorCode !== "ACCOUNT_API_FAILED" &&
          lastResult.errorCode !== "LOGIN_CHECK_TIMEOUT" &&
          lastResult.errorCode !== "LOGIN_CHECK_FAILED")
      ) {
        return lastResult;
      }
    }
    return lastResult!;
  }
}

export function mergeLoginChecks(
  platform: PlatformId,
  accountId: string,
  checks: Partial<Record<LoginCheckStep, LoginCheckResult>>,
): LoginCheckResult {
  const values = Object.values(checks);
  const evidence = [...new Set(values.flatMap((check) => check.evidence))];
  const special =
    values.find((check) => check.status === "risk_controlled") ??
    values.find((check) => check.status === "verification_required") ??
    values.find((check) => check.status === "profile_unavailable");
  if (special) {
    return finalResult(
      platform,
      accountId,
      special.status,
      evidence,
      checks,
      special,
    );
  }

  const cookies = checks.cookies;
  const currentUrl = checks.current_url;
  const accountApi = checks.account_api;
  const pageDom = checks.page_dom;

  // 当前用户接口代表平台服务端的最终判断；Cookie 和页面外壳可能残留，不能推翻它。
  if (
    accountApi?.status === "logged_in" ||
    accountApi?.status === "logged_out" ||
    accountApi?.status === "expired"
  ) {
    return finalResult(
      platform,
      accountId,
      accountApi.status,
      evidence,
      checks,
      accountApi,
    );
  }
  if (currentUrl?.status === "logged_out" || pageDom?.status === "logged_out") {
    const source = currentUrl?.status === "logged_out" ? currentUrl : pageDom!;
    return finalResult(
      platform,
      accountId,
      "logged_out",
      evidence,
      checks,
      source,
    );
  }
  if (cookies?.status === "expired") {
    return finalResult(
      platform,
      accountId,
      "expired",
      evidence,
      checks,
      cookies,
    );
  }
  if (cookies?.status === "logged_out") {
    return finalResult(
      platform,
      accountId,
      "logged_out",
      evidence,
      checks,
      cookies,
    );
  }
  if (cookies?.status === "logged_in" && pageDom?.status === "logged_in") {
    return finalResult(
      platform,
      accountId,
      "logged_in",
      evidence,
      checks,
      pageDom,
    );
  }

  const failed = values.find((check) => check.errorCode);
  return finalResult(platform, accountId, "unknown", evidence, checks, failed);
}

function finalResult(
  platform: PlatformId,
  accountId: string,
  status: LoginCheckResult["status"],
  evidence: string[],
  checks: Partial<Record<LoginCheckStep, LoginCheckResult>>,
  source?: LoginCheckResult,
): LoginCheckResult {
  return {
    status,
    platform,
    accountId: source?.accountId ?? accountId,
    nickname:
      status === "logged_in"
        ? (source?.nickname ??
          checks.account_api?.nickname ??
          checks.page_dom?.nickname)
        : source?.nickname,
    avatarUrl:
      status === "logged_in" ? checks.account_api?.avatarUrl : undefined,
    followersCount:
      status === "logged_in" ? checks.account_api?.followersCount : undefined,
    evidence,
    checkedAt: new Date().toISOString(),
    errorCode: source?.errorCode,
    errorMessage: source?.errorMessage,
    checks,
  };
}

function result(
  platform: PlatformId,
  accountId: string,
  status: LoginCheckResult["status"],
  evidence: string[],
  extra: Pick<LoginCheckResult, "errorCode" | "errorMessage"> = {},
): LoginCheckResult {
  return {
    status,
    platform,
    accountId,
    evidence,
    checkedAt: new Date().toISOString(),
    ...extra,
  };
}

function resultKey(profile: ProfileKey, platform: PlatformId): string {
  return `${profile.workspaceId}\0${profile.accountId}\0${platform}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new LoginCheckTimeoutError()),
      timeoutMs,
    );
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

class LoginCheckTimeoutError extends Error {
  constructor() {
    super("Login check timed out");
    this.name = "LoginCheckTimeoutError";
  }
}
