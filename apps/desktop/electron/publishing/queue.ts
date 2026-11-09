import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  validateDouyinInput,
  type DouyinBatchInput,
  type DouyinPublishRecord,
  type DouyinQueue,
  type DouyinQueueEntry,
  type DouyinQueueRow,
} from "@keagent/shared-types";
import { PublishingError, type PublishingIdentity } from "./core";
import { atomicJSON } from "./files";

type Entry = DouyinQueueRow & DouyinQueueEntry;
interface Checkpoint {
  paused: boolean;
  batches: Record<string, string>;
  entries: Entry[];
}

const id = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
const live = (entry: Entry) =>
  ["queued", "running", "submitting"].includes(entry.state);
const uncertain = (entry: Entry) =>
  entry.state === "unknown" || entry.state === "interrupted";
export const samePublisher = (a: PublishingIdentity, b: PublishingIdentity) =>
  a.userId === b.userId &&
  a.deviceId === b.deviceId &&
  a.generation === b.generation;

export class PublishQueue {
  private checkpoints = new Map<string, Checkpoint>();
  private context?: PublishingIdentity;
  private worker?: Promise<void>;
  private epoch = 0;

  constructor(
    private readonly ports: {
      identity: () => Promise<PublishingIdentity>;
      directory: (identity: PublishingIdentity) => string;
      execute: (
        entry: Entry,
        identity: PublishingIdentity,
        assertCurrent: () => Promise<void>,
        started: (record: DouyinPublishRecord) => void,
      ) => Promise<DouyinPublishRecord>;
      record: (id: string) => Promise<DouyinPublishRecord>;
      changed: () => void;
    },
  ) {}

  get busy() {
    return !!this.worker;
  }

  private file(identity: PublishingIdentity) {
    return path.join(this.ports.directory(identity), "publish-queue.json");
  }

