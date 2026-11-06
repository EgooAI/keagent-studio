import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { dialog } from "electron";
import fixture from "../../../../packages/shared-types/fixtures/artifact-handoff.v1.json";
import type {
  ArtifactHandoff,
  LocalMediaAssetResolver,
} from "@keagent/shared-types";
import { PublishingFiles } from "./files";
vi.mock("electron", () => ({
  dialog: { showOpenDialog: vi.fn() },
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => false }) },
}));
const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);
function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "douyin-files-"));
  roots.push(root);
  const handoff = structuredClone(fixture) as ArtifactHandoff;
  const locations = new Map<string, string>();
  for (const asset of handoff.assets) {
    const bytes = Buffer.from(`controlled-test-${asset.kind}`);
    const file = path.join(root, `${asset.kind}.test`);
    writeFileSync(file, bytes);
    asset.byteSize = bytes.length;
    asset.sha256 = createHash("sha256").update(bytes).digest("hex");
    locations.set(asset.id, file);
  }
  const identity = {
    userId: handoff.ownerId,
    deviceId: handoff.deviceId,
    generation: 1,
  };
  const resolver: LocalMediaAssetResolver = {
    resolve: async (asset) => ({
      assetId: asset.id,
      absolutePath: locations.get(asset.id)!,
      sha256: asset.sha256,
      byteSize: asset.byteSize,
    }),
  };
  return {
    root,
    handoff,
    locations,
    identity,
    resolver,
    files: new PublishingFiles(
      path.join(root, "consumer"),
      async () => identity,
      {} as never,
    ),
  };
}
it("copies and verifies fixed bytes without exposing local paths in previews", async () => {
  const h = setup();
  const snapshot = await h.files.snapshot(
    "controlled-request-0001",
    h.handoff.assets,
    h.resolver,
  );
  expect(readFileSync(snapshot.video).toString()).toBe("controlled-test-video");
  const preview = await h.files.preview(h.handoff.assets, h.resolver);
  expect(preview.video).toMatch(/^keagent:\/\/douyin\/preview\/[a-f0-9]{32}$/);
  expect(JSON.stringify(preview)).not.toContain(h.root);
});
it("rejects changed real bytes even when the resolver repeats old metadata", async () => {
  const h = setup();
  writeFileSync(h.locations.get(h.handoff.assets[0].id)!, "changed bytes");
  await expect(
    h.files.snapshot("controlled-request-0001", h.handoff.assets, h.resolver),
  ).rejects.toMatchObject({ code: "ASSET_CHANGED" });
});
it("does not guess file paths when a token mapping is missing", async () => {
  const h = setup();
  h.resolver.resolve = async () => {
    throw new Error("private path must not escape");
  };
  await expect(
    h.files.snapshot("controlled-request-0001", h.handoff.assets, h.resolver),
  ).rejects.toMatchObject({ code: "ASSET_UNAVAILABLE" });
  await expect(
    h.files.media(new URL("keagent://douyin/cover/not-a-token")),
  ).rejects.toThrow();
});
it("keeps a selected PNG cover as a consumer-only opaque reference", async () => {
  const h = setup();
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC9sAAAAASUVORK5CYII=",
    "base64",
  );
  const file = path.join(h.root, "replacement.png");
  writeFileSync(file, png);
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({
    canceled: false,
    filePaths: [file],
  });
  const cover = await h.files.cover();
  expect(cover).not.toHaveProperty("absolutePath");
  const snapshot = await h.files.snapshot(
    "controlled-request-0001",
    h.handoff.assets,
    h.resolver,
    cover.ref,
  );
  expect(snapshot.cover.endsWith(".png")).toBe(true);
  expect(readFileSync(snapshot.cover)).toEqual(png);
  expect(h.handoff.artifact.assets.cover).toBe(fixture.artifact.assets.cover);
  const scope = await h.files.directory();
  h.identity.userId = "another-user";
  expect(await h.files.directory()).not.toBe(scope);
  await expect(h.files.media(new URL(cover.url))).rejects.toMatchObject({
    code: "COVER_MISSING",
  });
});
