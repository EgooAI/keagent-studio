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
  SocialPlatform,
  DouyinBrowserTab,
  DouyinPublishInput,
  DouyinPublishRecord,
} from "@keagent/shared-types";
import { XHS_HOME, checkXhsLogin } from "./plugins/checkLogin/xhs";
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
    {
      view: BrowserView;
      session: Session;
      profile: ProfileKey;
      platform: SocialPlatform;
    }
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
        this.douyinDetector(profile, this.require(profile.accountId).view),
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
  private douyinDetector(profile: ProfileKey, view: BrowserView) {
    return createDouyinLoginDetector({
      profile,
      ensureProfile: async () => this.profiles.exists(profile),
      getCookies: (urls) => view.getCookies(urls),
      openOrReusePage: (url) => view.openOrReusePage(url),
      inspectDom: (input) => view.inspectDom(input),
      requestAccountApi: (request, timeout) =>
        view.requestAccountApi(request, timeout),
    });
  }
  tabs(): DouyinBrowserTab[] {
    return [...this.views].map(([accountId, { view, platform }]) => {
      const { profile: _profile, ...state } = view.getState();
      return { accountId, platform, ...state };
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
  async socialAccounts(identity: PublishingIdentity) {
    const { items } = await this.cloud<{ items: DouyinAccount[] }>(
      "accounts/list",
    );
    if (!samePublisher(identity, await this.identity()))
      throw new PublishingError("SESSION_CHANGED", "登录已变更");
    return items
      .filter(
        (a) =>
          a.deviceId === identity.deviceId &&
          !a.unboundAt &&
          a.loginStatus === "logged_in" &&
          a.platformUserId &&
          this.profiles.isSaved(this.profileFor(identity, a.id)),
      )
      .map((a) => ({ ...a, platform: a.platform ?? "douyin" }));
  }
  private async ensure(accountId: string) {
    const account = await this.owned(accountId);
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
    const platform = account.platform ?? "douyin";
    if (platform === "douyin")
      view.observeAccountApi(DOUYIN_LOGIN_CONFIG.accountApi);
    const value = { view, session: opened.session, profile, platform };
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
      const { view, platform } = await this.ensure(accountId);
      this.selectManual(accountId);
      this.changed();
      await view.openOrReusePage(
        platform === "xhs" ? XHS_HOME : DOUYIN_LOGIN_CONFIG.homeUrl,
      );
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
      const platform = account.platform ?? "douyin";
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
      if (platform === "xhs") {
        await this.confirmXhsAccount(view, account.platformUserId);
      } else {
        await view.navigate(DOUYIN_LOGIN_CONFIG.homeUrl);
        await confirmContactAccount(
          view.createOpenCliPage(),
          account.platformUserId,
        );
      }
      const destination = publicCommenterProfile(
        await resolveProfile(),
        platform,
      );
      if (!samePublisher(identity, await this.identity()))
        throw new PublishingError("SESSION_CHANGED", "登录已变更");
      const result = await view.navigate(destination);
      if (result.url.replace(/\/$/, "") !== destination)
        throw new PublishingError(
          "CONTACT_REDIRECTED",
          "平台未打开对应的评论者主页，请检查账号或访问限制",
        );
      if (!samePublisher(identity, await this.identity()))
        throw new PublishingError("SESSION_CHANGED", "登录已变更");
      this.selectManual(accountId);
      this.changed();
    });
  }
  private async confirmXhsAccount(view: BrowserView, expected: string) {
    const result = await checkXhsLogin(view);
    if (result.status !== "logged_in")
      throw new PublishingError(
        "LOGIN_REQUIRED",
        result.errorMessage || "请在小红书重新登录",
      );
    if (result.accountId !== expected)
      throw new PublishingError(
        "ACCOUNT_CHANGED",
        "当前小红书账号与已保存账号不一致",
      );
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
    const { profile, platform, view } = await this.ensure(accountId);
    const result =
      platform === "xhs"
        ? await checkXhsLogin(view)
        : await this.detection.check(
            profile,
            "douyin",
            save ? "profile_save" : "manual",
          );
    if (save && result.status !== "logged_in")
      throw new PublishingError(
        "LOGIN_REQUIRED",
        result.errorMessage || "请先在浏览器完成登录或验证",
      );
    const apiIdentity =
      platform === "xhs" ? result : result.checks?.account_api;
    const platformUserId =
      apiIdentity?.status === "logged_in" ? apiIdentity.accountId : undefined;
    if (save && (!platformUserId || platformUserId === accountId))
      throw new PublishingError(
        "ACCOUNT_IDENTITY_UNAVAILABLE",
        "无法确认平台账号身份，请刷新账号首页后重试",
      );
    if (save && !this.profiles.isSaved(profile)) {
      const identity = await this.identity();
      const { items } = await this.cloud<{ items: DouyinAccount[] }>(
        "accounts/list",
      );
      if (
        items.some(
          (a) =>
            a.id !== accountId &&
            a.deviceId === identity.deviceId &&
            !a.unboundAt &&
            (a.platform ?? "douyin") === platform &&
            a.platformUserId === platformUserId &&
            this.profiles.isSaved(this.profileFor(identity, a.id)),
        )
      )
        throw new PublishingError(
          "ACCOUNT_ALREADY_BOUND",
          "本机已保存这个平台账号，请直接使用已有账号",
        );
    }
    const saved = await this.cloud<DouyinAccount>("accounts/update", {
      id: accountId,
      name:
        result.nickname ||
        (platform === "xhs" && platformUserId
          ? "小红书 · " + platformUserId.slice(-6)
          : account.name),
      loginStatus: result.status,
      ...(save ? { savedProfile: true } : {}),
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
      const { view, platform } = this.require(accountId);
      if ((action === "post" || action === "manage") && platform !== "douyin")
        throw new PublishingError("INVALID_INPUT", "此入口仅支持抖音账号", 422);
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
        const view = await steps.run(
          "check_login",
          "检查抖音登录",
          async () => {
            const account = await this.owned(accountId);
            if (account.platform === "xhs")
              throw new PublishingError(
                "INVALID_INPUT",
                "视频发布只支持抖音账号",
                422,
              );
            const { view, profile } = await this.ensure(accountId);
            const login = await this.detection.check(
              profile,
              "douyin",
              "task_execution",
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
            return view;
          },
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
    return this.withSavedPage(accountId, "douyin", signal, work);
  }
  observeSocial<T>(
    identity: PublishingIdentity,
    accountId: string,
    platform: SocialPlatform,
    signal: AbortSignal,
    work: (page: OpenCliPage, platformUserId: string) => Promise<T>,
  ) {
    return this.withSavedPage(
      accountId,
      platform,
      signal,
      (page, _viewer, platformUserId) => work(page, platformUserId),
      identity,
    );
  }
  private withSavedPage<T>(
    accountId: string,
    platform: SocialPlatform,
    signal: AbortSignal,
    work: (
      page: OpenCliPage,
      hasViewerSession: boolean,
      platformUserId: string,
    ) => Promise<T>,
    expectedIdentity?: PublishingIdentity,
  ) {
    signal = AbortSignal.any([signal, this.lifetime.signal]);
    return this.run(
      accountId,
      false,
      async () => {
        const account = await this.owned(accountId);
        if ((account.platform ?? "douyin") !== platform)
          throw new PublishingError(
            "ACCOUNT_UNAVAILABLE",
            "此账号不属于所选平台",
          );
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
        if (expectedIdentity && !samePublisher(expectedIdentity, identity))
          throw new PublishingError("SESSION_CHANGED", "登录已变更");
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
          const metadata = await view.getCookies([
            platform === "xhs" ? XHS_HOME : "https://www.douyin.com/",
          ]);
          const hasViewerSession = metadata.some(
            (cookie) =>
              (platform === "xhs"
                ? cookie.name === "web_session"
                : DOUYIN_LOGIN_CONFIG.cookieNames.includes(cookie.name)) &&
              (cookie.expirationDate === undefined ||
                cookie.expirationDate > Date.now() / 1000),
          );
          signal.throwIfAborted();
          if (expectedIdentity) {
            if (!hasViewerSession || !account.platformUserId)
              throw new PublishingError(
                "LOGIN_REQUIRED",
                "请在本机账号浏览器登录并保存该平台账号",
              );
            if (platform === "xhs") {
              await this.confirmXhsAccount(view, account.platformUserId);
            } else {
              const result = await this.douyinDetector(
                profile,
                view,
              ).checkAccountApi();
              const currentId = result.accountId;
              if (
                result.status !== "logged_in" ||
                !currentId ||
                currentId === accountId
              )
                throw new PublishingError(
                  "LOGIN_REQUIRED",
                  "抖音登录已失效或无法核对账号，请在账号浏览器确认",
                );
              if (currentId !== account.platformUserId)
                throw new PublishingError(
                  "ACCOUNT_CHANGED",
                  "当前抖音账号与已保存账号不一致",
                );
            }
            signal.throwIfAborted();
            if (!samePublisher(expectedIdentity, await this.identity()))
              throw new PublishingError("SESSION_CHANGED", "登录已变更");
          }
          return await work(
            page,
            hasViewerSession,
            account.platformUserId ?? "",
          );
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
