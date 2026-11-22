import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  validateDouyinInput,
  validatePublishSchedule,
  type DouyinBatchInput,
  type DouyinMessageStepLog,
  type DouyinPublishRecord,
  type DouyinPublishInput,
  type DouyinPublishStartResult,
  type DouyinQueue,
  type DouyinQueueEntry,
  type DouyinQueueRow,
} from "@keagent/shared-types";
import { PublishingError, type PublishingIdentity } from "./core";
import { atomicJSON } from "./files";

import {
  validateMessage,
  type MessageExecutionSteps,
  type MessageInput,
} from "../social/message";

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
    platform: entry.platform,
    title: entry.title,
    eligibleAt: time > Date.now() ? time : undefined,
    kind: entry.kind,
    artifactId: entry.artifactId,
    state: entry.state,
    recordId: entry.recordId,
    progress: entry.progress,
    errorCode: entry.errorCode,
    errorMessage: entry.errorMessage,
    messageSteps: entry.messageSteps,
    resultSource: entry.resultSource,
  };
}

function finishMessageStep(
  entry: MessageEntry,
  result: Pick<DouyinMessageStepLog, "status" | "errorCode" | "errorMessage">,
) {
  const steps = entry.messageSteps;
  const step = steps?.at(-1);
  if (!steps || step?.status !== "started") return;
  entry.messageSteps = [
    ...steps.slice(0, -1),
    {
      ...step,
      ...result,
      durationMs: Math.max(0, Date.now() - Date.parse(step.timestamp)),
    },
  ];
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

function canResumeMessagePause(data: Checkpoint) {
  return (
    data.paused &&
    !!data.pausedForMessage &&
    data.entries.some(
      (entry) =>
        entry.id === data.pausedForMessage &&
        entry.kind === "message" &&
        (entry.state === "accepted" || entry.state === "failed"),
    ) &&
    !data.entries.some(uncertain)
  );
}

function resumeMessagePause(data: Checkpoint) {
  if (!canResumeMessagePause(data)) return false;
  clearQueuePause(data);
  return true;
}

function clearQueuePause(data: Checkpoint) {
  delete data.pausedForMessage;
  data.paused = false;
}

function canResumeFromAccountQueue(data: Checkpoint) {
  return (
    data.paused &&
    !data.entries.some(uncertain) &&
    data.entries.some(
      (entry) => entry.kind === "message" && entry.state === "queued",
    ) &&
    !data.entries.some((entry) => entry.kind !== "message" && live(entry))
  );
}

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
        steps: MessageExecutionSteps,
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
      for (const entry of data.entries) {
        if (entry.state !== "running" && entry.state !== "submitting") continue;
        entry.state =
          entry.kind === "message" && entry.state === "submitting"
            ? "unknown"
            : "interrupted";
        if (entry.kind === "message")
          finishMessageStep(entry, {
            status: "failed",
            errorCode: "INTERRUPTED",
            errorMessage: "桌面端在步骤完成前退出",
          });
      }
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
    const data = this.data(identity);
    const { paused, entries } = data;
    const recent = entries
      .filter((entry) => !live(entry) && !uncertain(entry))
      .slice(-100);
    const outstanding = entries.filter(
      (entry) => live(entry) || uncertain(entry),
    );
    return {
      paused,
      messageResumeAvailable: !this.worker && canResumeFromAccountQueue(data),
      rows: [...outstanding, ...recent.reverse()].map((entry) =>
        publicRow(entry, data),
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
      platform: input.platform,
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
      let resumed = false;
      this.save(identity, data, () => {
        entry.state = "accepted";
        entry.resultSource = "platform";
        entry.checkedAt = new Date().toISOString();
        entry.messageSteps = [
          ...(entry.messageSteps ?? []),
          {
            step: "recheck_conversation",
            status: "completed",
            timestamp: new Date(now).toISOString(),
            durationMs: Math.max(0, Date.now() - now),
          },
        ];
        delete entry.errorCode;
        delete entry.errorMessage;
        delete entry.message;
        resumed = resumeMessagePause(data);
      });
      if (resumed) this.kick(identity);
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
    let resumed = false;
    this.save(identity, data, () => {
      entry.state = state;
      entry.resultSource = "manual";
      entry.checkedAt = new Date().toISOString();
      delete entry.errorCode;
      delete entry.errorMessage;
      delete entry.message;
      resumed = resumeMessagePause(data);
    });
    if (resumed) this.kick(identity);
    return publicRow(entry, data);
  }

  async direct(
    identity: PublishingIdentity,
    input: DouyinPublishInput,
    artifactId: string,
  ): Promise<DouyinPublishStartResult> {
    const data = this.data(identity);
    let entry = data.entries.find((row) => row.id === input.requestKey);
    if (
      typeof input.requestKey !== "string" ||
      !/^[A-Za-z0-9_-]{16,100}$/.test(input.requestKey) ||
      !id(input.accountId) ||
      !id(artifactId) ||
      (input.platform !== undefined &&
        !["channels", "douyin"].includes(input.platform)) ||
      validateDouyinInput(input)
    )
      throw new PublishingError("INVALID_INPUT", "单条发布参数无效");
    if (input.scheduledAt !== undefined) {
      const issue = validatePublishSchedule(
        input.platform ?? "douyin",
        input.scheduledAt,
      );
      if (issue && !entry)
        throw new PublishingError("INVALID_SCHEDULE", issue, 422);
    }
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
      this.assertRoom(identity, data);
      if (
        data.entries.some(
          (row) =>
            row.artifactId === artifactId &&
            (row.platform ?? "douyin") === (input.platform ?? "douyin") &&
            (live(row) || uncertain(row)),
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
        platform: input.platform,
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
    if (entry.state === "queued") return { id: entry.id, state: "queued" };
    while (!entry.recordId) {
      await this.assertCurrent(identity);
      if (!live(entry))
        throw new PublishingError(
          entry.errorCode || "EXECUTION_FAILED",
          entry.errorMessage || "发布未启动，请检查队列记录",
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
      (input.platform !== undefined &&
        !["channels", "douyin"].includes(input.platform)) ||
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
        validateDouyinInput({
          ...entry,
          platform: input.platform,
          hashtags: entry.hashtags === undefined ? [] : entry.hashtags,
        })
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
      .update(
        JSON.stringify(
          input.platform === "channels"
            ? [accountId, entries, "channels"]
            : [accountId, entries],
        ),
      )
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
            (entry.platform ?? "douyin") === (input.platform ?? "douyin") &&
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
          shortTitle: entry.shortTitle,
          description: entry.description,
          hashtags: entry.hashtags,
          id: randomUUID(),
          batchId: requestKey,
          accountId,
          platform: input.platform,
          state: "queued",
        });
    });
    this.kick(identity);
    return this.view(identity);
  }

  applyVideoResult(identity: PublishingIdentity, record: DouyinPublishRecord) {
    if (
      record.ownerId !== identity.userId ||
      record.deviceId !== identity.deviceId ||
      !["accepted", "failed", "canceled", "unknown"].includes(record.state)
    )
      return;
    const data = this.data(identity);
    const entry = data.entries.find(
      (row) =>
        row.kind !== "message" &&
        row.recordId === record.id &&
        row.artifactId === record.artifactId,
    );
    if (
      !entry ||
      (record.state === "unknown" && entry.state !== "interrupted") ||
      (!uncertain(entry) &&
        (record.resultSource !== "manual" ||
          entry.resultSource === "manual" ||
          live(entry)))
    )
      return;
    this.save(identity, data, () => {
      entry.state = record.state;
      entry.resultSource = record.resultSource;
      entry.progress = record.progress;
      entry.errorCode = record.errorCode;
      delete entry.errorMessage;
    });
  }

  async refreshVideoResults(identity: PublishingIdentity, resuming = false) {
    for (const entry of this.data(identity).entries.filter(uncertain)) {
      if (entry.kind === "message" || !entry.recordId) continue;
      let record: DouyinPublishRecord;
      try {
        record = await this.ports.record(entry.recordId);
      } catch (error) {
        if (resuming) throw error;
        continue;
      }
      await this.assertCurrent(identity);
      if (
        resuming &&
        (record.state === "running" || record.state === "submitting")
      )
        throw new PublishingError(
          "DEVICE_BUSY",
          "请等待上次发布记录完成恢复，再恢复队列",
        );
      if (record.id === entry.recordId && uncertain(entry))
        this.applyVideoResult(identity, record);
    }
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
    } else if (action === "resume-message") {
      if (!data.paused) return this.view(identity);
      if (this.worker || !canResumeFromAccountQueue(data))
        throw new PublishingError(
          "QUEUE_CONFLICT",
          "当前暂停不能在账号队列恢复，请检查待核对任务或前往发布中心",
        );
      this.save(identity, data, () => clearQueuePause(data));
      this.kick(identity);
    } else if (action === "resume") {
      if (this.worker)
        throw new PublishingError("DEVICE_BUSY", "请等待当前发布结束再恢复");
      await this.refreshVideoResults(identity, true);
      if (
        data.entries.some(
          (entry) => entry.kind === "message" && uncertain(entry),
        )
      )
        throw new PublishingError(
          "OUTCOME_UNRESOLVED",
          "请先在 AI 获客的账号队列核对私信结果",
        );
      if (data.entries.some((entry) => entry.state === "unknown"))
        throw new PublishingError(
          "OUTCOME_UNRESOLVED",
          "请先在成片详情核对未知的发布结果",
        );
      this.save(identity, data, () => clearQueuePause(data));
      this.kick(identity);
    } else if (action === "clear-interrupted") {
      await this.refreshVideoResults(identity, true);
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
      if (entry.kind === "message")
        entry.messageSteps = [
          {
            step: "check_account",
            status: "started",
            timestamp: new Date().toISOString(),
          },
        ];
    });
    const execute = async () => {
      if (entry.kind === "message") {
        await assertCurrent();
        if (!this.ports.sendMessage || !entry.message)
          throw new PublishingError("INVALID_INPUT", "私信内容不可用");
        await this.ports.sendMessage(
          entry.message,
          identity,
          async () => {
            await assertCurrent();
            this.save(identity, data, () => {
              entry.state = "submitting";
              entry.submittedAt = Date.now();
            });
          },
          {
            start: (step) =>
              this.save(identity, data, () => {
                entry.messageSteps = [
                  ...(entry.messageSteps ?? []),
                  {
                    step,
                    status: "started",
                    timestamp: new Date().toISOString(),
                  },
                ];
              }),
            complete: () =>
              this.save(identity, data, () => {
                finishMessageStep(entry, { status: "completed" });
              }),
          },
        );
        this.save(identity, data, () => {
          finishMessageStep(entry, { status: "completed" });
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
        if (
          record.state === "unknown" ||
          (record.errorCode === "VERIFICATION_REQUIRED" &&
            data.entries.some((row) => row.state === "queued"))
        )
          data.paused = true;
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
            finishMessageStep(entry, {
              status: "failed",
              errorCode: code,
              errorMessage: entry.errorMessage,
            });
          }
          entry.errorCode = code;
          if (
            entry.kind !== "message" &&
            code === "VERIFICATION_REQUIRED" &&
            data.entries.some((row) => row.state === "queued")
          )
            data.paused = true;
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
