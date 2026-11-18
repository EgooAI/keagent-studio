import { createHash } from "node:crypto";
import type {
  DouyinQueueRow,
  OutreachTask,
  OutreachStatus,
} from "@keagent/shared-types";
import { PublishingError, type PublishingIdentity } from "../publishing/core";
import { samePublisher, type PublishQueue } from "../publishing/queue";

type Row = OutreachTask & { accountId: string; workId: string; method: string };
type Ref = { outreachId: string; attempt: number };
const terminal = new Set(["sent", "failed", "canceled", "uncertain"]);
function messageKey(row: Row) {
  return createHash("sha256")
    .update(row.id + ":" + row.attempt)
    .digest("hex")
    .slice(0, 32);
}
function delivery(state: DouyinQueueRow["state"]): OutreachStatus {
  switch (state) {
    case "queued":
      return "submitted";
    case "running":
    case "submitting":
      return "sending";
    case "accepted":
      return "sent";
    case "failed":
    case "canceled":
      return state;
    case "unknown":
    case "interrupted":
      return "uncertain";
  }
}

export class DesktopOutreach {
  constructor(
    private request: (route: string, input?: unknown) => Promise<unknown>,
    private queue: Pick<
      PublishQueue,
      "row" | "enqueueMessage" | "control" | "confirmMessage"
    >,
    private identity: () => Promise<PublishingIdentity>,
  ) {}
  private async load(id: string) {
    const result = (await this.request("/v1/collection/outreach/list", {
      id,
      limit: 1,
    })) as { items: Row[] };
    if (!result.items[0])
      throw new PublishingError("OUTREACH_NOT_FOUND", "找不到私信任务");
    return result.items[0];
  }
  private async current(identity: PublishingIdentity) {
    if (!samePublisher(identity, await this.identity()))
      throw new PublishingError("SESSION_CHANGED", "登录账号已切换");
  }
  private async report(
    identity: PublishingIdentity,
    row: Row,
    task: DouyinQueueRow,
    confirmed = task.resultSource === "platform" ||
      task.resultSource === "manual",
  ) {
    await this.current(identity);
    await this.request("/v1/collection/outreach/result", {
      id: row.id,
      attempt: row.attempt,
      status: delivery(task.state),
      method: "electron",
      creatorhubTaskId: task.id,
      error: (task.errorMessage || task.errorCode || "").slice(0, 450),
      confirmed,
    });
    return this.load(row.id);
  }
  async submit(input: {
    analysisId: string;
    draft: string;
    requestKey: string;
  }) {
    const identity = await this.identity();
    const created = (await this.request(
      "/v1/collection/outreach/submit",
      input,
    )) as {
      id: string;
      commenterProfile: string;
      commenterName: string;
      commentId: string;
      attempt: number;
    };
    const row = await this.load(created.id);
    if (row.status !== "approved" || created.attempt !== row.attempt)
      return row;
    await this.current(identity);
    // A local enqueue can succeed even when its cloud receipt is lost.
    const previous = this.queue.row(identity, messageKey(row));
    if (previous?.kind === "message")
      return this.report(identity, row, previous);
    const consent = (await this.request("/v1/collection/lead/consent/get", {
      accountId: row.accountId,
      workId: row.workId,
    })) as {
      state: string;
      creatorhubAccountId?: string;
      purposes?: { manualContact: boolean };
    };
    await this.current(identity);
    let task: DouyinQueueRow;
    try {
      if (
        consent.state !== "active" ||
        !consent.purposes?.manualContact ||
        consent.creatorhubAccountId
      )
        throw new PublishingError(
          "ACCOUNT_UNAVAILABLE",
          "请使用本机已登录的平台账号重新采集该作品，再审核发送",
        );
      task = await this.queue.enqueueMessage(identity, {
        accountId: row.accountId,
        platform: row.workId.startsWith("xhs-") ? "xhs" : "douyin",
        profileUrl: created.commenterProfile,
        recipientName: created.commenterName,
        text: row.draft,
        requestKey: messageKey(row),
        source: { workId: row.workId, commentId: created.commentId },
      });
    } catch (error) {
      // Conflicting replays can already have a queued write. Never mark those safe to retry.
      if (
        error instanceof PublishingError &&
        ["QUEUE_FULL", "INVALID_INPUT", "ACCOUNT_UNAVAILABLE"].includes(
          error.code,
        )
      )
        await this.request("/v1/collection/outreach/result", {
          id: row.id,
          attempt: row.attempt,
          status: "failed",
          error: error.message,
          method: "electron",
        });
      throw error;
    }
    return this.report(identity, row, task);
  }
  async reply(
    identity: PublishingIdentity,
    input: {
      accountId: string;
      workId: string;
      commentId: string;
      text: string;
      requestKey: string;
    },
  ) {
    const { accountId, workId, commentId, text, requestKey } = input;
    const contact = (await this.request("/v1/collection/comments/contact", {
      accountId,
      workId,
      id: commentId,
    })) as { profileUrl: string; recipientName?: string };
    await this.current(identity);
    return this.queue.enqueueMessage(identity, {
      accountId,
      platform: workId.startsWith("xhs-") ? "xhs" : "douyin",
      profileUrl: contact.profileUrl,
      recipientName: contact.recipientName ?? "",
      text,
      requestKey,
      source: { workId, commentId },
    });
  }
  async refresh(input: Ref) {
    const identity = await this.identity();
    const row = await this.load(input.outreachId);
    if (
      row.attempt !== input.attempt ||
      (terminal.has(row.status) && row.status !== "uncertain") ||
      row.method !== "electron"
    )
      return row;
    await this.current(identity);
    const task = this.queue.row(identity, row.creatorhubTaskId);
    if (!task)
      throw new PublishingError(
        "OUTREACH_UNKNOWN",
        "本机没有对应任务，请在平台会话核对",
      );
    return this.report(identity, row, task);
  }
  async cancel(input: Ref) {
    const identity = await this.identity();
    const row = await this.load(input.outreachId);
    await this.current(identity);
    if (row.attempt !== input.attempt || row.method !== "electron")
      throw new PublishingError(
        "OUTREACH_CHANGED",
        "只能取消本机队列中当前的任务",
      );
    if (this.queue.row(identity, row.creatorhubTaskId)?.state !== "canceled")
      await this.queue.control(identity, "cancel", row.creatorhubTaskId);
    return this.refresh(input);
  }
  async confirm(input: Ref & { status: "sent" | "failed" }) {
    const identity = await this.identity();
    const row = await this.load(input.outreachId);
    await this.current(identity);
    if (
      row.attempt !== input.attempt ||
      row.method !== "electron" ||
      !["sent", "failed"].includes(input.status)
    )
      throw new PublishingError("OUTREACH_CHANGED", "请核对当前私信任务");
    let task = this.queue.row(identity, row.creatorhubTaskId);
    if (task?.kind !== "message")
      throw new PublishingError("OUTREACH_UNKNOWN", "无法找到本机任务");
    const localStatus = delivery(task.state);
    if (localStatus === input.status) {
      if (row.status === input.status) return row;
      if (
        task.resultSource === "manual" &&
        ["submitted", "sending", "uncertain"].includes(row.status)
      )
        return this.report(identity, row, task);
    }
    if (row.status !== "uncertain") {
      // The local queue can finish while the cloud still shows the send in progress.
      if (
        !["submitted", "sending"].includes(row.status) ||
        localStatus !== "uncertain"
      )
        throw new PublishingError("OUTREACH_CHANGED", "请核对当前私信任务");
      const synced = await this.report(identity, row, task);
      if (
        synced.status !== "uncertain" ||
        synced.attempt !== row.attempt ||
        synced.creatorhubTaskId !== task.id
      )
        throw new PublishingError("OUTREACH_CHANGED", "请核对当前私信任务");
      await this.current(identity);
      task = this.queue.row(identity, row.creatorhubTaskId);
      if (task?.kind !== "message")
        throw new PublishingError("OUTREACH_UNKNOWN", "无法找到本机任务");
    }
    if (delivery(task.state) !== input.status)
      await this.queue.confirmMessage(identity, task.id, input.status);
    return this.report(identity, row, this.queue.row(identity, task.id)!, true);
  }
}
