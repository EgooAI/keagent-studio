import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CommentObservation } from "@keagent/shared-types";
import type { DouyinBrowser } from "../publishing/browser";
import { PublishingError, type PublishingIdentity } from "../publishing/core";
import { samePublisher } from "../publishing/queue";
import { standardTarget } from "./target-validator";
import { observePage, readWork } from "./page-observer";
import { ObservationRecorder } from "./observation-recorder";

export class CommentObservationService {
  private active = new Map<
    string,
    { controller: AbortController; identity: PublishingIdentity }
  >();
  // Retain terminal records if storage fails after IPC has acknowledged the task.
  private unsaved = new Map<
    string,
    { directory: string; record: CommentObservation }
  >();
  constructor(
    private browser: DouyinBrowser,
    private identity: () => Promise<PublishingIdentity>,
    private directory: (identity: PublishingIdentity) => string,
    private changed: () => void,
  ) {}

  get busy() {
    return this.active.size > 0 || this.unsaved.size > 0;
  }

  private recorder(identity: PublishingIdentity) {
    const recorder = new ObservationRecorder(
      path.join(this.directory(identity), "comment-observation"),
    );
    for (const [id, pending] of this.unsaved) {
      if (pending.directory !== recorder.directory) continue;
      try {
        recorder.save(pending.record);
        this.unsaved.delete(id);
      } catch {
        throw new PublishingError(
          "RECORD_WRITE_FAILED",
          "观察已结束，但本机记录保存失败。请检查磁盘空间后刷新。",
        );
      }
    }
    return recorder;
  }

  list(identity: PublishingIdentity) {
    return this.recorder(identity).list(new Set(this.active.keys()));
  }

  get(identity: PublishingIdentity, id: string) {
    return this.recorder(identity).get(id, this.active.has(id));
  }

  start(
    identity: PublishingIdentity,
    accountId: string,
    url: unknown,
    screenshotOnIssue: boolean,
    id = randomBytes(16).toString("hex"),
    onFinished?: () => void,
    beforeNavigate?: () => Promise<void>,
  ) {
    if (!/^[a-f0-9]{32}$/.test(accountId))
      throw new PublishingError("INVALID_INPUT", "请选择本机抖音账号");
    const recorder = this.recorder(identity);
    const record: CommentObservation = {
      id,
      accountId,
      deviceId: identity.deviceId,
      targetUrl: "",
      inputWorkId: "",
      state: "queued",
      panelStatus: "not_checked",
      startedAt: new Date().toISOString(),
    };
    try {
      Object.assign(record, standardTarget(url));
    } catch (error) {
      if (!(error instanceof PublishingError)) throw error;
      Object.assign(record, {
        state: "stopped",
        endedAt: record.startedAt,
        errorCode: error.code,
        reason: error.message,
      });
      recorder.save(record);
      this.changed();
      onFinished?.();
      return record;
    }
    recorder.save(record);
    const controller = new AbortController();
    this.active.set(record.id, { controller, identity });
    const timeout = setTimeout(
      () =>
        controller.abort(
          new PublishingError(
            "OBSERVATION_TIMEOUT",
            "观察超过时限，已关闭观察页面",
          ),
        ),
      60_000,
    );
    const signal = controller.signal;
    const execute = async () => {
      const assertCurrent = async () => {
        if (!samePublisher(identity, await this.identity()))
          throw new PublishingError(
            "SESSION_CHANGED",
            "应用登录已变更，观察已停止",
          );
        signal.throwIfAborted();
      };
      try {
        await this.browser.observe(
          accountId,
          signal,
          async (page, hasViewerSession) => {
            if (beforeNavigate) await beforeNavigate();
            await assertCurrent();
            record.state = "running";
            recorder.save(record);
            this.changed();
            await page.goto(record.targetUrl, { waitUntil: "none" });
            await page.withPublishViewport(async () => {
              let result = await observePage(
                page,
                record.inputWorkId,
                signal,
                hasViewerSession,
              );
              await assertCurrent();
              if (
                screenshotOnIssue &&
                result.verifiedWorkId &&
                ["not_visible", "load_failed", "loading", "unknown"].includes(
                  result.panelStatus,
                )
              ) {
                const png = await page.captureObservation();
                const after = await readWork(
                  page,
                  record.inputWorkId,
                  hasViewerSession,
                );
                await assertCurrent();
                if (
                  after.verifiedWorkId === result.verifiedWorkId &&
                  after.panelStatus === result.panelStatus &&
                  after.author?.url === result.author?.url
                ) {
                  fs.writeFileSync(
                    path.join(recorder.directory, record.id + ".png"),
                    Buffer.from(png, "base64"),
                    { mode: 0o600 },
                  );
                  record.screenshotSaved = true;
                } else {
                  result = after;
                }
              }
              Object.assign(record, result);
            });
          },
        );
        signal.throwIfAborted();
        record.state = record.errorCode ? "stopped" : "finished";
      } catch (cause) {
        const error = signal.aborted ? signal.reason : cause;
        record.state = "stopped";
        record.errorCode =
          error instanceof PublishingError ? error.code : "OBSERVATION_FAILED";
        record.reason =
          error instanceof PublishingError
            ? error.message
            : "未能完成页面观察，请检查网络和账号浏览器后重试";
        if (
          [
            "LOGIN_REQUIRED",
            "VERIFICATION_REQUIRED",
            "ACCESS_RESTRICTED",
          ].includes(record.errorCode)
        )
          record.panelStatus = "restricted";
      } finally {
        clearTimeout(timeout);
        record.endedAt = new Date().toISOString();
        this.active.delete(record.id);
        try {
          recorder.save(record);
        } catch {
          this.unsaved.set(record.id, {
            directory: recorder.directory,
            record,
          });
        }
        this.changed();
        onFinished?.();
      }
    };
    // Initial journal is durable before IPC acknowledges the queued observation.
    void execute();
    return { ...record };
  }

  cancel(identity: PublishingIdentity, id: string) {
    const task = this.active.get(id);
    if (task && samePublisher(identity, task.identity))
      task.controller.abort(new PublishingError("CANCELED", "用户已取消观察"));
  }

  screenshot(identity: PublishingIdentity, id: string) {
    if (
      !/^[a-f0-9]{32}$/.test(id) ||
      !this.list(identity).some(
        (record) => record.id === id && record.screenshotSaved,
      )
    )
      throw new PublishingError(
        "SCREENSHOT_UNAVAILABLE",
        "该记录没有已保存的截图",
      );
    return (
      "data:image/png;base64," +
      fs
        .readFileSync(path.join(this.recorder(identity).directory, id + ".png"))
        .toString("base64")
    );
  }

  stop() {
    for (const { controller } of this.active.values())
      controller.abort(
        new PublishingError("INTERRUPTED", "应用退出或登录状态已变更"),
      );
  }
}
