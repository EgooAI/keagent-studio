import { CommentObservationService } from "../comment-observation/service";
import { CollectionRunService } from "../comment-observation/collection-runs";
import { DesktopOutreach } from "../social/outreach";
import { WorkMonitor } from "../social/monitor";
import {
  sendSocialMessage,
  verifyExistingSocialMessage,
} from "../social/message";
import { publicCommenterProfile } from "../comment-observation/comment-contact";
import { ipcMain, app, dialog, type BrowserWindow } from "electron";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  DirectPublisher,
  PublishingError,
  type PublishingIdentity,
} from "./core";
import { desktopErrorMessage } from "./errors";
import { DouyinBrowser } from "./browser";
import { PublishingFiles } from "./files";
import { PublishQueue, samePublisher } from "./queue";
import type {
  ArtifactExchange,
  LocalMediaAssetResolver,
  DouyinPublishInput,
  DouyinPublishRecord,
  DouyinDesktopState,
  DouyinBatchInput,
  MediaAsset,
} from "@keagent/shared-types";

export interface PublishingDependencies {
  identity(): Promise<PublishingIdentity>;
  request(route: string, input?: unknown): Promise<unknown>;
  exchange: ArtifactExchange;
  resolver?: LocalMediaAssetResolver;
  /** Main-only dependency injection for controlled Electron integration tests. */
  configureSession?: (session: Electron.Session) => Promise<void>;
}
export function registerPublishing(
  window: BrowserWindow,
  dependencies: PublishingDependencies,
  devOrigin = "http://127.0.0.1:5173",
) {
  let resolver = dependencies.resolver;
  let recovering = false;
  let lifetime = new AbortController();
  const files = new PublishingFiles(
    path.join(app.getPath("userData"), "douyin"),
    dependencies.identity,
    window,
  );
  const emit = () => {
    if (!window.isDestroyed()) window.webContents.send("douyin:changed");
  };
  const cloud = async <T>(
    operation: string,
    input: unknown = {},
  ): Promise<T> => {
    const value = (await dependencies.request(
      `/v1/douyin/${operation}`,
      input,
    )) as T;
    if (operation === "records/report") {
      const record = value as DouyinPublishRecord;
      if (!["running", "submitting"].includes(record.state))
        files.acknowledged(
          files.directoryFor({
            userId: record.ownerId,
            deviceId: record.deviceId,
          }),
          record.id,
        );
    }
    return value;
  };
  const browser = new DouyinBrowser(
    window,
    path.join(app.getPath("userData"), "douyin-profiles"),
    dependencies.identity,
    cloud,
    emit,
    dependencies.configureSession,
  );
  const observations = new CommentObservationService(
    browser,
    dependencies.identity,
    (identity) => files.directoryFor(identity),
    emit,
  );
  const collection = new CollectionRunService(
    observations,
    dependencies.identity,
    dependencies.request,
    (identity) => files.directoryFor(identity),
    emit,
  );
  const monitor = new WorkMonitor(
    browser,
    dependencies.identity,
    dependencies.request,
    (identity) => files.directoryFor(identity),
  );
  const publisher = new DirectPublisher({
    identity: dependencies.identity,
    exchange: dependencies.exchange,
    resolver: () => resolver,
    cloud,
    snapshot: (key, assets, port, cover, identity) =>
      files.snapshot(key, assets, port, cover, identity),
    publish: (account, input, media, signal, steps, before, progress) =>
      browser.publish(account, input, media, signal, steps, before, progress),
    journal: (record) =>
      files.journal(
        files.directoryFor({
          userId: record.ownerId,
          deviceId: record.deviceId,
        }),
        record,
      ),
    changed: emit,
    cleanup: (key, identity) => files.cleanup(key, identity),
  });
  const queue = new PublishQueue({
    identity: dependencies.identity,
    directory: (identity) => files.directoryFor(identity),
    record: async (id) => {
      const record = await cloud<DouyinPublishRecord>("records/get", { id });
      if (
        publisher.active?.id === record.id &&
        record.resultSource === "manual"
      )
        publisher.active = record;
      return record;
    },
    changed: emit,
    verifyMessage: async (
      identity,
      { accountId, workId, commentId, submittedAt },
      matchesText,
    ) => {
      const signal = AbortSignal.any([
        lifetime.signal,
        AbortSignal.timeout(45_000),
      ]);
      const contact = (await dependencies.request(
        "/v1/collection/comments/contact",
        {
          accountId,
          workId,
          id: commentId,
        },
      )) as { profileUrl?: unknown };
      const profileUrl = publicCommenterProfile(contact?.profileUrl, "douyin");
      return browser.observeSocial(
        identity,
        accountId,
        "douyin",
        signal,
        (page) =>
          page.withMessagePopups(profileUrl, () =>
            page.withPublishViewport(() =>
              verifyExistingSocialMessage(
                page,
                {
                  profileUrl,
                  submittedAt,
                  matchesText: (text) => matchesText(profileUrl, text),
                },
                signal,
              ),
            ),
          ),
      );
    },
    sendMessage: async (input, identity, beforeSubmit, steps) => {
      const signal = AbortSignal.any([
        lifetime.signal,
        AbortSignal.timeout(120000),
      ]);
      await browser.observeSocial(
        identity,
        input.accountId,
        input.platform,
        signal,
        (page, senderId) =>
          page.withMessagePopups(input.profileUrl, () =>
            page.withPublishViewport(() => {
              steps.complete();
              return sendSocialMessage(
                page,
                input,
                signal,
                async () => {
                  if (!input.source)
                    throw new PublishingError(
                      "COMMENT_PURPOSE_DENIED",
                      "无法确认评论来源授权",
                    );
                  const result = (await dependencies.request(
                    "/v1/collection/comments/contact",
                    {
                      accountId: input.accountId,
                      workId: input.source.workId,
                      id: input.source.commentId,
                    },
                  )) as { profileUrl?: string };
                  if (result?.profileUrl !== input.profileUrl)
                    throw new PublishingError(
                      "COMMENT_CHANGED",
                      "评论来源或收件人已变化，请重新审核",
                    );
                  await beforeSubmit();
                },
                senderId,
                steps,
              );
            }),
          ),
      );
    },
    execute: async (entry, _identity, assertCurrent, started) => {
      await publisher.idle();
      await assertCurrent();
      const account = await browser.check(entry.accountId);
      await assertCurrent();
      if (account.loginStatus === "verification_required")
        throw new PublishingError(
          "VERIFICATION_REQUIRED",
          "抖音需要完成安全验证",
        );
      if (account.loginStatus !== "logged_in")
        throw new PublishingError("LOGIN_REQUIRED", "批次账号需要重新登录");
      let input = entry.direct;
      if (!input) {
        const handoff = await dependencies.exchange.createHandoff({
          requestKey: entry.id,
          artifactId: entry.artifactId,
          expectedReviewRevision: entry.expectedReviewRevision,
        });
        input = {
          requestKey: entry.id,
          handoffId: handoff.id,
          accountId: entry.accountId,
          title: entry.title,
          description: entry.description,
          hashtags: [],
          batch: true,
        };
      }
      await assertCurrent();
      const record = await publisher.start(input, assertCurrent);
      try {
        started(record);
      } catch {
        throw new PublishingError(
          "QUEUE_WRITE",
          "发布记录已创建，但本机队列无法保存",
        );
      } finally {
        await publisher.idle();
      }
      return publisher.active?.id === record.id ? publisher.active : record;
    },
  });
  const outreach = new DesktopOutreach(
    dependencies.request,
    queue,
    dependencies.identity,
  );
  async function recover() {
    if (
      recovering ||
      (publisher.active &&
        ["running", "submitting"].includes(publisher.active.state))
    )
      return;
    recovering = true;
    try {
      const identity = await dependencies.identity();
      void queue.recoverMessageReceipt(identity).catch((error: unknown) => {
        console.warn(
          "private message receipt check deferred",
          error instanceof PublishingError ? error.code : "CHECK_UNAVAILABLE",
        );
      });
      const scope = files.directoryFor(identity);
      for (const saved of files.pending(scope)) {
        if (
          saved.ownerId !== identity.userId ||
          saved.deviceId !== identity.deviceId
        )
          continue;
        if (saved.state === "submitting") {
          saved.state = "unknown";
          saved.errorCode = "PUBLISH_OUTCOME_UNKNOWN";
        } else if (saved.state === "running") {
          saved.state = "failed";
          saved.errorCode = "INTERRUPTED";
        }
        files.journal(scope, saved);
        try {
          await cloud("records/report", saved);
          await files.cleanup(saved.requestKey);
        } catch (error) {
          if ((error as { code?: string }).code === "STATE_CONFLICT")
            files.acknowledged(scope, saved.id);
        }
      }
    } finally {
      recovering = false;
    }
  }
  const recoveryTimer = setInterval(() => {
    void recover().catch(() => {});
    void collection.recover().catch(() => {});
    void monitor.tick().catch(() => {});
  }, 30000);
  recoveryTimer.unref();
  async function state(): Promise<DouyinDesktopState> {
    const identity = await dependencies.identity();
    return {
      deviceId: identity.deviceId,
      resolverAvailable: !!resolver,
      tabs: browser.tabs(),
      activeAccountId: browser.active,
      queue: queue.view(identity),
      activeRecord:
        publisher.active?.ownerId === identity.userId &&
        publisher.active.deviceId === identity.deviceId
          ? publisher.active
          : undefined,
    };
  }
  const methods = new Set([
    "state",
    "collection.start",
    "collection.cancel",
    "collection.contact",
    "social.status",
    "social.start",
    "social.monitors",
    "social.workHistory",
    "social.remove",
    "social.scan",
    "social.reply",
    "outreach.submit",
    "outreach.refresh",
    "outreach.cancel",
    "outreach.confirm",
    "observation.start",
    "observation.list",
    "observation.cancel",
    "observation.screenshot",
    "account.add",
    "account.open",
    "account.check",
    "account.save",
    "account.unbind",
    "browser.action",
    "browser.viewport",
    "browser.hide",
    "cover.select",
    "preview",
    "publish.start",
    "publish.batch",
    "publish.queue",
  ]);
  ipcMain.handle(
    "douyin:request",
    async (event, method: unknown, input: unknown = {}) => {
      try {
        const url = new URL(event.senderFrame?.url || "about:blank");
        const trusted =
          app.isPackaged || process.argv.includes("--built")
            ? url.protocol === "keagent:" && url.hostname === "app"
            : url.origin === devOrigin;
        if (
          event.sender !== window.webContents ||
          event.senderFrame !== event.sender.mainFrame ||
          !trusted ||
          typeof method !== "string" ||
          !methods.has(method) ||
          !input ||
          typeof input !== "object" ||
          Array.isArray(input) ||
          JSON.stringify(input).length > 32768
        )
          throw new PublishingError("FORBIDDEN", "非法桌面发布请求", 403);
        const requestIdentity = await dependencies.identity();
        const value = input as Record<string, unknown>;
        let data: unknown;
        const accountId =
          typeof value.accountId === "string" ? value.accountId : "";
        if (method === "collection.start") {
          data = await collection.start(requestIdentity, value);
        } else if (method === "collection.cancel") {
          data = await collection.cancel(requestIdentity, value.id);
        } else if (method === "collection.contact") {
          const { workId, id } = value;
          if (
            typeof workId !== "string" ||
            !/^(?:[0-9]{5,30}|xhs-[0-9a-f]{24})$/.test(workId) ||
            typeof id !== "string" ||
            !/^[a-f0-9]{32}$/.test(id)
          )
            throw new PublishingError(
              "INVALID_INPUT",
              "评论或作品引用无效",
              422,
            );
          await browser.openCommenter(requestIdentity, accountId, async () => {
            const result = await dependencies.request(
              "/v1/collection/comments/contact",
              { workId, accountId, id },
            );
            return (result as { profileUrl?: unknown } | null)?.profileUrl;
          });
          data = await state();
        } else if (method === "social.status") {
          data = await monitor.status(requestIdentity);
        } else if (method === "social.start") {
          data = await monitor.start(
            requestIdentity,
            value as unknown as Parameters<typeof monitor.start>[1],
          );
        } else if (method === "social.monitors") {
          data = await monitor.list(requestIdentity);
        } else if (method === "social.workHistory") {
          data = monitor.history(requestIdentity);
        } else if (method === "social.remove") {
          data = await monitor.remove(requestIdentity, String(value.id));
        } else if (method === "social.scan") {
          data = await monitor.scan(requestIdentity, String(value.id));
        } else if (method === "social.reply") {
          data = await outreach.reply(
            requestIdentity,
            value as unknown as Parameters<typeof outreach.reply>[1],
          );
        } else if (method === "outreach.submit") {
          data = await outreach.submit(
            value as Parameters<typeof outreach.submit>[0],
          );
        } else if (method === "outreach.refresh") {
          data = await outreach.refresh(
            value as { outreachId: string; attempt: number },
          );
        } else if (method === "outreach.cancel") {
          data = await outreach.cancel(
            value as { outreachId: string; attempt: number },
          );
        } else if (method === "outreach.confirm") {
          data = await outreach.confirm(
            value as {
              outreachId: string;
              attempt: number;
              status: "sent" | "failed";
            },
          );
        } else if (method === "observation.start") {
          data = observations.start(
            requestIdentity,
            accountId,
            value.url,
            value.screenshotOnIssue === true,
          );
        } else if (method === "observation.list")
          data = observations.list(requestIdentity);
        else if (method === "observation.cancel") {
          observations.cancel(requestIdentity, String(value.id));
          data = null;
        } else if (method === "observation.screenshot")
          data = observations.screenshot(requestIdentity, String(value.id));
        else if (method === "state") {
          await recover();
          await queue.refreshVideoResults(requestIdentity);
          data = await state();
        } else if (method === "account.add") {
          const platform = value.platform ?? "douyin";
          if (platform !== "douyin" && platform !== "xhs")
            throw new PublishingError("INVALID_INPUT", "账号平台无效", 422);
          const id = randomBytes(16).toString("hex");
          await cloud("accounts/bind", {
            id,
            platform,
            name: platform === "xhs" ? "新的小红书账号" : "新的抖音账号",
            loginStatus: "logged_out",
          });
          await browser.open(id);
          data = { id };
        } else if (method === "account.open") {
          await browser.open(accountId);
          data = await state();
        } else if (method === "account.check" || method === "account.save")
          data = await browser.check(
            accountId,
            method === "account.save",
            true,
          );
        else if (method === "account.unbind") {
          await browser.unbind(accountId);
          data = null;
        } else if (method === "browser.action") {
          await browser.action(
            accountId,
            String(value.action),
            typeof value.recordId === "string" ? value.recordId : undefined,
          );
          data = await state();
        } else if (method === "browser.hide") {
          browser.hide();
          data = null;
        } else if (method === "browser.viewport") {
          browser.viewport(
            accountId,
            value.bounds as Electron.Rectangle,
            value.visible === true,
          );
          data = null;
        } else if (method === "cover.select") {
          browser.hide();
          data = await files.cover();
        } else if (method === "preview") {
          if (!resolver)
            throw new PublishingError(
              "RESOLVER_UNAVAILABLE",
              "制作侧本机文件解析器尚未接入",
            );
          if (typeof value.artifactId !== "string")
            throw new PublishingError("INVALID_INPUT", "成片引用无效", 422);
          const artifact = await dependencies.exchange.getArtifact(
            value.artifactId,
          );
          const identity = await dependencies.identity();
          const assets: MediaAsset[] = await Promise.all(
            Object.values(artifact.assets)
              .filter(Boolean)
              .map((id) => dependencies.exchange.getAsset(id)),
          );
          if (
            assets.some(
              (asset) =>
                asset.ownerId !== identity.userId ||
                asset.location.deviceId !== identity.deviceId ||
                asset.availability.state !== "available",
            )
          )
            throw new PublishingError(
              "ASSET_UNAVAILABLE",
              "成片不在当前设备或文件不可用",
            );
          data = await files.preview(assets, resolver);
        } else if (method === "publish.batch") {
          if (!resolver)
            throw new PublishingError(
              "DEVICE_BUSY",
              "请等待当前发布准备结束，并确认文件解析器可用",
            );
          data = queue.add(
            requestIdentity,
            value as unknown as DouyinBatchInput,
          );
        } else if (method === "publish.queue") {
          data = await queue.control(requestIdentity, value.action, value.id);
        } else if (method === "publish.start") {
          const input = value as unknown as DouyinPublishInput;
          const handoff = await dependencies.exchange.getHandoff(
            input.handoffId,
          );
          if (!samePublisher(requestIdentity, await dependencies.identity()))
            throw new PublishingError("SESSION_CHANGED", "登录已变更");
          data = await queue.direct(
            requestIdentity,
            input,
            handoff.artifact.id,
          );
        }
        const responseIdentity = await dependencies.identity();
        if (
          responseIdentity.generation !== requestIdentity.generation ||
          responseIdentity.userId !== requestIdentity.userId ||
          responseIdentity.deviceId !== requestIdentity.deviceId
        )
          throw new PublishingError(
            "SESSION_CHANGED",
            "登录已变更，请重新操作",
            403,
          );
        return { ok: true, data };
      } catch (error) {
        const e = error as { code?: string; status?: number };
        return {
          ok: false,
          error: {
            code: e.code || "DESKTOP_OPERATION_FAILED",
            status: e.status || 409,
            message: desktopErrorMessage(error),
          },
        };
      }
    },
  );
  window.on("close", (event) => {
    if (
      publisher.active &&
      ["running", "submitting"].includes(publisher.active.state)
    ) {
      browser.hide();
      const answer = dialog.showMessageBoxSync(window, {
        type: "question",
        buttons: ["继续发布", "退出应用"],
        defaultId: 0,
        cancelId: 0,
        message: "抖音发布仍在执行",
        detail: "退出会中断操作；已经提交的结果需要重新打开应用后核对。",
      });
      if (answer === 0) event.preventDefault();
      else stop();
    }
  });
  function stop() {
    lifetime.abort();
    lifetime = new AbortController();
    monitor.stop();
    collection.stop();
    observations.stop();
    queue.stop();
    publisher.stop();
    browser.shutdown();
  }
  window.on("closed", () => {
    clearInterval(recoveryTimer);
    stop();
    browser.dispose();
    ipcMain.removeHandler("douyin:request");
  });
  return {
    stop,
    async reconciled(record: DouyinPublishRecord, generation: number) {
      const identity = await dependencies.identity();
      if (
        identity.generation !== generation ||
        record.ownerId !== identity.userId ||
        record.deviceId !== identity.deviceId
      )
        return;
      queue.applyVideoResult(identity, record);
      if (publisher.active?.id === record.id) publisher.active = record;
    },
    async targetStopped(runId: string, expectedGeneration: number) {
      const identity = await dependencies.identity();
      if (identity.generation === expectedGeneration)
        await collection.targetStopped(identity, runId);
    },
    setResolver(value: LocalMediaAssetResolver) {
      resolver = value;
      emit();
    },
    async media(url: URL) {
      return files.media(url);
    },
    publisher,
  };
}
