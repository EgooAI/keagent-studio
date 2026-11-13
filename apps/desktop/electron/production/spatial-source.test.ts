import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
const require = createRequire(import.meta.url);
const spatial = require("./spatial-source.cjs");
const sources = require("./sources.cjs");
const { PanoramaWorkflow } = require("../panorama/workflow.cjs");
const domain = require("../panorama/domain.cjs");
const media = require("../panorama/media.cjs");
const dns = require("node:dns/promises");
const https = require("node:https");
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    if (
      !root.startsWith(path.resolve("output/spatial-source-tests") + path.sep)
    )
      throw new Error("Unsafe test cleanup");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
const pageURL = "https://open.realsee.com/ke/example/";
const baseURL = "https://vr-public.realsee-cdn.cn/example/";
function rawWork() {
  return {
    code: "example-work",
    initial: { pano_index: 0 },
    model: {
      type: 0,
      file_url: baseURL + "model.at3d",
      material_base_url: baseURL,
      material_textures: [baseURL + "texture_0.jpg"],
    },
    observers: [0, 1].map((index) => ({
      index,
      position: [0, 0, -index],
      quaternion: { w: 1, x: 0, y: 0, z: 0 },
      accessible_nodes: [1 - index],
      visible_nodes: [1 - index],
    })),
    panorama: {
      type: 0,
      base_url: baseURL,
      list: [0, 1].map((index) => ({
        index,
        ...Object.fromEntries(
          ["right", "left", "up", "down", "front", "back"].map((face) => [
            face,
            `${index}-${face}.avif`,
          ]),
        ),
      })),
    },
  };
}
function fixture() {
  const parent = path.resolve("output/spatial-source-tests");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "case-"));
  roots.push(root);
  const workflow = new PanoramaWorkflow(root, "", {});
  const owner = workflow.owner("owner-a");
  const property = {
    id: "p",
    title: "空间导入测试",
    details: { vrUrl: pageURL },
  };
  const previous = { property, scenes: [{ id: "old", asset: "old.jpg" }] };
  workflow.store(owner).imports.p = previous;
  const bytes = Buffer.concat([
    Buffer.from([255, 216, 255]),
    Buffer.alloc(100),
  ]);
  vi.spyOn(media, "probe").mockImplementation(async (file: unknown) => ({
    streams: [
      {
        codec_type: "video",
        codec_name: "mjpeg",
        width:
          String(file).startsWith("pano-") ||
          String(file).startsWith("texture_")
            ? 512
            : 4096,
        height:
          String(file).startsWith("pano-") ||
          String(file).startsWith("texture_")
            ? 512
            : 2048,
      },
    ],
  }));
  vi.spyOn(media, "run").mockImplementation(async (...input: unknown[]) => {
    const args = input[1] as string[];
    const file = args.at(-1)!;
    fs.writeFileSync(
      path.join(String(input[2]), file),
      Buffer.concat([bytes, Buffer.from(file)]),
    );
  });
  vi.spyOn(spatial, "download").mockImplementation(async (url: unknown) =>
    url === pageURL
      ? Buffer.from(
          `<script type="application/json">${JSON.stringify({ firstscreen: { defaultWork: rawWork() } })}</script>`,
        )
      : Buffer.concat([bytes, Buffer.from(String(url))]),
  );
  return { workflow, owner, property, previous };
}

