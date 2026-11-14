import {
  WebContentsView,
  type BrowserWindow,
  type Session,
  type WebContents,
} from "electron";
import type {
  BrowserState,
  ProfileKey,
  RuntimeErrorReporter,
} from "./contracts";
import type {
  AccountApiRequest,
  AccountApiResponse,
  CookieMetadata,
  DomInspectionInput,
  DomInspectionResult,
} from "../login/contracts";
import {
  isAllowedBrowserUrl,
  normalizeBrowserUserAgent,
  normalizeHttpUrl,
  publicBrowserUrl,
} from "./browser-input";
import { OpenCliPage } from "./opencli-page";
import type { ExecutionStepReporter } from "../task-executor/execution-log";

const BROWSER_CHROME_HEIGHT = 84;
const SIDEBAR_WIDTH = 200;
const NARROW_SIDEBAR_WIDTH = 72;
const NARROW_WINDOW_WIDTH = 900;
const ABORTED_NAVIGATION_SETTLE_MS = 5_000;
const RETRYABLE_NAVIGATION_ERRORS = new Set([
  "ERR_CONNECTION_ABORTED",
  "ERR_CONNECTION_CLOSED",
  "ERR_CONNECTION_RESET",
  "ERR_NETWORK_CHANGED",
  "ERR_PROXY_CONNECTION_FAILED",
  "ERR_TIMED_OUT",
]);

export class BrowserView {
  private readonly defaultUserAgent: string;
  private readonly view: WebContentsView;
  private readonly resizeListener = (): void => this.layout();
  private lastTargetUrl: string | undefined;
  private navigationFailed = false;
  private navigationCommitVersion = 0;
  private observedAccountApiKey: string | undefined;
  private recentAccountApiRequest:
    | {
        baseUrl: string;
        headers: Record<string, string>;
        url: string;
      }
    | undefined;

  constructor(
    private readonly window: BrowserWindow,
    private readonly profile: ProfileKey,
    profileSession: Session,
    enableDevTools: boolean,
    private saved: boolean,
    private readonly publishDebugRoot: string,
    private readonly onError: RuntimeErrorReporter,
    private readonly onStateChange: (state: BrowserState) => void,
    private readonly onNavigation: (url: string) => void,
    private readonly observation = false,
  ) {
    this.view = new WebContentsView({
      webPreferences: {
        offscreen: this.observation,
        session: profileSession,
        allowRunningInsecureContent: false,
        contextIsolation: true,
        devTools: enableDevTools,
        navigateOnDragDrop: false,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
      },
    });
    this.defaultUserAgent = this.view.webContents.getUserAgent();
    this.view.setVisible(false);
    this.configureContents(this.view.webContents);
    window.contentView.addChildView(this.view);
    window.on("resize", this.resizeListener);
    this.layout();
  }

  getState(): BrowserState {
    const contents = this.contents();
    return {
      profile: this.profile,
      title: contents?.getTitle() ?? "",
      // Platform URLs may contain short-lived login or CSRF credentials. The
      // real page keeps its URL, while BrowserState exposes only a safe view.
      url: publicBrowserUrl(contents?.getURL() ?? ""),
      loading: contents?.isLoading() ?? false,
      canGoBack: contents?.navigationHistory.canGoBack() ?? false,
      canGoForward: contents?.navigationHistory.canGoForward() ?? false,
      saved: this.saved,
    };
  }

  getProfile(): ProfileKey {
    return this.profile;
  }

  createOpenCliPage(steps?: ExecutionStepReporter): OpenCliPage {
    return new OpenCliPage(
      this.requireContents(),
      async (url) => {
        await this.navigate(url);
      },
      this.publishDebugRoot,
      steps,
    );
  }

  async navigate(url: string): Promise<BrowserState> {
    const targetUrl = normalizeHttpUrl(url);
    const contents = this.requireContents();
    this.lastTargetUrl = targetUrl;
    contents.setUserAgent(
      normalizeBrowserUserAgent(this.defaultUserAgent, targetUrl),
    );
    try {
      if (this.observation) await contents.loadURL(targetUrl);
      else await this.loadURL(contents, targetUrl);
      this.navigationFailed = false;
      return this.emitState();
    } catch (error) {
      this.navigationFailed = true;
      throw error;
    }
  }

