import type {
  ArtifactExchange,
  ArtifactHandoff,
  LocalMediaAssetResolver,
  MediaAsset,
} from "@keagent/shared-types";
import {
  validateDouyinInput,
  type DouyinPublishInput,
  type DouyinPublishRecord,
  type DouyinAccount,
  type DouyinPublishLog,
} from "@keagent/shared-types";
import type { ExecutionStepReporter } from "./runtime/task-executor/execution-log";

export class PublishingError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}
/** Only an explicit platform rejection can make a submitted attempt safely retryable. */
export class ConfirmedPublishRejection extends PublishingError {}
export interface PublishingIdentity {
  userId: string;
  deviceId: string;
  generation: number;
}
export interface PublishFiles {
  video: string;
  cover: string;
}
export interface PublishPorts {
  identity(): Promise<PublishingIdentity>;
  exchange: ArtifactExchange;
  resolver(): LocalMediaAssetResolver | undefined;
  cloud<T>(operation: string, input?: unknown): Promise<T>;
  snapshot(
    id: string,
    assets: MediaAsset[],
    resolver: LocalMediaAssetResolver,
    coverRef?: string,
    identity?: PublishingIdentity,
  ): Promise<PublishFiles>;
  publish(
    accountId: string,
    input: DouyinPublishInput,
    files: PublishFiles,
    signal: AbortSignal,
    steps: ExecutionStepReporter,
    beforeSubmit: () => Promise<void>,
    progress: (value: number) => void,
  ): Promise<{ externalId: string; url: string }>;
  journal(record: DouyinPublishRecord): void;
  changed(record?: DouyinPublishRecord): void;
  cleanup(requestKey: string, identity?: PublishingIdentity): Promise<void>;
}
export async function validateHandoff(
  exchange: ArtifactExchange,
  handoff: ArtifactHandoff,
  identity: PublishingIdentity,
): Promise<MediaAsset[]> {
  if (
    handoff.ownerId !== identity.userId ||
    handoff.deviceId !== identity.deviceId
  )
    throw new PublishingError("WRONG_DEVICE", "请在持有成片的原设备发布");
  const current = await exchange.getArtifact(handoff.artifact.id);
  if (current.id !== handoff.artifact.id || current.ownerId !== identity.userId)
    throw new PublishingError("NOT_FOUND", "成片归属与交接不一致", 404);
  if (current.review.state !== "approved")
    throw new PublishingError("NOT_APPROVED", "成片尚未通过验收或验收已撤回");
  if (current.review.revision !== handoff.artifact.review.revision)
    throw new PublishingError(
      "REVISION_CONFLICT",
      "验收已变更，请重新接收成片",
    );
  if (
    Object.entries(current.assets).some(
      ([kind, id]) =>
        handoff.artifact.assets[kind as keyof typeof current.assets] !== id,
    )
  )
    throw new PublishingError("REVISION_CONFLICT", "成片资产与交接不一致");
  const assets = await Promise.all(
    handoff.assets.map((asset) => exchange.getAsset(asset.id)),
  );
  for (const asset of assets) {
    if (
      asset.ownerId !== identity.userId ||
      asset.location.deviceId !== identity.deviceId
    )
      throw new PublishingError("WRONG_DEVICE", "资产不属于当前用户或设备");
    if (asset.availability.state !== "available")
      throw new PublishingError(
        "ASSET_UNAVAILABLE",
        "成片文件不可用，请先恢复并验证文件",
      );
    const frozen = handoff.assets.find((value) => value.id === asset.id)!;
    if (
      asset.sha256 !== frozen.sha256 ||
      asset.byteSize !== frozen.byteSize ||
      asset.location.fileToken !== frozen.location.fileToken
    )
      throw new PublishingError("ASSET_CHANGED", "资产内容与交接不一致");
  }
  if (
    !assets.some(
      (asset) =>
        asset.id === current.assets.video &&
        asset.kind === "video" &&
        asset.mimeType === "video/mp4",
    ) ||
    !assets.some(
      (asset) => asset.id === current.assets.cover && asset.kind === "cover",
    )
  )
    throw new PublishingError("INVALID_INPUT", "交接缺少视频或封面", 422);
  return assets;
}

