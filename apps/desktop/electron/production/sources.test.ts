import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
const require = createRequire(import.meta.url);
const { PanoramaWorkflow } = require("../panorama/workflow.cjs");
const domain = require("../panorama/domain.cjs");
const media = require("../panorama/media.cjs");
const providers = require("../panorama/providers.cjs");
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    if (
      !root.startsWith(
        path.resolve("output/production-source-tests") + path.sep,
      )
    )
      throw new Error("Unsafe cleanup path");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const parent = path.resolve("output/production-source-tests");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "case-"));
  roots.push(root);
  const workflow = new PanoramaWorkflow(root, "", {});
  const bytes = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff]),
    Buffer.alloc(90, 10),
  ]);
  vi.spyOn(media, "probe").mockResolvedValue({
    streams: [{ codec_name: "mjpeg", width: 2048, height: 1024 }],
  });
  vi.spyOn(providers, "downloadImage").mockResolvedValue(bytes);
  const property = {
    id: "beike-test",
    title: "测试房屋",
    areaSqm: 0,
    priceCents: 0,
    layout: "",
    description: "",
    sellingPoints: [],
  };
  workflow.remote = vi.fn(async () => ({
    property,
    images: [
      {
        url: "https://p.ljcdn.com/photo.jpg",
        room: "客厅",
        description: "白色墙面",
      },
    ],
    panoramas: [],
  }));
  return { workflow, bytes, property };
}
describe("production sources", () => {
  it("prefers validated panorama assets over photographs and isolates cached sources by user", async () => {
    const { workflow, property } = fixture();
    workflow.remote.mockResolvedValue({
      property,
      images: [{ url: "https://p.ljcdn.com/photo.jpg", room: "照片" }],
      panoramas: [{ url: "https://p.ljcdn.com/pano.jpg", room: "全景" }],
    });
    const source = await workflow.handle("a", "beike-import", {});
    expect(source.materialMode).toBe("panorama");
    expect(source.scenes[0].kind).toBe("panorama");
    expect(providers.downloadImage).toHaveBeenCalledTimes(1);
    expect(providers.downloadImage.mock.calls[0][0]).toContain("pano.jpg");
    expect(
      (
        await workflow.handle("a", "source-restore", {
          propertyId: property.id,
        })
      ).scenes,
    ).toHaveLength(1);
    await expect(
      workflow.handle("b", "source-restore", { propertyId: property.id }),
    ).rejects.toThrow("没有");
  });
  it("blocks raw photos and requires review of actual expansion output before script generation", async () => {
    const { workflow } = fixture();
    const source = await workflow.handle("a", "beike-import", {});
    const config = { ...domain.defaultConfig, materialMode: "expand" };
    await expect(
      workflow.handle("a", "generate", {
        propertyId: source.property.id,
        scenes: source.scenes,
        config,
      }),
    ).rejects.toThrow("须先完成");
    const owner = workflow.owner("a");
    const raw = source.scenes[0];
    const expanded = await workflow.importBytes(
      owner,
      Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(90, 11)]),
      "客厅",
      "expanded",
    );
    await expect(
      workflow.handle("a", "generate", {
        propertyId: source.property.id,
        scenes: [expanded],
        config,
      }),
    ).rejects.toThrow("审核");
    const draft = await workflow.handle("a", "generate", {
      propertyId: source.property.id,
      scenes: [
        {
          ...expanded,
          approved: true,
          sourceAsset: raw.asset,
          description: "已核对墙面",
        },
      ],
      config,
    });
    expect(draft.scenes[0]).toMatchObject({ kind: "expanded", approved: true });
    expect(draft.segments[0].text).not.toContain("万元");
    expect(() =>
      workflow.scenes(owner, [{ ...expanded, kind: "panorama" }]),
    ).toThrow("真实全景");
  });
  it("persists uncertain submissions, recovers through query, and never resubmits automatically", async () => {
    const { workflow, bytes } = fixture();
    const source = await workflow.handle("a", "beike-import", {});
    const scene = source.scenes[0];
    workflow.remote.mockRejectedValue(new Error("request outcome unknown"));
    const input = {
      scene,
      prompt: "保留原图，扩展边缘",
      top_scale: 1,
      bottom_scale: 1,
      left_scale: 1.5,
      right_scale: 1.5,
    };
    await expect(workflow.handle("a", "image-submit", input)).rejects.toThrow(
      "unknown",
    );
    const calls = workflow.remote.mock.calls.length;
    await expect(workflow.handle("a", "image-submit", input)).rejects.toThrow(
      "已有扩图",
    );
    expect(workflow.remote.mock.calls).toHaveLength(calls);
    const recovered = new PanoramaWorkflow(workflow.root, "", {});
    recovered.remote = vi.fn(async () => ({
      status: "SUCCEEDED",
      imageUrl: "https://sample.oss-cn-beijing.aliyuncs.com/result.jpg",
    }));
    providers.downloadImage.mockResolvedValue(
      Buffer.concat([bytes, Buffer.from("expanded")]),
    );
    const tasks = await recovered.handle("a", "image-refresh", {});
    expect(tasks[0].result).toMatchObject({
      id: scene.id,
      kind: "expanded",
      approved: false,
      sourceAsset: scene.asset,
    });
    expect(recovered.remote.mock.calls[0][0]).toBe("image-query");
    expect((await recovered.handle("b", "state")).imageTasks).toHaveLength(0);
  });
});
