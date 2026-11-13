import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
const require = createRequire(import.meta.url);
const { PanoramaWorkflow } = require("../panorama/workflow.cjs");
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
  it("keeps only panoramas and reference images in the owner's cache", async () => {
    const { workflow, property } = fixture();
    workflow.remote.mockResolvedValue({
      property,
      images: [{ url: "https://p.ljcdn.com/photo.jpg", room: "照片" }],
      panoramas: [{ url: "https://p.ljcdn.com/pano.jpg", room: "全景" }],
      referenceImages: [
        { url: "https://p.ljcdn.com/plan.jpg", room: "户型图" },
      ],
    });
    const source = await workflow.handle("a", "beike-import", {});
    expect(source.materialMode).toBe("panorama");
    expect(source.scenes.map((scene: { kind: string }) => scene.kind)).toEqual([
      "panorama",
    ]);
    expect(source.references).toHaveLength(1);
    expect(providers.downloadImage).toHaveBeenCalledTimes(2);
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
  it("rejects a Beike result with no VR images before downloading photos", async () => {
    const { workflow } = fixture();
    await expect(workflow.handle("a", "beike-import", {})).rejects.toThrow(
      "VR 全景图",
    );
    expect(providers.downloadImage).not.toHaveBeenCalled();
  });
  it("rejects photos, approved legacy expansions and expansions relabeled as panoramas", async () => {
    const { workflow, bytes } = fixture();
    const owner = workflow.owner("a");
    const scene = await workflow.importBytes(owner, bytes, "客厅", "photo");
    expect(() => workflow.scenes(owner, [scene])).toThrow("VR 全景图");
    const metadata = workflow.store(owner).assetMetadata[scene.asset];
    metadata.kinds = ["expanded"];
    expect(() =>
      workflow.scenes(owner, [{ ...scene, kind: "expanded", approved: true }]),
    ).toThrow("VR 全景图");
    expect(() =>
      workflow.scenes(owner, [
        { ...scene, kind: "panorama" },
        { ...scene, id: "99999999-9999-4999-8999-999999999999" },
      ]),
    ).toThrow("真实全景");
  });
  it("does not expose image submission or polling to old clients", async () => {
    const { workflow } = fixture();
    for (const method of ["image-submit", "image-refresh"])
      await expect(workflow.handle("a", method, {})).rejects.toThrow();
    expect(workflow.remote).not.toHaveBeenCalled();
  });
});