  // 启动导航但不等待加载完成：立即返回当前状态，加载中由 did-start-loading
  // 等事件驱动，界面用 loading 字段展示加载动画。
  startNavigation(url: string): BrowserState {
    const targetUrl = normalizeHttpUrl(url);
    const contents = this.requireContents();
    this.lastTargetUrl = targetUrl;
    contents.setUserAgent(
      normalizeBrowserUserAgent(this.defaultUserAgent, targetUrl),
    );
    void this.loadURL(contents, targetUrl).then(
      () => {
        this.navigationFailed = false;
      },
      (error: unknown) => {
        this.navigationFailed = true;
        this.onError(
          "browser_navigation_failed",
          "Web navigation failed",
          error,
          { page_url: targetUrl, stage: "web_navigation" },
        );
      },
    );
    return this.emitState();
  }

  async openOrReusePage(url: string): Promise<string> {
    const currentUrl = this.requireContents().getURL();
    // Chromium may retain the requested HTTP URL after a failed document load;
    // reusing it would preserve the blank page and skip the bounded retry path.
    if (
      !this.navigationFailed &&
      (currentUrl.startsWith("http://") || currentUrl.startsWith("https://"))
    ) {
      return currentUrl;
    }
    return (await this.navigate(url)).url;
  }

  async getCookies(urls: string[]): Promise<CookieMetadata[]> {
    const cookieStore = this.requireContents().session.cookies;
    const groups = await Promise.all(
      urls.map((url) => cookieStore.get({ url })),
    );
    const unique = new Map<string, CookieMetadata>();
    for (const cookie of groups.flat()) {
      unique.set(`${cookie.domain}\0${cookie.path}\0${cookie.name}`, {
        name: cookie.name,
        expirationDate: cookie.expirationDate,
      });
    }
    return [...unique.values()];
  }

  async inspectDom(input: DomInspectionInput): Promise<DomInspectionResult> {
    const serializedInput = JSON.stringify(input).replaceAll("<", "\\u003c");
    // 只带回命中的候选名和适配器明确允许的昵称，绝不返回页面正文或存储值。
    return this.requireContents().executeJavaScript(`(() => {
      const input = ${serializedInput};
      const bodyText = (document.body?.innerText || "").slice(0, 50000);
      const selectors = (values) => values.filter((value) => {
        try {
          const element = document.querySelector(value);
          if (!element) return false;
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" &&
            Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
        } catch { return false; }
      });
      const texts = (values) => values.filter((value) => bodyText.includes(value));
      const normalizeIdentity = (value) => typeof value === "string"
        ? value.replace(/\\s+/g, " ").trim().slice(0, 200)
        : "";
      const nicknameFromSelector = (input.nicknameSelectors || [])
        .map((value) => {
          try { return normalizeIdentity(document.querySelector(value)?.textContent); }
          catch { return ""; }
        })
        .find(Boolean);
      const nicknameFromText = (input.nicknameTextPatterns || [])
        .map((value) => {
          try { return normalizeIdentity(bodyText.match(new RegExp(value, "m"))?.[1]); }
          catch { return ""; }
        })
        .find(Boolean);
      let localStorageKeys = [];
      try {
        localStorageKeys = input.localStorageKeys.filter(
          (key) => localStorage.getItem(key) !== null,
        );
      } catch {}
      return {
        loggedInSelectors: selectors(input.loggedInSelectors),
        loggedOutSelectors: selectors(input.loggedOutSelectors),
        verificationSelectors: selectors(input.verificationSelectors),
        riskSelectors: selectors(input.riskSelectors),
        loggedInTexts: texts(input.loggedInTexts),
        loggedOutTexts: texts(input.loggedOutTexts),
        verificationTexts: texts(input.verificationTexts),
        riskTexts: texts(input.riskTexts),
        localStorageKeys,
        nickname: nicknameFromSelector || nicknameFromText || undefined,
      };
    })()`);
  }

