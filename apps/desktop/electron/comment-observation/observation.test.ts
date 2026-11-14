import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { BrowserExecutionCoordinator } from "../publishing/browser-execution-coordinator";
import { ObservationRecorder } from "./observation-recorder";
import { standardTarget } from "./target-validator";
import type { CommentObservation } from "@keagent/shared-types";

vi.mock("electron", () => ({ nativeImage: {}, dialog: {} }));
describe("standard work URLs", () => {
  it("preserves the full decimal ID and normalizes the trailing slash", () => {
    expect(
      standardTarget(" https://www.douyin.com/video/7612345678901234567/ "),
    ).toEqual({
      targetUrl: "https://www.douyin.com/video/7612345678901234567",
      inputWorkId: "7612345678901234567",
    });
  });
  it.each(["?from=share", "/?token=test#detail", "#detail", "?modal_id=12345"])(
    "drops the suffix %s before navigation or recording",
    (suffix) => {
      const canonical = "https://www.douyin.com/video/12345";
      expect(standardTarget(canonical + suffix)).toEqual({
        inputWorkId: "12345",
        targetUrl: canonical,
      });
    },
  );
  it.each([
    "https://www.douyin.com/user/author?vid=12345",
    "https://www.douyin.com/user/author?modal_id=12345&modal_id=54321",
    "https://www.douyin.com/user/author?modal_id=abc",
    "https://www.douyin.com/recommend?modal_id=12345",
    "https://v.douyin.com/abc",
    "https://www.douyin.com.evil/video/12345",
    "http://www.douyin.com/video/12345",
    "https://user@www.douyin.com/video/12345",
    "https://www.douyin.com/video/12345?modal_id=67890",
    "https://www.douyin.com/video/12345?from=share 复制此链接",
    "https://www.douyin.com/video/12a45",
    null,
  ])("rejects %s", (value) => {
    expect(() => standardTarget(value)).toThrow();
  });
  it("uses the opened author-profile modal even when vid differs", () => {
    expect(
      standardTarget(
        "https://www.douyin.com/user/example?from_tab_name=main&modal_id=7707599736451158395&vid=7707770934187031016",
      ),
    ).toEqual({
      inputWorkId: "7707599736451158395",
      targetUrl: "https://www.douyin.com/video/7707599736451158395",
    });
  });
});

describe("account browser execution", () => {
  it("reserves manual use and runs observation, login check and publish in FIFO order", async () => {
    const c = new BrowserExecutionCoordinator();
    c.setManual("a");
    const log: string[] = [];
    let release!: () => void;
    const observe = c.run("a", false, async () => {
      log.push("observe");
      await new Promise<void>((r) => (release = r));
    });
    const check = c.run("a", false, async () => {
      log.push("check");
    });
    const publish = c.run("a", false, async () => {
      log.push("publish");
    });
    await c.run("b", false, async () => {
      log.push("other");
    });
    expect(log).toEqual(["other"]);
    c.setManual(undefined);
    await Promise.resolve();
    await expect(c.run("a", true, async () => {})).rejects.toMatchObject({
      code: "ACCOUNT_BUSY",
    });
    expect(log).toEqual(["other", "observe"]);
    release();
    await Promise.all([observe, check, publish]);
    expect(log).toEqual(["other", "observe", "check", "publish"]);
    expect(c.occupied("a")).toBe(false);
  });
  it("removes canceled and timed-out waiters and releases ownership on errors", async () => {
    const c = new BrowserExecutionCoordinator();
    c.setManual("a");
    const work = vi.fn(async () => {});
    const abort = new AbortController();
    const queued = c.run("a", false, work, abort.signal);
    abort.abort();
    await expect(queued).rejects.toThrow();
    await expect(c.run("a", false, work, undefined, 5)).rejects.toMatchObject({
      code: "BROWSER_TIMEOUT",
    });
    const stopped = c.run("a", false, work);
    c.reset();
    await expect(stopped).rejects.toMatchObject({ code: "INTERRUPTED" });
    expect(work).not.toHaveBeenCalled();
    await expect(
      c.run("a", false, async () => {
        throw new Error("read failed");
      }),
    ).rejects.toThrow("read failed");
    await c.run("a", false, work);
    expect(work).toHaveBeenCalledTimes(1);
  });
});

it("recovers orphaned queued and running journals once without reopening a work", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "keagent-observation-"));
  try {
    const recorder = new ObservationRecorder(root);
    const record: CommentObservation = {
      id: "a".repeat(32),
      state: "queued",
      accountId: "test",
      deviceId: "device",
      ...standardTarget("https://www.douyin.com/video/12345"),
      panelStatus: "not_checked",
      startedAt: new Date().toISOString(),
    };
    recorder.save(record);
    recorder.save({ ...record, id: "b".repeat(32), state: "running" });
    expect(
      recorder.list(new Set([record.id, "b".repeat(32)])).map((r) => r.state),
    ).toEqual(["queued", "running"]);
    const recovered = new ObservationRecorder(root).list(new Set());
    for (const r of recovered)
      expect(r).toMatchObject({
        state: "stopped",
        errorCode: "INTERRUPTED",
        endedAt: expect.any(String),
        panelStatus: "not_checked",
      });
    expect(recorder.list(new Set())).toEqual(recovered);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