  private data(identity: PublishingIdentity) {
    const file = this.file(identity);
    const current = this.checkpoints.get(file);
    if (current) return current;
    let data: Checkpoint = { paused: false, batches: {}, entries: [] };
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (
        !Array.isArray(data.entries) ||
        !data.batches ||
        typeof data.paused !== "boolean"
      )
        throw new Error("invalid checkpoint");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new PublishingError(
          "QUEUE_UNREADABLE",
          "无法读取本机发布队列，原记录已保留",
        );
    }
    if (data.entries.some(live)) {
      data.paused = true;
      for (const entry of data.entries)
        if (entry.state === "running" || entry.state === "submitting")
          entry.state = "interrupted";
      atomicJSON(file, data);
    }
    this.checkpoints.set(file, data);
    return data;
  }

  private save(
    identity: PublishingIdentity,
    data: Checkpoint,
    change: () => void,
  ) {
    const previous = structuredClone(data);
    const entries = [...data.entries];
    change();
    try {
      atomicJSON(this.file(identity), data);
    } catch (error) {
      entries.forEach((entry, index) =>
        Object.assign(
          entry,
          { recordId: undefined, progress: undefined, errorCode: undefined },
          previous.entries[index],
        ),
      );
      Object.assign(data, previous, { entries });
      throw error;
    }
    this.ports.changed();
  }

  view(identity: PublishingIdentity): DouyinQueue {
    const { paused, entries } = this.data(identity);
    const recent = entries
      .filter((entry) => !live(entry) && !uncertain(entry))
      .slice(-100);
    const outstanding = entries.filter(
      (entry) => live(entry) || uncertain(entry),
    );
    return {
      paused,
      rows: [...outstanding, ...recent.reverse()].map(
        ({
          expectedReviewRevision: _revision,
          description: _description,
          ...row
        }) => row,
      ),
    };
  }

  add(identity: PublishingIdentity, input: DouyinBatchInput): DouyinQueue {
    if (
      this.worker &&
      (!this.context || !samePublisher(this.context, identity))
    )
      throw new PublishingError(
        "DEVICE_BUSY",
        "上一账号的发布正在停止，请稍后再试",
      );
    const { requestKey, accountId, entries } = input;
    if (
      typeof requestKey !== "string" ||
      !/^[a-f0-9-]{36}$/.test(requestKey) ||
      !id(accountId) ||
      !Array.isArray(entries) ||
      entries.length < 1 ||
      entries.length > 20
    )
      throw new PublishingError(
        "INVALID_INPUT",
        "每批请选择 1 至 20 条成片与一个发布账号",
        422,
      );
    for (const entry of entries)
      if (
        !entry ||
        !id(entry.artifactId) ||
        !Number.isSafeInteger(entry.expectedReviewRevision) ||
        entry.expectedReviewRevision < 1 ||
        validateDouyinInput({ ...entry, hashtags: [] })
      )
        throw new PublishingError(
          "INVALID_INPUT",
          "请检查成片、验收版本和发布文案",
          422,
        );
    if (
      new Set(entries.map((entry) => entry.artifactId)).size !== entries.length
    )
      throw new PublishingError(
        "INVALID_INPUT",
        "同一批次不能重复添加一份成片",
        422,
      );

    const data = this.data(identity);
    const signature = createHash("sha256")
      .update(JSON.stringify([accountId, entries]))
      .digest("hex");
    if (data.batches[requestKey]) {
      if (data.batches[requestKey] !== signature)
        throw new PublishingError(
          "IDEMPOTENCY_CONFLICT",
          "批次编号已绑定另一份配置",
        );
      return this.view(identity);
    }
    if (data.entries.filter(live).length + entries.length > 100)
      throw new PublishingError(
        "QUEUE_FULL",
        "本机最多保留 100 条待执行任务，请先处理现有队列",
      );
    if (
      entries.some(({ artifactId }) =>
        data.entries.some(
          (entry) =>
            entry.artifactId === artifactId &&
            (live(entry) || uncertain(entry)),
        ),
      )
    )
      throw new PublishingError(
        "ALREADY_QUEUED",
        "选中成片已有排队任务或待核对结果",
      );
    this.save(identity, data, () => {
      data.batches[requestKey] = signature;
      for (const entry of entries)
        data.entries.push({
          artifactId: entry.artifactId,
          expectedReviewRevision: entry.expectedReviewRevision,
          title: entry.title,
          description: entry.description,
          id: randomUUID(),
          batchId: requestKey,
          accountId,
          state: "queued",
        });
    });
    this.kick(identity);
    return this.view(identity);
  }

  async control(identity: PublishingIdentity, action: unknown, id: unknown) {
    const data = this.data(identity);
    if (action === "cancel") {
      const entry = data.entries.find(
        (row) => row.id === id && row.state === "queued",
      );
      if (!entry)
        throw new PublishingError("QUEUE_CONFLICT", "只能取消还未执行的任务");
      this.save(identity, data, () => {
        entry.state = "canceled";
      });
    } else if (action === "pause") {
      this.save(identity, data, () => {
        data.paused = true;
      });
    } else if (action === "resume") {
      if (this.worker)
        throw new PublishingError("DEVICE_BUSY", "请等待当前发布结束再恢复");
      const review = data.entries.filter(uncertain);
      for (const entry of review) {
        if (!entry.recordId) continue;
        const record = await this.ports.record(entry.recordId);
        await this.assertCurrent(identity);
        if (record.state === "running" || record.state === "submitting")
          throw new PublishingError(
            "DEVICE_BUSY",
            "请等待上次发布记录完成恢复，再恢复队列",
          );
        if (
          record.state === "accepted" ||
          record.state === "failed" ||
          record.state === "canceled"
        )
          this.save(identity, data, () =>
            Object.assign(entry, {
              state: record.state,
              errorCode: record.errorCode,
            }),
          );
      }
      if (data.entries.some((entry) => entry.state === "unknown"))
        throw new PublishingError(
          "OUTCOME_UNRESOLVED",
          "请先在成片详情核对未知的发布结果",
        );
      this.save(identity, data, () => {
        data.paused = false;
      });
      this.kick(identity);
    } else if (action === "clear-interrupted") {
      const entry = data.entries.find(
        (row) => row.id === id && row.state === "interrupted",
      );
      if (!entry)
        throw new PublishingError("QUEUE_CONFLICT", "该任务不处于中断状态");
      this.save(identity, data, () => {
        entry.state = "canceled";
      });
    } else throw new PublishingError("INVALID_INPUT", "未知的队列操作", 422);
    return this.view(identity);
  }

  private async assertCurrent(identity: PublishingIdentity) {
    if (!samePublisher(identity, await this.ports.identity()))
      throw new PublishingError(
        "SESSION_CHANGED",
        "登录状态已变更，本机队列已停止",
        403,
      );
  }

  private kick(identity: PublishingIdentity) {
    this.context = identity;
    if (this.worker) return;
    const data = this.data(identity);
    const entry =
      !data.paused && data.entries.find((row) => row.state === "queued");
    if (!entry) return;
    const epoch = this.epoch;
    const assertCurrent = async () => {
      await this.assertCurrent(identity);
      if (epoch !== this.epoch)
        throw new PublishingError("SESSION_CHANGED", "发布队列已停止", 403);
    };
    this.save(identity, data, () => {
      entry.state = "running";
    });
    this.worker = this.ports
      .execute(entry, identity, assertCurrent, (record) => {
        this.save(identity, data, () => {
          entry.recordId = record.id;
        });
      })
      .then((record) => {
        this.save(identity, data, () => {
          Object.assign(entry, {
            recordId: record.id,
            state: record.state,
            errorCode: record.errorCode,
            progress: record.progress,
          });
          if (record.state === "unknown") data.paused = true;
        });
      })
      .catch((error: unknown) => {
        const code = (error as { code?: string })?.code || "EXECUTION_FAILED";
        this.save(identity, data, () => {
          entry.state =
            entry.recordId || code === "QUEUE_WRITE" ? "interrupted" : "failed";
          entry.errorCode = code;
          if (
            entry.recordId ||
            [
              "OUTCOME_UNRESOLVED",
              "SESSION_CHANGED",
              "LOGIN_REQUIRED",
              "ACCOUNT_UNAVAILABLE",
              "QUEUE_WRITE",
            ].includes(code)
          )
            data.paused = true;
        });
      })
      .catch((error) => {
        data.paused = true;
        console.error("publish queue checkpoint failed", error);
      })
      .finally(() => {
        this.worker = undefined;
        if (this.context && epoch === this.epoch) {
          try {
            this.kick(this.context);
          } catch (error) {
            data.paused = true;
            console.error("publish queue could not advance", error);
          }
        }
        this.ports.changed();
      });
  }

  stop() {
    this.epoch++;
    const identity = this.context;
    this.context = undefined;
    if (!identity) return;
    const data = this.data(identity);
    if (data.entries.some(live)) {
      try {
        this.save(identity, data, () => {
          data.paused = true;
        });
      } catch (error) {
        data.paused = true;
        console.error("publish queue could not save pause", error);
      }
    }
  }
}
