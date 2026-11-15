import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  validateDouyinInput,
  type DouyinBatchInput,
  type DouyinPublishRecord,
  type DouyinPublishInput,
  type DouyinQueue,
  type DouyinQueueEntry,
  type DouyinQueueRow,
} from "@keagent/shared-types";
import { PublishingError, type PublishingIdentity } from "./core";
import { atomicJSON } from "./files";

import { validateMessage, type MessageInput } from "../social/message";

type VideoEntry = DouyinQueueRow &
  DouyinQueueEntry & { kind?: "video"; direct?: DouyinPublishInput };
type MessageEntry = DouyinQueueRow & {
  kind: "message";
  message?: MessageInput;
  signature: string;
  submittedAt?: number;
};
type Entry = VideoEntry | MessageEntry;

function messageSignature(
  platform: MessageInput["platform"],
  accountId: string,
  profileUrl: string,
  text: string,
) {
  return createHash("sha256")
    .update(JSON.stringify([platform, accountId, profileUrl, text]))
    .digest("hex");
}

const hour = 3600000;
export function nextMessageTime(submits: number[], now: number) {
  const recent = submits
    .filter((time) => time > now - 24 * hour)
    .sort((a, b) => b - a);
  return Math.max(
    0,
    (recent[0] ?? -Infinity) + hour / 4,
    (recent[1] ?? -Infinity) + hour,
    (recent[7] ?? -Infinity) + 24 * hour,
  );
}

function eligibleAt(data: Checkpoint, entry: Entry) {
  if (entry.kind !== "message" || entry.state !== "queued") return 0;
  const submits = data.entries.flatMap((row) =>
    row.kind === "message" &&
    row.accountId === entry.accountId &&
    row.submittedAt
      ? [row.submittedAt]
      : [],
  );
  return nextMessageTime(submits, Date.now());
}

function publicRow(entry: Entry, data: Checkpoint): DouyinQueueRow {
  const time = eligibleAt(data, entry);
  return {
    id: entry.id,
    createdAt: entry.createdAt,
    checkedAt: entry.checkedAt,
    sourceWorkId: entry.sourceWorkId,
    sourceCommentId:
      entry.sourceCommentId ??
      (entry.kind === "message" ? entry.message?.source?.commentId : undefined),
    batchId: entry.batchId,
    accountId: entry.accountId,
    title: entry.title,
    eligibleAt: time > Date.now() ? time : undefined,
    kind: entry.kind,
    artifactId: entry.artifactId,
    state: entry.state,
    recordId: entry.recordId,
    progress: entry.progress,
    errorCode: entry.errorCode,
    errorMessage: entry.errorMessage,
    resultSource: entry.resultSource,
  };
}
interface Checkpoint {
  paused: boolean;
  pausedForMessage?: string;
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
  private wake?: ReturnType<typeof setTimeout>;
  private checkingReceipt = false;
  private receiptRetryAt = new WeakMap<MessageEntry, number>();

  constructor(
    private readonly ports: {
      identity: () => Promise<PublishingIdentity>;
      directory: (identity: PublishingIdentity) => string;
      execute: (
        entry: VideoEntry,
        identity: PublishingIdentity,
        assertCurrent: () => Promise<void>,
        started: (record: DouyinPublishRecord) => void,
      ) => Promise<DouyinPublishRecord>;
      sendMessage?: (
        message: MessageInput,
        identity: PublishingIdentity,
        beforeSubmit: () => Promise<void>,
      ) => Promise<void>;
      verifyMessage?: (
        identity: PublishingIdentity,
        receipt: {
          accountId: string;
          workId: string;
          commentId: string;
          submittedAt: number;
        },
        matchesText: (profileUrl: string, text: string) => boolean,
      ) => Promise<boolean>;
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
          entry.state =
            entry.kind === "message" && entry.state === "submitting"
              ? "unknown"
              : "interrupted";
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
      entries.forEach((entry, index) => {
        for (const key of Object.keys(entry)) {
          if (!(key in previous.entries[index]))
            Reflect.deleteProperty(entry, key);
        }
        Object.assign(entry, previous.entries[index]);
      });
      delete data.pausedForMessage;
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
      rows: [...outstanding, ...recent.reverse()].map((entry) =>
        publicRow(entry, this.data(identity)),
      ),
    };
  }

