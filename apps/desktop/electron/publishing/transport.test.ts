import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import type { HandlerDetails, WindowOpenHandlerResponse } from "electron";
import {
  withUploadContext,
  allowedUploadUrl,
  uploadFetch,
  type UploadContext,
} from "./runtime-context";
import { OpenCliPage } from "./runtime/browser/opencli-page";
import { browserFetch } from "./plugins/publish/opencli/douyin/_shared/browser-fetch";
import {
  tosUpload,
  PART_SIZE,
} from "./plugins/publish/opencli/douyin/_shared/tos-upload";
import {
  parseTextExtra,
  extractHashtagNames,
} from "./plugins/publish/opencli/douyin/_shared/text-extra";
import { validateDouyinInput, douyinCaption } from "@keagent/shared-types";
const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);
function context(transport: typeof fetch): UploadContext {
  return {
    fetch: transport,
    signal: new AbortController().signal,
    beforeSubmit: async () => {},
    progress: () => {},
    steps: { record: () => {}, run: async (_s, _m, f) => f() },
    accountId: "account-a",
    assetHash: "1".repeat(64),
  };
}

it("uses a same-session IM popup only for an explicit chat entry and returns to the opener on reload", async () => {
  const profile = "https://www.douyin.com/user/test";
  const inbox = "https://www.douyin.com/chat";
  let handle = (_details: HandlerDetails): WindowOpenHandlerResponse => ({
    action: "deny",
  });
  const ask = (url: string) =>
    handle({ url, referrer: { url: profile } } as HandlerDetails);
  const child = Object.assign(new EventEmitter(), {
    getURL: () => inbox,
    focusedFrame: { origin: new URL(inbox).origin, detached: false },
    isDestroyed: () => false,
    executeJavaScriptInIsolatedWorld: vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true),
    sendInputEvent: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  });
  const popup = {
    webContents: child,
    destroy: vi.fn(),
    isDestroyed: () => false,
  };
  const opener = Object.assign(new EventEmitter(), {
    getURL: () => profile,
    session: {},
    isDestroyed: () => false,
    setWindowOpenHandler: (next: typeof handle) => {
      handle = next;
    },
    executeJavaScriptInIsolatedWorld: vi.fn(async () => {
      for (const url of [
        inbox.replace("douyin.com", "douyin.com.example"),
        "https://www.xiaohongshu.com/chat",
        inbox.replace("https:", "http:"),
        inbox.replace("//", "//user@"),
        "blob:" + inbox,
      ]) {
        expect(ask(url).action).toBe("deny");
      }
      const result = ask(inbox);
      expect(result.action).toBe("allow");
      expect(result.overrideBrowserWindowOptions?.webPreferences?.session).toBe(
        opener.session,
      );
      expect(ask(inbox).action).toBe("deny");
      opener.emit("did-create-window", popup);
    }),
  });
  const navigate = vi.fn(async () => {});
  const page = new OpenCliPage(opener as never, navigate);
  await page.withMessagePopups(profile, async () => {
    expect(ask(inbox).action).toBe("deny");
    await page.inspectDocument("openChat()", true);
    expect(page.getUrl()).toBe(inbox);
    const signal = new AbortController().signal;
    expect(
      await page.pressMessageEnter(
        "https://www.xiaohongshu.com",
        signal,
        "true",
      ),
    ).toBe(false);
    expect(
      await page.pressMessageEnter(new URL(inbox).origin, signal, "false"),
    ).toBe(false);
    expect(child.sendInputEvent).not.toHaveBeenCalled();
    expect(
      await page.pressMessageEnter(new URL(inbox).origin, signal, "true"),
    ).toBe(true);
    expect(child.sendInputEvent.mock.calls).toEqual([
      [{ type: "keyDown", keyCode: "Enter" }],
      [{ type: "keyUp", keyCode: "Enter" }],
    ]);
    const preventDefault = vi.fn();
    child.emit("will-redirect", {
      url: "https://elsewhere.example",
      preventDefault,
    });
    expect(preventDefault).toHaveBeenCalledOnce();
    await page.goto(profile, { waitUntil: "none" });
    expect(navigate).toHaveBeenCalledWith(profile);
    expect(page.getUrl()).toBe(profile);
  });
  expect(popup.destroy).toHaveBeenCalledOnce();
  expect(ask(inbox).action).toBe("deny");
});

it("only inserts a private draft into the same verified recipient and focused frame", async () => {
  const origin = "https://www.douyin.com";
  const url = origin + "/user/test";
  const editor = { tagName: "TEXTAREA", matches: () => true, select: vi.fn() };
  const dom = {
    location: { origin },
    document: { activeElement: editor },
    rightPeer: false,
  };
  const frame = { origin, detached: false };
  const opener = Object.assign(new EventEmitter(), {
    getURL: () => url,
    isDestroyed: () => false,
    focusedFrame: frame,
    setWindowOpenHandler: vi.fn(),
    executeJavaScriptInIsolatedWorld: async (
      _world: number,
      scripts: { code: string }[],
    ) => runInNewContext(scripts[0].code, dom),
    insertText: vi.fn(),
  });
  const page = new OpenCliPage(opener as never, async () => {});
  const fill = () =>
    page.replaceText("fixture", "textarea", {
      origin,
      signal: new AbortController().signal,
      stillReady: "rightPeer",
    });
  await page.withMessagePopups(url, async () => {
    await expect(fill()).rejects.toThrow();
    expect(editor.select).not.toHaveBeenCalled();
    dom.rightPeer = true;
    editor.select.mockImplementationOnce(() => {
      opener.focusedFrame = { origin, detached: false };
    });
    await expect(fill()).rejects.toThrow();
    expect(opener.insertText).not.toHaveBeenCalled();
    await fill();
    expect(opener.insertText).toHaveBeenCalledExactlyOnceWith("fixture");
  });
});

