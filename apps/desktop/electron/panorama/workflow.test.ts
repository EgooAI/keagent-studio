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
  scenes.push({
    ...scenes[0],
    id: "99999999-9999-4999-8999-999999999999",
    room: "餐厅",
  });
  const config = { ...domain.defaultConfig, voice: "test" };
  vi.spyOn(workflow, "capabilities").mockResolvedValue({
    ffmpeg: true,
    ffprobe: true,
    voices: [{ name: "test", language: "zh-CN" }],
  });
  return { workflow, owner, scenes, config };
}
describe("panorama domain", () => {
  it("normalizes only finite allowlisted task pacing values using config bounds", () => {
    expect(domain.renderOverrides(undefined)).toBeUndefined();
    expect(domain.renderOverrides({})).toBeUndefined();
    for (const pacing of [
      { speed: 0.5, rate: 0.5, maxSweep: 1 },
      { speed: 45, rate: 2, maxSweep: 180 },
    ]) {
      expect(domain.renderOverrides(pacing)).toEqual(pacing);
      expect(
        domain.config({ ...domain.defaultConfig, ...pacing }),
      ).toMatchObject(pacing);
    }
    for (const value of [
      null,
      [],
      "fast",
      new Date(),
      { cameraMode: "spatial" },
      { direction: -1 },
      { design: "short-tour" },
      { speed: 46 },
      { speed: 0.49 },
      { speed: NaN },
      { rate: Infinity },
      { rate: 2.1 },
      { rate: 0.4 },
      { maxSweep: 0 },
      { maxSweep: 181 },
      { speed: null },
      { rate: "1" },
      { speed: undefined },
    ])
      expect(() => domain.renderOverrides(value)).toThrow();
  });
  it("reuses the local catalog across restarts and replaces it only when the server version changes", async () => {
    const { workflow, owner } = fixture();
    const first = { recommended: [{ id: "old" }], parts: [], personal: [] };
    const second = { recommended: [{ id: "new" }], parts: [], personal: [] };
    const version = "a".repeat(64);
    const updatedVersion = "b".repeat(64);
    vi.mocked(workflow.capabilities).mockRestore();
    workflow.capabilityPromise = Promise.resolve({ ffmpeg: true });
    workflow.remote = vi
      .fn()
      .mockResolvedValue({ catalogVersion: version, library: first });
    expect(
      await workflow.handle("user-a", "factory-catalog", { cachedOnly: true }),
    ).toBeNull();
    expect(workflow.remote).not.toHaveBeenCalled();
    expect(await workflow.handle("user-a", "factory-catalog")).toMatchObject({
      library: first,
    });
    expect(workflow.remote).toHaveBeenCalledWith(
      "capabilities",
      expect.objectContaining({ bundleCatalog: true }),
      expect.any(AbortSignal),
    );

    const restarted = new PanoramaWorkflow(workflow.root, "", {});
    restarted.capabilityPromise = workflow.capabilityPromise;
    restarted.remote = vi.fn().mockResolvedValue({ catalogVersion: version });
    const call = (input = {}) =>
      restarted.handle("user-a", "factory-catalog", input);
    expect(await call({ cachedOnly: true })).toMatchObject({ library: first });
    expect(
      await restarted.handle("user-b", "factory-catalog", { cachedOnly: true }),
    ).toBeNull();
    expect(restarted.remote).not.toHaveBeenCalled();
    const persist = vi.spyOn(restarted, "persist");
    expect(await call()).toMatchObject({ library: first });
    expect(restarted.remote).toHaveBeenCalledWith(
      "capabilities",
      expect.objectContaining({ catalogVersion: version }),
      expect.any(AbortSignal),
    );
    expect(persist).not.toHaveBeenCalled();

    restarted.remote.mockResolvedValue({
      catalogVersion: updatedVersion,
      library: second,
    });
    expect(await call()).toMatchObject({ library: second });
    expect(persist).toHaveBeenCalledOnce();
    expect(restarted.store(owner).factoryCatalog.version).toBe(updatedVersion);
    restarted.remote.mockRejectedValue(new Error("offline"));
    await expect(call()).rejects.toThrow("offline");
    expect(await call({ cachedOnly: true })).toMatchObject({ library: second });
    expect(persist).toHaveBeenCalledOnce();
  });

  it("stores personal mix music outside the cloud catalog and restores it from the local cache", async () => {
    const { workflow } = fixture();
    const saved = { id: "mine:weekend", version: "1.0.0", name: "周末带看" };
    const backgroundMusic = { id: "warm-v1", volume: 19 };
    const input = { name: saved.name, parts: {} };
    const library = { recommended: [], parts: [], personal: [saved] };
    const capability = { catalogVersion: "1", library };
    vi.mocked(workflow.capabilities).mockResolvedValue(capability);
    workflow.remote = vi.fn().mockResolvedValue(saved);

    expect(
      await workflow.handle("user-a", "factory-save-mix", {
        ...input,
        backgroundMusic,
      }),
    ).toEqual({ ...saved, backgroundMusic });
    expect(workflow.remote).toHaveBeenCalledWith("mix-save", input);
    expect(await workflow.handle("user-a", "factory-catalog")).toMatchObject({
      library: { personal: [{ ...saved, backgroundMusic }] },
    });
    expect(saved).not.toHaveProperty("backgroundMusic");
    expect(await workflow.handle("user-b", "factory-catalog")).toMatchObject({
      library: { personal: [saved] },
    });

    const restarted = new PanoramaWorkflow(
      workflow.root,
      "",
      {},
      workflow.remote,
    );
    const cached = (user: string) =>
      restarted.handle(user, "factory-catalog", { cachedOnly: true });
    expect(
      (await cached("user-a")).library.personal[0].backgroundMusic,
    ).toEqual(backgroundMusic);
    expect(
      (await cached("user-b")).library.personal[0].backgroundMusic,
    ).toBeUndefined();
    await restarted.handle("user-a", "factory-save-mix", input);
    expect(
      (await cached("user-a")).library.personal[0].backgroundMusic,
    ).toBeUndefined();
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
    expect(draft.segments[3].text).toBe("这里是卧室。");
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
  it("accepts legacy and faster camera speeds while rejecting unsafe bounds", () => {
    for (const speed of [0.5, 4, 8, 12, 36, 45])
      expect(domain.config({ ...domain.defaultConfig, speed }).speed).toBe(
        speed,
      );
    for (const speed of [
      0,
      46,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ])
      expect(() => domain.config({ ...domain.defaultConfig, speed })).toThrow();
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
  it.each([1, 2])(
    "keeps omitted camera mode locked to panorama for schema %s snapshots",
    async (schemaVersion) => {
      const { workflow, owner, scenes, config } = fixture();
      const template = JSON.parse(
        fs.readFileSync("services/cloud/video_templates.json", "utf8"),
      ).find(
        (resource: any) =>
          resource.production.schemaVersion === schemaVersion &&
          resource.production.config.videoMode === "voiceover",
      );
      workflow.store(owner).imports[property.id] = { property, scenes };
      vi.spyOn(
        require("../production/factory.cjs"),
        "scriptImages",
      ).mockResolvedValue([]);
      workflow.remote = vi.fn(async (method: string) => {
        if (method === "template") return template;
        if (method === "script-vision")
          return domain.segments(property, scenes, {
            ...config,
            ...template.production.config,
          });
        throw new Error("unexpected provider " + method);
      });
      const draft = await workflow.handle(
        "user-a",
        "prepare",
        {
          propertyId: property.id,
          sceneIds: scenes.map((scene) => scene.id),
          templateVersion: template.version,
          config: { ...config, templateId: template.id, cameraMode: "spatial" },
        },
        property,
      );
      expect(draft.config).not.toHaveProperty("cameraMode");
      expect(draft.templateSnapshot.production.config).toEqual(
        template.production.config,
      );
      const input = {
        id: draft.id,
        revision: draft.revision,
        segments: draft.segments,
      };
      await expect(
        workflow.handle("user-a", "save", {
          ...input,
          config: { ...draft.config, cameraMode: "spatial" },
        }),
      ).rejects.toThrow("制作规则不可修改");
      const saved = await workflow.handle("user-a", "save", {
        ...input,
        config: { ...draft.config, cameraMode: "panorama" },
      });
      expect(saved.config).not.toHaveProperty("cameraMode");
      expect(saved.revision).toBe(2);
    },
  );

  it("saves a spatial destination without allowing its source work or route list to change", async () => {
    const { workflow, scenes, config } = fixture();
    const spatialSource = require("../production/spatial-source.cjs");
    const spatial = {
      workId: "a".repeat(64),
      panoIndex: 0,
      targetPanoIndex: 1,
      targets: [
        { index: 1, label: "点位 2" },
        { index: 2, label: "点位 3" },
      ],
    };
    vi.spyOn(spatialSource, "validateSpatialScene").mockImplementation(
      (_, value) => {
        const scene = value as { spatial: typeof spatial };
        if (
          !scene.spatial.targets.some(
            (target) => target.index === scene.spatial.targetPanoIndex,
          )
        )
          throw new Error("目标拍摄点无效");
        return structuredClone(scene.spatial);
      },
    );
    const draft = await workflow.handle(
      "user-a",
      "generate",
      {
        scenes: scenes.map((scene) => ({ ...scene, spatial })),
        config: { ...config, cameraMode: "spatial" },
      },
      property,
    );
    const input = {
      id: draft.id,
      revision: 1,
      config: draft.config,
      segments: draft.segments,
      scenes: draft.scenes.map((scene: object) => ({
        ...scene,
        spatial: { ...spatial, targetPanoIndex: 2 },
      })),
    };
    const saved = await workflow.handle("user-a", "save", input);
    expect(saved.scenes[0].spatial).toEqual({ ...spatial, targetPanoIndex: 2 });
    for (const change of [
      { workId: "b".repeat(64) },
      { panoIndex: 1 },
      { targets: [] },
      { targetPanoIndex: 99 },
    ]) {
      await expect(
        workflow.handle("user-a", "save", {
          ...input,
          revision: saved.revision,
          scenes: saved.scenes.map((scene: { spatial: typeof spatial }) => ({
            ...scene,
            spatial: { ...scene.spatial, ...change },
          })),
        }),
      ).rejects.toThrow();
    }
    expect(workflow.store(workflow.owner("user-a")).drafts[0].revision).toBe(2);
  });
  it("rejects spatial production from panorama-only materials before generating narration", async () => {
    const { workflow, scenes, config } = fixture();
    await expect(
      workflow.handle(
        "user-a",
        "generate",
        {
          scenes,
          config: { ...config, cameraMode: "spatial" },
        },
        property,
      ),
    ).rejects.toThrow("完整 VR 空间");
  });
  it("persists reviewed camera angles while freezing existing job scenes", async () => {
    const { workflow, owner, scenes, config } = fixture();
    const draft = await workflow.handle(
      "user-a",
      "generate",
      { scenes, config },
      property,
    );
    vi.spyOn(workflow, "execute").mockImplementation(() => {});
    const job = await workflow.handle("user-a", "start", {
      id: draft.id,
      revision: 1,
    });
    const updated = await workflow.handle("user-a", "save", {
      id: draft.id,
      revision: 1,
      config,
      segments: draft.segments,
      scenes: draft.scenes.map((scene: { id: string }) => ({
        id: scene.id,
        yaw: 150,
        direction: -1,
      })),
    });
    expect(updated.scenes[0]).toMatchObject({
      asset: scenes[0].asset,
      room: "客厅",
      yaw: 150,
      direction: -1,
    });
    expect(job.scenes[0].yaw).toBe(-30);
    const saved = JSON.parse(
      fs.readFileSync(
        path.join(workflow.directory(owner), "workspace.json"),
        "utf8",
      ),
    );
    expect(saved.drafts[0].scenes[0].yaw).toBe(150);
    const textOnly = await workflow.handle("user-a", "save", {
      id: draft.id,
      revision: updated.revision,
      config,
      segments: updated.segments,
    });
    expect(textOnly.scenes).toEqual(updated.scenes);
  });
  it("rejects replacing, reordering or corrupting reviewed camera media", async () => {
    const { workflow, scenes, config } = fixture();
    const draft = await workflow.handle(
      "user-a",
      "generate",
      { scenes, config },
      property,
    );
    const invalid = [
      draft.scenes.slice(0, 1),
      [...draft.scenes].reverse(),
      draft.scenes.map((scene: object) => ({
        ...scene,
        asset: "a".repeat(64) + ".jpg",
      })),
      draft.scenes.map((scene: object) => ({ ...scene, kind: "photo" })),
      draft.scenes.map((scene: object) => ({ ...scene, room: "另一套房" })),
      draft.scenes.map((scene: object) => ({ ...scene, yaw: 181 })),
      draft.scenes.map((scene: object) => ({ ...scene, yaw: Number.NaN })),
      draft.scenes.map((scene: object) => ({ ...scene, direction: null })),
    ];
    for (const cameraScenes of invalid) {
      await expect(
        workflow.handle("user-a", "save", {
          id: draft.id,
          revision: 1,
          config,
          segments: draft.segments,
          scenes: cameraScenes,
        }),
      ).rejects.toThrow();
    }
    expect(workflow.store(workflow.owner("user-a")).drafts[0].revision).toBe(1);
  });
  it("restores camera edits when saving the checkpoint fails", async () => {
    const { workflow, owner, scenes, config } = fixture();
    const draft = await workflow.handle(
      "user-a",
      "generate",
      { scenes, config },
      property,
    );
    vi.spyOn(workflow, "persist").mockImplementation(() => {
      throw new Error("disk full");
    });
    await expect(
      workflow.handle("user-a", "save", {
        id: draft.id,
        revision: 1,
        config,
        segments: draft.segments,
        scenes: draft.scenes.map((scene: object) => ({ ...scene, yaw: 150 })),
      }),
    ).rejects.toThrow("disk full");
    expect(workflow.store(owner).drafts[0]).toMatchObject({
      revision: 1,
      scenes: [
        expect.objectContaining({ yaw: -30 }),
        expect.objectContaining({ yaw: -30 }),
      ],
    });
  });
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
      bailianTts: true,
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
      workflow.handle(
        "user-a",
        "factory-" + method,
        method === "create"
          ? {
              sceneIdsByProperty: Object.fromEntries(
                properties.map((p) => [p.id, scenes.map((s) => s.id)]),
              ),
              ...(input as object),
            }
          : input,
      );
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

  it("draws a cover suggestion without a property reason and renders the reviewed revision", async () => {
    const {
      workflow,
      owner,
      call,
      act,
      pairs,
      templates,
      releaseScripts,
      scriptCalls,
    } = batchFixture();
    const properties = (await workflow.factoryProperties()).rows;
    properties[0].community = "测试小区";
    Object.assign(templates[0], { cover: { imageSource: "listing-frame" } });
    vi.spyOn(workflow, "execute").mockImplementation(() => {});
    await call("pause");
    const created = await call("create", {
      requestId: "cover-review",
      pairs: [{ ...pairs[0], coverReason: "新家交付 准备搬家" }],
    });
    expect(created.issues).toEqual([]);
    releaseScripts();
    await call("resume");
    const state = workflow.store(owner);
    await vi.waitFor(() =>
      expect(state.production.items[0].phase).toBe("review"),
    );
    const draft = state.drafts[0];
    const bank = require("../production/cover-reasons.json");
    expect(new Set(bank).size).toBe(bank.length);
    expect(bank).toContain(draft.coverReason);
    expect(draft.coverReason).toBe("新家交付 准备搬家");
    expect(draft.property.details?.saleReason).toBeUndefined();
    const item = state.production.items[0];
    expect((await call("detail", { id: item.id })).draft.coverReason).toBe(
      draft.coverReason,
    );
    const save = (coverReason: string) =>
      workflow.handle("user-a", "save", {
        id: draft.id,
        revision: draft.revision,
        config: draft.config,
        segments: draft.segments,
        coverReason,
      });
    await expect(save(" ")).rejects.toThrow("封面售卖原因");
    await expect(save("理由一\n理由二")).rejects.toThrow("一行");
    const reviewed = await save("搬去和父母同住");
    await act("confirm", { id: item.id, revision: reviewed.revision });
    await vi.waitFor(() => expect(state.jobs).toHaveLength(1));
    const job = state.jobs[0];
    expect(job.coverReason).toBe(reviewed.coverReason);
    expect(
      require("../production/presentation.cjs").card(job, "cover").rows[1],
    ).toBe("搬去和父母同住");
    expect(scriptCalls()).toBe(1);
  });

  it("resolves a personal mix once per batch and sends the pinned recipe to script generation for every property", async () => {
    const { workflow, owner, call, templates, releaseScripts } = batchFixture();
    const source = {
      id: "mine:test",
      version: "1.0.0",
      parts: Object.fromEntries(
        ["edit", "cover", "script"].map((kind) => [
          kind,
          { id: kind + "-version", version: "1.0.0" },
        ]),
      ),
    };
    const snapshot = {
      ...templates[0],
      id: "mix:task-recipe",
      name: "我的搭配",
      parts: source.parts,
      cover: {
        kind: "cover",
        design: "classic",
        imageSource: "last",
        titleSource: "property",
        showFacts: false,
        brandColor: "#446688",
      },
    };
    const previousRemote = workflow.remote;
    workflow.remote = vi.fn((method: string, input: unknown) =>
      method === "mix-resolve"
        ? Promise.resolve(snapshot)
        : previousRemote(method, input),
    );
    await call("pause");
    const input = {
      requestId: "pinned-batch",
      pairs: ["property-0", "property-1"].map((propertyId) => ({
        propertyId,
        templateId: source.id,
        version: source.version,
      })),
      mixes: [source],
    };
    expect(await call("create", input)).toMatchObject({
      issues: [],
      batchId: input.requestId,
    });
    expect(await call("create", input)).toMatchObject({
      batchId: input.requestId,
    });
    expect(
      workflow.remote.mock.calls.filter(
        ([method]: string[]) => method === "mix-resolve",
      ),
    ).toHaveLength(1);
    await expect(
      call("create", {
        ...input,
        mixes: [
          {
            ...source,
            parts: {
              ...source.parts,
              cover: { id: "another-cover", version: "1.0.0" },
            },
          },
        ],
      }),
    ).rejects.toThrow("另一批");
    releaseScripts();
    await call("resume");
    await vi.waitFor(() =>
      expect(
        workflow
          .store(owner)
          .production.items.every((i: any) => i.phase === "review"),
      ).toBe(true),
    );
    const scripts = workflow.remote.mock.calls.filter(
      ([method]: string[]) => method === "script-vision",
    );
    expect(scripts).toHaveLength(2);
    for (const [, payload] of scripts)
      expect(payload).toMatchObject({
        templateId: snapshot.id,
        templateVersion: snapshot.version,
      });
    for (const draft of workflow.store(owner).drafts)
      expect(draft.templateSnapshot).toEqual(snapshot);
  });

  it("upgrades the previous stock default and asks users to replace unavailable custom defaults", async () => {
    const { workflow, owner, call, pairs } = batchFixture();
    const selected = await workflow.factoryProperties();
    workflow.remote = vi.fn(async () => ({
      publicVoices: [
        { id: "builtin-public-zh-qwen-lingxin", language: "zh-CN" },
        { id: "voice-1", language: "zh-CN" },
      ],
    }));
    await call("pause");
    const input = { requestId: "voice-migration", pairs: [pairs[0]] };
    workflow.factoryProperties = vi.fn(async () => ({
      ...selected,
      defaults: { voiceId: "retired-custom-voice" },
    }));
    expect(await call("create", input)).toMatchObject({
      issues: [{ error: "默认音色已不可用，请重新选择音色后提交" }],
    });
    expect(workflow.store(owner).production.items).toHaveLength(0);
    for (const voiceId of [
      "builtin-public-zh-vv-v2",
      "builtin-public-zh-qwen-plus",
    ]) {
      workflow.factoryProperties = vi.fn(async () => ({
        ...selected,
        defaults: { voiceId },
      }));
      expect(
        await call("create", { ...input, requestId: voiceId }),
      ).toMatchObject({
        batchId: voiceId,
      });
      expect(workflow.store(owner).production.items[0].config).toMatchObject({
        ttsProvider: "bailian",
        voice: "builtin-public-zh-qwen-lingxin",
      });
    }
  });

  it("freezes task pacing separately from templates and preserves it across pending retry, copy and review", async () => {
    const { workflow, owner, call, act, pairs, templates, releaseScripts } =
      batchFixture();
    Object.assign(templates[0].production.config, {
      speed: 8,
      rate: 1,
      maxSweep: 100,
    });
    await call("pause");
    const base = { requestId: "pacing-default", pairs: [pairs[0]] };
    await call("create", base);
    expect(
      (await call("create", { ...base, renderOverrides: {} })).batchId,
    ).toBe(base.requestId);
    const input = {
      ...base,
      requestId: "pacing-custom",
      renderOverrides: { speed: 24, rate: 1.2, maxSweep: 160 },
    };
    await call("create", input);
    expect(
      (
        await call("create", {
          ...input,
          renderOverrides: { maxSweep: 160, rate: 1.2, speed: 24 },
        })
      ).batchId,
    ).toBe(input.requestId);
    await expect(
      call("create", { ...input, renderOverrides: { speed: 25 } }),
    ).rejects.toThrow("提交标识");
    for (const renderOverrides of [
      { speed: 46 },
      { cameraMode: "spatial" },
      null,
    ])
      await expect(
        call("create", { ...base, requestId: "invalid", renderOverrides }),
      ).rejects.toThrow();
    const state = workflow.store(owner);
    const item = state.production.items.find(
      (row: any) => row.batchId === input.requestId,
    );
    const snapshot = structuredClone(item.templateSnapshot);
    expect(item.config).toMatchObject(input.renderOverrides);
    expect(snapshot.production.config).toMatchObject({
      speed: 8,
      rate: 1,
      maxSweep: 100,
    });
    const copied = (await act("copy", item))[0];
    expect(copied.ok).toBe(true);
    const pendingCopy = state.production.items.find(
      (row: any) => row.id === copied.createdId,
    );
    expect(pendingCopy.config).toMatchObject(input.renderOverrides);
    await act("cancel", item);
    expect((await act("retry", item))[0].ok).toBe(true);
    releaseScripts();
    await call("resume");
    await vi.waitFor(() =>
      expect(
        state.production.items.every((row: any) => row.phase === "review"),
      ).toBe(true),
    );
    await call("pause");
    for (const row of [item, pendingCopy]) {
      const draft = state.drafts.find((entry: any) => entry.id === row.draftId);
      expect(draft.config).toMatchObject(input.renderOverrides);
      expect(draft.templateSnapshot).toEqual(snapshot);
    }
    const draft = state.drafts.find((entry: any) => entry.id === item.draftId);
    const beforeInvalidSave = structuredClone({
      revision: draft.revision,
      config: draft.config,
      itemConfig: item.config,
    });
    for (const rate of [null, undefined, "1", NaN, Infinity]) {
      await expect(
        workflow.handle("user-a", "save", {
          id: draft.id,
          revision: draft.revision,
          config: { ...draft.config, rate },
          segments: draft.segments,
        }),
      ).rejects.toThrow("rate 超出范围");
      expect({
        revision: draft.revision,
        config: draft.config,
        itemConfig: item.config,
      }).toEqual(beforeInvalidSave);
    }
    const pacing = { speed: 32, rate: 1.4, maxSweep: 120 };
    const saved = await workflow.handle("user-a", "save", {
      id: draft.id,
      revision: draft.revision,
      config: { ...draft.config, ...pacing },
      segments: draft.segments,
    });
    expect(item.config).toMatchObject(pacing);
    expect(saved.templateSnapshot).toEqual(snapshot);
    const restarted = new PanoramaWorkflow(workflow.root, "", {});
    restarted.capabilities = workflow.capabilities;
    restarted.remote = workflow.remote;
    const restored = restarted
      .store(owner)
      .production.items.find((row: any) => row.id === item.id);
    expect(restored.config).toMatchObject(pacing);
    expect(restored.templateSnapshot).toEqual(snapshot);
    const resumedCall = (method: string, input: unknown) =>
      restarted.handle("user-a", "factory-" + method, input);
    const resumedAct = (action: string, revision?: number) =>
      resumedCall("act", { action, rows: [{ id: item.id, revision }] });
    const reviewCopy = (await resumedAct("copy"))[0];
    const copiedDraft = (
      await resumedCall("detail", { id: reviewCopy.createdId })
    ).draft;
    expect(copiedDraft.config).toMatchObject(pacing);
    expect(copiedDraft.templateSnapshot).toEqual(snapshot);
    expect((await resumedAct("cancel"))[0].ok).toBe(true);
    expect((await resumedAct("retry"))[0].ok).toBe(true);
    expect((await resumedAct("confirm", saved.revision))[0].ok).toBe(true);
    expect(restored.phase).toBe("queued");
    expect(restored.config).toMatchObject(pacing);
    expect(templates[0].production.config).toEqual(snapshot.production.config);
  });

  it("validates selections per property and freezes them for every selected template", async () => {
    const { workflow, owner, scenes, call, pairs } = batchFixture();
    await call("pause");
    const propertyId = pairs[0].propertyId;
    const saved = workflow.store(owner).imports[propertyId];
    const extra = {
      ...scenes[0],
      id: "88888888-8888-4888-8888-888888888888",
      room: "额外房间",
    };
    saved.scenes = [...scenes, extra];
    const materials = await call("materials", { propertyId });
    expect(materials.scenes.map((s: { id: string }) => s.id)).toEqual([
      ...scenes.map((s) => s.id),
      extra.id,
    ]);
    await expect(
      call("materials", { propertyId: "not-owned" }),
    ).rejects.toThrow("房源已移除");
    for (const ids of [
      [],
      [scenes[0].id],
      [scenes[0].id, "not-owned-scene"],
      Array(8).fill(scenes[0].id),
    ]) {
      const result = await call("create", {
        requestId: "selection-batch",
        pairs: pairs.slice(0, 2),
        sceneIdsByProperty: { [propertyId]: ids },
      });
      expect(result.batchId).toBeUndefined();
      expect(result.issues).toHaveLength(2);
    }
    expect(workflow.store(owner).production.items).toHaveLength(0);
    const input = {
      requestId: "selection-batch",
      pairs: pairs.slice(0, 2),
      sceneIdsByProperty: { [propertyId]: [extra.id, scenes[0].id] },
    };
    await call("create", input);
    saved.scenes = scenes;
    extra.room = "之后修改的名称";
    const items = workflow.store(owner).production.items;
    for (const item of items) {
      expect(item.scenes.map((s: { id: string }) => s.id)).toEqual([
        scenes[0].id,
        extra.id,
      ]);
      expect(item.scenes[1].room).toBe("额外房间");
    }
    expect((await call("create", input)).batchId).toBe("selection-batch");
    await expect(
      call("create", {
        ...input,
        sceneIdsByProperty: { [propertyId]: scenes.map((s) => s.id) },
      }),
    ).rejects.toThrow("提交标识");
    const restarted = new PanoramaWorkflow(workflow.root, "", {});
    expect(restarted.store(owner).production.items[0].scenes).toEqual(
      items[0].scenes,
    );
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
    saved.config.openingPhoto = domain.hash("old photo");
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

  it("upgrades old captions explicitly and reuses timed recognition after restart", async () => {
    const { workflow, owner } = fixture();
    const id = domain.hash("old opening");
    const original = [{ text: "校对过的字幕", start: 0.1, end: 1.2 }];
    const clip = { id, name: "opening.mp4", duration: 3 };
    workflow.saveOpeningAsset(owner, workflow.store(owner), {
      ...clip,
      captions: original,
    });
    workflow.saveOpeningVideos(owner, workflow.store(owner), [clip]);
    const video = workflow.openingVideoFile(owner, id);
    fs.mkdirSync(path.dirname(video), { recursive: true });
    fs.writeFileSync(video, "fixture");
    vi.spyOn(media, "probe").mockResolvedValue({
      streams: [{ codec_type: "audio" }],
    });
    vi.spyOn(media, "openingAudio").mockImplementation(
      async (...args: unknown[]) => {
        fs.writeFileSync(
          path.join(args[2] as string, "fixture.wav"),
          "audio fixture",
        );
        return { audio: "fixture.wav" };
      },
    );
    const phrases = [
      [
        { text: "请", start: 0.22, end: 0.43 },
        { text: "进。", start: 0.43, end: 1.19 },
      ],
    ];
    workflow.remote = vi
      .fn()
      .mockResolvedValueOnce({ phrases: [] })
      .mockResolvedValue({ phrases });
    const read = (extra = {}) =>
      workflow.handle("user-a", "opening-captions", { id, ...extra });
    const upgrade = { regroup: true, previous: original };
    expect(await read()).toEqual(original);
    expect(workflow.remote).not.toHaveBeenCalled();
    await expect(read(upgrade)).rejects.toThrow("保留现有字幕");
    expect(await read()).toEqual(original);
    const [caption, concurrent] = await Promise.all([
      read(upgrade),
      read(upgrade),
    ]);
    expect(caption).toEqual([{ text: "请进", start: 0.22, end: 1.19 }]);
    expect(concurrent).toEqual(caption);
    expect(workflow.remote).toHaveBeenCalledTimes(2);
    expect(workflow.remote).toHaveBeenCalledWith(
      "opening-asr",
      expect.objectContaining({ wordTiming: true }),
      expect.anything(),
    );
    const reopened = new PanoramaWorkflow(workflow.root, "", {});
    expect(await reopened.handle("user-a", "opening-captions", { id })).toEqual(
      caption,
    );
    expect(reopened.store(owner).openingAssets[id].timedPhrases).toEqual(
      phrases,
    );
    expect(
      (await reopened.handle("user-a", "opening-videos"))[0].needsWordTiming,
    ).toBeUndefined();
  });

  it("keeps the local opening library account-scoped and requires an explicit selection for each batch", async () => {
    const { workflow, owner, call, pairs, templates } = batchFixture();
    templates[0].production.config.videoMode = "avatar";
    await call("pause");
    const input = { requestId: "face-batch", pairs: [pairs[0]] };
    const source = path.join(workflow.root, "intro.mp4");
    workflow.dialogs.openIntro = vi.fn().mockResolvedValue(source);
    vi.spyOn(media, "probe").mockResolvedValue({
      format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "3.0" },
      streams: [{ codec_type: "video" }],
    });
    const save = (contents: string, saveToLibrary: boolean) => {
      fs.writeFileSync(source, contents.repeat(10));
      return workflow.handle("user-a", "opening-clip-import", {
        saveToLibrary,
      });
    };
    const first = await save("first clip", true);
    const second = await save("second clip", true);
    const temporary = await save("temporary clip", false);

    expect(
      await workflow.handle("user-a", "opening-captions", { id: first.id }),
    ).toEqual([]);
    const original = [{ start: 0.8, end: 2, text: "欢迎看访" }];
    workflow.store(owner).openingAssets[first.id].captions = original;
    const cues = [{ ...original[0], text: "欢迎看房" }];
    expect(
      await workflow.handle("user-a", "opening-captions-save", {
        id: first.id,
        previous: original,
        texts: ["“欢迎，看房！”"],
      }),
    ).toEqual(cues);
    await expect(
      workflow.handle("user-a", "opening-captions-save", {
        id: first.id,
        previous: cues,
        texts: ["欢迎", "看房"],
      }),
    ).rejects.toThrow("字幕条数");
    await expect(
      workflow.handle("user-a", "opening-captions-save", {
        id: first.id,
        previous: [],
        texts: [],
      }),
    ).rejects.toThrow("字幕已更新");
    const previousAsset = workflow.store(owner).openingAssets[second.id];
    const lastVersion = workflow.store(owner).openingAssets[temporary.id];
    lastVersion.captionLayout = 2;
    lastVersion.captions = [
      { start: 0.2, end: 2.4, text: "建面89.5平方米，得房率80%！" },
    ];
    delete previousAsset.captionLayout;
    previousAsset.captions = [
      { start: 0, end: 1.4, text: "今天带大家看一套朝南的三" },
      { start: 1.4, end: 2, text: "居室，" },
      { start: 2.5, end: 3, text: "请进。" },
    ];
    workflow.persist(owner);
    const restarted = new PanoramaWorkflow(workflow.root, "", {});
    expect(
      await restarted.handle("user-a", "opening-captions", { id: second.id }),
    ).toEqual([
      { start: 0, end: 2, text: "今天带大家看一套朝南的三居室" },
      { start: 2.5, end: 3, text: "请进" },
    ]);
    expect(
      await restarted.handle("user-a", "opening-captions", { id: first.id }),
    ).toEqual(cues);
    expect(
      await restarted.handle("user-a", "opening-captions", {
        id: temporary.id,
      }),
    ).toEqual([{ start: 0.2, end: 2.4, text: "建面89.5平方米得房率80%" }]);
    await restarted.handle("user-a", "opening-captions-save", {
      id: first.id,
      previous: cues,
      texts: [],
    });
    expect(
      await restarted.handle("user-a", "opening-captions", {
        id: first.id,
        retry: true,
      }),
    ).toEqual(cues);
    expect(await restarted.handle("user-a", "opening-videos")).toMatchObject([
      first,
      second,
    ]);
    expect(await restarted.handle("user-b", "opening-videos")).toEqual([]);
    const url = new URL(workflow.openingVideoURL(owner, first.id));
    expect(workflow.mediaFile("user-a", url)).toBe(
      workflow.openingVideoFile(owner, first.id),
    );
    expect(() => workflow.mediaFile("user-b", url)).toThrow("无权访问");

    expect(await call("create", input)).toMatchObject({
      issues: [{ error: "请选择本机开场视频" }],
    });
    expect(
      await call("create", { ...input, openingVideo: "1".repeat(64) }),
    ).toMatchObject({
      issues: [{ error: "请选择本机开场视频" }],
    });
    expect(await call("create", { ...input, openingVideo: first.id })).toEqual({
      batchId: input.requestId,
      issues: [],
    });
    expect(
      await call("create", {
        ...input,
        requestId: "temporary-batch",
        openingVideo: temporary.id,
      }),
    ).toEqual({
      batchId: "temporary-batch",
      issues: [],
    });
    await workflow.handle("user-a", "opening-video-remove", { id: first.id });
    expect(await workflow.handle("user-a", "opening-videos")).toMatchObject([
      second,
    ]);
    expect(
      workflow
        .store(owner)
        .production.items.map((item: any) => item.config.openingVideo),
    ).toEqual([temporary.id, first.id]);
    expect(
      fs.readFileSync(workflow.openingVideoFile(owner, first.id), "utf8"),
    ).toBe("first clip".repeat(10));
    workflow.dialogs.openIntro.mockResolvedValue(undefined);
    expect(
      await workflow.handle("user-a", "opening-clip-import", {
        saveToLibrary: true,
      }),
    ).toBeNull();
    expect(await workflow.handle("user-a", "opening-videos")).toMatchObject([
      second,
    ]);
  });

  it("keeps music private and preserves the selected track when it is removed from the library", async () => {
    const { workflow, owner, call, pairs } = batchFixture();
    await call("pause");
    const builtIns = await workflow.handle("user-a", "music-tracks");
    expect(builtIns.map((track: { name: string }) => track.name)).toEqual([
      "暖意",
      "晴日",
      "静庭",
    ]);
    for (const track of builtIns)
      expect(
        fs.statSync(workflow.mediaFile("user-a", new URL(track.url))).size,
      ).toBeGreaterThan(0);

    const source = path.join(workflow.root, "我的曲目.wav");
    const contents = "test audio".repeat(10);
    fs.writeFileSync(source, contents);
    workflow.dialogs.openMusic = vi.fn().mockResolvedValue(source);
    const probe = vi
      .spyOn(media, "probe")
      .mockResolvedValueOnce({
        format: { duration: "12" },
        streams: [{ codec_type: "video" }],
      })
      .mockResolvedValue({
        format: { duration: "12" },
        streams: [{ codec_type: "audio" }],
      });
    await expect(workflow.handle("user-a", "music-import")).rejects.toThrow(
      "无法读取音频",
    );
    const local = await workflow.handle("user-a", "music-import");
    expect(probe).toHaveBeenCalledTimes(2);
    await workflow.handle("user-a", "music-rename", {
      id: local.id,
      name: "房源配乐",
    });
    expect(await workflow.handle("user-a", "music-import")).toMatchObject({
      name: "房源配乐",
    });

    const restarted = new PanoramaWorkflow(workflow.root, "", {});
    const saved = (await restarted.handle("user-a", "music-tracks")).at(-1);
    expect(saved).toMatchObject({ id: local.id, name: "房源配乐" });
    expect(await restarted.handle("user-b", "music-tracks")).toHaveLength(3);
    const localURL = new URL(saved.url);
    expect(() => restarted.mediaFile("user-b", localURL)).toThrow("无权访问");
    expect(() =>
      restarted.mediaFile("user-a", new URL("invalid", localURL)),
    ).toThrow("引用无效");

    await call("create", { requestId: "silent", pairs: [pairs[0]] });
    const backgroundMusic = { id: local.id, volume: 15 };
    const input = { requestId: "music", pairs: [pairs[0]], backgroundMusic };
    await call("create", input);
    await expect(
      call("create", {
        ...input,
        requestId: "invalid-volume",
        backgroundMusic: { ...backgroundMusic, volume: 31 },
      }),
    ).rejects.toThrow("音量无效");
    await expect(
      call("create", {
        ...input,
        backgroundMusic: { ...backgroundMusic, volume: 20 },
      }),
    ).rejects.toThrow("提交标识");
    await workflow.handle("user-a", "music-remove", { id: local.id });
    expect(await workflow.handle("user-a", "music-tracks")).toHaveLength(3);
    expect(await call("create", input)).toMatchObject({ batchId: "music" });
    await expect(
      call("create", { ...input, requestId: "removed" }),
    ).rejects.toThrow("已移除");

    const items = workflow.store(owner).production.items;
    expect(
      items.find((item: any) => item.batchId === "silent").config
        .backgroundMusic,
    ).toBeUndefined();
    expect(
      items.find((item: any) => item.batchId === "music").config
        .backgroundMusic,
    ).toEqual(backgroundMusic);
    const retained = await workflow.resolveMusic(owner, local.id);
    expect(fs.readFileSync(retained, "utf8")).toBe(contents);
    fs.unlinkSync(retained);
    await expect(workflow.resolveMusic(owner, local.id)).rejects.toThrow(
      "已丢失",
    );
  });

  it("sends only walkthrough information to the cloud and puts local opening audio before narration", async () => {
    const { workflow, owner, call, act, pairs, scenes, templates, config } =
      batchFixture();
    const recipe = templates[0].production;
    recipe.config.videoMode = "avatar";
    Object.assign(recipe, {
      opening: { prompt: "旧版开场提示词", location: { source: "fixed" } },
    });
    const id = domain.hash("opening");
    const file = workflow.openingVideoFile(owner, id);
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, Buffer.alloc(100));
    const expected = domain.segments(property, scenes, {
      ...config,
      ...recipe.config,
      openingVideo: id,
    });
    expect(expected.map((segment: { kind: string }) => segment.kind)).toEqual([
      "scene",
      "scene",
      "closing",
    ]);
    workflow.remote = vi.fn(async (method, input) => {
      if (method === "voice-list")
        return { publicVoices: [{ id: "voice-1", language: "zh-CN" }] };
      if (method === "script-vision") {
        expect(input.omitOpening).toBe(true);
        expect(JSON.stringify(input)).not.toContain(id);
        expect(JSON.stringify(input)).not.toContain("旧版开场提示词");
        return expected;
      }
      throw new Error("unexpected provider " + method);
    });
    const opening = vi
      .spyOn(media, "openingAudio")
      .mockResolvedValue({ duration: 4, audio: "opening.wav" });
    const speak = vi
      .spyOn(media, "synthesize")
      .mockImplementation(async (segment: any) => ({
        ...segment,
        duration: 1,
        audio: "tour.wav",
      }));
    const render = vi
      .spyOn(media, "render")
      .mockResolvedValue({ duration: 7, timeline: [] });

    await call("create", {
      requestId: "local-only",
      pairs: [pairs[0]],
      openingVideo: id,
    });
    const item = workflow.store(owner).production.items[0];
    await vi.waitFor(() => expect(item.phase).toBe("review"));
    const { draft, openingVideoUrl } = await call("detail", { id: item.id });
    expect(openingVideoUrl).toBe(workflow.openingVideoURL(owner, id));
    expect(draft.segments).toEqual(expected);
    expect(
      await act("confirm", { id: item.id, revision: draft.revision }),
    ).toMatchObject([{ ok: true }]);
    await vi.waitFor(() => expect(render).toHaveBeenCalled());
    expect(opening).toHaveBeenCalledWith(
      file,
      id,
      expect.any(String),
      expect.any(AbortSignal),
    );
    expect(speak.mock.calls.map(([segment]: any[]) => segment.id)).toEqual(
      expected.map((segment: { id: string }) => segment.id),
    );
    expect(render.mock.calls[0][1]).toMatchObject([
      { kind: "opening", audio: "opening.wav", duration: 4, captions: [] },
      ...expected,
    ]);
    await vi.waitFor(() => expect(item.phase).toBe("archiving"));
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
    const legacyVoice = {
      ...config,
      ttsProvider: "volcengine",
      voice: "builtin-public-zh-vv-v2",
    };
    const draft = {
      id: "legacy-draft",
      property,
      config: legacyVoice,
      scenes,
      confirmation: "whole",
      revision: 1,
      segments: domain.segments(property, scenes, config),
      createdAt: "2026-01-01",
    };
    state.drafts.push(draft, {
      ...draft,
      id: "first-bailian-draft",
      config: {
        ...config,
        ttsProvider: "bailian",
        voice: "builtin-public-zh-qwen-plus",
      },
    });
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
    expect(list.counts).toEqual({ all: 3, done: 1, review: 2 });
    expect(fs.readFileSync(file + ".pre-batch", "utf8")).toBe(before);
    const migratedState = migrated.store(owner);
    const production = migratedState.production;
    for (const migratedDraft of migratedState.drafts)
      expect(migratedDraft.config).toMatchObject({
        ttsProvider: "bailian",
        voice: "builtin-public-zh-qwen-lingxin",
      });
    expect(migratedState.jobs[0].config).toEqual(legacyVoice);
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
      counts: { all: 4, queued: 1, review: 2, done: 1 },
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
