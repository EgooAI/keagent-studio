import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { DouyinPublishRecord } from "@keagent/shared-types";
import { PublishQueue } from "./queue";

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
