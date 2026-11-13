import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const {
  verifyWorks,
  shotOptions,
  assertFrameVisible,
} = require("./spatial-render.cjs");
const { normalizeWork } = require("./spatial-source.cjs");
const { hash } = require("../panorama/domain.cjs");
const roots: string[] = [];
const source = "https://open.realsee.com/ke/example/";
const cdn = "https://vr-public.realsee-cdn.cn/example/";
const faces = ["right", "left", "up", "down", "front", "back"];
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

afterEach(() => {
  for (const root of roots.splice(0)) {
    if (
      !root.startsWith(path.resolve("output/spatial-render-tests") + path.sep)
    )
      throw new Error("Unsafe test cleanup");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function importedWork() {
  const parent = path.resolve("output/spatial-render-tests");
  fs.mkdirSync(parent, { recursive: true });
  const ownerDir = fs.mkdtempSync(path.join(parent, "case-"));
  roots.push(ownerDir);
  const { work, assets } = normalizeWork(
    {
      code: "example-work",
      model: {
        type: 0,
        file_url: cdn + "model.at3d",
        material_textures: [cdn + "texture.jpg"],
      },
      observers: [0, 1].map((index) => ({
        index,
        position: [0, 0, -index || 0],
        quaternion: { w: 1, x: 0, y: 0, z: 0 },
        accessible_nodes: [1 - index],
      })),
      panorama: {
        type: 0,
        base_url: cdn,
        list: [0, 1].map((index) => ({
          index,
          ...Object.fromEntries(
            faces.map((face) => [face, `${index}-${face}.avif`]),
          ),
        })),
      },
    },
    source,
  );
  for (const asset of assets) {
    const content = Buffer.from(asset.file);
    Object.assign(asset, { sha256: hash(content), bytes: content.length });
  }
  const panoramas = [0, 1].map((index) => ({
    index,
    asset: `${hash(String(index))}.jpg`,
  }));
  work._keagent = {
    schemaVersion: 1,
    assets: assets.map(
      ({
        file,
        sha256,
        bytes,
      }: {
        file: string;
        sha256: string;
        bytes: number;
      }) => ({ file, sha256, bytes }),
    ),
    panoramas,
  };
  const workId = hash(json(work));
  const directory = path.join(ownerDir, "spatial", workId);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "work.json"), json(work));
  for (const asset of assets)
    fs.writeFileSync(path.join(directory, asset.file), asset.file);
  const provenance = {
    schemaVersion: 1,
    workId,
    workCode: work.code,
    source,
    assets,
  };
  fs.writeFileSync(path.join(directory, "source.json"), json(provenance));
  const scene = {
    asset: panoramas[0].asset,
    yaw: 35,
    spatial: { workId, panoIndex: 0, targetPanoIndex: 1 },
  };
  return { ownerDir, directory, work, provenance, scene };
}

describe("spatial capture preflight", () => {
  it("rejects unloaded black frames even with opaque alpha or a stray bright pixel", () => {
    const black = Buffer.alloc(128 * 128 * 4);
    const nearBlack = Buffer.alloc(black.length, 8);
    for (let offset = 3; offset < black.length; offset += 4) {
      black[offset] = 255;
      nearBlack[offset] = 255;
    }
    for (const pixels of [Buffer.alloc(0), black, nearBlack])
      expect(() => assertFrameVisible(pixels)).toThrow("空白画面");
    black[0] = 255;
    expect(() => assertFrameVisible(black)).toThrow("空白画面");
  });

  it("accepts a textured room and a uniformly bright wall without requiring image variance", () => {
    const wall = Buffer.alloc(128 * 128 * 4, 210);
    const room = Buffer.alloc(wall.length);
    for (let offset = 0; offset < wall.length; offset += 4) {
      wall[offset + 3] = 255;
      const value = 30 + (Math.floor(offset / 512) % 200);
      room[offset] = value;
      room[offset + 1] = Math.floor(value * 0.8);
      room[offset + 2] = Math.floor(value * 0.6);
      room[offset + 3] = 255;
    }
    expect(() => assertFrameVisible(room)).not.toThrow();
    expect(() => assertFrameVisible(wall)).not.toThrow();
  });

  it("preserves frame timing and converts horizontal field of view for portrait and landscape", () => {
    const scene = {
      yaw: 35,
      spatial: { workId: "a".repeat(64), panoIndex: 2, targetPanoIndex: 3 },
    };
    const portrait = shotOptions(
      { scene, frames: 90, fps: 30 },
      { aspectRatio: "9:16", resolution: "720p" },
    );
    expect(portrait).toMatchObject({
      width: 720,
      height: 1280,
      frames: 90,
      fps: 30,
      yaw: 35,
      from: 2,
      to: 3,
    });
    expect(portrait.vFov).toBeCloseTo(116.0123, 3);
    const landscape = shotOptions(
      { scene, frames: 48, fps: 24 },
      { aspectRatio: "16:9", resolution: "1080p" },
    );
    expect(landscape).toMatchObject({
      width: 1920,
      height: 1080,
      frames: 48,
      fps: 24,
    });
    expect(landscape.vFov).toBeCloseTo(67.6727, 3);
    const config = { aspectRatio: "9:16", resolution: "720p" };
    expect(() =>
      shotOptions({ scene, frames: 3600, fps: 60 }, config),
    ).not.toThrow();
    for (const [frames, fps] of [
      [1, 30],
      [90.5, 30],
      [90, 0],
      [90, 61],
      [90, 29.97],
      [3601, 60],
      [NaN, 30],
      [90, Infinity],
    ])
      expect(() => shotOptions({ scene, frames, fps }, config)).toThrow(
        "时长或帧率无效",
      );
  });

  it("loads the frozen import and returns the original viewer and asset references", async () => {
    const { ownerDir, scene, work, provenance } = importedWork();
    const works = await verifyWorks([{ scene }, { scene }], ownerDir);
    expect(works.size).toBe(1);
    const saved = works.get(scene.spatial.workId);
    expect(saved.source).toBe(source);
    expect(saved.expected).toMatchObject({
      code: work.code,
      observers: work.observers,
      modelURL: cdn + "model.at3d",
      textureURLs: [cdn + "texture.jpg"],
    });
    expect(saved.expected.panoramas[1].front).toBe(cdn + "1-front.avif");
    expect(saved.files.size).toBe(provenance.assets.length + 1);
  });

  it("rejects a changed frozen model, source asset, or node image association", async () => {
    const { ownerDir, directory, scene, work } = importedWork();
    fs.appendFileSync(path.join(directory, "work.json"), " ");
    await expect(verifyWorks([{ scene }], ownerDir)).rejects.toThrow(
      "校验失败",
    );
    fs.writeFileSync(path.join(directory, "work.json"), json(work));
    await expect(
      verifyWorks(
        [{ scene: { ...scene, asset: "b".repeat(64) + ".jpg" } }],
        ownerDir,
      ),
    ).rejects.toThrow("点位不匹配");
    fs.writeFileSync(path.join(directory, "model.at3d"), "changed");
    await expect(verifyWorks([{ scene }], ownerDir)).rejects.toThrow(
      "素材已变更",
    );
  });

  it("rejects mismatched provenance and unapproved viewer or asset URLs before capture", async () => {
    const { ownerDir, directory, scene, provenance } = importedWork();
    const invalid = [
      { ...provenance, workId: "b".repeat(64) },
      { ...provenance, workCode: "another-work" },
      { ...provenance, assets: provenance.assets.slice(1) },
      { ...provenance, source: "https://127.0.0.1/viewer" },
      {
        ...provenance,
        assets: provenance.assets.map((asset: object, index: number) =>
          index ? asset : { ...asset, sha256: "b".repeat(64) },
        ),
      },
      {
        ...provenance,
        assets: provenance.assets.map((asset: object, index: number) =>
          index
            ? asset
            : {
                ...asset,
                source: "https://vr-public.realsee-cdn.cn.evil.test/model.at3d",
              },
        ),
      },
    ];
    for (const record of invalid) {
      fs.writeFileSync(path.join(directory, "source.json"), json(record));
      await expect(verifyWorks([{ scene }], ownerDir)).rejects.toThrow(
        /来源|仅支持|域名/,
      );
    }
  });
});
