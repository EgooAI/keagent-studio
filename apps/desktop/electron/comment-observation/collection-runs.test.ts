import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { CollectionRun, CommentObservation } from "@keagent/shared-types";
import { CollectionRunService } from "./collection-runs";
import { ObservationRecorder } from "./observation-recorder";

vi.mock("electron", () => ({ dialog: {}, nativeImage: {} }));

const identity = {
  userId: "test-owner",
  deviceId: "test-device",
  generation: 1,
};
const newRun: CollectionRun = {
  id: "1".repeat(32),
  targetId: "2".repeat(32),
  accountId: "3".repeat(32),
  deviceId: identity.deviceId,
  targetName: "测试视频",
  targetVersion: 1,
  inputWorkId: "10001",
  targetUrl: "https://www.douyin.com/video/10001",
  state: "queued",
  panelStatus: "not_checked",
  createdAt: new Date().toISOString(),
};
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { force: true, recursive: true });
});

it("aborts the matching observation even if a successful claim arrives after target cancellation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "collection-claim-"));
  roots.push(root);
  let deliverClaim!: (run: CollectionRun) => void;
  const request = vi.fn(async (route: string) => {
    if (route.endsWith("/create")) return newRun;
    if (route.endsWith("/claim"))
      return new Promise<CollectionRun>((resolve) => {
        deliverClaim = resolve;
      });
    throw new Error("Unexpected route: " + route);
  });
  const started = new Set<string>();
  const canceled: string[] = [];
  const service = new CollectionRunService(
    {
      get: () => undefined,
      start: (_identity, accountId, targetUrl, _screenshot, id = newRun.id) => {
        started.add(id);
        return {
          id,
          accountId,
          targetUrl: String(targetUrl),
          state: "queued",
          inputWorkId: newRun.inputWorkId,
          startedAt: newRun.createdAt,
          deviceId: identity.deviceId,
          panelStatus: "not_checked",
        };
      },
      cancel: (_identity, id) => {
        if (started.delete(id)) canceled.push(id);
      },
    },
    async () => identity,
    request,
    () => root,
    () => {},
  );
  const begin = service.start(identity, {
    targetId: newRun.targetId,
    expectedVersion: 1,
    requestKey: "manual-request-key-001",
  });
  await vi.waitFor(() => expect(deliverClaim).toBeTypeOf("function"));
  const stop = service.targetStopped(identity, newRun.id);
  deliverClaim({ ...newRun, state: "running" });
  await Promise.all([begin, stop]);
  expect(canceled).toEqual([newRun.id]);
  expect(started.size).toBe(0);
});

it.each(["finished", "running"] as const)(
  "recovers a %s observation without reopening the work",
  async (localState) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "collection-run-"));
    roots.push(root);
    const recorder = new ObservationRecorder(
      path.join(root, "comment-observation"),
    );
    let leaseToken: string | undefined;
    let cloudState: CollectionRun["state"] = "queued";
    let online = true;
    let active = false;
    let onFinished: (() => void) | undefined;
    const observe = vi.fn(
      (_identity, accountId, targetUrl, _screenshot, id, done) => {
        expect(id).toBe(newRun.id);
        active = true;
        onFinished = done;
        const record: CommentObservation = {
          id,
          accountId,
          deviceId: identity.deviceId,
          targetUrl,
          inputWorkId: "10001",
          panelStatus: "not_checked",
          state: "running",
          startedAt: newRun.createdAt,
        };
        recorder.save(record);
        return record;
      },
    );
    const request = vi.fn(async (route: string, input: unknown) => {
      const body = input as {
        leaseToken?: string;
        state?: CollectionRun["state"];
      };
      const run = () => ({ ...newRun, state: cloudState });
      if (route.endsWith("/list"))
        return { items: cloudState === "queued" ? [run()] : [] };
      if (route.endsWith("/create")) return run();
      if (route.endsWith("/claim")) {
        leaseToken = body.leaseToken;
        cloudState = "running";
        return run();
      }
      expect(body.leaseToken).toBe(leaseToken);
      if (route.endsWith("/finish")) {
        if (!online) throw new Error("offline");
        cloudState = body.state!;
      }
      return run();
    });
    const service = () =>
      new CollectionRunService(
        {
          get: (_identity, id) => recorder.get(id, active),
          start: observe,
          cancel: vi.fn(),
        },
        async () => identity,
        request,
        () => root,
        () => {},
      );
    const first = service();
    // A run created before its IPC response was delivered must be found without the UI.
    await first.recover();
    expect(observe).toHaveBeenCalledTimes(1);
    const pending = path.join(root, "collection-runs", newRun.id + ".json");
    expect(JSON.parse(fs.readFileSync(pending, "utf8")).leaseToken).toBe(
      leaseToken,
    );
    active = false;
    if (localState === "finished") {
      recorder.save({
        ...recorder.get(newRun.id, true)!,
        state: "finished",
        endedAt: newRun.createdAt,
        verifiedWorkId: "10001",
        author: {
          name: "测试作者",
          url: "https://www.douyin.com/user/example",
        },
        panelStatus: "explicitly_empty",
      });
      online = false;
      onFinished!();
      await vi.waitFor(() =>
        expect(request.mock.calls.some(([r]) => r.endsWith("/finish"))).toBe(
          true,
        ),
      );
      expect(fs.existsSync(pending)).toBe(true);
    }
    online = true;
    await service().recover();
    expect(cloudState).toBe(
      localState === "finished" ? "succeeded" : "interrupted",
    );
    expect(observe).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(pending)).toBe(false);
  },
);
