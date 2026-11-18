import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { DouyinPublishRecord } from "@keagent/shared-types";
import { PublishingError } from "./core";
import { PublishQueue, nextMessageTime } from "./queue";

vi.mock("electron", () => ({ dialog: {}, nativeImage: {} }));
const identity = { userId: "owner-a", deviceId: "device-a", generation: 1 };
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    expect(path.dirname(root)).toBe(os.tmpdir());
    expect(path.basename(root)).toMatch(/^publish-queue-test-/);
    fs.rmSync(root, { recursive: true });
  }
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "publish-queue-test-"));
  roots.push(root);
  const entries = ["a", "b"].map((value) => ({
    artifactId: value.repeat(32),
    expectedReviewRevision: 2,
    title: "发布 " + value,
    description: "已验收文案",
  }));
  const input = {
    requestKey: randomUUID(),
    accountId: "c".repeat(32),
    entries,
  };
  const record = (
    artifactId: string,
    state: DouyinPublishRecord["state"],
  ): DouyinPublishRecord => ({
    ...identity,
    ownerId: identity.userId,
    artifactId,
    id: artifactId,
    state,
    progress: 100,
    requestKey: randomUUID(),
    handoffId: "d".repeat(32),
    accountId: input.accountId,
    title: "批量发布测试",
    description: "",
    hashtags: [],
    logs: [],
    createdAt: "",
    updatedAt: "",
  });
  const ports = {
    identity: async () => identity,
    directory: (scope: typeof identity) => path.join(root, scope.userId),
    changed: vi.fn(),
    record: vi.fn(async (id: string) => record(id, "unknown")),
    execute: vi.fn<ConstructorParameters<typeof PublishQueue>[0]["execute"]>(),
  };
  return { input, ports, record };
}

it("runs each confirmed item once and pauses for unknown results", async () => {
  const { input, ports, record } = setup();
  ports.execute.mockImplementation(async (entry, _, check, started) => {
    await check();
    started(record(entry.artifactId, "running"));
    return record(
      entry.artifactId,
      entry.artifactId === input.entries[0].artifactId ? "unknown" : "accepted",
    );
  });
  const queue = new PublishQueue(ports);
  queue.add(identity, input);
  queue.add(identity, input);
  await vi.waitFor(() => expect(queue.view(identity).paused).toBe(true));
  expect(queue.view(identity).rows.map((row) => row.state)).toEqual([
    "unknown",
    "queued",
  ]);
  expect(ports.execute).toHaveBeenCalledTimes(1);
  await expect(
    queue.control(identity, "resume", undefined),
  ).rejects.toMatchObject({ code: "OUTCOME_UNRESOLVED" });
  ports.record.mockImplementation(async (id) => record(id, "accepted"));
  await queue.control(identity, "resume", undefined);
  await vi.waitFor(() =>
    expect(
      queue.view(identity).rows.every((row) => row.state === "accepted"),
    ).toBe(true),
  );
  expect(ports.execute).toHaveBeenCalledTimes(2);
});

it("recovers a persisted queue without replaying its interrupted item", async () => {
  const { input, ports } = setup();
  ports.execute.mockReturnValueOnce(new Promise(() => {}));
  const original = new PublishQueue(ports);
  original.add(identity, input);
  original.stop();
  const restarted = new PublishQueue(ports);
  expect(restarted.view(identity)).toMatchObject({
    paused: true,
    rows: [{ state: "interrupted" }, { state: "queued" }],
  });
  expect(restarted.view({ ...identity, userId: "owner-b" }).rows).toEqual([]);
  expect(() =>
    restarted.add(identity, { ...input, requestKey: randomUUID() }),
  ).toThrow("已有排队任务或待核对结果");
  const next = restarted.view(identity).rows[1];
  await restarted.control(identity, "cancel", next.id);
  expect(restarted.view(identity).rows.map((row) => row.state)).toEqual([
    "interrupted",
    "canceled",
  ]);
  expect(ports.execute).toHaveBeenCalledTimes(1);
});