  async requestAccountApi(
    request: AccountApiRequest,
    timeoutMs: number,
  ): Promise<AccountApiResponse> {
    const deadline = Date.now() + timeoutMs;
    const contents = this.requireContents();
    const baseUrl = normalizeHttpUrl(request.url);
    const url = request.reuseRecentUrl
      ? await this.findRecentRequestUrl(baseUrl)
      : baseUrl;
    const recentHeadersBaseUrl = normalizeHttpUrl(
      request.reuseRecentHeadersFromUrl ?? baseUrl,
    );
    const recentHeaders = await waitForAccountApiHeaders(
      () => this.getRecentRequestHeaders(recentHeadersBaseUrl, request),
      timeoutMs,
    );
    const body = request.jsonBodyFromCookie
      ? await this.createJsonBodyFromCookie(baseUrl, request.jsonBodyFromCookie)
      : undefined;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error("Account API request timed out");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remainingMs);
    try {
      const response = await contents.session.fetch(url, {
        method: request.method ?? "GET",
        credentials: "include",
        headers: {
          Accept: "application/json",
          ...request.headers,
          ...recentHeaders,
          ...(request.referrer ? { Referer: request.referrer } : {}),
          "User-Agent": normalizeBrowserUserAgent(this.defaultUserAgent, url),
        },
        body,
        signal: controller.signal,
      });
      const contentLength = Number(response.headers.get("content-length") ?? 0);
      if (contentLength > 1_000_000) {
        throw new Error("Account API response is too large");
      }
      const text = await response.text();
      if (text.length > 1_000_000) {
        throw new Error("Account API response is too large");
      }
      return {
        body: parseAccountApiResponseBody(text, request.responseType),
        ok: response.ok,
        status: response.status,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  observeAccountApi(request: AccountApiRequest): void {
    const headerNames = (request.reuseRecentHeaders ?? [])
      .map((name) => name.toLowerCase())
      .sort();
    if (!request.reuseRecentUrl && headerNames.length === 0) {
      return;
    }
    const baseUrl = normalizeHttpUrl(request.url);
    const key = `${baseUrl}\0${headerNames.join("\0")}`;
    if (this.observedAccountApiKey === key) {
      return;
    }
    this.observedAccountApiKey = key;
    const base = new URL(baseUrl);
    this.requireContents().session.webRequest.onBeforeSendHeaders(
      { urls: [`${base.origin}${base.pathname}*`] },
      (details, callback) => {
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(details.requestHeaders)) {
          if (headerNames.includes(name.toLowerCase())) {
            headers[name.toLowerCase()] = value;
          }
        }
        this.recentAccountApiRequest = {
          baseUrl,
          headers,
          url: details.url,
        };
        callback({ requestHeaders: details.requestHeaders });
      },
    );
  }

  private getRecentRequestHeaders(
    baseUrl: string,
    request: AccountApiRequest,
  ): Record<string, string> | undefined {
    const required = request.reuseRecentHeaders ?? [];
    if (required.length === 0) {
      return {};
    }
    const recent = this.recentAccountApiRequest;
    const headers = recent?.baseUrl === baseUrl ? recent.headers : {};
    if (required.some((name) => !headers[name.toLowerCase()])) {
      return undefined;
    }
    // 动态签名只保存在隔离 Profile 的 BrowserView 内存中，不进入检测结果或日志。
    return headers;
  }

  private async createJsonBodyFromCookie(
    url: string,
    input: NonNullable<AccountApiRequest["jsonBodyFromCookie"]>,
  ): Promise<string> {
    const cookies = await this.requireContents().session.cookies.get({ url });
    const credential = input.cookieNames
      .map((name) => cookies.find((cookie) => cookie.name === name)?.value)
      .find(Boolean);
    if (!credential) {
      throw new Error("Account API session credential is unavailable");
    }
    // 凭据只在 BrowserView 内组装请求体，不返回给检测器或日志层。
    return JSON.stringify({ [input.field]: credential });
  }

  private async findRecentRequestUrl(baseUrl: string): Promise<string> {
    if (this.recentAccountApiRequest?.baseUrl === baseUrl) {
      return this.recentAccountApiRequest.url;
    }
    const serializedBaseUrl = JSON.stringify(baseUrl).replaceAll(
      "<",
      "\\u003c",
    );
    const candidate = await this.requireContents().executeJavaScript(`(() => {
      const base = new URL(${serializedBaseUrl});
      return performance.getEntriesByType("resource")
        .map((entry) => entry.name)
        .reverse()
        .find((value) => {
          try {
            const url = new URL(value);
            return url.origin === base.origin && url.pathname === base.pathname;
          } catch { return false; }
        });
    })()`);
    if (typeof candidate !== "string") {
      return baseUrl;
    }
    const recent = new URL(normalizeHttpUrl(candidate));
    const base = new URL(baseUrl);
    return recent.origin === base.origin && recent.pathname === base.pathname
      ? recent.toString()
      : baseUrl;
  }

  goBack(): BrowserState {
    const contents = this.requireContents();
    if (contents.navigationHistory.canGoBack()) {
      contents.navigationHistory.goBack();
    }
    return this.emitState();
  }

  goForward(): BrowserState {
    const contents = this.requireContents();
    if (contents.navigationHistory.canGoForward()) {
      contents.navigationHistory.goForward();
    }
    return this.emitState();
  }

  async reload(): Promise<BrowserState> {
    const contents = this.requireContents();
    const targetUrl = this.lastTargetUrl ?? contents.getURL();
    if (isAllowedBrowserUrl(targetUrl)) {
      return this.navigate(targetUrl);
    }
    contents.reload();
    return this.emitState();
  }

  async flushSession(): Promise<void> {
    const profileSession = this.requireContents().session;
    profileSession.flushStorageData();
    await profileSession.cookies.flushStore();
  }

  markSaved(): BrowserState {
    this.saved = true;
    return this.emitState();
  }

  setVisible(visible: boolean): void {
    this.view.setVisible(visible);
    if (visible) {
      this.layout();
    }
  }

  destroy(): void {
    this.window.off("resize", this.resizeListener);
    if (!this.window.isDestroyed()) {
      this.window.contentView.removeChildView(this.view);
    }
    if (!this.view.webContents.isDestroyed()) {
      if (this.observedAccountApiKey)
        this.view.webContents.session.webRequest.onBeforeSendHeaders(null);
      this.view.webContents.close();
    }
  }

  private configureContents(contents: WebContents): void {
    const update = (): BrowserState => this.emitState();
    contents.on("did-start-loading", update);
    contents.on("did-stop-loading", update);
    contents.on("did-navigate", (_event, url) => {
      this.navigationCommitVersion += 1;
      this.lastTargetUrl = url;
      update();
      this.onNavigation(url);
    });
    contents.on("did-navigate-in-page", (_event, url) => {
      this.lastTargetUrl = url;
      update();
      this.onNavigation(url);
    });
    contents.on("page-title-updated", update);
    contents.on("render-process-gone", update);
    contents.on("will-navigate", (event) => {
      if (!isAllowedBrowserUrl(event.url)) {
        event.preventDefault();
      }
    });
    contents.on("will-redirect", (event) => {
      if (!isAllowedBrowserUrl(event.url)) {
        event.preventDefault();
      }
    });
    contents.setWindowOpenHandler(({ url }) => {
      // 平台登录经常用新窗口跳转；留在当前受控视图可避免登录页逃离 Profile 隔离。
      if (!this.observation && isAllowedBrowserUrl(url)) {
        void this.navigate(url).catch((error: unknown) => {
          this.onError(
            "browser_popup_navigation_failed",
            "Platform popup navigation failed",
            error,
            { page_url: url, stage: "platform_navigation" },
          );
        });
      }
      return { action: "deny" };
    });
  }

  private loadURL(contents: WebContents, targetUrl: string): Promise<void> {
    const navigationCommitVersion = this.navigationCommitVersion;
    return loadBrowserUrlWithRetry(
      () => contents.loadURL(targetUrl),
      async () => {
        // 系统代理或代理节点短暂切换时，先让 Chromium 重新读取代理配置，
        // 再关闭旧连接；只对明确的瞬时网络错误执行一次，不重试证书或风控错误。
        await contents.session.forceReloadProxyConfig();
        await contents.session.closeAllConnections();
      },
      () =>
        this.waitForAllowedNavigationCommit(contents, navigationCommitVersion),
    );
  }

  private waitForAllowedNavigationCommit(
    contents: WebContents,
    afterVersion: number,
  ): Promise<boolean> {
    const hasCommitted = (url = contents.getURL()): boolean =>
      this.navigationCommitVersion > afterVersion && isAllowedBrowserUrl(url);
    if (contents.isDestroyed()) return Promise.resolve(false);
    if (hasCommitted()) return Promise.resolve(true);

    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = (committed: boolean): void => {
        clearTimeout(timer);
        contents.off("did-navigate", onNavigate);
        contents.off("destroyed", onDestroyed);
        resolve(committed);
      };
      const onNavigate = (_event: unknown, url: string): void => {
        if (hasCommitted(url)) finish(true);
      };
      const onDestroyed = (): void => finish(false);

      contents.on("did-navigate", onNavigate);
      contents.on("destroyed", onDestroyed);
      // ERR_ABORTED can precede the replacement page's commit. Wait briefly,
      // but keep a real cancellation bounded instead of hiding it forever.
      timer = setTimeout(() => finish(false), ABORTED_NAVIGATION_SETTLE_MS);
      timer.unref();
    });
  }

  private viewport: Electron.Rectangle | undefined;

  setViewport(bounds: Electron.Rectangle): void {
    this.viewport = bounds;
    this.layout();
  }

  private layout(): void {
    if (this.window.isDestroyed()) {
      return;
    }
    if (this.viewport) {
      this.view.setBounds(this.viewport);
      return;
    }
    const size = this.window.getContentSize();
    const width = size[0] ?? 0;
    const height = size[1] ?? 0;
    const sidebarWidth =
      width <= NARROW_WINDOW_WIDTH ? NARROW_SIDEBAR_WIDTH : SIDEBAR_WIDTH;
    this.view.setBounds({
      x: sidebarWidth,
      y: BROWSER_CHROME_HEIGHT,
      width: Math.max(0, width - sidebarWidth),
      height: Math.max(0, height - BROWSER_CHROME_HEIGHT),
    });
  }

  private contents(): WebContents | undefined {
    const contents = this.view.webContents;
    return contents.isDestroyed() ? undefined : contents;
  }

  private requireContents(): WebContents {
    const contents = this.contents();
    if (!contents) {
      throw new Error("Browser view is closed");
    }
    return contents;
  }

  private emitState(): BrowserState {
    const state = this.getState();
    this.onStateChange(state);
    return state;
  }
}

