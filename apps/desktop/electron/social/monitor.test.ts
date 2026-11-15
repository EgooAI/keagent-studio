import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WorkMonitor } from "./monitor";
import type { DouyinBrowser } from "../publishing/browser";
import type { OpenCliPage } from "../publishing/runtime/browser/opencli-page";

vi.mock("./comments", async (original) => ({
  ...(await original<typeof import("./comments")>()),
  collectWorkComments: async () => ({
    workId: "70123456789",
    items: [],
    coverage: "partial",
    observedAt: new Date().toISOString(),
  }),
}));
const identity = { userId: "owner", deviceId: "local", generation: 1 };
const accountId = "b".repeat(32);
const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of roots.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});
it("resumes a saved watch, verifies source authorization before each read and preserves a confirmed empty scan", async () => {
  vi.useFakeTimers();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keagent-monitor-"));
  roots.push(dir);
  const observe = vi.fn(async (_who, _id, _site, _signal, read) =>
    read({} as OpenCliPage),
  );
  const browser = {
    socialAccounts: async () => [
      {
        id: accountId,
        name: "示例",
        loginStatus: "logged_in",
        platform: "douyin",
      },
    ],
    observeSocial: observe,
  } as unknown as DouyinBrowser;
  let active = true;
  const request = vi.fn(async (route: string) => {
    if (route.endsWith("consent/get"))
      return { state: active ? "active" : "revoked" };
    if (route.endsWith("comments/import"))
      return {
        readCount: 0,
        addedCount: 0,
        updatedCount: 0,
        coverage: "partial",
      };
    return {};
  });
  const open = () =>
    new WorkMonitor(
      browser,
      async () => identity,
      request,
      () => dir,
    );
  const first = open();
  await first.start(identity, {
    url: "https://www.douyin.com/video/70123456789",
    accountId,
    requestKey: "request-00001",
    monitor: true,
    consent: { accepted: true },
  });
  const restored = open();
  expect(restored.list(identity)).toHaveLength(1);
  await restored.tick();
  expect(observe).toHaveBeenCalledTimes(1);
  vi.setSystemTime(Date.now() + 900001);
  await restored.tick();
  expect(observe).toHaveBeenCalledTimes(2);
  active = false;
  vi.setSystemTime(Date.now() + 900001);
  await expect(restored.tick()).rejects.toThrow("授权");
  expect(observe).toHaveBeenCalledTimes(2);
  const [row] = restored.list(identity);
  expect(row.error).toContain("授权");
  restored.remove(identity, row.id);
  expect(open().list(identity)).toEqual([]);
  expect(open().history(identity)[0].mode).toBe("stopped");
  vi.setSystemTime(Date.now() + 900001);
  await open().tick();
  expect(observe).toHaveBeenCalledTimes(2);
  active = true;
  await restored.start(identity, {
    url: "https://www.douyin.com/video/70123456789",
    accountId,
    requestKey: "request-once",
    consent: { accepted: true },
  });
  expect(open().list(identity)).toEqual([]);
  expect(open().history(identity)[0].mode).toBe("once");
});
