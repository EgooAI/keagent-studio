import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type {
  MediaAsset,
  RegisterMediaAssetInput,
  VideoArtifact,
  CreateArtifactInput,
} from "@keagent/shared-types";
import { LocalMediaRegistry, type MediaProbe } from "./registry";
import {
  ArtifactRegistrationService,
  type CompletedArtifactOutput,
  type RegistryExchange,
} from "./service";
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});
async function setup() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "keagent-registry-test-"),
  );
  directories.push(root);
  const identity = { userId: "owner", deviceId: "device", generation: 1 };
  const probe = vi.fn<MediaProbe>(async (_file, kind) =>
    kind === "video"
      ? {
          kind,
          mimeType: "video/mp4",
          width: 720,
          height: 1280,
          durationMs: 4000,
        }
      : { kind, mimeType: "image/jpeg", width: 720, height: 1280 },
  );
  const registry = new LocalMediaRegistry(
    path.join(root, "registry"),
    async () => identity,
    probe,
  );
  const file = path.join(root, "controlled.mp4");
  await fs.writeFile(file, "explicit controlled test video");
  const cover = path.join(root, "controlled.jpg");
  await fs.writeFile(cover, "explicit controlled test cover");
  let count = 0;
  const assets = new Map<string, MediaAsset>();
  const requests = new Map<string, MediaAsset>();
  let artifact: VideoArtifact | undefined;
  const exchange: RegistryExchange = {
    registerAsset: vi.fn(async (input: RegisterMediaAssetInput) => {
      const prior = requests.get(input.requestKey);
      if (prior) return structuredClone(prior);
      const { requestKey: _key, fileToken, ...metadata } = input;
      const asset: MediaAsset = {
        ...metadata,
        id: String(++count).padStart(32, "a"),
        schemaVersion: 1,
        ownerId: identity.userId,
        location: { kind: "local", deviceId: identity.deviceId, fileToken },
        availability: {
          state: "available",
          revision: 1,
          reportedAt: new Date().toISOString(),
        },
        createdAt: new Date().toISOString(),
      };
      assets.set(asset.id, asset);
      requests.set(input.requestKey, asset);
      return structuredClone(asset);
    }),
    createArtifact: vi.fn(async (input: CreateArtifactInput) => {
      artifact = {
        id: "b".repeat(32),
        schemaVersion: 1,
        ownerId: identity.userId,
        source: input.source,
        content: input.content,
        assets: input.assets,
        review: { state: "pending", revision: 1 },
        createdAt: new Date().toISOString(),
      };
      return structuredClone(artifact);
    }),
    getArtifact: vi.fn(async () => structuredClone(artifact!)),
    getAsset: vi.fn(async (id) => structuredClone(assets.get(id)!)),
    reportAvailability: vi.fn(async (input) => {
      const asset = assets.get(input.id)!;
      asset.availability = {
        state: input.state,
        revision: asset.availability.revision + 1,
        reportedAt: new Date().toISOString(),
      };
      return structuredClone(asset);
    }),
  };
  const output: CompletedArtifactOutput = {
    source: {
      producer: "panorama",
      taskId: "11111111-1111-4111-8111-111111111111",
      revision: 1,
    },
    content: {
      title: "实际制作任务的成片",
      script: "已完成的最终文案",
      property: { id: "property", title: "房源" },
    },
    files: { video: file, cover },
    sample: false,
  };
  return {
    root,
    identity,
    registry,
    probe,
    file,
    assets,
    exchange,
    output,
    service: new ArtifactRegistrationService(registry, exchange),
  };
}
describe("shared local media registry", () => {
  it("does not coalesce different content into an in-flight immutable source version", async () => {
    const h = await setup();
    let begin!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => (begin = resolve));
    const gate = new Promise<void>((resolve) => (finish = resolve));
    h.probe.mockImplementationOnce(async () => {
      begin();
      await gate;
      return {
        kind: "video",
        mimeType: "video/mp4",
        width: 720,
        height: 1280,
        durationMs: 4000,
      };
    });
    const first = h.service.register(h.output);
    await started;
    await expect(
      h.service.register({
        ...h.output,
        content: { ...h.output.content, title: "another title" },
      }),
    ).rejects.toMatchObject({ code: "SOURCE_OUTPUT_CHANGED" });
    finish();
    expect((await first).content.title).toBe(h.output.content.title);
  });
  it("registers actual bytes, survives restart and resolves through token bindings only", async () => {
    const h = await setup();
    const result = await h.service.register(h.output);
    expect(result.review).toEqual({ state: "pending", revision: 1 });
    expect(h.exchange.registerAsset).toHaveBeenCalledTimes(2);
    const asset = h.assets.get(result.assets.video)!;
    const resolved = await h.registry.resolve(asset);
    expect(resolved.absolutePath).not.toBe(h.file);
    expect(resolved.sha256).toBe(
      createHash("sha256")
        .update("explicit controlled test video")
        .digest("hex"),
    );
    await fs.writeFile(h.file, "producer file changed after registration");
    expect(await fs.readFile(resolved.absolutePath, "utf8")).toBe(
      "explicit controlled test video",
    );
    const restarted = new LocalMediaRegistry(
      path.join(h.root, "registry"),
      async () => h.identity,
      h.probe,
    );
    expect(await restarted.resolve(asset)).toEqual(resolved);
  });
  it("replays a completed source without resetting approval or creating new assets", async () => {
    const h = await setup();
    const artifact = await h.service.register(h.output);
    const get = vi.mocked(h.exchange.getArtifact);
    get.mockResolvedValue({
      ...artifact,
      review: { state: "approved", revision: 2 },
    });
    expect((await h.service.register(h.output)).review.state).toBe("approved");
    expect(h.exchange.registerAsset).toHaveBeenCalledTimes(2);
    expect(h.exchange.createArtifact).toHaveBeenCalledTimes(1);
    await expect(
      h.service.register({
        ...h.output,
        content: { ...h.output.content, title: "changed" },
      }),
    ).rejects.toMatchObject({ code: "SOURCE_OUTPUT_CHANGED" });
  });
  it("coalesces repeated registration and resumes an interrupted cloud create with stable asset keys", async () => {
    const h = await setup();
    const original = h.exchange.createArtifact;
    vi.mocked(h.exchange.createArtifact).mockRejectedValueOnce(
      new Error("connection lost"),
    );
    await expect(h.service.register(h.output)).rejects.toThrow(
      "connection lost",
    );
    h.exchange.createArtifact = original;
    const [first, second] = await Promise.all([
      h.service.register(h.output),
      h.service.register(h.output),
    ]);
    expect(first.id).toBe(second.id);
    expect(h.assets.size).toBe(2);
  });
  it("blocks foreign owners, devices, altered asset IDs and token rebinding", async () => {
    const h = await setup();
    const artifact = await h.service.register(h.output);
    const asset = h.assets.get(artifact.assets.video)!;
    await expect(
      h.registry.resolve({ ...asset, ownerId: "other" }),
    ).rejects.toMatchObject({ code: "WRONG_DEVICE" });
    await expect(
      h.registry.resolve({
        ...asset,
        location: { ...asset.location, deviceId: "other" },
      }),
    ).rejects.toMatchObject({ code: "WRONG_DEVICE" });
    await expect(
      h.registry.resolve({ ...asset, id: "c".repeat(32) }),
    ).rejects.toMatchObject({ code: "ASSET_CHANGED" });
    await expect(
      h.registry.bind({ ...asset, id: "c".repeat(32) }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
  it("requires an exact file before restoring a missing mapping and reporting available", async () => {
    const h = await setup();
    const artifact = await h.service.register(h.output);
    const asset = h.assets.get(artifact.assets.video)!;
    const { directory } = await h.registry.context();
    await fs.rm(
      path.join(directory, "tokens", `${asset.location.fileToken}.json`),
    );
    await expect(h.registry.resolve(asset)).rejects.toMatchObject({
      code: "ASSET_UNAVAILABLE",
    });
    const wrong = path.join(h.root, "wrong.mp4");
    await fs.writeFile(wrong, "wrong bytes");
    await expect(h.service.restore(asset, wrong)).rejects.toMatchObject({
      code: "FILE_MISMATCH",
    });
    expect(h.exchange.reportAvailability).not.toHaveBeenCalled();
    asset.availability.state = "missing";
    await h.service.restore(asset, h.file);
    expect((await h.registry.resolve(asset)).sha256).toBe(asset.sha256);
    expect(h.exchange.reportAvailability).toHaveBeenCalledWith({
      id: asset.id,
      expectedRevision: 1,
      state: "available",
    });
  });
  it("never repairs by guessing paths when the file itself disappears or the mapping escapes its scope", async () => {
    const h = await setup();
    const artifact = await h.service.register(h.output);
    const asset = h.assets.get(artifact.assets.video)!;
    const resolved = await h.registry.resolve(asset);
    await fs.rm(resolved.absolutePath);
    await expect(h.registry.resolve(asset)).rejects.toMatchObject({
      code: "ASSET_UNAVAILABLE",
    });
    const { directory } = await h.registry.context();
    const map = path.join(
      directory,
      "tokens",
      `${asset.location.fileToken}.json`,
    );
    const entry = JSON.parse(await fs.readFile(map, "utf8"));
    entry.relative = "../outside.mp4";
    await fs.writeFile(map, JSON.stringify(entry));
    await expect(h.registry.resolve(asset)).rejects.toMatchObject({
      code: "REGISTRY_CORRUPTED",
    });
  });
  it("stops a registration after identity changes before any cloud write", async () => {
    const h = await setup();
    h.probe.mockImplementationOnce(async () => {
      h.identity.generation++;
      return {
        kind: "video",
        mimeType: "video/mp4",
        width: 720,
        height: 1280,
        durationMs: 4000,
      };
    });
    await expect(h.service.register(h.output)).rejects.toMatchObject({
      code: "SESSION_CHANGED",
    });
    expect(h.exchange.registerAsset).not.toHaveBeenCalled();
  });
  it("does not register sample outputs as real production artifacts", async () => {
    const h = await setup();
    await expect(
      h.service.register({ ...h.output, sample: true }),
    ).rejects.toMatchObject({ code: "SAMPLE_NOT_PUBLISHABLE" });
    expect(h.exchange.registerAsset).not.toHaveBeenCalled();
  });
});
