import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
const require = createRequire(import.meta.url);
const { PanoramaWorkflow } = require("../panorama/workflow.cjs");
const domain = require("../panorama/domain.cjs");
const media = require("../panorama/media.cjs");
const providers = require("../panorama/providers.cjs");
const catalog = require("../../../../services/cloud/video_templates.json");
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    if (!root.startsWith(path.resolve("output/factory-tests") + path.sep))
      throw new Error("Unsafe cleanup path");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
function selectedIds(workflow: any, propertyId: string): string[] {
  return (workflow.store(workflow.owner("a")).imports[propertyId]?.scenes || [])
    .filter(
      (scene: { kind?: string }) => !scene.kind || scene.kind === "panorama",
    )
    .map((scene: { id: string }) => scene.id);
}
async function fixture() {
  const parent = path.resolve("output/factory-tests");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "case-"));
  roots.push(root);
  const workflow = new PanoramaWorkflow(root, "", {
    open: async () => [],
    save: async () => null,
  });
  const owner = workflow.owner("a");
  const property = {
    id: "house-a",
    title: "测试房源",
    description: "",
    areaSqm: 0,
    priceCents: 0,
    layout: "",
    sellingPoints: [],
    images: [],
  };
  const bytes = (value: number) =>
    Buffer.concat([Buffer.from([255, 216, 255]), Buffer.alloc(100, value)]);
  vi.spyOn(media, "probe").mockResolvedValue({
    streams: [{ codec_name: "mjpeg", width: 2048, height: 1024 }],
  });
  const scenes = [];
  for (const [index, room] of ["卧室", "客厅"].entries())
    scenes.push({
      ...(await workflow.importBytes(
        owner,
        bytes(index + 1),
        room,
        "panorama",
      )),
      description: "已核实的原图说明",
    });
  workflow.store(owner).imports[property.id] = {
    property,
    scenes,
    materialMode: "panorama",
  };
  workflow.persist(owner);
  vi.spyOn(workflow, "capabilities").mockResolvedValue({
    ffmpeg: true,
    ffprobe: true,
    voices: [{ name: "test", language: "zh-CN" }],
  });
  vi.spyOn(providers, "downloadImage").mockResolvedValue(bytes(8));
  vi.spyOn(media, "scriptImage").mockImplementation(async (file: unknown) =>
    fs.readFileSync(String(file)).toString("base64"),
  );
  const synthesize = vi
    .spyOn(media, "synthesize")
    .mockImplementation(async (...args: unknown[]) => ({
      ...(args[0] as object),
      audio: "test.wav",
      duration: 1,
      captions: [],
    }));
  const render = vi
    .spyOn(media, "render")
    .mockResolvedValue({ duration: 4, timeline: [] });
  workflow.remote = vi.fn(
    async (method: string, input: Record<string, unknown>) => {
      if (method === "template") {
        const template = catalog.find((t: { id: string }) => t.id === input.id);
        if (!template || (input.version && input.version !== template.version))
          throw new Error("模板已下架或版本变化");
        return structuredClone(template);
      }
      if (method === "script-vision")
        return [
          "opening",
          ...(input.images as { id: string; kind: string }[])
            .filter((image) => image.kind !== "reference")
            .map((image) => image.id),
          "closing",
        ].map((id) => ({ id, text: `生成的${id}介绍` }));
      throw new Error("Unexpected remote operation " + method);
    },
  );
  const config = {
    ...domain.defaultConfig,
    voice: "test",
    scriptProvider: "ai",
  };
  return {
    workflow,
    owner,
    property,
    scenes,
    config,
    synthesize,
    render,
    bytes,
  };
}
describe("simple video factory", () => {
  it("requires 2–7 owned images and sends only the selection in original material order", async () => {
    const { workflow, owner, property, config, scenes, bytes } =
      await fixture();
    for (let i = 3; i <= 9; i++)
      scenes.push(
        await workflow.importBytes(owner, bytes(i), `空间 ${i}`, "panorama"),
      );
    const ids = scenes.map((scene) => scene.id);
    for (const sceneIds of [
      undefined,
      [],
      ids.slice(0, 1),
      ids.slice(0, 8),
      [ids[0], ids[0]],
      [ids[0], "other-property-scene"],
    ]) {
      await expect(
        workflow.handle(
          "a",
          "prepare",
          { propertyId: property.id, config, sceneIds },
          property,
        ),
      ).rejects.toThrow(/2–7|不属于/);
    }
    expect(
      workflow.remote.mock.calls.some(
        (c: unknown[]) => c[0] === "script-vision",
      ),
    ).toBe(false);
    for (const sceneIds of [[ids[3], ids[1]], ids.slice(0, 7).reverse()]) {
      const draft = await workflow.handle(
        "a",
        "prepare",
        { propertyId: property.id, config, sceneIds },
        property,
      );
      const expected = ids.filter((id) => sceneIds.includes(id));
      expect(draft.scenes.map((scene: { id: string }) => scene.id)).toEqual(
        expected,
      );
      const vision = workflow.remote.mock.calls
        .filter((c: unknown[]) => c[0] === "script-vision")
        .at(-1);
      expect(vision[1].images.map((image: { id: string }) => image.id)).toEqual(
        expected,
      );
    }
    expect(workflow.store(owner).imports[property.id].scenes).toHaveLength(9);
  });
  it("downloads only remote VR originals and reuses them when ordinary photos change", async () => {
    const { workflow, owner, property, config, bytes } = await fixture();
    delete workflow.store(owner).imports[property.id];
    const remote = {
      ...property,
      panoramas: [
        "https://p.ljcdn.com/pano.jpg",
        "https://p.ljcdn.com/pano2.jpg",
      ],
      images: ["https://p.ljcdn.com/photo.jpg"],
    };
    providers.downloadImage.mockImplementation(async (url: string) =>
      bytes(url.endsWith("pano2.jpg") ? 10 : 9),
    );
    await require("./factory.cjs").load(workflow, owner, remote, () => {});
    const draft = await workflow.handle(
      "a",
      "prepare",
      {
        propertyId: property.id,
        sceneIds: selectedIds(workflow, property.id),
        config,
      },
      remote,
    );
    expect(draft.scenes).toHaveLength(2);
    expect(draft.scenes[0].kind).toBe("panorama");
    expect(providers.downloadImage).toHaveBeenCalledWith(
      remote.panoramas[0],
      expect.any(AbortSignal),
    );
    await workflow.handle(
      "a",
      "prepare",
      {
        propertyId: property.id,
        sceneIds: selectedIds(workflow, property.id),
        config,
      },
      { ...remote, images: ["https://p.ljcdn.com/new-photo.jpg"] },
    );
    expect(providers.downloadImage).toHaveBeenCalledTimes(2);
  });
  it("allows replacing a full legacy photo collection with VR materials without deleting history", async () => {
    const { workflow, owner, property, bytes } = await fixture();
    const photo = await workflow.importBytes(
      owner,
      bytes(6),
      "旧照片",
      "photo",
    );
    workflow.store(owner).imports[property.id].scenes = Array.from(
      { length: 20 },
      () => ({ ...photo }),
    );
    expect(workflow.withPropertyCovers("a", [property])[0].importStatus).toBe(
      "incomplete",
    );
    const file = path.join(workflow.root, "全景.jpg");
    fs.writeFileSync(file, bytes(5));
    workflow.dialogs.open = async () => [file];
    await expect(
      workflow.handle("a", "property-import", { kind: "photo" }, property),
    ).rejects.toThrow("VR 全景图");
    expect(
      await workflow.handle(
        "a",
        "property-import",
        { kind: "panorama" },
        property,
      ),
    ).toEqual({ count: 1 });
    expect(workflow.store(owner).imports[property.id].scenes).toHaveLength(21);
    expect(
      (
        await workflow.handle("a", "source-restore", {
          propertyId: property.id,
        })
      ).scenes,
    ).toHaveLength(1);
    expect(workflow.withPropertyCovers("a", [property])[0].importStatus).toBe(
      "ready",
    );
  });
  it("cancels a pending script on logout without saving a draft", async () => {
    const { workflow, owner, property, config } = await fixture();
    workflow.remote = vi.fn(
      (_method: unknown, _input: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          }),
        ),
    );
    const pending = workflow.handle(
      "a",
      "prepare",
      {
        propertyId: property.id,
        sceneIds: selectedIds(workflow, property.id),
        config,
      },
      property,
    );
    await vi.waitFor(() => expect(workflow.remote).toHaveBeenCalledTimes(1));
    workflow.stop();
    await expect(pending).rejects.toThrow("aborted");
    expect(workflow.store(owner).drafts).toHaveLength(0);
    expect(workflow.previews.size).toBe(0);
  });
  it("prepares one caption per original image in order, without expanding or rendering before a single confirmation", async () => {
    const { workflow, property, config, synthesize, render } = await fixture();
    const draft = await workflow.handle(
      "a",
      "prepare",
      {
        propertyId: property.id,
        sceneIds: selectedIds(workflow, property.id),
        config,
      },
      property,
    );
    expect(draft.confirmation).toBe("whole");
    expect(draft.scenes.map((s: { room: string }) => s.room)).toEqual([
      "卧室",
      "客厅",
    ]);
    expect(
      draft.segments
        .filter((s: { kind: string }) => s.kind === "scene")
        .map((s: { sceneId: string }) => s.sceneId),
    ).toEqual(draft.scenes.map((s: { id: string }) => s.id));
    expect(workflow.remote.mock.calls.map((c: unknown[]) => c[0])).toEqual([
      "template",
      "script-vision",
    ]);
    expect(synthesize).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
    await expect(
      workflow.handle("a", "start", { id: draft.id, revision: 1 }),
    ).rejects.toThrow("确认整条");
    const job = await workflow.handle("a", "start", {
      id: draft.id,
      revision: 1,
      confirmed: true,
    });
    await workflow.active.get(job.id)?.promise;
    expect(job.status).toBe("succeeded");
    expect(job.confirmedAt).toBeTruthy();
    expect(
      job.scenes.every(
        (s: { kind: string; approved: boolean }) => s.kind === "panorama",
      ),
    ).toBe(true);
    expect(job.scenes.map((s: { room: string }) => s.room)).toEqual([
      "卧室",
      "客厅",
    ]);
    expect(render).toHaveBeenCalledTimes(1);
    const count = workflow.remote.mock.calls.filter(
      (c: unknown[]) => c[0] === "image-submit",
    ).length;
    expect(count).toBe(0);
    expect(
      (
        await workflow.handle("a", "start", {
          id: draft.id,
          revision: 1,
          confirmed: true,
        })
      ).id,
    ).toBe(job.id);
    expect(
      workflow.remote.mock.calls.filter(
        (c: unknown[]) => c[0] === "image-submit",
      ),
    ).toHaveLength(count);
  });
  it("sends original VR images and references, then renders without image generation", async () => {
    const { workflow, owner, property, config, bytes, scenes } =
      await fixture();
    const pano = await workflow.importBytes(
      owner,
      bytes(9),
      "客厅全景",
      "panorama",
    );
    workflow.store(owner).imports[property.id].scenes.push(pano);
    const planFile = path.join(workflow.root, "户型图.jpg");
    fs.writeFileSync(planFile, bytes(10));
    workflow.dialogs.open = async () => [planFile];
    await workflow.handle(
      "a",
      "property-import",
      { kind: "reference" },
      property,
    );
    const [plan] = workflow.store(owner).imports[property.id].references;
    const draft = await workflow.handle(
      "a",
      "prepare",
      {
        propertyId: property.id,
        sceneIds: selectedIds(workflow, property.id),
        config: {
          ...config,
          templateId: "standard-tour-vision",
          scriptProvider: "template",
        },
        templateVersion: "2.0.0",
      },
      property,
    );
    expect(draft.config.materialMode).toBe("panorama");
    expect(draft.templateSnapshot.production.schemaVersion).toBe(2);
    const ids = [
      ...scenes.map((scene) => scene.id).filter((id) => id !== pano.id),
      pano.id,
    ];
    expect(draft.scenes.map((scene: { id: string }) => scene.id)).toEqual(ids);
    expect(draft.segments.map((segment: { id: string }) => segment.id)).toEqual(
      ["opening", ...ids, "closing"],
    );
    expect(workflow.remote.mock.calls[1]).toEqual([
      "script-vision",
      expect.objectContaining({
        property: expect.objectContaining({ title: property.title }),
        images: [...ids, plan.id].map((id, index) =>
          expect.objectContaining({
            id,
            kind: ["panorama", "panorama", "panorama", "reference"][index],
            jpeg: bytes([1, 2, 9, 10][index]).toString("base64"),
          }),
        ),
      }),
      expect.any(AbortSignal),
    ]);
    const job = await workflow.handle("a", "start", {
      id: draft.id,
      revision: 1,
      confirmed: true,
    });
    await workflow.active.get(job.id)?.promise;
    expect(job.status).toBe("succeeded");
    expect(
      job.scenes.map((scene: { id: string; kind: string }) => [
        scene.id,
        scene.kind,
      ]),
    ).toEqual(ids.map((id) => [id, "panorama"]));
    expect(
      workflow.remote.mock.calls.filter(
        (c: unknown[]) => c[0] === "image-submit",
      ),
    ).toHaveLength(0);
  });
  it("rejects photo-only properties and excludes legacy photos from mixed materials", async () => {
    const { workflow, owner, property, config, bytes, scenes, synthesize } =
      await fixture();
    const photo = await workflow.importBytes(
      owner,
      bytes(7),
      "普通照片",
      "photo",
    );
    workflow.store(owner).imports[property.id].scenes = [photo];
    await expect(
      workflow.handle(
        "a",
        "prepare",
        {
          propertyId: property.id,
          sceneIds: selectedIds(workflow, property.id),
          config,
        },
        property,
      ),
    ).rejects.toThrow("VR 全景图");
    expect(synthesize).not.toHaveBeenCalled();
    workflow.store(owner).imports[property.id].scenes = [photo, ...scenes];
    const draft = await workflow.handle(
      "a",
      "prepare",
      {
        propertyId: property.id,
        sceneIds: selectedIds(workflow, property.id),
        config,
      },
      property,
    );
    expect(draft.scenes.map((s: { id: string }) => s.id)).toEqual(
      scenes.map((s) => s.id),
    );
    expect(workflow.store(owner).imports[property.id].scenes[0]).toEqual(photo);
  });
  it("rejects legacy photo drafts and retries before speech or rendering", async () => {
    const { workflow, owner, property, config, bytes, synthesize } =
      await fixture();
    const draft = await workflow.handle(
      "a",
      "prepare",
      {
        propertyId: property.id,
        sceneIds: selectedIds(workflow, property.id),
        config,
      },
      property,
    );
    const photo = await workflow.importBytes(
      owner,
      bytes(7),
      "普通照片",
      "photo",
    );
    const stored = workflow
      .store(owner)
      .drafts.find((d: { id: string }) => d.id === draft.id);
    stored.scenes = [photo];
    await expect(
      workflow.handle("a", "start", {
        id: draft.id,
        revision: 1,
        confirmed: true,
      }),
    ).rejects.toThrow("VR 全景图");
    workflow.store(owner).jobs.push({
      ...stored,
      id: "legacy-job",
      draftId: draft.id,
      status: "failed",
      confirmedAt: "2026-11-13",
    });
    await expect(
      workflow.handle("a", "retry", { id: "legacy-job" }),
    ).rejects.toThrow("VR 全景图");
    expect(synthesize).not.toHaveBeenCalled();
  });
  it("coalesces concurrent script preparation and keeps missing materials explicit", async () => {
    const { workflow, property, config } = await fixture();
    const [first, second] = await Promise.all([
      workflow.handle(
        "a",
        "prepare",
        {
          propertyId: property.id,
          sceneIds: selectedIds(workflow, property.id),
          config,
        },
        property,
      ),
      workflow.handle(
        "a",
        "prepare",
        {
          propertyId: property.id,
          sceneIds: selectedIds(workflow, property.id),
          config,
        },
        property,
      ),
    ]);
    expect(first.id).toBe(second.id);
    expect(workflow.remote).toHaveBeenCalledTimes(2);
    await expect(
      workflow.handle(
        "b",
        "prepare",
        {
          propertyId: property.id,
          sceneIds: selectedIds(workflow, property.id),
          config,
        },
        property,
      ),
    ).rejects.toThrow("补充素材");
  });
  it("attaches imported files to an owned property and makes them available to the two-choice flow", async () => {
    const { workflow, property, config, bytes } = await fixture();
    const another = { ...property, id: "new-property" };
    const file = path.join(workflow.root, "客厅.jpg");
    fs.writeFileSync(file, bytes(5));
    const secondFile = path.join(workflow.root, "卧室.jpg");
    fs.writeFileSync(secondFile, bytes(6));
    workflow.dialogs.open = async () => [file, secondFile];
    expect(
      await workflow.handle(
        "a",
        "property-import",
        { propertyId: another.id, kind: "panorama" },
        another,
      ),
    ).toEqual({ count: 2 });
    expect(workflow.withPropertyCovers("a", [another])[0].image).toBe(
      workflow.store(workflow.owner("a")).imports[another.id].scenes[0].url,
    );
    const draft = await workflow.handle(
      "a",
      "prepare",
      {
        propertyId: another.id,
        sceneIds: selectedIds(workflow, another.id),
        config,
      },
      another,
    );
    expect(draft.scenes[0].room).toBe("客厅");
    expect(draft.config.materialMode).toBe("panorama");
    await expect(
      workflow.handle("b", "source-restore", { propertyId: another.id }),
    ).rejects.toThrow("没有");
  });
  it("uses the first saved photo as the cover only for its owner", async () => {
    const { workflow, owner, property, bytes } = await fixture();
    const listing = {
      ...property,
      image: "/cover.jpg",
      images: ["/photo.jpg"],
    };
    const saved = workflow.store(owner).imports[property.id];
    saved.scenes.unshift(
      await workflow.importBytes(owner, bytes(5), "客厅", "photo"),
    );
    saved.references = [
      await workflow.importBytes(owner, bytes(6), "户型图", "reference"),
    ];
    expect(workflow.withPropertyCovers("a", [listing])[0].image).toBe(
      saved.scenes[0].url,
    );
    expect(workflow.withPropertyCovers("b", [listing])[0].image).toBe(
      "/photo.jpg",
    );
    expect(
      workflow.withPropertyCovers("b", [{ ...listing, images: [] }])[0].image,
    ).toBe("/cover.jpg");
  });
  it("resolves published rules instead of renderer overrides and retains a locked snapshot after unlisting", async () => {
    const { workflow, owner, property, config } = await fixture();
    workflow.store(owner).imports[property.id].scenes[0].direction = -1;
    const draft = await workflow.handle(
      "a",
      "prepare",
      {
        propertyId: property.id,
        sceneIds: selectedIds(workflow, property.id),
        templateVersion: "1.0.0",
        config: {
          ...config,
          brandColor: "#FFFFFF",
          openingTemplate: "篡改的文案",
          speed: 12,
        },
      },
      property,
    );
    expect(draft.config.brandColor).toBe("#167D8D");
    expect(draft.config.speed).toBe(4);
    expect(
      draft.scenes.every(
        (scene: { direction: number }) => scene.direction === 1,
      ),
    ).toBe(true);
    expect(draft.config.openingTemplate).toContain("{title}");
    expect(draft.templateVersion).toBe("1.0.0");
    expect(draft.templateSnapshot.production.config).toMatchObject({
      brandColor: "#167D8D",
      speed: 4,
    });
    await expect(
      workflow.handle("a", "save", {
        id: draft.id,
        revision: 1,
        config: { ...draft.config, speed: 8 },
        segments: draft.segments,
      }),
    ).rejects.toThrow("制作规则不可修改");
    const resolve = workflow.remote;
    workflow.remote = vi.fn(
      async (method: string, input: Record<string, unknown>) => {
        if (method === "template") throw new Error("模板已下架");
        return resolve(method, input);
      },
    );
    const job = await workflow.handle("a", "start", {
      id: draft.id,
      revision: 1,
      confirmed: true,
    });
    await workflow.active.get(job.id)?.promise;
    expect(job.status).toBe("succeeded");
    expect(job.templateSnapshot.version).toBe("1.0.0");
    expect(
      workflow.remote.mock.calls.some(
        (call: unknown[]) => call[0] === "template",
      ),
    ).toBe(false);
    const count = workflow.store(owner).drafts.length;
    await expect(
      workflow.handle(
        "a",
        "prepare",
        {
          propertyId: property.id,
          sceneIds: selectedIds(workflow, property.id),
          config,
        },
        property,
      ),
    ).rejects.toThrow("模板已下架");
    expect(workflow.store(owner).drafts).toHaveLength(count);
  });
  it("rejects a stale selected version before scripts or images are requested", async () => {
    const { workflow, owner, property, config, synthesize } = await fixture();
    await expect(
      workflow.handle(
        "a",
        "prepare",
        {
          propertyId: property.id,
          sceneIds: selectedIds(workflow, property.id),
          config,
          templateVersion: "9.0.0",
        },
        property,
      ),
    ).rejects.toThrow("版本变化");
    expect(workflow.store(owner).drafts).toHaveLength(0);
    expect(
      workflow.remote.mock.calls.map((call: unknown[]) => call[0]),
    ).toEqual(["template"]);
    expect(synthesize).not.toHaveBeenCalled();
  });
});