it("serializes messages, direct publishing and batch publishing, including idempotent replay", async () => {
  const { input, ports, record } = setup();
  const order: string[] = [];
  let finishMessage!: () => void;
  const hold = new Promise<void>((resolve) => {
    finishMessage = resolve;
  });
  const queue = new PublishQueue({
    ...ports,
    sendMessage: async (_message, _identity, beforeSubmit) => {
      order.push("dm");
      await beforeSubmit();
      await hold;
    },
  });
  const message = {
    platform: "xhs" as const,
    accountId: input.accountId,
    profileUrl: "https://www.xiaohongshu.com/user/profile/" + "a".repeat(24),
    recipientName: "收件人",
    text: "你好",
    requestKey: randomUUID(),
    source: { workId: "xhs-" + "b".repeat(24), commentId: "c".repeat(32) },
  };
  const row = queue.enqueueMessage(identity, message);
  expect(queue.enqueueMessage(identity, message).id).toBe(row.id);
  expect(queue.row(identity, row.id)).not.toHaveProperty("message");
  ports.execute.mockImplementation(async (entry, _, check, started) => {
    await check();
    order.push(entry.direct ? "direct" : "batch");
    started(record(entry.artifactId, "running"));
    return record(entry.artifactId, "accepted");
  });
  const direct = queue.direct(
    identity,
    {
      requestKey: randomUUID(),
      accountId: input.accountId,
      handoffId: "d".repeat(32),
      hashtags: [],
      title: "单条视频",
      description: "正文",
    },
    "e".repeat(32),
  );
  queue.add(identity, input);
  await vi.waitFor(() =>
    expect(queue.row(identity, row.id)?.state).toBe("submitting"),
  );
  expect(order).toEqual(["dm"]);
  finishMessage();
  await direct;
  await vi.waitFor(() =>
    expect(
      queue.view(identity).rows.every((row) => row.state === "accepted"),
    ).toBe(true),
  );
  expect(order).toEqual(["dm", "direct", "batch", "batch"]);
  expect(queue.row(identity, row.id)).toMatchObject({
    state: "accepted",
    checkedAt: expect.any(String),
    sourceWorkId: message.source.workId,
    sourceCommentId: message.source.commentId,
  });
});

it("keeps the conversation check result on an unverified message without resending", async () => {
  const { input, ports } = setup();
  const detail = "重新打开目标会话后仍未核实消息";
  const sendMessage = vi.fn<
    NonNullable<ConstructorParameters<typeof PublishQueue>[0]["sendMessage"]>
  >(async (_message, _identity, beforeSubmit, steps) => {
    steps.complete();
    steps.start("open_conversation");
    steps.complete();
    steps.start("fill_message");
    steps.complete();
    steps.start("trigger_send");
    await beforeSubmit();
    steps.complete();
    steps.start("verify_conversation");
    throw new PublishingError("DM_OUTCOME_UNKNOWN", detail);
  });
  const queue = new PublishQueue({ ...ports, sendMessage });
  const message = {
    platform: "douyin" as const,
    accountId: input.accountId,
    profileUrl: "https://www.douyin.com/user/recipient",
    recipientName: "用户",
    text: "你好",
    requestKey: randomUUID(),
    source: { workId: "123456", commentId: "b".repeat(32) },
  };
  queue.enqueueMessage(identity, message);
  await vi.waitFor(() => expect(queue.view(identity).paused).toBe(true));
  expect(queue.enqueueMessage(identity, message)).toMatchObject({
    state: "unknown",
    errorCode: "DM_OUTCOME_UNKNOWN",
    errorMessage: detail,
    messageSteps: [
      { step: "check_account", status: "completed" },
      { step: "open_conversation", status: "completed" },
      { step: "fill_message", status: "completed" },
      { step: "trigger_send", status: "completed" },
      {
        step: "verify_conversation",
        status: "failed",
        errorCode: "DM_OUTCOME_UNKNOWN",
        errorMessage: detail,
        durationMs: expect.any(Number),
      },
    ],
  });
  expect(sendMessage).toHaveBeenCalledTimes(1);
  // A different process only has the old queue row, which contains no message text.
  const recovered = new PublishQueue({
    ...ports,
    sendMessage,
    verifyMessage: async (scope, receipt, matches) => {
      expect(scope).toEqual(identity);
      expect(receipt).toMatchObject({
        accountId: message.accountId,
        workId: message.source.workId,
        commentId: message.source.commentId,
        submittedAt: expect.any(Number),
      });
      expect(matches(message.profileUrl, "不同内容")).toBe(false);
      expect(matches("https://www.douyin.com/user/another", message.text)).toBe(
        false,
      );
      return matches(message.profileUrl, message.text);
    },
  });
  expect(recovered.row(identity, message.requestKey)?.messageSteps).toEqual(
    queue.row(identity, message.requestKey)?.messageSteps,
  );
  await recovered.recoverMessageReceipt(identity);
  expect(recovered.view(identity)).toMatchObject({
    paused: false,
    rows: [
      {
        id: message.requestKey,
        state: "accepted",
        resultSource: "platform",
        checkedAt: expect.any(String),
        errorMessage: undefined,
        errorCode: undefined,
      },
    ],
  });
  expect(
    recovered.row(identity, message.requestKey)?.messageSteps?.at(-1),
  ).toMatchObject({ step: "recheck_conversation", status: "completed" });
  expect(sendMessage).toHaveBeenCalledTimes(1);
});

