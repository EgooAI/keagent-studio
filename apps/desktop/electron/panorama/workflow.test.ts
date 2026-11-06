import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
const require = createRequire(import.meta.url);
const domain = require("./domain.cjs");
const providers = require("./providers.cjs");
const media = require("./media.cjs");
const { PanoramaWorkflow } = require("./workflow.cjs");
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) {
    expect(
      root.startsWith(path.resolve("output/workflow-unit-tests") + path.sep),
    ).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
const property = {
  id: "p",
  title: "测试房源",
  areaSqm: 80,
  priceCents: 280000000,
  layout: "两室",
  sellingPoints: ["已核实的装修"],
};
function fixture() {
  const testRoot = path.resolve("output/workflow-unit-tests");
  fs.mkdirSync(testRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(testRoot, "case-"));
  roots.push(root);
  const workflow = new PanoramaWorkflow(root, "", {
    open: async () => [],
    save: async () => null,
  });
  const owner = workflow.owner("user-a");
  workflow.store(owner);
  fs.mkdirSync(path.join(root, owner, "assets"));
  const asset = `${domain.hash("fake image")}.jpg`;
  fs.writeFileSync(path.join(root, owner, "assets", asset), "fake image");
  const scenes = [
    {
      id: "11111111-1111-4111-8111-111111111111",
      asset,
      room: "客厅",
      description: "白色墙面",
      yaw: -30,
    },
  ];
  const config = { ...domain.defaultConfig, voice: "test" };
  vi.spyOn(workflow, "capabilities").mockResolvedValue({
    ffmpeg: true,
    ffprobe: true,
    voices: [{ name: "test", language: "zh-CN" }],
  });
  return { workflow, owner, scenes, config };
}
describe("panorama domain", () => {
  it("saves reusable templates without property-specific or identity fields and freezes draft versions", async () => {
    const { workflow, scenes, config } = fixture();
    const template = await workflow.handle("user-a", "template-save", {
      name: "门店带看",
      config: {
        ...config,
        agentName: "本人",
        agentContact: "测试联系方式",
        coverTitle: "本套房屋",
        leadSceneId: scenes[0].id,
      },
    });
    for (const key of [
      "voice",
      "avatarId",
      "agentName",
      "agentContact",
      "coverTitle",
      "coverSceneId",
      "leadSceneId",
      "materialMode",
      "templateId",
    ])
      expect(template.config).not.toHaveProperty(key);
    const draft = await workflow.handle(
      "user-a",
      "generate",
      {
        scenes,
        config: { ...config, ...template.config, templateId: template.id },
      },
      property,
    );
    expect(draft.templateVersion).toBe("1");
    const updated = await workflow.handle("user-a", "template-save", {
      id: template.id,
      version: 1,
      name: "门店带看",
      config: { ...draft.config, brandColor: "#CC5522" },
    });
    expect(updated.version).toBe(2);
    const reopened = new PanoramaWorkflow(workflow.root, "", {});
    expect(
      (await reopened.handle("user-a", "state")).templates[0].version,
    ).toBe(2);
    expect(
      (await reopened.handle("user-a", "state")).drafts[0].templateVersion,
    ).toBe("1");
    expect(draft.config.brandColor).toBe(config.brandColor);
    expect(draft.templateVersion).toBe("1");
    await expect(
      workflow.handle("user-a", "template-save", {
        id: template.id,
        version: 1,
        name: "覆盖旧版",
        config,
      }),
    ).rejects.toThrow("已更新");
    await expect(
      workflow.handle(
        "user-b",
        "generate",
        { scenes, config: { ...config, templateId: template.id } },
        property,
      ),
    ).rejects.toThrow("模板不存在");
  });
  it("uses the selected lead scene and skips absent descriptions and unknown facts", async () => {
    const { workflow, scenes, config } = fixture();
    const second = {
      ...scenes[0],
      id: "22222222-2222-4222-8222-222222222222",
      room: "卧室",
      description: "",
    };
    const draft = await workflow.handle(
      "user-a",
      "generate",
      {
        scenes: [...scenes, second],
        config: {
          ...config,
          leadSceneId: second.id,
          coverSceneId: scenes[0].id,
        },
      },
      { ...property, areaSqm: 0, priceCents: 0, layout: "" },
    );
    expect(draft.segments[0].sceneId).toBe(second.id);
    expect(draft.segments.at(-1).sceneId).toBe(second.id);
    expect(draft.segments[2].text).toBe("这里是卧室。");
    expect(draft.segments[0].text).not.toMatch(/0平方米|0万元/);
    await expect(
      workflow.handle(
        "user-a",
        "generate",
        { scenes, config: { ...config, coverSceneId: second.id } },
        property,
      ),
    ).rejects.toThrow("已移除");
    expect(() =>
      domain.config({ ...config, brandColor: "red\\Ninjection" }),
    ).toThrow("品牌色");
  });
  it("requires a user-owned uploaded photo before generating digital-human scripts", async () => {
    const { workflow, scenes, config } = fixture();
    const remote = vi.fn(
      async (): Promise<{ avatars: { id: string; status: string }[] }> => ({
        avatars: [],
      }),
    );
    workflow.remote = remote;
    await expect(
      workflow.handle(
        "user-a",
        "generate",
        {
          scenes,
          config: {
            ...config,
            videoMode: "avatar",
            avatarId: "",
            scriptProvider: "ai",
          },
        },
        property,
      ),
    ).rejects.toThrow("本人照片");
    await expect(
      workflow.handle(
        "user-a",
        "generate",
        {
          scenes,
          config: {
            ...config,
            videoMode: "avatar",
            avatarId: "somebody-else",
            scriptProvider: "ai",
          },
        },
        property,
      ),
    ).rejects.toThrow("自己");
    expect(remote).toHaveBeenCalledTimes(1);
    remote.mockResolvedValue({
      avatars: [{ id: "own-photo", status: "ready" }],
    });
    const draft = await workflow.handle(
      "user-a",
      "generate",
      {
        scenes,
        config: { ...config, videoMode: "avatar", avatarId: "own-photo" },
      },
      property,
    );
    expect(draft.config.avatarId).toBe("own-photo");
  });
  it("cancels a system-voice preview on logout before exposing its media URL", async () => {
    const { workflow } = fixture();
    let complete: (result: unknown) => void = () => {};
    let signal: AbortSignal | undefined;
    vi.spyOn(media, "synthesize").mockImplementation((...args: unknown[]) => {
      signal = args[3] as AbortSignal;
      return new Promise((resolve) => {
        complete = resolve;
      });
    });
    const preview = workflow.handle("user-a", "preview-system", {
      voice: "test",
      language: "zh-CN",
    });
    await vi.waitFor(() => expect(media.synthesize).toHaveBeenCalled());
    workflow.stop();
    expect(signal?.aborted).toBe(true);
    complete({ audio: "segment-example.wav" });
    await expect(preview).rejects.toThrow();
    expect(workflow.previews.size).toBe(0);
  });
  it("retries a temporary checkpoint sharing violation without removing the previous file", () => {
    const { workflow, owner } = fixture();
    const original = fs.renameSync;
    const rename = vi
      .spyOn(fs, "renameSync")
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("temporary sharing violation"), {
          code: "EPERM",
        });
      })
      .mockImplementation(original);
    workflow.persist(owner);
    expect(rename).toHaveBeenCalledTimes(2);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(workflow.directory(owner), "workspace.json"),
          "utf8",
        ),
      ).schemaVersion,
    ).toBe(1);
    rename.mockImplementation(() => {
      throw Object.assign(new Error("disk failure"), { code: "EIO" });
    });
    expect(() => workflow.persist(owner)).toThrow("disk failure");
  });
  it("uses verified facts and rejects unknown template variables", () => {
    const segments = domain.segments(
      property,
      [{ id: "s", room: "客厅", description: "白墙" }],
      domain.config(domain.defaultConfig),
    );
    expect(segments[0].text).toContain("280万元");
    expect(segments[1]).toMatchObject({
      id: "s",
      sceneId: "s",
      text: "这里是客厅。白墙",
    });
    expect(() => domain.fill("{school}", {})).toThrow("未知模板变量");
    expect(() =>
      domain.config({ ...domain.defaultConfig, speed: NaN }),
    ).toThrow();
    expect(() => domain.config({ ...domain.defaultConfig, rate: 0 })).toThrow();
    expect(() =>
      domain.validateSegments([{ id: "wrong", text: "x" }], [{ id: "s" }]),
    ).toThrow();
  });
  it("caps movement while retaining audio duration and invalidates only affected audio", () => {
    expect(
      domain.motion(150, 30, { speed: 4, direction: -1, maxSweep: 80 }),
    ).toEqual({ start: 150, end: 70, sweep: -80, duration: 30 });
    const c = domain.defaultConfig;
    expect(domain.audioKey({ text: "介绍" }, c)).toBe(
      domain.audioKey(
        { text: "介绍" },
        { ...c, speed: 8, maxSweep: 30, avatarId: "new" },
      ),
    );
    expect(domain.audioKey({ text: "介绍" }, c)).not.toBe(
      domain.audioKey({ text: "介绍" }, { ...c, rate: 1.2 }),
    );
    expect(domain.sentences("一。二！三？")).toEqual(["一。", "二！", "三？"]);
    expect(domain.sentences("面积80.5平方米。总价280万元。")).toEqual([
      "面积80.5平方米。",
      "总价280万元。",
    ]);
    const english =
      "This spacious living room has a large window and a wooden floor.";
    expect(domain.sentences(english).join(" ").replace(/\s+/g, " ")).toBe(
      english,
    );
    expect(
      providers.avatarResult({
        resp_data: JSON.stringify({
          code: 0,
          vid: { url: "https://vendor.example/video.mp4" },
        }),
      }),
    ).toEqual({ status: "done", url: "https://vendor.example/video.mp4" });
    expect(media.escapeASS("{\\pos(1,1)}\n字")).toBe("｛＼pos(1,1)｝\\N字");
  });
  it("keeps binary hashes stable and rejects private CDN addresses", () => {
    expect(domain.hash(Buffer.from("abc"))).toBe(domain.hash("abc"));
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.169.254",
      "::1",
      "::ffff:7f00:1",
    ])
      expect(providers.privateAddress(address)).toBe(true);
    expect(providers.privateAddress("8.8.8.8")).toBe(false);
  });
});
describe("persistent local workflow", () => {
  it("rejects an approval superseded while preflight is awaiting runtime checks", async () => {
    const { workflow, scenes, config } = fixture();
    const draft = await workflow.handle(
      "user-a",
      "generate",
      { scenes, config },
      property,
    );
    let release: () => void = () => {};
    vi.spyOn(workflow, "preflight").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const pending = workflow.handle("user-a", "start", {
      id: draft.id,
      revision: 1,
    });
    await workflow.handle("user-a", "save", {
      id: draft.id,
      revision: 1,
      config,
      segments: draft.segments.map((s: { text: string }) => ({
        ...s,
        text: s.text + "已修改。",
      })),
    });
    release();
    await expect(pending).rejects.toThrow("草稿已更新");
  });
  it("reports progress callback failures without crashing the main process", async () => {
    await expect(
      media.run(
        process.execPath,
        [
          "-e",
          "process.stdout.write('out_time_us=1000000\\n');setTimeout(()=>{},1000)",
        ],
        process.cwd(),
        undefined,
        () => {
          throw new Error("checkpoint failed");
        },
      ),
    ).rejects.toThrow("checkpoint failed");
  });
  it("freezes the approved revision, rejects conflicts, and keeps user media isolated", async () => {
    const { workflow, owner, scenes, config } = fixture();
    const draft = await workflow.handle(
      "user-a",
      "generate",
      { scenes, config },
      property,
    );
    const updated = await workflow.handle("user-a", "save", {
      id: draft.id,
      revision: 1,
      segments: draft.segments.map((s: { text: string }) => ({
        ...s,
        text: s.text + "已确认。",
      })),
      config,
    });
    await expect(
      workflow.handle("user-a", "save", {
        id: draft.id,
        revision: 1,
        segments: draft.segments,
        config,
      }),
    ).rejects.toThrow("草稿已更新");
    const execute = vi.spyOn(workflow, "execute").mockImplementation(() => {});
    const job = await workflow.handle("user-a", "start", {
      id: updated.id,
      revision: 2,
    });
    expect(
      (
        await workflow.handle("user-a", "start", {
          id: updated.id,
          revision: 2,
        })
      ).id,
    ).toBe(job.id);
    expect(execute).toHaveBeenCalledTimes(1);
    await workflow.handle("user-a", "save", {
      id: updated.id,
      revision: 2,
      segments: updated.segments,
      config: { ...config, speed: 6 },
    });
    expect(job.config.speed).toBe(4);
    expect((await workflow.handle("user-b", "state")).drafts).toHaveLength(0);
    expect(() =>
      workflow.mediaFile(
        "user-b",
        new URL(`keagent://media/${owner}/assets/${scenes[0].asset}`),
      ),
    ).toThrow("无权");
    expect(() =>
      workflow.mediaFile(
        "user-a",
        new URL(`keagent://media/${owner}/workspace.json`),
      ),
    ).toThrow("素材地址无效");
    const restarted = new PanoramaWorkflow(workflow.root, "", {});
    expect((await restarted.handle("user-a", "state")).jobs[0]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("中断"),
    });
  });
  it("does not re-submit a digital human request with an unknown outcome", async () => {
    const { workflow, owner } = fixture();
    workflow
      .store(owner)
      .jobs.push({ id: "j", status: "failed", avatar: { submitting: true } });
    await expect(
      workflow.handle("user-a", "retry", { id: "j" }),
    ).rejects.toThrow("提交结果未知");
  });
  it("a canceled render cannot publish success", async () => {
    const { workflow, owner, scenes, config } = fixture();
    const draft = await workflow.handle(
      "user-a",
      "generate",
      { scenes, config },
      property,
    );
    vi.spyOn(media, "synthesize").mockImplementation(async (s: unknown) => s);
    let resolveRender: (value: unknown) => void = () => {};
    vi.spyOn(media, "render").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRender = resolve;
        }),
    );
    const job = await workflow.handle("user-a", "start", {
      id: draft.id,
      revision: 1,
    });
    const running = workflow.active.get(job.id).promise;
    await vi.waitFor(() => expect(media.render).toHaveBeenCalled());
    await workflow.handle("user-a", "cancel", { id: job.id });
    resolveRender({ duration: 12 });
    await running;
    expect(workflow.store(owner).jobs[0].status).toBe("canceled");
    expect(job.duration).toBeUndefined();
  });
});
