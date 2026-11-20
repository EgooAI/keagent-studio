import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BrowserWindow, WebContents } from "electron";
import type { ExecutionStepReporter } from "../task-executor/execution-log";

export interface OpenCliGotoOptions {
  waitUntil?: "load" | "none";
  settleMs?: number;
}

export type OpenCliWaitOptions =
  number | { time: number } | { selector: string; timeout?: number };

export interface OpenCliScreenshotOptions {
  fullPage?: boolean;
  path?: string;
}

export interface PublishPageElementQuery {
  selector: string;
  text?: string;
  exactText?: boolean;
  index?: number;
  within?: string;
}

export type PublishPageElementState = "attached" | "hidden" | "visible";

interface PublishPageElementSnapshot {
  count: number;
  visible: boolean;
  x?: number;
  y?: number;
}

const installedInitScripts = new WeakMap<WebContents, Set<string>>();

/**
 * Compatibility surface required by the vendored OpenCLI adapters and the
 * social-auto-upload ports.
 * It deliberately exposes only bounded browser operations, never Electron's
 * WebContents or Session to platform plugins.
 */
export class OpenCliPage {
  private messagePopup?: BrowserWindow;
  private openingMessageEntry = false;
  private messageOrigin?: string;

  constructor(
    private readonly opener: WebContents,
    private readonly navigate: (url: string) => Promise<void>,
    private readonly debugRoot?: string,
    private readonly steps?: ExecutionStepReporter,
  ) {}

  private get contents(): WebContents {
    if (this.messagePopup?.isDestroyed()) throw new Error("私信窗口已关闭");
    return this.messagePopup?.webContents ?? this.opener;
  }
  get inMessagePopup(): boolean {
    return !!this.messagePopup;
  }

  private closeMessagePopup(): void {
    const popup = this.messagePopup;
    this.messagePopup = undefined;
    if (popup && !popup.isDestroyed()) popup.destroy();
  }