  row(identity: PublishingIdentity, id: string) {
    const entry = this.data(identity).entries.find((row) => row.id === id);
    return entry && publicRow(entry, this.data(identity));
  }

  private assertRoom(identity: PublishingIdentity, data: Checkpoint) {
    if (
      this.worker &&
      (!this.context || !samePublisher(this.context, identity))
    )
      throw new PublishingError("DEVICE_BUSY", "前一会话的队列正在停止");
    if (data.entries.filter(live).length >= 100)
      throw new PublishingError(
        "QUEUE_FULL",
        "本机队列中已有 100 个待处理任务",
      );
  }

  enqueueMessage(identity: PublishingIdentity, input: MessageInput) {
    validateMessage(input);
    const data = this.data(identity);
    const signature = messageSignature(
      input.platform,
      input.accountId,
      input.profileUrl,
      input.text,
    );
    const existing = data.entries.find((row) => row.id === input.requestKey);
    if (existing) {
      if (existing.kind !== "message" || existing.signature !== signature)
        throw new PublishingError(
          "IDEMPOTENCY_CONFLICT",
          "该请求编号已关联另一条任务",
        );
      return publicRow(existing, data);
    }
    if (
      data.entries.some(
        (row) =>
          row.kind === "message" &&
          row.signature === signature &&
          (live(row) || uncertain(row)),
      )
    )
      throw new PublishingError(
        "ALREADY_QUEUED",
        "这条私信已在队列中或等待核对",
      );
    this.assertRoom(identity, data);
    const entry: MessageEntry = {
      createdAt: new Date().toISOString(),
      sourceWorkId: input.source?.workId,
      sourceCommentId: input.source?.commentId,
      id: input.requestKey,
      batchId: input.requestKey,
      accountId: input.accountId,
      title:
        "私信 · " + (input.recipientName || input.profileUrl.split("/").pop()),
      kind: "message",
      state: "queued",
      signature,
      message: {
        platform: input.platform,
        accountId: input.accountId,
        profileUrl: input.profileUrl,
        text: input.text,
        recipientName: input.recipientName,
        requestKey: input.requestKey,
        source: input.source,
      },
    };
    this.save(identity, data, () => data.entries.push(entry));
    this.kick(identity);
    return publicRow(entry, data);
  }

  async recoverMessageReceipt(identity: PublishingIdentity) {
    if (this.worker || this.checkingReceipt || !this.ports.verifyMessage)
      return;
    const data = this.data(identity);
    const now = Date.now();
    const entry = data.entries.find(
      (
        row,
      ): row is MessageEntry & { sourceWorkId: string; submittedAt: number } =>
        row.kind === "message" &&
        row.state === "unknown" &&
        !!row.submittedAt &&
        /^\d{5,30}$/.test(row.sourceWorkId ?? "") &&
        id(row.sourceCommentId ?? row.message?.source?.commentId) &&
        now >= (this.receiptRetryAt.get(row) ?? 0),
    );
    const commentId =
      entry?.sourceCommentId ?? entry?.message?.source?.commentId;
    if (!entry || !commentId) return;
    this.checkingReceipt = true;
    this.receiptRetryAt.set(entry, now + 5 * 60_000);
    const epoch = this.epoch;
    try {
      await this.assertCurrent(identity);
      const confirmed = await this.ports.verifyMessage(
        identity,
        {
          accountId: entry.accountId,
          workId: entry.sourceWorkId,
          commentId,
          submittedAt: entry.submittedAt,
        },
        (profile, text) =>
          messageSignature("douyin", entry.accountId, profile, text) ===
          entry.signature,
      );
      if (!confirmed) return;
      await this.assertCurrent(identity);
      if (epoch !== this.epoch || entry.state !== "unknown") return;
      const resume =
        data.pausedForMessage === entry.id &&
        !data.entries.some((row) => row !== entry && uncertain(row));
      this.save(identity, data, () => {
        entry.state = "accepted";
        entry.resultSource = "platform";
        entry.checkedAt = new Date().toISOString();
        delete entry.errorCode;
        delete entry.errorMessage;
        delete entry.message;
        if (resume) {
          data.paused = false;
          delete data.pausedForMessage;
        }
      });
      if (resume) this.kick(identity);
    } finally {
      this.checkingReceipt = false;
    }
  }