describe("Realsee spatial import", () => {
  it("parses only JSON and normalizes all network references into safe local assets", () => {
    const html = `<script>throw new Error('must not execute')</script><script type="application/json"><!--${JSON.stringify({ firstscreen: { defaultWork: rawWork() } })}--></script>`;
    const { work, assets } = spatial.normalizeWork(
      spatial.parseWork(html),
      pageURL,
    );
    expect(work.observers[0].quaternion).toEqual({ w: 1, x: 0, y: 0, z: 0 });
    expect(work.model.file_url).toBe("model.at3d");
    expect(work.model.material_textures).toEqual(["texture_0.jpg"]);
    expect(work.panorama.list[1].front).toBe("pano-1-front.avif");
    expect(JSON.stringify(work)).not.toContain("https:");
    expect(assets).toHaveLength(14);
    expect(spatial.targetsFor(work.observers, 0)).toEqual([
      { index: 1, label: "点位 2" },
    ]);
    expect(() =>
      spatial.parseWork("<script>globalThis.work = {}</script>"),
    ).toThrow("公开空间模型");
  });
  it("rejects unsupported hosts, invalid poses and nonexistent or duplicate positions", () => {
    for (const url of [
      "http://open.realsee.com/x",
      "https://open.realsee.com.evil.test/x",
      "https://u:p@open.realsee.com/x",
      "https://open.realsee.com:444/x",
    ])
      expect(() => spatial.sourceURL(url)).toThrow();
    for (const mutate of [
      (work: any) => {
        work.observers[0].position[0] = NaN;
      },
      (work: any) => {
        work.observers[0].quaternion.w = 0;
      },
      (work: any) => {
        work.observers[0].accessible_nodes = [99];
      },
      (work: any) => {
        work.observers[1].position = [0, 0, 0];
      },
      (work: any) => {
        work.panorama.list[1].index = 0;
      },
      (work: any) => {
        work.model.file_url = "https://127.0.0.1/model.at3d";
      },
    ]) {
      const work = rawWork();
      mutate(work);
      expect(() => spatial.normalizeWork(work, pageURL)).toThrow();
    }
  });
  it("pins public DNS and refuses redirects and private addresses", async () => {
    const lookup = vi
      .spyOn(dns, "lookup")
      .mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    let status = 200;
    const get = vi
      .spyOn(https, "get")
      .mockImplementation((...args: unknown[]) => {
        const options = args[1] as any;
        const done = args[2] as (response: any) => void;
        options.lookup(
          "open.realsee.com",
          {},
          (error: unknown, address: string) => {
            expect(error).toBeNull();
            expect(address).toBe("8.8.8.8");
          },
        );
        const response = Object.assign(new EventEmitter(), {
          statusCode: status,
          resume() {},
          destroy(error: Error) {
            response.emit("error", error);
          },
        });
        queueMicrotask(() => {
          done(response);
          response.emit("data", Buffer.from("example"));
          response.emit("end");
        });
        return new EventEmitter();
      });
    const signal = new AbortController().signal;
    expect(
      (await spatial.download(pageURL, signal, { bytes: 0 }, 100)).toString(),
    ).toBe("example");
    await expect(
      spatial.download(pageURL, signal, { bytes: 0 }, 2),
    ).rejects.toThrow("大小限制");
    status = 302;
    await expect(
      spatial.download(pageURL, signal, { bytes: 0 }, 100),
    ).rejects.toThrow("HTTP 302");
    lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const calls = get.mock.calls.length;
    await expect(
      spatial.download(pageURL, signal, { bytes: 0 }, 100),
    ).rejects.toThrow("内网");
    expect(get).toHaveBeenCalledTimes(calls);
  });
  it("atomically replaces the gallery, keeps stable scene IDs and preserves source metadata", async () => {
    const { workflow, owner, property } = fixture();
    const result = await spatial.importProperty(
      workflow,
      owner,
      property,
      { propertyId: "p" },
      () => {},
    );
    expect(result.count).toBe(2);
    expect(result.scenes[0]).toMatchObject({
      yaw: 0,
      spatial: { panoIndex: 0, targetPanoIndex: 1 },
    });
    const workFile = path.join(
      workflow.directory(owner),
      "spatial",
      result.workId,
      "work.json",
    );
    expect(domain.hash(fs.readFileSync(workFile))).toBe(result.workId);
    const saved = JSON.parse(fs.readFileSync(workFile, "utf8"));
    for (const asset of saved._keagent.assets)
      expect(
        domain.hash(
          fs.readFileSync(path.join(path.dirname(workFile), asset.file)),
        ),
      ).toBe(asset.sha256);
    expect(saved._keagent.panoramas).toEqual(
      result.scenes.map((scene: any) => ({
        index: scene.spatial.panoIndex,
        asset: scene.asset,
      })),
    );
    const first = result.scenes[0];
    expect(
      spatial.validateSpatialScene(workflow.directory(owner), {
        ...first,
        spatial: {
          ...first.spatial,
          targets: [{ index: 999, label: "forged" }],
        },
      }),
    ).toEqual(first.spatial);
    expect(() =>
      spatial.validateSpatialScene(workflow.directory(owner), {
        ...first,
        asset: result.scenes[1].asset,
      }),
    ).toThrow("不匹配");
    expect(() =>
      spatial.validateSpatialScene(workflow.directory(owner), {
        ...first,
        spatial: { ...first.spatial, targetPanoIndex: 0 },
      }),
    ).toThrow("不可达");
    expect(() =>
      spatial.validateSpatialScene(workflow.directory(owner), {
        ...first,
        spatial: { ...first.spatial, workId: "../x" },
      }),
    ).toThrow("标识无效");
    fs.appendFileSync(workFile, " ");
    expect(() =>
      spatial.validateSpatialScene(workflow.directory(owner), first),
    ).toThrow("校验失败");
    fs.writeFileSync(workFile, JSON.stringify(saved, null, 2) + "\n");
    const repeated = await spatial.importProperty(
      workflow,
      owner,
      property,
      { propertyId: "p" },
      () => {},
    );
    expect(repeated.scenes.map((scene: any) => scene.id)).toEqual(
      result.scenes.map((scene: any) => scene.id),
    );
    const restored = await sources.handle(
      workflow,
      owner,
      "source-restore",
      { propertyId: "p" },
      () => {},
    );
    expect(restored.scenes[0].spatial).toEqual(result.scenes[0].spatial);
    expect(restored.spatial.workId).toBe(result.workId);
    await expect(
      spatial.importProperty(
        workflow,
        owner,
        undefined,
        { propertyId: "p", property },
        () => {},
      ),
    ).rejects.toThrow("房源不存在");
  });
  it("retains the prior gallery when the final checkpoint cannot be saved", async () => {
    const { workflow, owner, property, previous } = fixture();
    const persist = workflow.persist.bind(workflow);
    vi.spyOn(workflow, "persist").mockImplementation((value: unknown) => {
      if (workflow.store(owner).imports.p !== previous)
        throw new Error("disk full");
      persist(String(value));
    });
    await expect(
      spatial.importProperty(
        workflow,
        owner,
        property,
        { propertyId: "p" },
        () => {},
      ),
    ).rejects.toThrow("disk full");
    expect(workflow.store(owner).imports.p).toBe(previous);
  });
});