  async withMessagePopups<T>(profileUrl: string, work: () => Promise<T>) {
    const profile = new URL(profileUrl);
    const origin = profile.origin;
    if (
      profile.protocol !== "https:" ||
      profile.username ||
      profile.password ||
      !["https://www.douyin.com", "https://www.xiaohongshu.com"].includes(
        origin,
      )
    )
      throw new Error("私信收件人平台无效");
    const allowed = (value: string) => {
      try {
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          url.origin === origin &&
          !url.username &&
          !url.password
        );
      } catch {
        return false;
      }
    };
    const onPopup = (popup: BrowserWindow) => {
      this.messagePopup = popup;
      const contents = popup.webContents;
      const guard = (event: { url: string; preventDefault(): void }) => {
        if (!allowed(event.url)) event.preventDefault();
      };
      contents.on("will-navigate", guard);
      contents.on("will-redirect", guard);
      contents.setWindowOpenHandler(() => ({ action: "deny" }));
    };
    this.messageOrigin = origin;
    this.opener.on("did-create-window", onPopup);
    this.opener.setWindowOpenHandler(({ url, referrer, postBody }) => {
      if (
        !this.openingMessageEntry ||
        this.messagePopup ||
        postBody ||
        !allowed(this.opener.getURL()) ||
        !allowed(url) ||
        (referrer.url && !allowed(referrer.url))
      )
        return { action: "deny" };
      this.openingMessageEntry = false;
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          show: false,
          width: 1280,
          height: 900,
          webPreferences: {
            session: this.opener.session,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            nodeIntegrationInSubFrames: false,
            webSecurity: true,
            devTools: false,
            offscreen: true,
          },
        },
      };
    });
    try {
      return await work();
    } finally {
      this.messageOrigin = undefined;
      this.openingMessageEntry = false;
      this.closeMessagePopup();
      this.opener.off("did-create-window", onPopup);
      if (!this.opener.isDestroyed())
        this.opener.setWindowOpenHandler(() => ({ action: "deny" }));
    }
  }

  async goto(url: string, options: OpenCliGotoOptions = {}): Promise<void> {
    this.closeMessagePopup();
    await this.runStep("open_platform_page", "打开平台页面", async () => {
      await this.navigate(url);
      if (options.waitUntil !== "none") {
        const maxMs = options.settleMs ?? 1_000;
        try {
          await this.evaluate(
            buildDomStableExpression(maxMs, Math.min(500, maxMs)),
          );
        } catch (error) {
          // OpenCLI treats a second SPA navigation during settling as non-fatal;
          // the command's next explicit check remains authoritative.
          if (!isNavigationEvaluationError(error)) throw error;
        }
      }
    });
  }

  // Keep the observer independent of scripts installed by the remote page.
  async inspectDocument<T>(
    source: string,
    openMessageEntry = false,
  ): Promise<T> {
    const open = openMessageEntry && !!this.messageOrigin && !this.messagePopup;
    this.openingMessageEntry = open;
    try {
      return await this.contents.executeJavaScriptInIsolatedWorld(
        1001,
        [{ code: source }],
        open,
      );
    } finally {
      this.openingMessageEntry = false;
    }
  }

  async evaluate<T = unknown>(source: string): Promise<T> {
    const expression = buildEvaluateExpression(source);
    try {
      return await this.contents.executeJavaScript(expression);
    } catch (error) {
      if (!isNavigationEvaluationError(error)) throw error;
      // Match OpenCLI's single retry when a SPA navigation destroys the first
      // JavaScript execution context.
      await delay(250);
      return this.contents.executeJavaScript(expression);
    }
  }

  /**
   * Executes a non-idempotent page action exactly once. A navigation that
   * destroys the JavaScript context is surfaced to the caller so an upload or
   * publish request cannot be replayed accidentally.
   */
  evaluateOnce<T = unknown>(source: string): Promise<T> {
    return this.runStep("submit_page_request", "提交平台页面请求", () =>
      this.contents.executeJavaScript(buildEvaluateExpression(source)),
    );
  }

  async wait(options: OpenCliWaitOptions): Promise<void> {
    if (typeof options === "number") {
      if (options >= 1) {
        const maxMs = options * 1_000;
        try {
          await this.evaluate(
            buildDomStableExpression(maxMs, Math.min(500, maxMs)),
          );
          return;
        } catch {
          // Match OpenCLI's fixed-sleep fallback when DOM observation fails.
        }
      }
      await delay(options * 1_000);
      return;
    }
    if ("time" in options) {
      await delay(options.time * 1_000);
      return;
    }
    const timeoutMs = (options.timeout ?? 10) * 1_000;
    const selector = JSON.stringify(options.selector).replaceAll(
      "<",
      "\\u003c",
    );
    const found = await this.evaluate<boolean>(`(async () => {
      const deadline = Date.now() + ${timeoutMs};
      while (Date.now() < deadline) {
        try { if (document.querySelector(${selector})) return true; } catch {}
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    })()`);
    if (!found) {
      throw new Error(`Timed out waiting for selector: ${options.selector}`);
    }
  }

  getUrl(): string {
    return this.contents.getURL();
  }

  async waitForUrl(pattern: string, timeoutMs = 30_000): Promise<void> {
    await this.runStep("wait_page_navigation", "等待平台页面跳转", async () => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (urlMatchesPattern(this.contents.getURL(), pattern)) return;
        await delay(100);
      }
      throw new Error(`Timed out waiting for URL: ${pattern}`);
    });
  }

  async addInitScript(source: string): Promise<void> {
    const installed =
      installedInitScripts.get(this.contents) ?? new Set<string>();
    if (installed.has(source)) return;
    const debuggerApi = this.contents.debugger;
    const attachedHere = !debuggerApi.isAttached();
    if (attachedHere) debuggerApi.attach("1.3");
    try {
      await debuggerApi.sendCommand("Page.enable");
      await debuggerApi.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
        source,
      });
      installed.add(source);
      installedInitScripts.set(this.contents, installed);
    } finally {
      if (attachedHere && debuggerApi.isAttached()) debuggerApi.detach();
    }
  }

  async elementCount(query: PublishPageElementQuery): Promise<number> {
    return (await this.elementSnapshot(query)).count;
  }

  async isElementVisible(query: PublishPageElementQuery): Promise<boolean> {
    return (await this.elementSnapshot(query)).visible;
  }

  async waitForElement(
    query: PublishPageElementQuery,
    state: PublishPageElementState = "visible",
    timeoutMs = 10_000,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.runStep("wait_page_control", "等待平台页面控件", async () => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        const snapshot = await this.elementSnapshot(query);
        const matched =
          state === "attached"
            ? snapshot.count > 0
            : state === "visible"
              ? snapshot.visible
              : snapshot.count === 0 || !snapshot.visible;
        if (matched) return;
        await delay(100);
      }
      throw new Error(
        `Timed out waiting for element to become ${state}: ${query.selector}`,
      );
    });
  }

  async clickElement(
    query: PublishPageElementQuery,
    options: { signal?: AbortSignal; origin?: string } = {},
  ): Promise<void> {
    await this.runStep("click_page_control", "点击平台页面控件", async () => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        options.signal?.throwIfAborted();
        if (options.origin && new URL(this.getUrl()).origin !== options.origin)
          throw new Error("The platform page changed before clicking");
        if ((await this.elementSnapshot(query, true)).visible) break;
        await delay(100);
      }
      options.signal?.throwIfAborted();
      // Observe readiness repeatedly, then invoke the click exactly once.
      const snapshot = (await this.contents.executeJavaScript(
        buildElementSnapshotExpression(query, true, options.origin ?? null),
        true,
      )) as PublishPageElementSnapshot;
      if (!snapshot.visible)
        throw new Error(
          `The platform control is not clickable: ${query.selector}`,
        );
    });
  }

  async withPublishViewport<T>(action: () => Promise<T>): Promise<T> {
    // Offscreen WebContentsViews start without a document. Chromium cannot
    // install an emulation viewport on that target until it has a renderer.
    if (!this.contents.getURL()) await this.contents.loadURL("about:blank");
    return this.withDebugger(async (debuggerApi) => {
      // Hidden WebContentsViews can otherwise have a zero-sized DOM viewport.
      await debuggerApi.sendCommand("Emulation.setDeviceMetricsOverride", {
        width: 1280,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      try {
        return await action();
      } finally {
        if (debuggerApi.isAttached())
          await debuggerApi
            .sendCommand("Emulation.clearDeviceMetricsOverride")
            .catch(() => {});
      }
    });
  }

  async chooseFiles(
    trigger: PublishPageElementQuery,
    files: string[],
    timeoutMs = 10_000,
    options: { signal?: AbortSignal; origin?: string } = {},
  ): Promise<void> {
    await this.runStep(
      "upload_media",
      `上传 ${files.length} 个本地素材`,
      async () => {
        if (files.length === 0) {
          throw new Error("chooseFiles requires at least one file");
        }
        const debuggerApi = this.contents.debugger;
        const attachedHere = !debuggerApi.isAttached();
        if (attachedHere) debuggerApi.attach("1.3");

        let chooserTimer: ReturnType<typeof setTimeout> | undefined;
        let rejectChooser: ((error: Error) => void) | undefined;
        let chooserListener:
          | ((
              event: unknown,
              method: string,
              params: { backendNodeId?: number; frameId?: string },
            ) => void)
          | undefined;
        const chooserPromise = new Promise<{
          backendNodeId: number;
          frameId?: string;
        }>((resolve, reject) => {
          rejectChooser = reject;
          chooserListener = (
            _event: unknown,
            method: string,
            params: { backendNodeId?: number; frameId?: string },
          ): void => {
            if (method !== "Page.fileChooserOpened") return;
            const backendNodeId = params.backendNodeId;
            if (!backendNodeId) {
              reject(new Error("File chooser did not expose its input node"));
              return;
            }
            resolve({ backendNodeId, frameId: params.frameId });
          };
          debuggerApi.on("message", chooserListener);
          chooserTimer = setTimeout(
            () => reject(new Error("Timed out waiting for file chooser")),
            timeoutMs,
          );
        });
        void chooserPromise.catch(() => undefined);

        try {
          await debuggerApi.sendCommand("Page.enable");
          await debuggerApi.sendCommand("Page.setInterceptFileChooserDialog", {
            enabled: true,
          });
          const { frameTree } = (await debuggerApi.sendCommand(
            "Page.getFrameTree",
          )) as { frameTree: { frame: { id: string } } };
          await this.clickElement(trigger, options);
          const { backendNodeId, frameId } = await chooserPromise;
          options.signal?.throwIfAborted();
          if (
            frameId !== frameTree.frame.id ||
            (options.origin && new URL(this.getUrl()).origin !== options.origin)
          )
            throw new Error(
              "The file chooser did not belong to the platform page",
            );
          await debuggerApi.sendCommand("DOM.setFileInputFiles", {
            files,
            backendNodeId,
          });
        } finally {
          if (chooserTimer) clearTimeout(chooserTimer);
          rejectChooser?.(new Error("File chooser interception ended"));
          if (chooserListener) debuggerApi.off("message", chooserListener);
          if (debuggerApi.isAttached()) {
            await debuggerApi
              .sendCommand("Page.setInterceptFileChooserDialog", {
                enabled: false,
              })
              .catch(() => undefined);
          }
          if (attachedHere && debuggerApi.isAttached()) debuggerApi.detach();
        }
      },
    );
  }

  async setFileInput(
    files: string[],
    selector = 'input[type="file"]',
    options: { signal?: AbortSignal; origin?: string } = {},
  ): Promise<void> {
    await this.runStep(
      "upload_media",
      `上传 ${files.length} 个本地素材`,
      async () => {
        options.signal?.throwIfAborted();
        if (files.length === 0) {
          throw new Error("setFileInput requires at least one file");
        }
        const debuggerApi = this.contents.debugger;
        const attachedHere = !debuggerApi.isAttached();
        if (attachedHere) debuggerApi.attach("1.3");
        try {
          const document = (await debuggerApi.sendCommand("DOM.getDocument", {
            depth: 0,
            pierce: true,
          })) as { root?: { nodeId?: number } };
          const rootNodeId = document.root?.nodeId;
          if (!rootNodeId) throw new Error("DOM root is unavailable");
          const { nodeIds } = (await debuggerApi.sendCommand(
            "DOM.querySelectorAll",
            { nodeId: rootNodeId, selector },
          )) as { nodeIds: number[] };
          if (nodeIds.length !== 1) {
            throw new Error(`Expected one file input: ${selector}`);
          }
          options.signal?.throwIfAborted();
          if (
            options.origin &&
            new URL(this.getUrl()).origin !== options.origin
          )
            throw new Error(
              "The platform page changed before setting the file",
            );
          await debuggerApi.sendCommand("DOM.setFileInputFiles", {
            files,
            nodeId: nodeIds[0],
          });
        } finally {
          if (attachedHere && debuggerApi.isAttached()) debuggerApi.detach();
        }
      },
    );
  }

  async replaceText(
    text: string,
    selector: string,
    {
      origin,
      signal,
      stillReady,
    }: { origin: string; signal: AbortSignal; stillReady?: string },
  ): Promise<void> {
    await this.runStep("input_text", `输入 ${text.length} 个字符`, async () => {
      signal.throwIfAborted();
      const contents = this.contents;
      const frame = this.messageOrigin && contents.focusedFrame;
      const sameMessageFrame = () =>
        !this.messageOrigin ||
        (this.messageOrigin === origin &&
          !!frame &&
          !frame.detached &&
          frame.origin === origin &&
          contents.focusedFrame === frame &&
          !!stillReady);
      if (!sameMessageFrame()) throw new Error("收件人的私信输入框已改变");
      const checkEditor = `(() => {
        if (location.origin !== ${JSON.stringify(origin)}) return false;
        const correctEditor = () => ${this.messageOrigin ? `(${stillReady}) === true` : "true"};
        if (!correctEditor()) return false;
        let doc = document, field = doc.activeElement;
        while (${Boolean(this.messageOrigin)} && field?.tagName === "IFRAME") {
          doc = field.contentDocument;
          if (!doc || doc.location.origin !== location.origin) return false;
          field = doc.activeElement;
        }
        if (!field?.matches(${JSON.stringify(selector)})) return false;
        if (field.tagName === "INPUT" || (${Boolean(this.messageOrigin)} && field.tagName === "TEXTAREA")) field.select();
        else doc.getSelection().selectAllChildren(field);
        if (!${Boolean(text)}) doc.execCommand('delete');
        return correctEditor();
      })()`;
      const ready = this.messageOrigin
        ? await contents.executeJavaScriptInIsolatedWorld(1001, [
            { code: checkEditor },
          ])
        : await contents.executeJavaScript(checkEditor);
      signal.throwIfAborted();
      if (
        !ready ||
        !sameMessageFrame() ||
        contents !== this.contents ||
        new URL(contents.getURL()).origin !== origin
      )
        throw new Error("The platform editor did not accept the input");
      if (text) await contents.insertText(text);
    });
  }

  async pressMessageEnter(
    origin: string,
    signal: AbortSignal,
    stillReady: string,
  ): Promise<boolean | "unobserved"> {
    signal.throwIfAborted();
    if (
      this.messageOrigin !== origin ||
      this.messagePopup?.isDestroyed() ||
      this.opener.isDestroyed()
    )
      return false;
    const contents = this.contents;
    const frame = contents.focusedFrame;
    if (!frame || frame.detached || frame.origin !== origin) return false;
    const token = JSON.stringify(crypto.randomUUID());
    const inspect = <T>(code: string): Promise<T> =>
      contents.executeJavaScriptInIsolatedWorld(1001, [{ code }]);
    const ready = await inspect<boolean>(`(() => {
        if (location.origin !== ${JSON.stringify(origin)}) return false;
        let field = document.activeElement;
        while (field?.tagName === "IFRAME") {
          const doc = field.contentDocument;
          if (!doc || doc.location.origin !== location.origin) return false;
          field = doc.activeElement;
        }
        if (!field?.matches('textarea:not(:disabled):not([readonly]),input[type=text]:not(:disabled):not([readonly]),[contenteditable=true],[contenteditable="plaintext-only"]') ||
          field.closest('[aria-disabled=true]') || (${stillReady}) !== true) return false;
        const doc = field.ownerDocument;
        globalThis.keAgentMessageEnter?.stop();
        const receipt = { token: ${token}, seen: false, stop: () => doc.removeEventListener('keydown', observe, true) };
        function observe(event) {
          if (event.isTrusted && event.key === 'Enter' &&
              event.target instanceof doc.defaultView.Node && field.contains(event.target))
            receipt.seen = true;
        }
        doc.addEventListener('keydown', observe, true);
        globalThis.keAgentMessageEnter = receipt;
        return true;
      })()`);
    if (!ready) return false;
    try {
      signal.throwIfAborted();
      if (
        contents.isDestroyed() ||
        this.messagePopup?.isDestroyed() ||
        contents !== this.contents ||
        frame.detached ||
        contents.focusedFrame !== frame ||
        frame.origin !== origin ||
        new URL(contents.getURL()).origin !== origin
      )
        return false;
      contents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
      contents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
      // Electron can return after queuing input. Only the bound composer can acknowledge delivery.
      for (let attempt = 0; attempt < 5; attempt++) {
        signal.throwIfAborted();
        if (contents.isDestroyed()) break;
        const seen = await inspect<boolean>(
          `globalThis.keAgentMessageEnter?.token === ${token} && globalThis.keAgentMessageEnter.seen`,
        ).catch(() => false);
        if (seen) return true;
        await delay(40);
      }
      return "unobserved";
    } finally {
      if (!contents.isDestroyed())
        await inspect(`(() => {
          if (globalThis.keAgentMessageEnter?.token !== ${token}) return;
          globalThis.keAgentMessageEnter.stop();
          delete globalThis.keAgentMessageEnter;
        })()`).catch(() => {});
    }
  }

  async capturePostResponse(
    endpoint: string,
    beforeSubmit: () => Promise<void>,
    click: () => Promise<void>,
    signal: AbortSignal,
    validatePost?: (body: string) => boolean,
  ): Promise<string> {
    return this.withDebugger(async (debuggerApi) => {
      await debuggerApi.sendCommand("Network.enable", {
        maxResourceBufferSize: 64 * 1024,
        maxTotalBufferSize: 1024 * 1024,
        maxPostDataSize: 0,
      });
      const wait = AbortSignal.any([signal, AbortSignal.timeout(180_000)]);
      let requestId: string | undefined;
      let armed = false;
      let success = false;
      let continuedPost = false;
      let stop = () => {};
      let rejectReceipt: (reason: Error) => void;
      let listener: (
        event: Electron.Event,
        method: string,
        params: {
          requestId?: string;
          request?: { method: string; url: string };
          response?: { status: number; url: string };
        },
      ) => void;
      const receipt = new Promise<string>((resolve, reject) => {
        rejectReceipt = reject;
        stop = () =>
          reject(wait.reason ?? new Error("The platform tab closed"));
        listener = (_event, method, params) => {
          if (!armed) return;
          if (method === "Network.requestWillBeSent" && !requestId) {
            const request = params.request;
            if (
              request?.method === "POST" &&
              request.url?.split("?")[0] === endpoint
            )
              requestId = params.requestId;
          }
          if (!requestId || params.requestId !== requestId) return;
          if (method === "Network.responseReceived" && params.response) {
            success =
              params.response.status >= 200 &&
              params.response.status < 300 &&
              params.response.url?.split("?")[0] === endpoint;
          }
          if (method === "Network.loadingFailed")
            reject(new Error("The platform response was lost"));
          if (method === "Network.loadingFinished") {
            if (!success) {
              reject(new Error("The platform receipt could not be confirmed"));
              return;
            }
            void debuggerApi
              .sendCommand("Network.getResponseBody", { requestId })
              .then(
                ({ body, base64Encoded }) =>
                  resolve(
                    base64Encoded
                      ? Buffer.from(body, "base64").toString("utf8")
                      : body,
                  ),
                reject,
              );
          }
        };
        debuggerApi.on("message", listener);
        debuggerApi.on("detach", stop);
        wait.addEventListener("abort", stop, { once: true });
      });
      void receipt.catch(() => {});
      const contents = this.contents;
      // This session belongs to the locked publishing account.
      const webRequest = contents.session.webRequest;
      try {
        if (validatePost)
          webRequest.onBeforeRequest(
            { urls: [endpoint + "*"] },
            (details, respond) => {
              if (
                details.method !== "POST" ||
                details.url.split("?")[0] !== endpoint ||
                details.webContentsId !== contents.id
              ) {
                respond({});
                return;
              }
              let allow = false;
              if (armed && !continuedPost && !wait.aborted) {
                try {
                  const chunks = details.uploadData ?? [];
                  if (chunks.length && chunks.every((chunk) => chunk.bytes))
                    allow = validatePost(
                      Buffer.concat(
                        chunks.map((chunk) => chunk.bytes!),
                      ).toString("utf8"),
                    );
                } catch {
                  // An unrecognized payload cannot be sent as a scheduled post.
                }
              }
              if (allow) continuedPost = true;
              respond({ cancel: !allow });
              if (!allow)
                rejectReceipt(
                  new Error(
                    "The platform request did not contain the verified schedule",
                  ),
                );
            },
          );
        await beforeSubmit();
        wait.throwIfAborted();
        armed = true;
        await click();
        const body = await receipt;
        if (validatePost && !continuedPost)
          throw new Error("The scheduled POST was not verified");
        return body;
      } finally {
        if (validatePost) webRequest.onBeforeRequest(null);
        debuggerApi.off("message", listener!);
        debuggerApi.off("detach", stop);
        wait.removeEventListener("abort", stop);
        if (!this.contents.isDestroyed() && debuggerApi.isAttached())
          await debuggerApi.sendCommand("Network.disable").catch(() => {});
      }
    });
  }

  async observeJsonResponses(
    matches: (url: URL) => boolean,
    consume: (url: URL, data: unknown) => void,
    readPage: () => Promise<void>,
  ): Promise<void> {
    const observed = this.contents;
    return this.withDebugger(async (debuggerApi) => {
      const requests = new Map<string, URL>();
      const reads = new Set<Promise<void>>();
      let failure: Error | undefined;
      const listener = (
        _event: unknown,
        method: string,
        params: {
          requestId: string;
          type?: string;
          response?: { url: string; status: number };
        },
      ) => {
        const { requestId, response } = params;
        if (method === "Network.responseReceived" && response) {
          if (params.type === "Preflight") return;
          const url = URL.canParse(response.url) ? new URL(response.url) : null;
          if (!url || !matches(url)) return;
          if (response.status !== 200) {
            failure = new Error(
              "平台未能返回作品评论，请检查账号登录和作品访问权限",
            );
          } else requests.set(requestId, url);
          return;
        }
        const url = requests.get(requestId);
        if (!url) return;
        if (method === "Network.loadingFailed") {
          requests.delete(requestId);
          failure = new Error("评论加载中断，请稍后重试");
        }
        if (method !== "Network.loadingFinished") return;
        requests.delete(requestId);
        const read = debuggerApi
          .sendCommand("Network.getResponseBody", { requestId })
          .then(({ body, base64Encoded }) => {
            const json = base64Encoded
              ? Buffer.from(body, "base64").toString("utf8")
              : body;
            consume(url, JSON.parse(json));
          })
          .catch((error: unknown) => {
            failure =
              error instanceof Error ? error : new Error("评论响应无法读取");
          });
        reads.add(read);
        void read.finally(() => reads.delete(read));
      };
      await debuggerApi.sendCommand("Network.enable", {
        maxResourceBufferSize: 2 * 1024 * 1024,
        maxTotalBufferSize: 8 * 1024 * 1024,
        maxPostDataSize: 0,
      });
      debuggerApi.on("message", listener);
      try {
        await readPage();
      } finally {
        debuggerApi.off("message", listener);
        await Promise.all(reads);
        if (!observed.isDestroyed() && debuggerApi.isAttached())
          await debuggerApi.sendCommand("Network.disable").catch(() => {});
      }
      if (failure) throw failure;
    });
  }

  private async withDebugger<T>(
    action: (debuggerApi: Electron.Debugger) => Promise<T>,
  ): Promise<T> {
    const contents = this.contents;
    const debuggerApi = contents.debugger;
    const attachedHere = !debuggerApi.isAttached();
    if (attachedHere) debuggerApi.attach("1.3");
    try {
      return await action(debuggerApi);
    } finally {
      if (attachedHere && !contents.isDestroyed() && debuggerApi.isAttached())
        debuggerApi.detach();
    }
  }

  async nativeType(text: string): Promise<void> {
    await this.runStep("input_text", `输入 ${text.length} 个字符`, () =>
      this.contents.insertText(text),
    );
  }

  async pressKey(key: string): Promise<void> {
    await this.runStep("press_key", "发送键盘按键", () => {
      const parts = key.split("+");
      const rawKeyCode = parts.pop() ?? key;
      const keyCode = rawKeyCode.startsWith("Key")
        ? rawKeyCode.slice(3)
        : rawKeyCode;
      const modifiers = parts.map((value) => {
        switch (value.toLowerCase()) {
          case "control":
            return "control" as const;
          case "alt":
            return "alt" as const;
          case "meta":
            return "meta" as const;
          case "shift":
            return "shift" as const;
          default:
            throw new Error(`Unsupported key modifier: ${value}`);
        }
      });
      this.contents.sendInputEvent({
        type: "keyDown",
        keyCode,
        modifiers,
      });
      this.contents.sendInputEvent({
        type: "keyUp",
        keyCode,
        modifiers,
      });
    });
  }

  async nativeClick(x: number, y: number): Promise<void> {
    await this.runStep("click_page_control", "点击平台页面控件", () =>
      this.sendNativeClick(x, y),
    );
  }

  private sendNativeClick(x: number, y: number): void {
    this.contents.sendInputEvent({ type: "mouseMove", x, y });
    this.contents.sendInputEvent({
      type: "mouseDown",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    this.contents.sendInputEvent({
      type: "mouseUp",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  }

  async captureObservation(): Promise<string> {
    const image = await this.contents.capturePage(undefined, {
      stayHidden: true,
      stayAwake: true,
    });
    if (image.isEmpty()) throw new Error("Observation screenshot unavailable");
    return image.toPNG().toString("base64");
  }

  async screenshot(options: OpenCliScreenshotOptions = {}): Promise<string> {
    const rectangle = options.fullPage
      ? await this.evaluate<{ height: number; width: number }>(`(() => ({
          width: Math.min(4096, Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0)),
          height: Math.min(4096, Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0))
        }))()`)
      : undefined;
    const data = (
      await this.contents.capturePage(
        rectangle && rectangle.width > 0 && rectangle.height > 0
          ? { x: 0, y: 0, width: rectangle.width, height: rectangle.height }
          : undefined,
      )
    ).toPNG();
    const base64 = data.toString("base64");
    if (options.path) {
      const outputPath = resolveOpenCliScreenshotPath(
        options.path,
        this.debugRoot,
      );
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, data);
    }
    return base64;
  }

  async screenshotDebug(prefix: string): Promise<string> {
    const safePrefix = prefix.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80);
    const outputPath = path.join(
      this.debugRoot ?? os.tmpdir(),
      `${safePrefix}-${Date.now()}.png`,
    );
    return this.screenshot({ fullPage: true, path: outputPath });
  }

  private async runStep<T>(
    step: string,
    message: string,
    action: () => T | Promise<T>,
  ): Promise<T> {
    return this.steps ? this.steps.run(step, message, action) : action();
  }

  private elementSnapshot(
    query: PublishPageElementQuery,
    scrollIntoView = false,
  ): Promise<PublishPageElementSnapshot> {
    return this.evaluate<PublishPageElementSnapshot>(
      buildElementSnapshotExpression(query, scrollIntoView),
    );
  }
}

export function buildElementSnapshotExpression(
  query: PublishPageElementQuery,
  scrollIntoView = false,
  clickOrigin?: string | null,
): string {
  const serialized = JSON.stringify(query).replaceAll("<", "\\u003c");
  const prepareForClick = scrollIntoView
    ? `element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });`
    : "";
  const viewportCheck = scrollIntoView
    ? ` && rect.bottom > 0 && rect.right > 0 &&
        rect.top < window.innerHeight && rect.left < window.innerWidth &&
        x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight &&
        !clickTarget.matches(':disabled, [aria-disabled="true"]') &&
        !(clickTarget instanceof HTMLLabelElement && clickTarget.control?.disabled) &&
        clickTarget.contains(document.elementFromPoint(x, y))`
    : "";
  const activate =
    clickOrigin === undefined
      ? ""
      : `
      if (visible && (!${JSON.stringify(clickOrigin)} || location.origin === ${JSON.stringify(clickOrigin)}) && clickTarget instanceof HTMLElement) {
        element.focus({ preventScroll: true });
        clickTarget.click();
      } else return { count: elements.length, visible: false };`;
  return `(() => {
    const query = ${serialized};
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const expected = normalize(query.text);
      const roots = query.within ? [...document.querySelectorAll(query.within)] : [document];
      const candidates = new Set(roots.flatMap(root => [...root.querySelectorAll(query.selector)]));
      const elements = [...candidates].filter((element) => {
        if (query.text === undefined) return true;
        const actual = normalize(element.textContent);
        return query.exactText ? actual === expected : actual.includes(expected);
      });
      const rendered = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' &&
          Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
      };
      const element = query.index === undefined
        ? elements.find(rendered)
        : elements[query.index];
      if (!element) return { count: elements.length, visible: false };
      const clickTarget = element.closest('label, button, a[href], [role="button"], [role="radio"], [role="checkbox"]') || element;
      ${prepareForClick}
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const visible = rendered(element)${viewportCheck};
      ${activate}
      return {
        count: elements.length,
        visible,
        x,
        y,
      };
  })()`;
}

export function buildEvaluateExpression(source: string): string {
  const code = source.trim();
  if (!code) return "undefined";
  if (/^\([\s\S]*\)\s*\(.*\)\s*$/.test(code)) return code;
  if (/^(async\s+)?(\([^)]*\)|[A-Za-z_]\w*)\s*=>/.test(code)) {
    return `(${code})()`;
  }
  if (/^(async\s+)?function[\s(]/.test(code)) return `(${code})()`;
  return code;
}

export function buildDomStableExpression(
  maxMs: number,
  quietMs: number,
): string {
  return `new Promise(resolve => {
    if (!document.body) {
      setTimeout(() => resolve('nobody'), ${maxMs});
      return;
    }
    let timer = null;
    let cap = null;
    const done = (reason) => {
      clearTimeout(timer);
      clearTimeout(cap);
      observer.disconnect();
      resolve(reason);
    };
    const resetQuiet = () => {
      clearTimeout(timer);
      timer = setTimeout(() => done('quiet'), ${quietMs});
    };
    const observer = new MutationObserver(resetQuiet);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
    });
    resetQuiet();
    cap = setTimeout(() => done('capped'), ${maxMs});
  })`;
}

export function resolveOpenCliScreenshotPath(
  filePath: string,
  debugRoot?: string,
): string {
  if (filePath.startsWith("/tmp/")) {
    return path.join(debugRoot ?? os.tmpdir(), path.basename(filePath));
  }
  return filePath;
}

export function urlMatchesPattern(url: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", "\\0")
    .replaceAll("*", "[^/]*")
    .replaceAll("\\0", ".*");
  return new RegExp(`^${escaped}$`).test(url);
}

export function isNavigationEvaluationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /execution context.*destroyed|cannot find context|frame was detached/i.test(
    message,
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