it("reads a legacy hash-only receipt once and preserves an unattributed pause", async () => {
  const { input, ports } = setup();
  const profile = "https://www.douyin.com/user/recipient";
  const submittedAt = Date.now() - 300_000;
  const signature = createHash("sha256")
    .update(JSON.stringify(["douyin", input.accountId, profile, "测试一下"]))
    .digest("hex");
  const taskId = randomUUID();
  const legacy = {
    paused: true,
    batches: {},
    entries: [
      {
        kind: "message",
        state: "unknown",
        signature,
        accountId: input.accountId,
        id: taskId,
        batchId: taskId,
        sourceWorkId: "1234567890",
        sourceCommentId: "b".repeat(32),
        submittedAt,
        errorCode: "DM_OUTCOME_UNKNOWN",
      },
    ],
  };
  const dir = ports.directory(identity);
  fs.mkdirSync(dir);
  fs.writeFileSync(
    path.join(dir, "publish-queue.json"),
    JSON.stringify(legacy),
  );
  const sendMessage = vi.fn(async () => {
    throw new Error("Unexpected send");
  });
  let resolve!: (text: string) => void;
  const firstRead = new Promise<string>((done) => (resolve = done));
  const verifyMessage = vi.fn<
    NonNullable<ConstructorParameters<typeof PublishQueue>[0]["verifyMessage"]>
  >(async (_scope, receipt, matches) => {
    expect(receipt.submittedAt).toBe(submittedAt);
    return matches(profile, await firstRead);
  });
  const queue = new PublishQueue({ ...ports, sendMessage, verifyMessage });
  const first = queue.recoverMessageReceipt(identity);
  await queue.recoverMessageReceipt(identity);
  resolve("此前发过的内容");
  await first;
  expect(verifyMessage).toHaveBeenCalledTimes(1);
  expect(queue.row(identity, taskId)?.state).toBe("unknown");
  const restarted = new PublishQueue({
    ...ports,
    sendMessage,
    verifyMessage: async (_i, _r, match) => match(profile, "测试一下"),
  });
  await restarted.recoverMessageReceipt(identity);
  expect(restarted.view(identity)).toMatchObject({
    paused: true,
    rows: [{ id: taskId, state: "accepted", resultSource: "platform" }],
  });
  expect(sendMessage).not.toHaveBeenCalled();
  expect(ports.execute).not.toHaveBeenCalled();
});

it.each([
  { status: "sent", state: "accepted", manualPause: false },
  { status: "failed", state: "failed", manualPause: false },
  { status: "sent", state: "accepted", manualPause: true },
] as const)(
  "handles manual confirmation $status with explicit pause $manualPause",
  async ({ status, state, manualPause }) => {
    const { input, ports } = setup();
    const first = {
      platform: "douyin" as const,
      accountId: input.accountId,
      profileUrl: "https://www.douyin.com/user/recipient",
      recipientName: "收件人",
      text: "原私信",
      requestKey: randomUUID(),
    };
    const next = {
      ...first,
      accountId: "e".repeat(32),
      requestKey: randomUUID(),
    };
    const sendMessage = vi.fn<
      NonNullable<ConstructorParameters<typeof PublishQueue>[0]["sendMessage"]>
    >(async (message, _scope, beforeSubmit) => {
      await beforeSubmit();
      if (message.requestKey === first.requestKey)
        throw new PublishingError("DM_OUTCOME_UNKNOWN", "会话中没有发送回执");
    });
    const queue = new PublishQueue({ ...ports, sendMessage });
    queue.enqueueMessage(identity, first);
    await vi.waitFor(() => expect(queue.view(identity).paused).toBe(true));
    await expect(
      queue.control(identity, "resume-message", undefined),
    ).rejects.toMatchObject({ code: "QUEUE_CONFLICT" });
    queue.enqueueMessage(identity, next);
    if (manualPause) await queue.control(identity, "pause", undefined);
    queue.confirmMessage(identity, first.requestKey, status);
    expect(queue.row(identity, first.requestKey)).toMatchObject({
      state,
      resultSource: "manual",
    });
    expect(queue.view(identity)).toMatchObject({
      paused: manualPause,
      messageResumeAvailable: manualPause,
    });
    if (manualPause) {
      expect(queue.row(identity, next.requestKey)?.state).toBe("queued");
    } else {
      await vi.waitFor(() =>
        expect(queue.row(identity, next.requestKey)?.state).toBe("accepted"),
      );
    }
    expect(
      sendMessage.mock.calls.map(([message]) => message.requestKey),
    ).toEqual(
      manualPause ? [first.requestKey] : [first.requestKey, next.requestKey],
    );
  },
);

