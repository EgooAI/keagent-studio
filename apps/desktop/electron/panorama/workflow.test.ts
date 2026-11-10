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
  it("downloads the MiniMax OSS result and rejects unrelated hosts", async () => {
    const { workflow, owner } = fixture();
    const dns = require("node:dns/promises");
    vi.spyOn(dns, "lookup").mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
    ]);
    const fetch = vi.fn().mockResolvedValue(new Response("video fixture"));
    vi.stubGlobal("fetch", fetch);
    const file = path.join(workflow.directory(owner), "result.mp4");
    const url =
      "https://algeng-video-infer.oss-cn-shanghai.aliyuncs.com/output.mp4?signature=test";
    const signal = new AbortController().signal;
    await providers.downloadMiniMaxVideo(url, file, signal);
    expect(fs.readFileSync(file, "utf8")).toBe("video fixture");
    expect(fetch).toHaveBeenCalledWith(
      new URL(url),
      expect.objectContaining({ redirect: "error" }),
    );
    for (const host of [
      "other-bucket.oss-cn-shanghai.aliyuncs.com",
      "algeng-video-infer.oss-cn-shanghai.aliyuncs.com.evil.example",
    ])
      await expect(
        providers.downloadMiniMaxVideo(
          `https://${host}/result.mp4`,
          file,
          signal,
        ),
      ).rejects.toThrow("域名无效");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("persists personal opening images per owner and preserves them after canceled or invalid uploads", async () => {
    const { workflow, owner } = fixture();
    const file = path.join(workflow.directory(owner), "portrait.jpg");
    fs.writeFileSync(
      file,
      Buffer.concat([Buffer.from([255, 216, 255]), Buffer.alloc(100)]),
    );
    workflow.dialogs.openIntroPhoto = vi.fn().mockResolvedValue(file);
    vi.spyOn(media, "probe").mockResolvedValue({
      streams: [{ codec_name: "mjpeg", width: 640, height: 480 }],
    });
    const photo = await workflow.handle("user-a", "opening-photo-import");
    const background = await workflow.handle(
      "user-a",
      "opening-background-import",
    );
    const directory = workflow.directory(owner);
    fs.mkdirSync(path.join(directory, "cache"), { recursive: true });
    fs.writeFileSync(
      path.join(directory, "cache", "opening.wav"),
      "test audio",
    );
    vi.spyOn(media, "scriptImage").mockResolvedValue("background-reference");
    workflow.remote = vi
      .fn()
      .mockRejectedValue(new Error("stop before provider"));
    await expect(
      workflow.miniMaxOpening(
        directory,
        {
          openingPhoto: photo.id,
          openingLocation: { source: "personal", asset: background.asset },
          aspectRatio: "9:16",
        },
        { audio: "opening.wav" },
        new AbortController().signal,
        { id: "template", version: "1.0.0" },
      ),
    ).rejects.toThrow("stop before provider");
    expect(workflow.remote).toHaveBeenCalledWith(
      "opening-submit",
      expect.objectContaining({
        location: "background-reference",
        photo: fs.readFileSync(file).toString("base64"),
        audio: Buffer.from("test audio").toString("base64"),
      }),
      expect.any(AbortSignal),
    );
    workflow.stores.clear();
    const saved = await workflow.handle("user-a", "opening-materials");
    expect(saved.photo.url).toMatch(/^data:image\/jpeg;base64,/);
    expect(saved.background.asset).toBe(background.asset);
    expect(await workflow.handle("user-b", "opening-materials")).toEqual({});
    workflow.dialogs.openIntroPhoto.mockResolvedValue(undefined);
    expect(
      await workflow.handle("user-a", "opening-background-import"),
    ).toBeNull();
    expect(workflow.store(owner).openingBackground.id).toBe(background.id);
    workflow.dialogs.openIntroPhoto.mockResolvedValue(file);
    fs.writeFileSync(file, "invalid image");
    await expect(
      workflow.handle("user-a", "opening-photo-import"),
    ).rejects.toThrow("JPEG");
    expect(workflow.store(owner).openingPhoto.id).toBe(photo.id);
  });

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
  it("exports only the owning user's completed real output through the registration port", () => {
    const { workflow, owner } = fixture();
    const job = {
      id: "11111111-1111-4111-8111-111111111111",
      draftRevision: 2,
      property,
      segments: [{ text: "最终文案" }],
      status: "succeeded",
      sample: false,
    };
    workflow.store(owner).jobs.push(job);
    const output = workflow.completedArtifactOutput("user-a", job.id);
    expect(output.source).toEqual({
      producer: "panorama",
      taskId: job.id,
      revision: 2,
    });
    expect(output.content.script).toBe("最终文案");
    expect(output.files.video).toBe(
      path.join(workflow.directory(owner), "jobs", job.id, "final.mp4"),
    );
    expect(() => workflow.completedArtifactOutput("user-b", job.id)).toThrow(
      "尚未完成",
    );
    job.status = "running";
    expect(() => workflow.completedArtifactOutput("user-a", job.id)).toThrow(
      "尚未完成",
    );
    job.status = "succeeded";
    job.sample = true;
    expect(() => workflow.completedArtifactOutput("user-a", job.id)).toThrow(
      "示例成片",
    );
    expect(() =>
      workflow.completedArtifactOutput("user-a", "../../private"),
    ).toThrow("引用无效");
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
  it("does not retry a retired opening without a new source", async () => {
    const { workflow, owner, scenes, config } = fixture();
    workflow.remote = vi.fn();
    workflow.store(owner).jobs.push({
      id: "j",
      status: "failed",
      property,
      scenes,
      config: { ...config, videoMode: "avatar" },
      avatar: { submitting: true },
    });
    await expect(
      workflow.handle("user-a", "retry", { id: "j" }),
    ).rejects.toThrow("改用房源画面开场");
    expect(workflow.remote).not.toHaveBeenCalled();
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

describe("production queue", () => {
  function batchFixture() {
    const env = fixture();
    const { workflow, owner, scenes, config } = env;
    const state = workflow.store(owner);
    const properties = Array.from({ length: 20 }, (_, i) => ({
      ...property,
      id: "property-" + i,
      title: "房源 " + i,
      importStatus: "ready",
    }));
    const templates = Array.from({ length: 3 }, (_, i) => ({
      id: "template-" + i,
      name: "模板 " + i,
      version: "1.0.0",
      production: {
        schemaVersion: 1,
        config: {
          language: "zh-CN",
          videoMode: "voiceover",
          openingTemplate: "开场介绍",
          sceneTemplate: "空间介绍",
          closingTemplate: "结束介绍",
        },
      },
    }));
    for (const p of properties) state.imports[p.id] = { property: p, scenes };
    workflow.factoryProperties = vi.fn(async () => ({
      rows: properties,
      defaults: { voiceId: "voice-1" },
    }));
    const mediaFactory = require("../production/factory.cjs");
    vi.spyOn(mediaFactory, "scriptImages").mockResolvedValue([]);
    let releaseScripts: () => void = () => {};
    const scripts = new Promise<void>((resolve) => {
      releaseScripts = resolve;
    });
    let scriptCalls = 0;
    workflow.remote = vi.fn(async (method: string) => {
      if (method === "voice-list")
        return { publicVoices: [{ id: "voice-1", language: "zh-CN" }] };
      if (method === "script-vision") {
        scriptCalls++;
        await scripts;
        return domain.segments(property, scenes, {
          ...config,
          ...templates[0].production.config,
        });
      }
      throw new Error("unexpected provider " + method);
    });
    vi.mocked(workflow.capabilities).mockResolvedValue({
      ffmpeg: true,
      ffprobe: true,
      ai: true,
      managedVoices: true,
      volcTts: true,
      voices: [],
      templates,
      defaultConfig: config,
    });
    const pairs = properties.flatMap((p) =>
      templates.map((template) => ({
        propertyId: p.id,
        templateId: template.id,
        version: template.version,
      })),
    );
    const call = (method: string, input?: unknown) =>
      workflow.handle("user-a", "factory-" + method, input);
    const act = (
      action: string,
      ...rows: { id: string; revision?: number }[]
    ) => call("act", { action, rows });
    return {
      ...env,
      call,
      act,
      pairs,
      templates,
      releaseScripts,
      scriptCalls: () => scriptCalls,
    };
  }

  it("sends the approved opening WAV to MiniMax and reuses it as the narration track", async () => {
    const { workflow, owner, scenes, config } = fixture();
    const dir = workflow.directory(owner);
    const references = path.join(dir, "opening");
    fs.mkdirSync(references);
    const video = Buffer.from("video reference".repeat(6));
    const photo = Buffer.from("photo reference".repeat(6));
    const wav = Buffer.from("original Doubao WAV");
    const openingClip = domain.hash(video);
    const openingPhoto = domain.hash(photo);
    fs.writeFileSync(path.join(references, `${openingClip}.mp4`), video);
    fs.writeFileSync(path.join(references, `${openingPhoto}.photo`), photo);
    vi.mocked(workflow.capabilities).mockResolvedValue({
      ffmpeg: true,
      ffprobe: true,
      managedVoices: true,
      volcTts: true,
      minimaxOpening: true,
    });
    workflow.remote = vi.fn(async (method: string, input: unknown) => {
      if (method === "voice-list")
        return { publicVoices: [{ id: "test", language: "zh-CN" }] };
      if (method === "opening-submit") {
        expect(input).toMatchObject({
          audio: wav.toString("base64"),
          video: video.toString("base64"),
          photo: photo.toString("base64"),
          authorized: true,
        });
        return { requestKey: "a".repeat(64) };
      }
      if (method === "opening-query")
        return {
          status: "succeeded",
          videoUrl: "https://cdn.hailuoai.com/example.mp4",
        };
      throw new Error(`Unexpected provider operation ${method}`);
    });
    vi.spyOn(media, "synthesize").mockImplementation(
      async (...args: unknown[]) => {
        const [segment, voice, cache] = args as [
          { kind: string },
          { ttsProvider: string },
          string,
        ];
        expect(voice.ttsProvider).toBe("volcengine");
        const audio = `${segment.kind}.wav`;
        fs.writeFileSync(path.join(cache, audio), wav);
        return { audio, duration: 4.2, captions: [] };
      },
    );
    vi.spyOn(providers, "downloadMiniMaxVideo").mockImplementation(
      async (...args: unknown[]) => {
        fs.writeFileSync(String(args[1]), "MiniMax video".repeat(6));
      },
    );
    vi.spyOn(media, "probe").mockResolvedValue({
      format: { duration: 5 },
      streams: [{ codec_type: "video" }],
    });
    const render = vi
      .spyOn(media, "render")
      .mockResolvedValue({ duration: 12.6 });
    const input = {
      scenes,
      config: {
        ...config,
        ttsProvider: "volcengine",
        openingClip,
        openingPhoto,
      },
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const draft = await workflow.handle(
        "user-a",
        "generate",
        input,
        property,
      );
      if (!attempt) {
        await expect(
          workflow.handle("user-a", "start", {
            id: draft.id,
            revision: draft.revision,
          }),
        ).rejects.toThrow("请先确认整条视频的文案");
        expect(workflow.remote).not.toHaveBeenCalled();
      }
      const job = await workflow.handle("user-a", "start", {
        id: draft.id,
        revision: draft.revision,
        confirmed: true,
      });
      await workflow.active.get(job.id)?.promise;
      expect(job.status, job.error).toBe("succeeded");
    }
    expect(
      workflow.remote.mock.calls.filter(
        ([method]: [string]) => method === "opening-submit",
      ),
    ).toHaveLength(1);
    const [, tracks, , , , , videoFile] = render.mock.calls[0];
    expect(tracks).toMatchObject([
      { audio: "opening.wav" },
      { audio: "scene.wav" },
      { audio: "closing.wav" },
    ]);
    expect(String(videoFile)).toMatch(/minimax-[a-f0-9]{64}\.mp4$/);
  });

  it("lets a legacy opening draft switch to room footage", async () => {
    const { workflow, owner, scenes, config, call, act, pairs } =
      batchFixture();
    await call("pause");
    await call("create", { requestId: "legacy-opening", pairs: [pairs[0]] });
    const state = workflow.store(owner);
    const draft = await workflow.handle(
      "user-a",
      "generate",
      { scenes, config },
      property,
    );
    const saved = state.drafts.find(
      (value: { id: string }) => value.id === draft.id,
    );
    saved.config.videoMode = "avatar";
    const item = state.production.items[0];
    Object.assign(item, {
      phase: "review",
      draftId: draft.id,
      config: saved.config,
    });
    expect(
      await act("room-opening", { id: item.id, revision: draft.revision }),
    ).toMatchObject([{ ok: true }]);
    expect(saved.config).toMatchObject({ roomOpening: true });
    expect(saved.revision).toBe(draft.revision + 1);
    expect(item.phase).toBe("review");
  });

  it("locks each MiniMax task to its own original location and requires a fresh approval after a change", async () => {
    const { workflow, owner, scenes, config, call, act, pairs, templates } =
      batchFixture();
    const state = workflow.store(owner);
    const selected = [pairs[0], pairs[3], pairs[6]];
    const photo = "b".repeat(64);
    fs.mkdirSync(path.join(workflow.directory(owner), "opening"));
    fs.writeFileSync(
      path.join(workflow.directory(owner), "opening", `${photo}.photo`),
      "broker photo fixture".repeat(4),
    );
    state.openingPhoto = { id: photo };
    const template = templates[0];
    Object.assign(template.production, {
      schemaVersion: 2,
      opening: { prompt: "在地点图中出镜", location: { source: "property" } },
    });
    template.production.config.videoMode = "avatar";
    vi.mocked(workflow.capabilities).mockResolvedValue({
      ai: true,
      ffmpeg: true,
      ffprobe: true,
      managedVoices: true,
      volcTts: true,
      minimaxOpening: true,
      templates,
      defaultConfig: config,
      voices: [],
    });
    function addPhoto(propertyId: string, name: string, id: string) {
      const asset = `${domain.hash(name)}.jpg`;
      state.assetMetadata[asset] = {
        kinds: ["photo"],
        width: 640,
        height: 480,
      };
      fs.writeFileSync(
        path.join(workflow.directory(owner), "assets", asset),
        name,
      );
      state.imports[propertyId].scenes = [
        ...state.imports[propertyId].scenes,
        { ...scenes[0], id, asset, room: name, kind: "photo" },
      ];
      return asset;
    }
    const first = addPhoto(
      selected[0].propertyId,
      "正门",
      "22222222-2222-4222-8222-222222222222",
    );
    const replacement = addPhoto(
      selected[0].propertyId,
      "门厅",
      "33333333-3333-4333-8333-333333333333",
    );
    const other = addPhoto(
      selected[1].propertyId,
      "庭院",
      "44444444-4444-4444-8444-444444444444",
    );
    const factory = require("../production/factory.cjs");
    vi.mocked(factory.scriptImages).mockImplementation(
      async (_w: unknown, _o: string, scenes: { id: string }[]) => scenes,
    );
    workflow.remote = vi.fn(
      async (method: string, input: { images: { id: string }[] }) => {
        if (method === "voice-list")
          return { publicVoices: [{ id: "voice-1", language: "zh-CN" }] };
        if (method === "script-vision")
          return [
            "opening",
            ...input.images.map(({ id }) => id),
            "closing",
          ].map((id) => ({ id, text: "审核文案" }));
        throw new Error("unexpected provider " + method);
      },
    );
    await call("pause");
    const batch = {
      requestId: "location-opening",
      pairs: selected,
      openingRecipe: true,
    };
    expect((await call("create", batch)).issues[0].error).toContain(
      "经纪人照片",
    );
    await call("create", {
      ...batch,
      openingPhoto: photo,
      openingAuthorized: true,
    });
    await call("resume");
    const items = state.production.items;
    await vi.waitFor(() =>
      expect(items.map((item: { phase: string }) => item.phase)).toEqual([
        "review",
        "review",
        "review",
      ]),
    );
    expect(
      items.map(
        (item: { config: { openingLocation: { asset?: string } } }) =>
          item.config.openingLocation.asset,
      ),
    ).toEqual([first, other, undefined]);
    const [a, b, missing] = items;
    await expect(
      call("opening-location", { id: a.id, revision: 1, asset: other }),
    ).rejects.toThrow("当前房源");
    await call("opening-location", {
      id: a.id,
      revision: 1,
      asset: replacement,
    });
    expect((await call("detail", { id: a.id })).draft).toMatchObject({
      revision: 2,
      config: { openingLocation: { asset: replacement } },
    });
    expect(
      (await call("detail", { id: b.id })).config.openingLocation.asset,
    ).toBe(other);
    expect((await act("confirm", { id: a.id, revision: 1 }))[0].ok).toBe(false);
    expect(
      (await act("confirm", { id: missing.id, revision: 1 }))[0].error,
    ).toContain("开场地点图");
    expect(
      (await act("room-opening", { id: missing.id, revision: 1 }))[0].ok,
    ).toBe(true);
    expect(missing.config.openingLocation).toBeUndefined();
    expect(
      workflow.remote.mock.calls.some(
        ([method]: [string]) => method === "opening-submit",
      ),
    ).toBe(false);

    await call("pause");
    state.openingBackground = {
      id: domain.hash("personal"),
      asset: replacement,
    };
    const personalBatch = {
      requestId: "personal-background",
      pairs: [selected[0]],
      openingPhoto: photo,
      openingBackground: state.openingBackground.id,
      openingAuthorized: true,
      openingRecipe: true,
    };
    await call("create", personalBatch);
    const personalItem = state.production.items.find(
      (item: any) => item.batchId === personalBatch.requestId,
    );
    expect(personalItem.config.openingLocation).toEqual({
      source: "personal",
      asset: replacement,
    });
    state.openingBackground = { id: domain.hash("replacement"), asset: first };
    await call("resume");
    await vi.waitFor(() => expect(personalItem.phase).toBe("review"));
    expect(
      (await call("detail", { id: personalItem.id })).draft.config
        .openingLocation,
    ).toEqual({ source: "personal", asset: replacement });
    expect(
      (
        await call("create", {
          ...personalBatch,
          requestId: "stale-background",
        })
      ).issues[0].error,
    ).toContain("背景图已更新");
  });

  it("uses the template location with panorama-only properties and returns overlong narration to review", async () => {
    const {
      workflow,
      owner,
      config,
      call,
      act,
      pairs,
      templates,
      releaseScripts,
    } = batchFixture();
    const state = workflow.store(owner);
    const photo = "b".repeat(64);
    const opening = path.join(workflow.directory(owner), "opening");
    fs.mkdirSync(opening);
    fs.writeFileSync(
      path.join(opening, `${photo}.photo`),
      "broker photo fixture".repeat(4),
    );
    state.openingPhoto = { id: photo };
    const fixtureImage = Buffer.from("template location fixture".repeat(4));
    const asset = `${domain.hash(fixtureImage)}.jpg`;
    fs.writeFileSync(
      path.join(workflow.directory(owner), "assets", asset),
      fixtureImage,
    );
    const importImage = vi
      .spyOn(workflow, "importBytes")
      .mockResolvedValue({ asset });
    templates[0].production.config.videoMode = "avatar";
    Object.assign(templates[0].production, {
      schemaVersion: 2,
      opening: {
        prompt: "在门店出镜",
        location: { source: "fixed", image: fixtureImage.toString("base64") },
      },
    });
    vi.mocked(workflow.capabilities).mockResolvedValue({
      ai: true,
      ffmpeg: true,
      ffprobe: true,
      managedVoices: true,
      volcTts: true,
      minimaxOpening: true,
      templates,
      defaultConfig: config,
      voices: [],
    });
    vi.spyOn(media, "synthesize").mockResolvedValue({ duration: 16 });
    await call("create", {
      requestId: "fixed-location-opening",
      pairs: [pairs[0], pairs[3]],
      openingPhoto: photo,
      openingAuthorized: true,
      openingRecipe: true,
    });
    releaseScripts();
    const [first, second] = state.production.items;
    await vi.waitFor(() =>
      expect([first.phase, second.phase]).toEqual(["review", "review"]),
    );
    expect(importImage).toHaveBeenCalledTimes(1);
    expect(first.config.openingLocation.asset).toBe(asset);
    expect(second.config.openingLocation.asset).toBe(asset);
    expect(
      first.templateSnapshot.production.opening.location,
    ).not.toHaveProperty("image");
    expect((await act("confirm", { id: first.id, revision: 1 }))[0].ok).toBe(
      true,
    );
    await vi.waitFor(() => expect(first.error).toContain("16.0 秒"));
    expect(first.phase).toBe("review");
    expect((await call("detail", { id: first.id })).revision).toBe(2);
    expect(first.approvedRevision).toBeUndefined();
    expect(
      workflow.remote.mock.calls.some(
        ([method]: [string]) => method === "opening-submit",
      ),
    ).toBe(false);
  });

  it("snapshots the local clip for new face batches without consulting the avatar service", async () => {
    const { workflow, owner, call, pairs, templates } = batchFixture();
    templates[0].production.config.videoMode = "avatar";
    await call("pause");
    const input = { requestId: "face-batch", pairs: [pairs[0]] };
    expect(await call("create", input)).toMatchObject({
      issues: [{ error: "请先导入真人开场视频" }],
    });
    const source = path.join(workflow.root, "intro.mp4");
    fs.writeFileSync(source, "test opening clip");
    workflow.dialogs.openIntro = async () => source;
    vi.spyOn(media, "probe").mockResolvedValue({
      format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "3.0" },
      streams: [{ codec_type: "video" }],
    });
    const clip = await workflow.handle("user-a", "opening-clip-import");
    expect((await call("catalog")).openingClip).toEqual(clip);
    expect(
      (await workflow.handle("user-b", "factory-catalog")).openingClip,
    ).toBeUndefined();
    expect(await call("create", { ...input, openingClip: clip.id })).toEqual({
      batchId: input.requestId,
      issues: [],
    });
    fs.writeFileSync(source, "new test opening clip");
    await workflow.handle("user-a", "opening-clip-import");
    const item = workflow.store(owner).production.items[0];
    expect(item.config.openingClip).toBe(clip.id);
    expect(
      fs.readFileSync(
        path.join(workflow.directory(owner), "opening", `${clip.id}.mp4`),
        "utf8",
      ),
    ).toBe("test opening clip");
    expect(
      workflow.remote.mock.calls.map(([method]: [string]) => method),
    ).toEqual(["voice-list", "voice-list"]);
  });

  it("persists a 20 × 3 batch exactly once and pages large history as summaries", async () => {
    const { workflow, owner, call, pairs } = batchFixture();
    await call("pause");
    const input = { requestId: "batch-1", pairs };
    const attempts = await Promise.all([
      call("create", input),
      call("create", input),
    ]);
    expect(attempts).toEqual([
      { batchId: "batch-1", issues: [] },
      { batchId: "batch-1", issues: [] },
    ]);
    const page = await call("list", { page: 2, batchId: "batch-1" });
    expect(page.total).toBe(60);
    expect(page.rows).toHaveLength(10);
    expect(page.counts.preparing).toBe(60);
    expect(page.rows[0]).not.toHaveProperty("config");
    await expect(
      call("create", { ...input, pairs: pairs.slice(0, 5) }),
    ).rejects.toThrow("另一批");
    await expect(
      call("create", {
        requestId: "oversize",
        pairs: Array.from({ length: 201 }, () => pairs[0]),
      }),
    ).rejects.toThrow("200");
    expect(
      await call("create", {
        requestId: "invalid",
        pairs: [{ ...pairs[0], version: "old" }],
      }),
    ).toMatchObject({ issues: [{ error: "模板已更新或下架，请重新选择" }] });
    const data = workflow.store(owner).production;
    for (let i = 0; i < 10_000; i++)
      data.items.push({
        ...data.items[0],
        id: "history-" + i,
        batchId: undefined,
        phase: "done",
      });
    const history = await call("list", { page: 200, status: "done" });
    expect(history.total).toBe(10_000);
    expect(history.rows[49].id).toBe("history-9999");
    expect((await workflow.handle("user-b", "factory-list")).total).toBe(0);
  });

  it("backs up legacy history and restores a persisted queue without claiming work", async () => {
    const { workflow, owner, scenes, config } = fixture();
    const state = workflow.store(owner);
    const draft = {
      id: "legacy-draft",
      property,
      config,
      scenes,
      confirmation: "whole",
      revision: 1,
      segments: domain.segments(property, scenes, config),
      createdAt: "2026-01-01",
    };
    state.drafts.push(draft);
    state.jobs.push({
      ...draft,
      id: "legacy-job",
      draftId: "older-draft",
      draftRevision: 1,
      status: "succeeded",
    });
    workflow.persist(owner);
    const file = path.join(workflow.directory(owner), "workspace.json");
    const before = fs.readFileSync(file, "utf8");
    const migrated = new PanoramaWorkflow(workflow.root, "", {});
    const list = await migrated.handle("user-a", "factory-list");
    expect(list.counts).toEqual({ all: 2, done: 1, review: 1 });
    expect(fs.readFileSync(file + ".pre-batch", "utf8")).toBe(before);
    const production = migrated.store(owner).production;
    production.items.push({
      ...production.items.find((row: any) => row.id === draft.id),
      id: "interrupted",
      phase: "running",
      order: 1,
      approvedRevision: 1,
    });
    migrated.persist(owner);
    const reopened = new PanoramaWorkflow(workflow.root, "", {});
    expect(await reopened.handle("user-a", "factory-list")).toMatchObject({
      paused: true,
      interrupted: 1,
      counts: { all: 3, queued: 1, review: 1, done: 1 },
    });
    expect(reopened.active.size).toBe(0);
  });

  it("gates execution on approval, preserves FIFO, resumes after stop and retries only the failed archive", async () => {
    const { workflow, owner, call, act, pairs, releaseScripts, scriptCalls } =
      batchFixture();
    const active: { job: any; finish: () => void }[] = [];
    vi.spyOn(workflow, "execute").mockImplementation(
      (jobOwner: any, job: any) => {
        expect(jobOwner).toBe(owner);
        expect(workflow.active.size).toBe(0);
        const controller = new AbortController();
        const promise = new Promise<void>((resolve) => {
          function finish() {
            job.status = controller.signal.aborted ? "failed" : "succeeded";
            workflow.active.delete(job.id);
            workflow.persist(owner);
            resolve();
          }
          active.push({ job, finish });
          controller.signal.addEventListener("abort", finish, { once: true });
        });
        workflow.active.set(job.id, { controller, promise });
        return promise;
      },
    );
    workflow.archiveOutput = vi
      .fn()
      .mockRejectedValueOnce(new Error("登记暂时不可用"))
      .mockResolvedValue({ id: "artifact-1" });
    await call("create", {
      requestId: "batch-2",
      pairs: [pairs[0], pairs[3], pairs[6], pairs[9]],
    });
    await vi.waitFor(() => expect(scriptCalls()).toBe(2));
    await call("pause");
    releaseScripts();
    await vi.waitFor(async () =>
      expect((await call("list")).counts.review).toBe(2),
    );
    const review = (await call("list", { status: "review" })).rows;
    expect(active).toHaveLength(0);
    expect(
      await act("confirm", { id: review[0].id, revision: 99 }),
    ).toMatchObject([{ ok: false }]);
    expect(await act("confirm", ...review)).toMatchObject([
      { ok: true },
      { ok: true },
    ]);
    expect(await act("withdraw", review[1])).toMatchObject([{ ok: true }]);
    expect(await act("confirm", review[1])).toMatchObject([{ ok: false }]);
    const updated = await call("detail", { id: review[1].id });
    expect(await act("confirm", updated)).toMatchObject([{ ok: true }]);
    expect(active).toHaveLength(0);
    await call("resume");
    await vi.waitFor(() => expect(active).toHaveLength(1));
    expect((await call("detail", { id: review[0].id })).job.id).toBe(
      active[0].job.id,
    );
    await vi.waitFor(async () =>
      expect((await call("list")).counts.review).toBe(2),
    );
    workflow.stop();
    expect(await call("list")).toMatchObject({ paused: true, interrupted: 2 });
    await call("resume");
    await vi.waitFor(() => expect(active).toHaveLength(2));
    expect(active[1].job.id).toBe(active[0].job.id);
    active[1].finish();
    await vi.waitFor(async () => {
      expect(active).toHaveLength(3);
      expect((await call("detail", { id: review[0].id })).phase).toBe(
        "archiveFailed",
      );
    });
    expect(await act("retry", review[0])).toMatchObject([{ ok: true }]);
    await vi.waitFor(async () =>
      expect((await call("detail", { id: review[0].id })).artifactId).toBe(
        "artifact-1",
      ),
    );
    expect(active).toHaveLength(3);
    expect(await act("cancel", review[1])).toMatchObject([{ ok: true }]);
    await vi.waitFor(async () =>
      expect((await call("detail", { id: review[1].id })).phase).toBe(
        "canceled",
      ),
    );
  });
});