  confirmMessage(
    identity: PublishingIdentity,
    id: string,
    status: "sent" | "failed",
  ) {
    const data = this.data(identity);
    const entry = data.entries.find((row) => row.id === id);
    if (entry?.kind !== "message" || (status !== "sent" && status !== "failed"))
      throw new PublishingError("QUEUE_CONFLICT", "无效的私信核对请求");
    const state = status === "sent" ? "accepted" : "failed";
    if (entry.state === state) return publicRow(entry, data);
    if (!uncertain(entry))
      throw new PublishingError("QUEUE_CONFLICT", "该私信不处于待核对状态");
    this.save(identity, data, () => {
      entry.state = state;
      entry.resultSource = "manual";
      entry.checkedAt = new Date().toISOString();
      delete entry.errorCode;
      delete entry.errorMessage;
      delete entry.message;
    });
    return publicRow(entry, data);
  }

  async direct(
    identity: PublishingIdentity,
    input: DouyinPublishInput,
    artifactId: string,
  ): Promise<DouyinPublishRecord> {
    const data = this.data(identity);
    let entry = data.entries.find((row) => row.id === input.requestKey);
    if (
      typeof input.requestKey !== "string" ||
      !/^[A-Za-z0-9_-]{16,100}$/.test(input.requestKey) ||
      !id(input.accountId) ||
      !id(artifactId) ||
      validateDouyinInput(input)
    )
      throw new PublishingError("INVALID_INPUT", "单条发布参数无效");
    if (entry) {
      if (
        entry.kind === "message" ||
        !entry.direct ||
        JSON.stringify(entry.direct) !== JSON.stringify(input)
      )
        throw new PublishingError(
          "IDEMPOTENCY_CONFLICT",
          "该请求编号已关联其他任务",
        );
    } else {
      if (data.paused)
        throw new PublishingError("QUEUE_PAUSED", "请在本机队列恢复执行后重试");
      this.assertRoom(identity, data);
      if (
        data.entries.some(
          (row) =>
            row.artifactId === artifactId && (live(row) || uncertain(row)),
        )
      )
        throw new PublishingError(
          "ALREADY_QUEUED",
          "该成片已在队列中或等待核对",
        );
      const created: VideoEntry = {
        createdAt: new Date().toISOString(),
        id: input.requestKey,
        batchId: input.requestKey,
        accountId: input.accountId,
        artifactId,
        expectedReviewRevision: 0,
        title: input.title,
        description: input.description,
        state: "queued",
        direct: input,
      };
      this.save(identity, data, () => data.entries.push(created));
      entry = created;
      this.kick(identity);
    }
    while (!entry.recordId) {
      await this.assertCurrent(identity);
      if (!live(entry))
        throw new PublishingError(
          entry.errorCode || "EXECUTION_FAILED",
          entry.errorMessage || "发布未启动，请检查队列记录",
        );
      if (data.paused && entry.state === "queued")
        throw new PublishingError(
          "QUEUE_PAUSED",
          "任务已入队，请在本机队列恢复执行",
        );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await this.assertCurrent(identity);
    return this.ports.record(entry.recordId);
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
          createdAt: new Date().toISOString(),
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
    if (action === "confirm-sent" || action === "confirm-failed") {
      this.confirmMessage(
        identity,
        String(id),
        action === "confirm-sent" ? "sent" : "failed",
      );
    } else if (action === "cancel") {
      const entry = data.entries.find(
        (row) => row.id === id && row.state === "queued",
      );
      if (!entry)
        throw new PublishingError("QUEUE_CONFLICT", "只能取消还未执行的任务");
      this.save(identity, data, () => {
        entry.state = "canceled";
        if (entry.kind === "message") delete entry.message;
      });
    } else if (action === "pause") {
      this.save(identity, data, () => {
        delete data.pausedForMessage;
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
        delete data.pausedForMessage;
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
        if (entry.kind === "message") delete entry.message;
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
    clearTimeout(this.wake);
    if (data.paused) return;
    let earliest = Infinity;
    const now = Date.now();
    const entry = data.entries.find((row) => {
      if (row.state !== "queued") return false;
      const time = eligibleAt(data, row);
      if (time <= now) return true;
      earliest = Math.min(earliest, time);
      return false;
    });
    if (!entry) {
      if (Number.isFinite(earliest)) {
        this.wake = setTimeout(
          () => {
            this.wake = undefined;
            if (this.context && samePublisher(identity, this.context))
              this.kick(identity);
          },
          Math.min(2147483647, Math.max(1, earliest - now)),
        );
        this.wake.unref?.();
      }
      return;
    }
    const epoch = this.epoch;
    const assertCurrent = async () => {
      await this.assertCurrent(identity);
      if (epoch !== this.epoch)
        throw new PublishingError("SESSION_CHANGED", "发布队列已停止", 403);
    };
    this.save(identity, data, () => {
      entry.state = "running";
    });
    const execute = async () => {
      if (entry.kind === "message") {
        await assertCurrent();
        if (!this.ports.sendMessage || !entry.message)
          throw new PublishingError("INVALID_INPUT", "私信内容不可用");
        await this.ports.sendMessage(entry.message, identity, async () => {
          await assertCurrent();
          this.save(identity, data, () => {
            entry.state = "submitting";
            entry.submittedAt = Date.now();
          });
        });
        this.save(identity, data, () => {
          entry.state = "accepted";
          entry.resultSource = "platform";
          entry.checkedAt = new Date().toISOString();
          delete entry.message;
        });
        return;
      }
      const record = await this.ports.execute(
        entry,
        identity,
        assertCurrent,
        (record) => {
          this.save(identity, data, () => {
            entry.recordId = record.id;
          });
        },
      );
      this.save(identity, data, () => {
        Object.assign(entry, {
          recordId: record.id,
          state: record.state,
          errorCode: record.errorCode,
          progress: record.progress,
        });
        if (record.state === "unknown") data.paused = true;
      });
    };
    this.worker = execute()
      .catch((error: unknown) => {
        const code = (error as { code?: string })?.code || "EXECUTION_FAILED";
        this.save(identity, data, () => {
          entry.state =
            entry.kind === "message" &&
            entry.state === "submitting" &&
            code !== "DM_NOT_DISPATCHED"
              ? "unknown"
              : entry.recordId || code === "QUEUE_WRITE"
                ? "interrupted"
                : "failed";
          if (entry.kind === "message") {
            if (code === "DM_NOT_DISPATCHED") delete entry.submittedAt;
            delete entry.message;
            entry.errorMessage =
              entry.state === "unknown"
                ? error instanceof PublishingError &&
                  code === "DM_OUTCOME_UNKNOWN"
                  ? error.message
                  : "已提交，需在平台会话核对。队列不会重发。"
                : error instanceof PublishingError
                  ? error.message
                  : "网页私信执行失败";
          }
          entry.errorCode = code;
          if (
            entry.kind === "message" &&
            entry.state === "unknown" &&
            !data.paused
          )
            data.pausedForMessage = entry.id;
          if (
            entry.state === "unknown" ||
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
    clearTimeout(this.wake);
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
