import { BrowserExecutionCoordinator } from "./browser-execution-coordinator";
import {
  confirmContactAccount,
  publicCommenterProfile,
} from "../comment-observation/comment-contact";
import { samePublisher } from "./queue";
import type { OpenCliPage } from "./runtime/browser/opencli-page";
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
  private coordinator = new BrowserExecutionCoordinator();
  private lifetime = new AbortController();
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
          if (!this.coordinator.occupied(id))
            void this.check(id).catch(() => {});
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
  private profileFor(
    identity: PublishingIdentity,
    accountId: string,
  ): ProfileKey {
    const workspaceId = createHash("sha256")
      .update(`${identity.userId}:${identity.deviceId}`)
      .digest("hex");
    return { workspaceId, accountId };
  }
  private async ensure(accountId: string) {
    await this.owned(accountId);
    const existing = this.views.get(accountId);
    if (existing) return existing;
    const current = await this.identity();
    const profile = this.profileFor(current, accountId);
    const opened = await this.profiles.open(profile, { proxyMode: "system" });
    await this.configureSession?.(opened.session);
    const after = await this.identity();
    if (
      after.generation !== current.generation ||
      after.userId !== current.userId ||
      after.deviceId !== current.deviceId
    )
      throw new PublishingError("SESSION_CHANGED", "登录已变更");
    const view = new BrowserView(
      this.window,
      profile,
      opened.session,
      false,
      opened.saved,
      path.join(this.root, profile.workspaceId, accountId, "debug"),
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
      this.coordinator.occupied(accountId) ||
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
  private run<T>(
    id: string,
    foreground: boolean,
    work: () => Promise<T>,
    signal?: AbortSignal,
  ) {
    return this.coordinator.run(
      id,
      foreground,
      work,
      signal
        ? AbortSignal.any([signal, this.lifetime.signal])
        : this.lifetime.signal,
    );
  }
  open(accountId: string) {
    return this.run(accountId, true, async () => {
      const { view } = await this.ensure(accountId);
      this.selectManual(accountId);
      this.changed();
      await view.openOrReusePage(DOUYIN_LOGIN_CONFIG.homeUrl);
      this.changed();
    });
  }
  openCommenter(
    identity: PublishingIdentity,
    accountId: string,
    resolveProfile: () => Promise<unknown>,
  ) {
    return this.run(accountId, true, async () => {
      const account = await this.owned(accountId);
      const profile = this.profileFor(identity, accountId);
      if (
        !account.platformUserId ||
        account.loginStatus !== "logged_in" ||
        !this.profiles.isSaved(profile)
      )
        throw new PublishingError(
          "LOGIN_REQUIRED",
          "请先在当前设备登录并保存读取评论的账号",
        );
      const { view } = await this.ensure(accountId);
      if (!samePublisher(identity, await this.identity()))
        throw new PublishingError("SESSION_CHANGED", "登录已变更");
      await view.navigate(DOUYIN_LOGIN_CONFIG.homeUrl);
      await confirmContactAccount(
        view.createOpenCliPage(),
        account.platformUserId,
      );
      const destination = publicCommenterProfile(await resolveProfile());
      if (!samePublisher(identity, await this.identity()))
        throw new PublishingError("SESSION_CHANGED", "登录已变更");
      const result = await view.navigate(destination);
      if (result.url.replace(/\/$/, "") !== destination)
        throw new PublishingError(
          "CONTACT_REDIRECTED",
          "抖音未打开对应的评论者主页，请检查账号或访问限制",
        );
      this.selectManual(accountId);
      this.changed();
    });
  }
  private selectManual(id?: string) {
    for (const [key, { view }] of this.views)
      if (key !== id) view.setVisible(false);
    this.active = id;
    this.coordinator.setManual(id);
  }
  hide(): void {
    this.selectManual();
    this.changed();
  }
  viewport(
    accountId: string,
    input: Electron.Rectangle,
    visible: boolean,
  ): void {
    if (accountId !== this.active) return;
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
      entry.view.setVisible(visible && id === accountId);
  }
  check(
    accountId: string,
    save = false,
    manual = false,
  ): Promise<DouyinAccount> {
    return this.run(accountId, manual, () =>
      this.checkAccount(accountId, save),
    );
  }
  private async checkAccount(
    accountId: string,
    save: boolean,
  ): Promise<DouyinAccount> {
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
    return this.run(accountId, true, async () => {
      await this.owned(accountId);
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
        this.selectManual(accountId);
      } else if (action === "manage") {
        await view.navigate(
          "https://creator.douyin.com/creator-micro/content/manage",
        );
        this.selectManual(accountId);
      } else if (action === "close") {
        view.destroy();
        this.views.delete(accountId);
        if (this.active === accountId) this.selectManual();
      } else throw new PublishingError("INVALID_INPUT", "浏览器操作无效", 422);
      this.changed();
    });
  }
  async unbind(accountId: string): Promise<void> {
    return this.run(accountId, true, async () => {
      const account = await this.owned(accountId);

      await this.cloud("accounts/unbind", {
        id: accountId,
        name: account.name,
        loginStatus: account.loginStatus,
      });
      const { profile, view } = await this.ensureForDeletion(accountId);
      view.destroy();
      this.views.delete(accountId);
      if (this.active === accountId) this.selectManual();
      await this.profiles.delete(profile);
      this.changed();
    });
  }
  private async ensureForDeletion(accountId: string) {
    const existing = this.views.get(accountId);
    if (existing) return existing;
    const current = await this.identity();
    const profile = this.profileFor(current, accountId);
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
    return this.run(
      accountId,
      false,
      async () => {
        const account = await this.owned(accountId);
        const { view, profile } = await this.ensure(accountId);
        const login = await steps.run("check_login", "检查抖音登录", () =>
          this.detection.check(profile, "douyin", "task_execution"),
        );
        if (login.status !== "logged_in")
          throw new PublishingError(
            "LOGIN_REQUIRED",
            "抖音登录失效或需要人工验证",
          );
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

        view.setVisible(false);
        this.changed();
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
      },
      signal,
    );
  }
  observe<T>(
    accountId: string,
    signal: AbortSignal,
    work: (page: OpenCliPage, hasViewerSession: boolean) => Promise<T>,
  ) {
    return this.run(
      accountId,
      false,
      async () => {
        const account = await this.owned(accountId);
        if (account.loginStatus === "verification_required")
          throw new PublishingError(
            "VERIFICATION_REQUIRED",
            "该账号需要人工完成安全验证",
          );
        if (account.loginStatus === "risk_controlled")
          throw new PublishingError(
            "ACCESS_RESTRICTED",
            "当前账号处于平台访问限制状态",
          );
        if (account.loginStatus !== "logged_in")
          throw new PublishingError(
            "LOGIN_REQUIRED",
            "请先在账号浏览器确认登录并保存账号",
          );
        const identity = await this.identity();
        const profile = this.profileFor(identity, accountId);
        if (!this.profiles.isSaved(profile))
          throw new PublishingError(
            "ACCOUNT_NOT_SAVED",
            "请先在此设备保存该账号",
          );
        const existing = this.views.get(accountId);
        if (existing && existing.profile.workspaceId !== profile.workspaceId)
          throw new PublishingError("SESSION_CHANGED", "账号工作区已变更");
        const session =
          existing?.session ??
          (await this.profiles.open(profile, { proxyMode: "system" })).session;
        if (!existing) await this.configureSession?.(session);
        signal.throwIfAborted();
        const view = new BrowserView(
          this.window,
          profile,
          session,
          false,
          true,
          this.root,
          () => {},
          () => {},
          () => {},
          true,
        );
        const close = () => view.destroy();
        signal.addEventListener("abort", close, { once: true });
        try {
          const page = view.createOpenCliPage();
          const metadata = await view.getCookies(["https://www.douyin.com/"]);
          const hasViewerSession = metadata.some(
            (cookie) =>
              DOUYIN_LOGIN_CONFIG.cookieNames.includes(cookie.name) &&
              (cookie.expirationDate === undefined ||
                cookie.expirationDate > Date.now() / 1000),
          );
          signal.throwIfAborted();
          return await work(page, hasViewerSession);
        } finally {
          signal.removeEventListener("abort", close);
          if (!signal.aborted) close();
        }
      },
      signal,
    );
  }
  shutdown(): void {
    this.lifetime.abort(new PublishingError("INTERRUPTED", "浏览器执行已中断"));
    this.lifetime = new AbortController();
    this.coordinator.reset();
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