it("allows the account queue to release a stale private-message pause", async () => {
  const { input, ports } = setup();
  const settledId = randomUUID();
  const directory = ports.directory(identity);
  fs.mkdirSync(directory);
  fs.writeFileSync(
    path.join(directory, "publish-queue.json"),
    JSON.stringify({
      paused: true,
      pausedForMessage: settledId,
      batches: {},
      entries: [
        {
          id: settledId,
          kind: "message",
          state: "accepted",
          resultSource: "manual",
          accountId: input.accountId,
        },
      ],
    }),
  );
  const sendMessage = vi.fn<
    NonNullable<ConstructorParameters<typeof PublishQueue>[0]["sendMessage"]>
  >(async (_message, _scope, beforeSubmit) => beforeSubmit());
  const queue = new PublishQueue({ ...ports, sendMessage });
  const queued = queue.enqueueMessage(identity, {
    platform: "douyin",
    accountId: input.accountId,
    profileUrl: "https://www.douyin.com/user/recipient",
    recipientName: "另一位收件人",
    text: "新任务",
    requestKey: randomUUID(),
  });
  expect(queue.view(identity)).toMatchObject({
    paused: true,
    messageResumeAvailable: true,
  });
  expect(sendMessage).not.toHaveBeenCalled();
  await queue.control(identity, "resume-message", undefined);
  await vi.waitFor(() =>
    expect(queue.row(identity, queued.id)?.state).toBe("accepted"),
  );
  expect(queue.view(identity)).toMatchObject({
    paused: false,
    messageResumeAvailable: false,
  });
  expect(sendMessage.mock.calls.map(([message]) => message.requestKey)).toEqual(
    [queued.id],
  );
  expect(queue.row(identity, settledId)).toMatchObject({
    state: "accepted",
    resultSource: "manual",
  });
});

