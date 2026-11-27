import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  CollectionPage,
  CollectionRun,
  CollectionRunState,
  CommentObservation,
} from "@keagent/shared-types";
import { PublishingError, type PublishingIdentity } from "../publishing/core";
import { atomicJSON } from "../publishing/files";
import { samePublisher } from "../publishing/queue";
import type { CommentObservationService } from "./service";

const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{32}$/.test(value);

function outcome(record: CommentObservation): CollectionRunState {
  if (record.errorCode === "CANCELED") return "canceled";
  if (
    record.errorCode === "INTERRUPTED" ||
    record.errorCode === "SESSION_CHANGED"
  )
    return "interrupted";
  if (
    record.panelStatus === "restricted" ||
    ["ACCOUNT_NOT_SAVED", "LOGIN_UNCONFIRMED"].includes(record.errorCode ?? "")
  )
    return "blocked";
  if (
    record.verifiedWorkId &&
    ["loading", "unknown", "load_failed"].includes(record.panelStatus)
  )
    return "partial";
  return record.state === "finished" && record.verifiedWorkId
    ? "succeeded"
    : "failed";
}

export class CollectionRunService {
  private readonly syncing = new Map<string, Promise<CollectionRun>>();
  private recovering = false;
  private pendingFinishes = 0;
  private generation = 0;

  constructor(
    private readonly observations: Pick<
      CommentObservationService,
      "get" | "start" | "cancel"
    >,
    private readonly identity: () => Promise<PublishingIdentity>,
    private readonly request: (
      route: string,
      input: unknown,
    ) => Promise<unknown>,
    private readonly directory: (identity: PublishingIdentity) => string,
    private readonly changed: () => void,
  ) {}

  get busy() {
    return this.recovering || this.syncing.size > 0 || this.pendingFinishes > 0;
  }

  private async cloud<T>(
    identity: PublishingIdentity,
    operation: string,
    input: unknown,
  ) {
    if (!samePublisher(identity, await this.identity()))
      throw new PublishingError(
        "SESSION_CHANGED",
        "登录已变更，请重新操作",
        403,
      );
    try {
      return (await this.request(
        "/v1/collection/runs/" + operation,
        input,
      )) as T;
    } catch (cause) {
      const e = cause as { status?: number; code?: string; message?: string };
      throw new PublishingError(
        e.code || "COLLECTION_UNAVAILABLE",
        e.status && e.message
          ? e.message
          : "无法连接观察服务，请检查网络后重试",
        e.status || 503,
      );
    }
  }

  async start(identity: PublishingIdentity, input: Record<string, unknown>) {
    const generation = this.generation;
    const { targetId, expectedVersion, requestKey } = input;
    if (
      !validId(targetId) ||
      !Number.isSafeInteger(expectedVersion) ||
      Number(expectedVersion) < 1 ||
      typeof requestKey !== "string" ||
      !/^[\w-]{16,100}$/.test(requestKey)
    )
      throw new PublishingError("INVALID_INPUT", "观察目标或请求标识无效", 422);
    const run = await this.cloud<CollectionRun>(identity, "create", {
      targetId,
      expectedVersion,
      requestKey,
    });
    if (
      generation === this.generation &&
      (run.state === "queued" || run.state === "running")
    )
      return this.sync(identity, run.id);
    return run;
  }

  async cancel(identity: PublishingIdentity, id: unknown) {
    if (!validId(id))
      throw new PublishingError("INVALID_INPUT", "运行编号无效", 422);
    const run = await this.cloud<CollectionRun>(identity, "cancel", { id });
    if (run.state === "canceled") await this.targetStopped(identity, id);
    this.changed();
    return run;
  }

  async targetStopped(identity: PublishingIdentity, id: string) {
    if (!validId(id)) return;
    this.observations.cancel(identity, id);
    // An earlier claim may still be installing its local observer.
    const claim = this.syncing.get(this.file(identity, id));
    if (claim) {
      await claim.catch(() => {});
      this.observations.cancel(identity, id);
    }
  }

  private file(identity: PublishingIdentity, id: string) {
    return path.join(this.directory(identity), "collection-runs", id + ".json");
  }