describe("migrated video adapter", () => {
  it("waits for click readiness but never replays the click after navigation", async () => {
    const executeJavaScript = vi
      .fn()
      .mockResolvedValueOnce({ visible: false })
      .mockResolvedValueOnce({ visible: true, x: 100, y: 200 })
      .mockRejectedValue(new Error("Execution context was destroyed"));
    const page = new OpenCliPage(
      {
        executeJavaScript,
        getURL: () =>
          "https://creator.douyin.com/creator-micro/content/post/video",
      } as never,
      async () => {},
    );
    await expect(
      page.clickElement(
        { selector: "button", text: "发布", exactText: true },
        { origin: "https://creator.douyin.com" },
      ),
    ).rejects.toThrow("Execution context was destroyed");
    expect(executeJavaScript).toHaveBeenCalledTimes(3);
    expect(
      executeJavaScript.mock.calls.filter(([source]) =>
        source.includes("clickTarget.click()"),
      ),
    ).toHaveLength(1);
  });
  it("lets Chromium generate upload headers without changing the signature", async () => {
    const authorization = "AWS4-HMAC-SHA256 SignedHeaders=host;x-amz-date";
    const transport = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.has("host")).toBe(false);
      expect(headers.has("content-length")).toBe(false);
      expect(headers.get("authorization")).toBe(authorization);
      return new Response();
    });
    await withUploadContext(context(transport as typeof fetch), () =>
      uploadFetch("https://vod.bytedanceapi.com/", {
        method: "POST",
        headers: {
          Host: "vod.bytedanceapi.com",
          "Content-Length": "3",
          Authorization: authorization,
        },
        body: "abc",
      }),
    );
    expect(transport).toHaveBeenCalledOnce();
  });
  it("does not retry a final request when navigation destroys its execution context", async () => {
    const executeJavaScript = vi
      .fn()
      .mockRejectedValue(new Error("Execution context was destroyed"));
    const page = new OpenCliPage(
      { executeJavaScript } as never,
      async () => {},
    );
    await expect(
      browserFetch(
        page,
        "POST",
        "https://creator.douyin.com/web/api/media/aweme/create_v2/",
        { once: true, body: {} },
      ),
    ).rejects.toThrow();
    expect(executeJavaScript).toHaveBeenCalledTimes(1);
  });
  it("retains a single bounded retry for read-only page evaluation", async () => {
    const executeJavaScript = vi
      .fn()
      .mockRejectedValueOnce(new Error("Execution context was destroyed"))
      .mockResolvedValue({ status_code: 0 });
    const page = new OpenCliPage(
      { executeJavaScript } as never,
      async () => {},
    );
    await page.evaluate("1");
    expect(executeJavaScript).toHaveBeenCalledTimes(2);
  });
  it("uploads numbered parts, retries the same numbered transfer and keeps completion ordered", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "douyin-parts-"));
    roots.push(root);
    const file = path.join(root, "video.mp4");
    writeFileSync(file, Buffer.alloc(PART_SIZE + 3, 7));
    const calls: string[] = [];
    let failed = false;
    const transport = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method} ${url}`);
      if (url.includes("phase=init"))
        return new Response("<UploadId>controlled-id</UploadId>");
      if (url.includes("phase=transfer") && !failed) {
        failed = true;
        throw new Error("transient network");
      }
      return new Response(
        JSON.stringify({ code: 2000, data: { key: "uploaded-key" } }),
        { headers: { "x-tos-hash-crc64ecma": "123" } },
      );
    }) as unknown as typeof fetch;
    await withUploadContext(context(transport), () =>
      tosUpload({
        filePath: file,
        uploadInfo: {
          tos_upload_url: "https://tos-cn-i-test.volces.com/test-key",
          auth: "test-auth",
          upload_header: {},
          user_id: "test-user",
        },
        resumeDir: path.join(root, "resume"),
      }),
    );
    expect(calls[0]).toContain("phase=init");
    expect(calls.filter((call) => call.includes("phase=transfer")).length).toBe(
      3,
    );
    expect(calls.at(-1)).toContain("phase=finish");
  });
  it("aligns UTF-16 input limits and preserves hashtag offsets", () => {
    expect(
      validateDouyinInput({
        title: "😀".repeat(16),
        description: "",
        hashtags: [],
      }),
    ).toBeDefined();
    expect(douyinCaption("正文", ["#上海", "房产"])).toBe("正文 #上海 #房产");
    expect(extractHashtagNames("正文 #上海 #房产")).toEqual(["上海", "房产"]);
    expect(
      parseTextExtra("正文", [{ id: "", name: "上海", start: 3, end: 6 }])[0],
    ).toMatchObject({ start: 3, end: 6, hashtag_name: "上海" });
  });
  it("accepts platform HTTPS endpoints and rejects local or credential-bearing upload targets", () => {
    expect(allowedUploadUrl("https://vod.bytedanceapi.com/")).toBe(true);
    for (const url of [
      "http://vod.bytedanceapi.com",
      "https://127.0.0.1/upload",
      "https://evil.test/",
      "https://u:p@vod.bytedanceapi.com/",
      "file:///private",
    ])
      expect(allowedUploadUrl(url)).toBe(false);
  });
});