it.each(["message", "video"] as const)(
  "checks interrupted private messages before resuming a waiting %s",
  async (nextKind) => {
    const { input, ports } = setup();
    const firstId = randomUUID();
    const directory = ports.directory(identity);
    fs.mkdirSync(directory);
    fs.writeFileSync(
      path.join(directory, "publish-queue.json"),
      JSON.stringify({
        paused: false,
        batches: {},
        entries: [
          {
            id: firstId,
            kind: "message",
            state: "running",
            accountId: input.accountId,
          },
        ],
      }),
    );
    const sendMessage = vi.fn<
      NonNullable<ConstructorParameters<typeof PublishQueue>[0]["sendMessage"]>
    >(async (_message, _scope, before) => before());
    const queue = new PublishQueue({ ...ports, sendMessage });
    expect(queue.row(identity, firstId)?.state).toBe("interrupted");
    const nextId =
      nextKind === "message"
        ? queue.enqueueMessage(identity, {
            platform: "douyin",
            accountId: input.accountId,
            profileUrl: "https://www.douyin.com/user/recipient",
            recipientName: "收件人",
            text: "新任务",
            requestKey: randomUUID(),
          }).id
        : queue.add(identity, input).rows.find((row) => row.state === "queued")
            ?.id;
    await expect(
      queue.control(identity, "resume", undefined),
    ).rejects.toMatchObject({ code: "OUTCOME_UNRESOLVED" });
    expect(queue.view(identity)).toMatchObject({
      paused: true,
      messageResumeAvailable: false,
    });
    queue.confirmMessage(identity, firstId, "failed");
    expect(queue.view(identity)).toMatchObject({
      paused: true,
      messageResumeAvailable: nextKind === "message",
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(ports.execute).not.toHaveBeenCalled();
    if (nextKind === "video") {
      await expect(
        queue.control(identity, "resume-message", undefined),
      ).rejects.toMatchObject({ code: "QUEUE_CONFLICT" });
      return;
    }
    await queue.control(identity, "resume-message", undefined);
    await vi.waitFor(() =>
      expect(queue.row(identity, nextId!)?.state).toBe("accepted"),
    );
    expect(
      sendMessage.mock.calls.map(([message]) => message.requestKey),
    ).toEqual([nextId]);
  },
);

it("recovers an unconfirmed send without replaying it or its duplicate", async () => {
  const { input, ports } = setup();
  const queue = new PublishQueue({
    ...ports,
    sendMessage: async (_message, _identity, beforeSubmit) => {
      await beforeSubmit();
      await new Promise(() => {});
    },
  });
  const message = {
    platform: "douyin" as const,
    accountId: input.accountId,
    profileUrl: "https://www.douyin.com/user/recipient",
    recipientName: "用户",
    text: "你好",
    requestKey: randomUUID(),
    source: { workId: "123456", commentId: "d".repeat(32) },
  };
  queue.enqueueMessage(identity, message);
  await vi.waitFor(() =>
    expect(queue.row(identity, message.requestKey)?.state).toBe("submitting"),
  );
  let finishRead!: (confirmed: boolean) => void;
  const platformReceipt = new Promise<boolean>((resolve) => {
    finishRead = resolve;
  });
  const verifyMessage = vi.fn(() => platformReceipt);
  const resumed = new PublishQueue({ ...ports, verifyMessage });
  expect(resumed.row(identity, message.requestKey)?.state).toBe("unknown");
  expect(() =>
    resumed.enqueueMessage(identity, { ...message, requestKey: randomUUID() }),
  ).toThrow(/等待核对/);
  await expect(resumed.control(identity, "resume", null)).rejects.toMatchObject(
    { code: "OUTCOME_UNRESOLVED" },
  );
  const checking = resumed.recoverMessageReceipt(identity);
  await vi.waitFor(() => expect(verifyMessage).toHaveBeenCalledTimes(1));
  resumed.confirmMessage(identity, message.requestKey, "sent");
  finishRead(true);
  await checking;
  expect(resumed.row(identity, message.requestKey)).toMatchObject({
    state: "accepted",
    resultSource: "manual",
  });
  await resumed.control(identity, "resume", null);
  expect(ports.execute).not.toHaveBeenCalled();
});

it("defers repeat sends per account, allowing a video and another account's private message through", async () => {
  const { input, ports, record } = setup();
  const checkpoint = new PublishQueue({
    ...ports,
    sendMessage: async (_input, _identity, before) => before(),
  });
  ports.execute.mockImplementation(async (entry) =>
    record(entry.artifactId, "accepted"),
  );
  const base = {
    platform: "douyin" as const,
    accountId: input.accountId,
    profileUrl: "https://www.douyin.com/user/recipient",
    recipientName: "甲",
    text: "正文",
    requestKey: randomUUID(),
  };
  checkpoint.enqueueMessage(identity, base);
  await vi.waitFor(() =>
    expect(checkpoint.row(identity, base.requestKey)?.state).toBe("accepted"),
  );
  const queued = checkpoint.enqueueMessage(identity, {
    ...base,
    text: "第二条",
    requestKey: randomUUID(),
  });
  expect(queued.state).toBe("queued");
  expect(queued.eligibleAt).toBeGreaterThan(Date.now() + 14 * 60000);
  const other = checkpoint.enqueueMessage(identity, {
    ...base,
    accountId: "f".repeat(32),
    requestKey: randomUUID(),
  });
  checkpoint.add(identity, input);
  await vi.waitFor(() =>
    expect(checkpoint.row(identity, other.id)?.state).toBe("accepted"),
  );
  await vi.waitFor(() => expect(ports.execute).toHaveBeenCalledTimes(2));
  checkpoint.stop();
  const restarted = new PublishQueue(ports);
  expect(restarted.row(identity, queued.id)?.eligibleAt).toBe(
    queued.eligibleAt,
  );
  const hour = 3600000,
    now = 100 * hour;
  expect(nextMessageTime([now - hour / 2, now - hour / 3], now)).toBe(
    now + hour / 2,
  );
  expect(
    nextMessageTime(
      Array.from({ length: 8 }, (_, i) => now - (i + 1) * hour),
      now,
    ),
  ).toBe(now + 16 * hour);
});