  private sync(
    identity: PublishingIdentity,
    id: string,
  ): Promise<CollectionRun> {
    if (!validId(id))
      throw new PublishingError("INVALID_INPUT", "运行编号无效", 422);
    const file = this.file(identity, id);
    const previous = this.syncing.get(file);
    if (previous) return previous;
    const task = this.reconcile(identity, id, file).finally(() =>
      this.syncing.delete(file),
    );
    this.syncing.set(file, task);
    return task;
  }

  private async reconcile(
    identity: PublishingIdentity,
    id: string,
    file: string,
  ) {
    const generation = this.generation;
    // Persist the lease before claiming: a lost acknowledgment must not start a second observation.
    let leaseToken: string;
    if (fs.existsSync(file)) {
      leaseToken = JSON.parse(fs.readFileSync(file, "utf8")).leaseToken;
      if (!validId(leaseToken))
        throw new PublishingError("RECORD_INVALID", "本机运行记录损坏");
    } else {
      leaseToken = randomBytes(16).toString("hex");
      atomicJSON(file, { leaseToken });
    }
    const lease = { id, leaseToken };
    const record = this.observations.get(identity, id);
    let run: CollectionRun;
    if (record?.endedAt) {
      const state = outcome(record);
      const keepFinding =
        state === "succeeded" || state === "partial" || state === "blocked";
      run = await this.cloud<CollectionRun>(identity, "finish", {
        ...lease,
        state,
        panelStatus: keepFinding ? record.panelStatus : "not_checked",
        verifiedWorkId: keepFinding ? record.verifiedWorkId : undefined,
        title: keepFinding ? record.title : undefined,
        author: keepFinding ? record.author : undefined,
        errorCode: record.errorCode,
        reason: record.reason,
        observedAt: record.endedAt,
      });
    } else {
      run = await this.cloud<CollectionRun>(
        identity,
        record ? "heartbeat" : "claim",
        lease,
      );
    }
    if (run.id !== id || run.deviceId !== identity.deviceId)
      throw new PublishingError("WRONG_DEVICE", "观察运行与本机不匹配");
    if (run.state !== "running" && run.state !== "queued") {
      this.observations.cancel(identity, id);
      fs.rmSync(file, { force: true });
      this.changed();
      return run;
    }
    if (!record && run.state === "running") {
      if (
        !samePublisher(identity, await this.identity()) ||
        generation !== this.generation
      )
        throw new PublishingError(
          "SESSION_CHANGED",
          "登录已变更，请重新操作",
          403,
        );
      this.observations.start(
        identity,
        run.accountId,
        run.targetUrl,
        false,
        id,
        () => {
          this.pendingFinishes++;
          setImmediate(() => {
            this.pendingFinishes--;
            if (fs.existsSync(file))
              void this.sync(identity, id).catch(() => {});
          });
        },
        async () => {
          // The browser slot may have been held by a person since this lease was claimed.
          const latest = await this.cloud<CollectionRun>(
            identity,
            "heartbeat",
            lease,
          );
          if (latest.id !== id || latest.deviceId !== identity.deviceId)
            throw new PublishingError("WRONG_DEVICE", "观察运行与本机不匹配");
          if (latest.state !== "running")
            throw new PublishingError(
              latest.errorCode || "INTERRUPTED",
              latest.reason || "观察运行已停止",
            );
        },
      );
    }
    return run;
  }

  stop() {
    this.generation++;
  }

  async recover() {
    if (this.recovering) return;
    this.recovering = true;
    const generation = this.generation;
    try {
      const identity = await this.identity();
      if (generation !== this.generation) return;
      const dir = path.join(this.directory(identity), "collection-runs");
      const pending = fs.existsSync(dir)
        ? fs
            .readdirSync(dir)
            .filter((name) => /^[a-f0-9]{32}\.json$/.test(name))
            .map((name) => name.slice(0, -5))
        : [];
      await Promise.allSettled(pending.map((id) => this.sync(identity, id)));
      // A create can reach Go just before the desktop closes or loses its response.
      let cursor: string | undefined;
      do {
        const page: CollectionPage<CollectionRun> = await this.cloud(
          identity,
          "list",
          { state: "queued", cursor },
        );
        if (generation !== this.generation) return;
        await Promise.allSettled(
          page.items.map((run) => this.sync(identity, run.id)),
        );
        cursor = page.nextCursor;
      } while (cursor);
    } finally {
      this.recovering = false;
    }
  }
}