/** One direct Main-process execution, independent of renderer navigation and cloud scheduling. */
export class DirectPublisher {
  active?: DouyinPublishRecord;
  private controller?: AbortController;
  private pending?: Promise<DouyinPublishRecord>;
  private jobs = new Set<Promise<void>>();
  constructor(private readonly ports: PublishPorts) {}
  start(input: DouyinPublishInput): Promise<DouyinPublishRecord> {
    if (this.active && ["running", "submitting"].includes(this.active.state)) {
      if (this.active.requestKey === input.requestKey)
        return Promise.resolve(this.active);
      return Promise.reject(
        new PublishingError("DEVICE_BUSY", "当前设备已有发布正在执行"),
      );
    }
    if (this.pending) return this.pending.then(() => this.start(input));
    this.pending = this.prepare(input).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private async prepare(
    input: DouyinPublishInput,
  ): Promise<DouyinPublishRecord> {
    const invalid = validateDouyinInput(input);
    if (invalid) throw new PublishingError("INVALID_INPUT", invalid, 422);
    if (!/^[A-Za-z0-9_-]{16,100}$/.test(input.requestKey))
      throw new PublishingError("INVALID_INPUT", "发布请求键无效", 422);
    const resolver = this.ports.resolver();
    if (!resolver)
      throw new PublishingError(
        "RESOLVER_UNAVAILABLE",
        "制作侧本机文件解析器尚未接入，暂不能真实发布",
      );
    const identity = await this.ports.identity();
    const handoff = await this.ports.exchange.getHandoff(input.handoffId);
    if (handoff.id !== input.handoffId)
      throw new PublishingError("NOT_FOUND", "交接引用不一致", 404);
    const accounts = await this.ports.cloud<{ items: DouyinAccount[] }>(
      "accounts/list",
    );
    if (
      !accounts.items.some(
        (account) =>
          account.id === input.accountId &&
          account.deviceId === identity.deviceId &&
          !account.unboundAt,
      )
    )
      throw new PublishingError(
        "ACCOUNT_UNAVAILABLE",
        "请选择当前设备的有效抖音账号",
      );
    const assets = await validateHandoff(
      this.ports.exchange,
      handoff,
      identity,
    );
    let files: PublishFiles;
    let created: { record: DouyinPublishRecord; created: boolean };
    try {
      await this.assertIdentity(identity);
      files = await this.ports.snapshot(
        input.requestKey,
        assets,
        resolver,
        input.coverRef,
        identity,
      );
      await this.assertIdentity(identity);
      created = await this.ports.cloud("records/create", input);
    } catch (error) {
      await this.ports.cleanup(input.requestKey, identity).catch(() => {});
      throw error;
    }
    if (!created.created) {
      await this.ports.cleanup(input.requestKey, identity);
      return created.record;
    }
    this.active = created.record;
    this.controller = new AbortController();
    this.save();
    const job = this.execute(
      input,
      files,
      identity,
      handoff,
      this.controller.signal,
    );
    this.jobs.add(job);
    void job.then(
      () => this.jobs.delete(job),
      () => this.jobs.delete(job),
    );
    return { ...created.record };
  }
  private async assertIdentity(expected: PublishingIdentity): Promise<void> {
    const current = await this.ports.identity();
    if (
      current.userId !== expected.userId ||
      current.deviceId !== expected.deviceId ||
      current.generation !== expected.generation
    )
      throw new PublishingError(
        "SESSION_CHANGED",
        "登录状态已变更，请重新操作",
        403,
      );
  }
  private save(): void {
    if (!this.active) return;
    this.active.updatedAt = new Date().toISOString();
    this.ports.journal(this.active);
    this.ports.changed(this.active);
  }
  private async execute(
    input: DouyinPublishInput,
    files: PublishFiles,
    identity: PublishingIdentity,
    handoff: ArtifactHandoff,
    signal: AbortSignal,
  ): Promise<void> {
    const record = this.active!;
    const add = (entry: DouyinPublishLog) => {
      record.logs = [...record.logs.slice(-127), entry];
      this.save();
    };
    const steps: ExecutionStepReporter = {
      record: (status, step, _message, options = {}) =>
        add({
          status,
          step,
          timestamp: new Date().toISOString(),
          ...(options.durationMs === undefined
            ? {}
            : { durationMs: options.durationMs }),
          ...(status === "failed" ? { errorCode: "EXECUTION_FAILED" } : {}),
        }),
      run: async <T>(
        step: string,
        _message: string,
        action: () => T | Promise<T>,
      ): Promise<T> => {
        const started = Date.now();
        add({ step, status: "started", timestamp: new Date().toISOString() });
        try {
          const result = await action();
          add({
            step,
            status: "completed",
            timestamp: new Date().toISOString(),
            durationMs: Date.now() - started,
          });
          return result;
        } catch (error) {
          add({
            step,
            status: "failed",
            timestamp: new Date().toISOString(),
            errorCode:
              error instanceof PublishingError
                ? error.code
                : "EXECUTION_FAILED",
          });
          throw error;
        }
      },
    };
    const heartbeat = setInterval(() => {
      void this.ports
        .cloud("records/heartbeat", { id: record.id })
        .catch((error: unknown) => {
          if (
            Number((error as { status?: number }).status) === 401 ||
            Number((error as { status?: number }).status) === 403
          )
            this.stop();
        });
    }, 10000);
    heartbeat.unref?.();
    try {
      await this.assertIdentity(identity);
      signal.throwIfAborted();
      const result = await this.ports.publish(
        input.accountId,
        input,
        files,
        signal,
        steps,
        async () => {
          await this.assertIdentity(identity);
          signal.throwIfAborted();
          await validateHandoff(this.ports.exchange, handoff, identity);
          // Durable local marker precedes the cloud acknowledgment. Neither side may replay this boundary.
          record.state = "submitting";
          this.save();
          await this.ports.cloud("records/report", { ...record });
          signal.throwIfAborted();
        },
        (progress) => {
          record.progress = Math.min(95, Math.max(record.progress, progress));
          this.save();
        },
      );
      record.externalId = result.externalId;
      record.url = result.url;
      record.resultSource = "platform";
      record.state = "accepted";
      record.progress = 100;
    } catch (error) {
      if (
        record.state === "submitting" &&
        !(error instanceof ConfirmedPublishRejection)
      ) {
        record.state = "unknown";
        record.errorCode = "PUBLISH_OUTCOME_UNKNOWN";
      } else {
        record.state = signal.aborted ? "canceled" : "failed";
        record.errorCode =
          error instanceof PublishingError ? error.code : "EXECUTION_FAILED";
      }
    } finally {
      clearInterval(heartbeat);
      this.save();
      try {
        await this.ports.cloud("records/report", record);
      } catch {
        /* A durable terminal journal is retried on the next authenticated recovery. */
      }
      await this.ports.cleanup(input.requestKey, identity).catch(() => {});
    }
  }
  stop(): void {
    this.controller?.abort();
  }
  async idle(): Promise<void> {
    await Promise.allSettled([...this.jobs]);
  }
}
