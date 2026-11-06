import { describe, expect, it, vi } from "vitest";
import fixture from "../../../../packages/shared-types/fixtures/artifact-handoff.v1.json";
import type {
  ArtifactExchange,
  ArtifactHandoff,
  DouyinPublishInput,
  DouyinPublishRecord,
} from "@keagent/shared-types";
import {
  DirectPublisher,
  PublishingError,
  validateHandoff,
  type PublishPorts,
} from "./core";

function harness() {
  const handoff = structuredClone(fixture) as ArtifactHandoff;
  const identity = {
    userId: handoff.ownerId,
    deviceId: handoff.deviceId,
    generation: 1,
  };
  const account = "d".repeat(32);
  const input: DouyinPublishInput = {
    requestKey: "test-publish-key-0001",
    handoffId: handoff.id,
    accountId: account,
    title: "平台标题",
    description: "平台文案",
    hashtags: ["测试"],
  };
  const reports: DouyinPublishRecord[] = [];
  const persisted: DouyinPublishRecord[] = [];
  const order: string[] = [];
  const existing = new Map<string, DouyinPublishRecord>();
  const exchange = {
    getHandoff: vi.fn(async () => structuredClone(handoff)),
    getArtifact: vi.fn(async () => structuredClone(handoff.artifact)),
    getAsset: vi.fn(async (id: string) =>
      structuredClone(handoff.assets.find((asset) => asset.id === id)!),
    ),
  } as unknown as ArtifactExchange;
  const ports: PublishPorts = {
    identity: async () => ({ ...identity }),
    exchange,
    resolver: () => ({ resolve: vi.fn() }),
    snapshot: vi.fn(async () => ({
      video: "controlled-video.mp4",
      cover: "controlled-cover.png",
    })),
    cloud: vi.fn(async <T>(operation: string, value?: unknown): Promise<T> => {
      if (operation === "accounts/list")
        return { items: [{ id: account, deviceId: identity.deviceId }] } as T;
      if (operation === "records/create") {
        const prior = existing.get(input.requestKey);
        if (prior) return { record: prior, created: false } as T;
        const record = {
          ...(value as DouyinPublishInput),
          id: "e".repeat(32),
          ownerId: identity.userId,
          deviceId: identity.deviceId,
          artifactId: handoff.artifact.id,
          state: "running",
          progress: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          logs: [],
        } as DouyinPublishRecord;
        existing.set(input.requestKey, record);
        return { record, created: true } as T;
      }
      if (operation === "records/report") {
        const record = structuredClone(value) as DouyinPublishRecord;
        reports.push(record);
        order.push(`cloud:${record.state}`);
        return record as T;
      }
      return {} as T;
    }) as PublishPorts["cloud"],
    journal: (record) => {
      persisted.push(structuredClone(record));
      order.push(`journal:${record.state}`);
    },
    changed: () => {},
    cleanup: vi.fn(async () => {}),
    publish: vi.fn(async (_account, _input, _files, _signal, steps, before) => {
      await steps.run("upload_video", "上传视频", async () => {});
      await before();
      order.push("platform:create");
      return {
        externalId: "123456789012345",
        url: "https://www.douyin.com/video/123456789012345",
      };
    }),
  };
  return {
    handoff,
    identity,
    input,
    ports,
    reports,
    persisted,
    order,
    publisher: new DirectPublisher(ports),
  };
}
describe("direct artifact publishing boundary", () => {
  it("pins a handoff, saves the submission marker before its only external submit, and leaves source content unchanged", async () => {
    const h = harness();
    await h.publisher.start(h.input);
    await h.publisher.idle();
    expect(h.order.indexOf("journal:submitting")).toBeLessThan(
      h.order.indexOf("cloud:submitting"),
    );
    expect(h.order.indexOf("cloud:submitting")).toBeLessThan(
      h.order.indexOf("platform:create"),
    );
    expect(h.ports.publish).toHaveBeenCalledTimes(1);
    expect(h.reports.at(-1)?.state).toBe("accepted");
    expect(h.handoff).toEqual(fixture);
    expect(h.reports.at(-1)?.handoffId).toBe(h.handoff.id);
    expect(h.reports.at(-1)?.description).toBe("平台文案");
  });
  it("coalesces a double click while uploading and does not replay an existing record", async () => {
    const h = harness();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    h.ports.publish = vi.fn(async (_a, _i, _f, _s, _steps, before) => {
      await gate;
      await before();
      return {
        externalId: "123456789012345",
        url: "https://www.douyin.com/video/123456789012345",
      };
    });
    const first = await h.publisher.start(h.input);
    const second = await h.publisher.start(h.input);
    expect(second.id).toBe(first.id);
    await expect(
      h.publisher.start({ ...h.input, requestKey: "another-request-0001" }),
    ).rejects.toMatchObject({ code: "DEVICE_BUSY" });
    finish();
    await h.publisher.idle();
    await h.publisher.start(h.input);
    expect(h.ports.publish).toHaveBeenCalledTimes(1);
  });
  it("does not submit if the cloud submission acknowledgment is lost", async () => {
    const h = harness();
    const cloud = h.ports.cloud;
    h.ports.cloud = async <T>(op: string, value?: unknown) => {
      if (
        op === "records/report" &&
        (value as DouyinPublishRecord).state === "submitting"
      )
        throw new Error("network");
      return cloud<T>(op, value);
    };
    await h.publisher.start(h.input);
    await h.publisher.idle();
    expect(h.order).not.toContain("platform:create");
    expect(h.publisher.active?.state).toBe("unknown");
  });
  it("retains unknown after a navigation loses the final response, without replaying publication", async () => {
    const h = harness();
    h.ports.publish = vi.fn(async (_a, _i, _f, _s, _steps, before) => {
      await before();
      throw new Error("Execution context was destroyed");
    });
    await h.publisher.start(h.input);
    await h.publisher.idle();
    expect(h.publisher.active).toMatchObject({
      state: "unknown",
      errorCode: "PUBLISH_OUTCOME_UNKNOWN",
    });
    await h.publisher.start(h.input);
    expect(h.ports.publish).toHaveBeenCalledTimes(1);
  });
  it("blocks when the production resolver is missing", async () => {
    const h = harness();
    h.ports.resolver = () => undefined;
    await expect(h.publisher.start(h.input)).rejects.toMatchObject({
      code: "RESOLVER_UNAVAILABLE",
    });
    expect(h.ports.snapshot).not.toHaveBeenCalled();
    expect(h.ports.cloud).not.toHaveBeenCalled();
  });
  it("rechecks acceptance immediately before submitting", async () => {
    const h = harness();
    h.ports.publish = vi.fn(async (_a, _i, _f, _s, _steps, before) => {
      h.handoff.artifact.review.state = "rejected";
      await before();
      throw new Error("unreachable");
    });
    await h.publisher.start(h.input);
    await h.publisher.idle();
    expect(h.publisher.active).toMatchObject({
      state: "failed",
      errorCode: "NOT_APPROVED",
    });
    expect(h.reports.some((r) => r.state === "submitting")).toBe(false);
  });
  it("stops after logout or device identity changes", async () => {
    const h = harness();
    h.ports.publish = vi.fn(async (_a, _i, _f, _s, _steps, before) => {
      h.identity.generation++;
      await before();
      throw new Error("unreachable");
    });
    await h.publisher.start(h.input);
    await h.publisher.idle();
    expect(h.publisher.active).toMatchObject({
      state: "failed",
      errorCode: "SESSION_CHANGED",
    });
  });
  it.each([
    "wrong device",
    "withdrawn review",
    "changed review",
    "missing file",
    "changed metadata",
  ])("rejects %s", async (kind) => {
    const h = harness();
    const frozen = structuredClone(h.handoff);
    if (kind === "wrong device") h.identity.deviceId = "another-device";
    if (kind === "withdrawn review")
      h.handoff.artifact.review.state = "pending";
    if (kind === "changed review") h.handoff.artifact.review.revision++;
    if (kind === "missing file")
      h.handoff.assets[0].availability.state = "missing";
    if (kind === "changed metadata")
      h.handoff.assets[0].sha256 = "0".repeat(64);
    await expect(
      validateHandoff(h.ports.exchange, frozen, h.identity),
    ).rejects.toBeInstanceOf(PublishingError);
  });
});
