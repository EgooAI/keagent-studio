import type { BrowserWindow, Session } from "electron";
import path from "node:path";
import { createHash } from "node:crypto";
import type {
  DouyinAccount,
  DouyinBrowserTab,
  DouyinPublishInput,
  DouyinPublishRecord,
} from "@keagent/shared-types";
import { BrowserView } from "./runtime/browser/browser-view";
import { ProfileManager } from "./runtime/profiles/profile-manager";
import { LoginDetectionService } from "./runtime/login/login-detection";
import {
  DOUYIN_LOGIN_CONFIG,
  createDouyinLoginDetector,
} from "./plugins/checkLogin/douyin";
import { publishFromCreatorPage } from "./plugins/publish/opencli/douyin/publish";
import {
  PublishingError,
  type PublishFiles,
  type PublishingIdentity,
} from "./core";
import type { ProfileKey } from "./runtime/browser/contracts";
import type { ExecutionStepReporter } from "./runtime/task-executor/execution-log";

export class DouyinBrowser {
  private profiles: ProfileManager;
  private views = new Map<
    string,
    { view: BrowserView; session: Session; profile: ProfileKey }
  >();
  private detection: LoginDetectionService;
  active?: string;
  locked?: string;
  private timer: ReturnType<typeof setInterval>;
  private navigationChecks = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(
    private window: BrowserWindow,
    private root: string,
    private identity: () => Promise<PublishingIdentity>,
    private cloud: <T>(operation: string, input?: unknown) => Promise<T>,
    private changed: () => void,
    private configureSession?: (session: Session) => Promise<void>,
  ) {
    this.profiles = new ProfileManager(root);
    this.detection = new LoginDetectionService(
      (profile) =>
        createDouyinLoginDetector({
          profile,
          ensureProfile: async () => this.profiles.exists(profile),
          getCookies: (urls) =>
            this.require(profile.accountId).view.getCookies(urls),
          openOrReusePage: (url) =>
            this.require(profile.accountId).view.openOrReusePage(url),
          inspectDom: (input) =>
            this.require(profile.accountId).view.inspectDom(input),
          requestAccountApi: (request, timeout) =>
            this.require(profile.accountId).view.requestAccountApi(
              request,
              timeout,
            ),
        }),
      () => this.changed(),
      () => {},
    );
    this.timer = setInterval(
      () => {
        for (const id of this.views.keys()) {
          if (id !== this.locked) void this.check(id).catch(() => {});
        }
      },
      20 * 60 * 1000,
    );
    this.timer.unref();
  }
  tabs(): DouyinBrowserTab[] {
    return [...this.views].map(([accountId, { view }]) => {
      const { profile: _profile, ...state } = view.getState();
      return { accountId, ...state };
    });
  }
  private require(accountId: string) {
    const value = this.views.get(accountId);
    if (!value)
      throw new PublishingError("PROFILE_UNAVAILABLE", "请先打开账号浏览器");
    return value;
  }
  private async owned(accountId: string): Promise<DouyinAccount> {
    if (!/^[a-f0-9]{32}$/.test(accountId))
      throw new PublishingError("INVALID_INPUT", "账号引用无效", 422);
    const identity = await this.identity();
    const { items } = await this.cloud<{ items: DouyinAccount[] }>(
      "accounts/list",
    );
    const account = items.find(
      (value) =>
        value.id === accountId &&
        value.deviceId === identity.deviceId &&
        !value.unboundAt,
    );
    if (!account)
      throw new PublishingError(
        "ACCOUNT_UNAVAILABLE",
        "账号不属于当前用户或设备",
      );
    return account;
  }
  async ensure(accountId: string) {
    await this.owned(accountId);
    const existing = this.views.get(accountId);
    if (existing) return existing;
    const current = await this.identity();
    const workspaceId = createHash("sha256")
      .update(`${current.userId}:${current.deviceId}`)
      .digest("hex");
    const profile = { workspaceId, accountId };
    const opened = await this.profiles.open(profile, { proxyMode: "system" });
    await this.configureSession?.(opened.session);
    const after = await this.identity();
    if (
      after.generation !== current.generation ||
      after.userId !== current.userId
    )
      throw new PublishingError("SESSION_CHANGED", "登录已变更");
    const view = new BrowserView(
      this.window,
      profile,
      opened.session,
      false,
      opened.saved,
      path.join(this.root, workspaceId, accountId, "debug"),
      () => {},
      () => this.changed(),
      (url) => this.navigationChanged(accountId, url),
    );
    view.setViewport({ x: 0, y: 0, width: 0, height: 0 });
    view.observeAccountApi(DOUYIN_LOGIN_CONFIG.accountApi);
    const value = { view, session: opened.session, profile };
    this.views.set(accountId, value);
    return value;
  }
  private navigationChanged(accountId: string, url: string): void {
    if (
      this.locked === accountId ||
      ![
        ...DOUYIN_LOGIN_CONFIG.loggedOutUrls,
        ...DOUYIN_LOGIN_CONFIG.verificationUrls,
        ...DOUYIN_LOGIN_CONFIG.riskUrls,
      ].some((pattern) => pattern.test(url))
    )
      return;
    clearTimeout(this.navigationChecks.get(accountId));
    this.navigationChecks.set(
      accountId,
      setTimeout(() => {
        this.navigationChecks.delete(accountId);
        void this.check(accountId).catch(() => {});
      }, 500),
    );
  }
  async open(accountId: string): Promise<void> {
    const { view } = await this.ensure(accountId);
    this.active = accountId;
    this.changed();
    await view.openOrReusePage(DOUYIN_LOGIN_CONFIG.homeUrl);
    this.changed();
  }
  hide(): void {
    for (const { view } of this.views.values()) view.setVisible(false);
    this.active = undefined;
    this.changed();
  }
  viewport(
    accountId: string,
    input: Electron.Rectangle,
    visible: boolean,
  ): void {
    const { view } = this.require(accountId);
    const [width, height] = this.window.getContentSize();
    const values = [input.x, input.y, input.width, input.height];
    if (!values.every((v) => Number.isFinite(v) && v >= 0 && v <= 20000))
      throw new PublishingError("INVALID_INPUT", "浏览器尺寸无效", 422);
    const x = Math.min(width, Math.round(input.x)),
      y = Math.min(height, Math.round(input.y));
    view.setViewport({
      x,
      y,
      width: Math.max(0, Math.min(width - x, Math.round(input.width))),
      height: Math.max(0, Math.min(height - y, Math.round(input.height))),
    });
    for (const [id, entry] of this.views)
      entry.view.setVisible(visible && id === accountId && id !== this.locked);
  }
  async check(accountId: string, save = false): Promise<DouyinAccount> {
    if (this.locked === accountId)
      throw new PublishingError("ACCOUNT_BUSY", "发布期间不能检查或更换账号");
    const account = await this.owned(accountId);
    const { profile } = await this.ensure(accountId);
    const result = await this.detection.check(
      profile,
      "douyin",
      save ? "profile_save" : "manual",
    );
    if (save && result.status !== "logged_in")
      throw new PublishingError(
        "LOGIN_REQUIRED",
        result.errorMessage || "请先在浏览器完成登录或验证",
      );
    const apiIdentity = result.checks?.account_api;
    const platformUserId =
      apiIdentity?.status === "logged_in" ? apiIdentity.accountId : undefined;
    if (save && (!platformUserId || platformUserId === accountId))
      throw new PublishingError(
        "ACCOUNT_IDENTITY_UNAVAILABLE",
        "无法确认抖音账号身份，请刷新创作者中心后重试",
      );
    const saved = await this.cloud<DouyinAccount>("accounts/update", {
      id: accountId,
      name: result.nickname || account.name,
      loginStatus: result.status,
      ...(platformUserId && platformUserId !== accountId
        ? { platformUserId }
        : {}),
    });
    if (save) {
      await this.require(accountId).view.flushSession();
      this.profiles.save(profile);
      this.require(accountId).view.markSaved();
    }
    this.changed();
    return saved;
  }
  async action(
    accountId: string,
    action: string,
    recordId?: string,
  ): Promise<void> {
    await this.owned(accountId);
    if (this.locked === accountId)
      throw new PublishingError(
        "ACCOUNT_BUSY",
        "发布执行期间已锁定该账号的导航",
      );
    const { view } = this.require(accountId);
    if (action === "back") view.goBack();
    else if (action === "forward") view.goForward();
    else if (action === "reload") await view.reload();
    else if (action === "post") {
      if (!recordId || !/^[a-f0-9]{32}$/.test(recordId))
        throw new PublishingError("INVALID_INPUT", "发布记录无效", 422);
      const record = await this.cloud<DouyinPublishRecord>("records/get", {
        id: recordId,
      });
      if (
        record.accountId !== accountId ||
        !/^https:\/\/www\.douyin\.com\/video\/[0-9]{5,30}$/.test(
          record.url || "",
        )
      )
        throw new PublishingError("INVALID_INPUT", "作品引用无效", 422);
      await view.navigate(record.url!);
      this.active = accountId;
    } else if (action === "manage") {
      await view.navigate(
        "https://creator.douyin.com/creator-micro/content/manage",
      );
      this.active = accountId;
    } else if (action === "close") {
      view.destroy();
      this.views.delete(accountId);
      if (this.active === accountId) this.active = undefined;
    } else throw new PublishingError("INVALID_INPUT", "浏览器操作无效", 422);
    this.changed();
  }
  async unbind(accountId: string): Promise<void> {
    const account = await this.owned(accountId);
    if (this.locked === accountId)
      throw new PublishingError("ACCOUNT_BUSY", "发布期间不能解绑账号");
    await this.cloud("accounts/unbind", {
      id: accountId,
      name: account.name,
      loginStatus: account.loginStatus,
    });
    const { profile, view } = await this.ensureForDeletion(accountId);
    view.destroy();
    this.views.delete(accountId);
    await this.profiles.delete(profile);
    this.changed();
  }
  private async ensureForDeletion(accountId: string) {
    const existing = this.views.get(accountId);
    if (existing) return existing;
    const current = await this.identity();
    const workspaceId = createHash("sha256")
      .update(`${current.userId}:${current.deviceId}`)
      .digest("hex");
    const profile = { workspaceId, accountId };
    const opened = await this.profiles.open(profile, { proxyMode: "system" });
    const view = new BrowserView(
      this.window,
      profile,
      opened.session,
      false,
      opened.saved,
      this.root,
      () => {},
      () => {},
      () => {},
    );
    return { profile, view };
  }
  async publish(
    accountId: string,
    input: DouyinPublishInput,
    files: PublishFiles,
    signal: AbortSignal,
    steps: ExecutionStepReporter,
    beforeSubmit: () => Promise<void>,
    onProgress: (value: number) => void,
  ): Promise<{ externalId: string; url: string }> {
    const account = await this.owned(accountId);
    const { view, profile } = await this.ensure(accountId);
    const login = await steps.run("check_login", "检查抖音登录", () =>
      this.detection.check(profile, "douyin", "task_execution"),
    );
    if (login.status !== "logged_in")
      throw new PublishingError("LOGIN_REQUIRED", "抖音登录失效或需要人工验证");
    if (
      account.platformUserId &&
      login.checks?.account_api?.accountId !== account.platformUserId
    )
      throw new PublishingError(
        "ACCOUNT_CHANGED",
        "浏览器中的抖音账号已改变，请重新添加账号",
      );
    if (!this.profiles.isSaved(profile))
      throw new PublishingError(
        "ACCOUNT_NOT_SAVED",
        "请先在账号浏览器点击保存账号",
      );
    this.locked = accountId;
    view.setVisible(false);
    this.changed();
    try {
      const page = view.createOpenCliPage(steps);
      const result = await steps.run(
        "platform_publish",
        "执行抖音网页发布",
        () =>
          page.withPublishViewport(() =>
            publishFromCreatorPage(
              page,
              input,
              files,
              signal,
              steps,
              beforeSubmit,
              onProgress,
            ),
          ),
      );
      await view.flushSession().catch(() => {});
      return result;
    } finally {
      this.locked = undefined;
      this.changed();
    }
  }
  shutdown(): void {
    for (const timer of this.navigationChecks.values()) clearTimeout(timer);
    this.navigationChecks.clear();
    for (const { view } of this.views.values()) view.destroy();
    this.views.clear();
    this.active = undefined;
    this.changed();
  }
  dispose(): void {
    clearInterval(this.timer);
    this.shutdown();
  }
}
