import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  withUploadContext,
  allowedUploadUrl,
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
describe("migrated video adapter", () => {
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
