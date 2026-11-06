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
      ...(await workflow.importBytes(owner, bytes(index + 1), room, "photo")),
      description: "已核实的原图说明",
    });
  workflow.store(owner).imports[property.id] = {
    property,
    scenes,
    materialMode: "expand",
  };
  workflow.persist(owner);
  vi.spyOn(workflow, "capabilities").mockResolvedValue({
    ffmpeg: true,
    ffprobe: true,
    imageExpansion: true,
    voices: [{ name: "test", language: "zh-CN" }],
  });
  vi.spyOn(providers, "downloadImage").mockResolvedValue(bytes(8));
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
      if (method === "script")
        return (input.segments as { id: string; text: string }[]).map((s) => ({
          id: s.id,
          text: `生成的${s.id}介绍`,
        }));
      if (method === "image-submit") return { status: "PENDING" };
      if (method === "image-query")
        return {
          status: "SUCCEEDED",
          imageUrl: "https://test.aliyuncs.com/expanded.jpg",
        };
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
      { propertyId: property.id, config },
      property,
    );
    await vi.waitFor(() => expect(workflow.remote).toHaveBeenCalledTimes(1));
    workflow.stop();
    await expect(pending).rejects.toThrow("aborted");
    expect(workflow.store(owner).drafts).toHaveLength(0);
    expect(workflow.previews.size).toBe(0);
  });
  it("cancels image submission with the video job and does not proceed to speech", async () => {
    const { workflow, property, config, synthesize } = await fixture();
    const draft = await workflow.handle(
      "a",
      "prepare",
      { propertyId: property.id, config },
      property,
    );
    workflow.remote = vi.fn(
      (_method: unknown, _input: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          }),
        ),
    );
    const job = await workflow.handle("a", "start", {
      id: draft.id,
      revision: 1,
      confirmed: true,
    });
    await vi.waitFor(() => expect(workflow.remote).toHaveBeenCalledTimes(1));
    const done = workflow.active.get(job.id).promise;
    await workflow.handle("a", "cancel", { id: job.id });
    await done;
    expect(job.status).toBe("canceled");
    expect(synthesize).not.toHaveBeenCalled();
    expect(workflow.previews.size).toBe(0);
  });
  it("prepares one caption per original image in order, without expanding or rendering before a single confirmation", async () => {
    const { workflow, property, config, synthesize, render } = await fixture();
    const draft = await workflow.handle(
      "a",
      "prepare",
      { propertyId: property.id, config },
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
      "script",
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
        (s: { kind: string; approved: boolean }) =>
          s.kind === "expanded" && s.approved,
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
    expect(count).toBe(2);
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
  it("prioritizes existing panoramas and avoids expansion after confirmation", async () => {
    const { workflow, owner, property, config, bytes } = await fixture();
    const pano = await workflow.importBytes(
      owner,
      bytes(9),
      "客厅全景",
      "panorama",
    );
    workflow.store(owner).imports[property.id].scenes.push(pano);
    const draft = await workflow.handle(
      "a",
      "prepare",
      { propertyId: property.id, config },
      property,
    );
    expect(draft.config.materialMode).toBe("panorama");
    expect(draft.scenes).toHaveLength(1);
    const job = await workflow.handle("a", "start", {
      id: draft.id,
      revision: 1,
      confirmed: true,
    });
    await workflow.active.get(job.id)?.promise;
    expect(job.status).toBe("succeeded");
    expect(workflow.remote.mock.calls.map((c: unknown[]) => c[0])).toEqual([
      "template",
      "script",
    ]);
  });
  it("does not repeat uncertain paid image submissions on video retry", async () => {
    const { workflow, property, config, synthesize } = await fixture();
    const draft = await workflow.handle(
      "a",
      "prepare",
      { propertyId: property.id, config },
      property,
    );
    workflow.remote = vi.fn(async (method: string) => {
      if (method === "image-submit") throw new Error("提交结果未知");
      throw new Error("提交未确认");
    });
    const job = await workflow.handle("a", "start", {
      id: draft.id,
      revision: 1,
      confirmed: true,
    });
    await workflow.active.get(job.id)?.promise;
    expect(job.status).toBe("failed");
    expect(synthesize).not.toHaveBeenCalled();
    await workflow.handle("a", "retry", { id: job.id });
    await workflow.active.get(job.id)?.promise;
    expect(
      workflow.remote.mock.calls.filter(
        (c: unknown[]) => c[0] === "image-submit",
      ),
    ).toHaveLength(1);
    expect(
      workflow.remote.mock.calls.some((c: unknown[]) => c[0] === "image-query"),
    ).toBe(true);
  });
  it("coalesces concurrent script preparation and keeps missing materials explicit", async () => {
    const { workflow, property, config } = await fixture();
    const [first, second] = await Promise.all([
      workflow.handle(
        "a",
        "prepare",
        { propertyId: property.id, config },
        property,
      ),
      workflow.handle(
        "a",
        "prepare",
        { propertyId: property.id, config },
        property,
      ),
    ]);
    expect(first.id).toBe(second.id);
    expect(workflow.remote).toHaveBeenCalledTimes(2);
    await expect(
      workflow.handle(
        "b",
        "prepare",
        { propertyId: property.id, config },
        property,
      ),
    ).rejects.toThrow("补充素材");
  });
  it("attaches imported files to an owned property and makes them available to the two-choice flow", async () => {
    const { workflow, property, config, bytes } = await fixture();
    const another = { ...property, id: "new-property" };
    const file = path.join(workflow.root, "客厅.jpg");
    fs.writeFileSync(file, bytes(5));
    workflow.dialogs.open = async () => [file];
    expect(
      await workflow.handle(
        "a",
        "property-import",
        { propertyId: another.id, kind: "photo" },
        another,
      ),
    ).toEqual({ count: 1 });
    const draft = await workflow.handle(
      "a",
      "prepare",
      { propertyId: another.id, config },
      another,
    );
    expect(draft.scenes[0].room).toBe("客厅");
    expect(draft.config.materialMode).toBe("expand");
    await expect(
      workflow.handle("b", "source-restore", { propertyId: another.id }),
    ).rejects.toThrow("没有");
  });
  it("resolves published rules instead of renderer overrides and retains a locked snapshot after unlisting", async () => {
    const { workflow, owner, property, config } = await fixture();
    workflow.store(owner).imports[property.id].scenes[0].direction = -1;
    const draft = await workflow.handle(
      "a",
      "prepare",
      {
        propertyId: property.id,
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
        { propertyId: property.id, config },
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
        { propertyId: property.id, config, templateVersion: "9.0.0" },
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
