import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WebContents } from "electron";
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
  constructor(
    private readonly contents: WebContents,
    private readonly navigate: (url: string) => Promise<void>,
    private readonly debugRoot?: string,
    private readonly steps?: ExecutionStepReporter,
  ) {}

  async goto(url: string, options: OpenCliGotoOptions = {}): Promise<void> {
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
  ): Promise<void> {
    await this.runStep("wait_page_control", "等待平台页面控件", async () => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
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
    options: { force?: boolean } = {},
  ): Promise<void> {
    await this.runStep("click_page_control", "点击平台页面控件", async () => {
      // Playwright scrolls locator targets before a mouse click. Electron's raw
      // input events do not, so long publish forms otherwise receive a click at
      // coordinates outside the WebContentsView.
      const snapshot = await this.elementSnapshot(query, true);
      if (
        (!snapshot.visible && !options.force) ||
        snapshot.x === undefined ||
        snapshot.y === undefined
      ) {
        throw new Error(`Element is not visible: ${query.selector}`);
      }
      this.sendNativeClick(snapshot.x, snapshot.y);
    });
  }

  async chooseFiles(
    trigger: PublishPageElementQuery,
    files: string[],
    timeoutMs = 10_000,
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
              params: { backendNodeId?: number },
            ) => void)
          | undefined;
        const chooserPromise = new Promise<number>((resolve, reject) => {
          rejectChooser = reject;
          chooserListener = (
            _event: unknown,
            method: string,
            params: { backendNodeId?: number },
          ): void => {
            if (method !== "Page.fileChooserOpened") return;
            const backendNodeId = params.backendNodeId;
            if (!backendNodeId) {
              reject(new Error("File chooser did not expose its input node"));
              return;
            }
            resolve(backendNodeId);
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
          await this.clickElement(trigger);
          const backendNodeId = await chooserPromise;
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

  async setFileInput(files: string[], selector?: string): Promise<void> {
    await this.runStep(
      "upload_media",
      `上传 ${files.length} 个本地素材`,
      async () => {
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
          const query = (await debuggerApi.sendCommand("DOM.querySelector", {
            nodeId: rootNodeId,
            selector: selector ?? 'input[type="file"]',
          })) as { nodeId?: number };
          if (!query.nodeId) {
            throw new Error(
              `File input not found: ${selector ?? 'input[type="file"]'}`,
            );
          }
          await debuggerApi.sendCommand("DOM.setFileInputFiles", {
            files,
            nodeId: query.nodeId,
          });
        } finally {
          if (attachedHere && debuggerApi.isAttached()) debuggerApi.detach();
        }
      },
    );
  }

  async insertText(text: string): Promise<void> {
    await this.runStep("input_text", `输入 ${text.length} 个字符`, () =>
      this.contents.insertText(text),
    );
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
): string {
  const serialized = JSON.stringify(query).replaceAll("<", "\\u003c");
  const prepareForClick = scrollIntoView
    ? `element.scrollIntoView({ block: 'center', inline: 'center' });`
    : "";
  const viewportCheck = scrollIntoView
    ? ` && rect.bottom > 0 && rect.right > 0 &&
        rect.top < window.innerHeight && rect.left < window.innerWidth &&
        x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight`
    : "";
  return `(() => {
    const query = ${serialized};
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    let root = document;
    try {
      if (query.within) {
        root = document.querySelector(query.within);
        if (!root) return { count: 0, visible: false };
      }
      const expected = normalize(query.text);
      const elements = Array.from(root.querySelectorAll(query.selector)).filter((element) => {
        if (query.text === undefined) return true;
        const actual = normalize(element.textContent);
        return query.exactText ? actual === expected : actual.includes(expected);
      });
      const element = elements[query.index || 0];
      if (!element) return { count: elements.length, visible: false };
      ${prepareForClick}
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const visible = style.display !== 'none' && style.visibility !== 'hidden' &&
        Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0${viewportCheck};
      return {
        count: elements.length,
        visible,
        x,
        y,
      };
    } catch {
      return { count: 0, visible: false };
    }
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

function isNavigationEvaluationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /execution context.*destroyed|cannot find context|frame was detached/i.test(
    message,
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