export function parseAccountApiResponseBody(
  text: string,
  responseType: AccountApiRequest["responseType"] = "json",
): unknown {
  return responseType === "text" ? text : text ? JSON.parse(text) : null;
}

export async function waitForAccountApiHeaders(
  readHeaders: () => Record<string, string> | undefined,
  timeoutMs: number,
  pollIntervalMs = 50,
): Promise<Record<string, string>> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const headers = readHeaders();
    if (headers) {
      return headers;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error("Account API page signature is unavailable");
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(pollIntervalMs, remainingMs)),
    );
  }
}

export async function loadBrowserUrlWithRetry(
  load: () => Promise<void>,
  resetNetwork: () => Promise<void>,
  recoverAbortedNavigation?: () => Promise<boolean>,
): Promise<void> {
  const loadOnce = async (): Promise<void> => {
    try {
      await load();
    } catch (error) {
      if (
        navigationErrorCode(error) === "ERR_ABORTED" &&
        (await recoverAbortedNavigation?.())
      ) {
        return;
      }
      throw error;
    }
  };

  try {
    await loadOnce();
  } catch (error) {
    if (!isRetryableNavigationError(error)) throw error;
    await resetNetwork();
    await loadOnce();
  }
}

function isRetryableNavigationError(error: unknown): boolean {
  const code = navigationErrorCode(error);
  return code !== undefined && RETRYABLE_NAVIGATION_ERRORS.has(code);
}

function navigationErrorCode(error: unknown): string | undefined {
  const candidate = error as { code?: unknown; message?: unknown } | null;
  return typeof candidate?.code === "string"
    ? candidate.code
    : typeof candidate?.message === "string"
      ? candidate.message.match(/\bERR_[A-Z_]+\b/)?.[0]
      : undefined;
}
