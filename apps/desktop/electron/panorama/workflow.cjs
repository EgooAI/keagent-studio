const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const domain = require("./domain.cjs");
const media = require("./media.cjs");
const providers = require("./providers.cjs");
const sources = require("../production/sources.cjs");
const templateLibrary = require("../production/templates.cjs");
const factory = require("../production/factory.cjs");
const { ProductionQueue } = require("../production/queue.cjs");
const uuid = /^[a-f0-9-]{36}$/;
const assetName = /^[a-f0-9]{64}\.(jpg|png)$/;

class PanoramaWorkflow {
  constructor(root, sampleRoot, dialogs, remote) {
    this.root = root;
    this.sampleRoot = sampleRoot;
    this.dialogs = dialogs;
    this.remote = remote;
    this.stores = new Map();
    this.active = new Map();
    this.previews = new Set();
    this.capabilityPromise = null;
    this.sourceFlight = new Map();
    this.queue = new ProductionQueue(this);
  }
  owner(userId) {
    domain.ensure(
      typeof userId === "string" && userId,
      "请登录后使用全景工作流",
    );
    return domain.hash(userId);
  }
  directory(owner) {
    return path.join(this.root, owner);
  }
  store(owner) {
    if (this.stores.has(owner)) return this.stores.get(owner);
    const dir = this.directory(owner);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "workspace.json");
    // shortcut: device-local checkpoints; move to cloud leases when adding cross-device execution.
    const state = fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, "utf8"))
      : { schemaVersion: 1, drafts: [], jobs: [] };
    domain.ensure(
      state.schemaVersion === 1 &&
        Array.isArray(state.drafts) &&
        Array.isArray(state.jobs),
      "本机工作流记录损坏；原文件已保留",
    );
    if (
      fs.existsSync(file) &&
      !state.production &&
      !fs.existsSync(file + ".pre-batch")
    )
      fs.copyFileSync(file, file + ".pre-batch", fs.constants.COPYFILE_EXCL);
    for (const job of state.jobs)
      if (job.status === "running") {
        job.status = "failed";
        job.error = "客户端退出导致中断，可重试并复用已完成素材";
      }
    this.stores.set(owner, state);
    state.properties ??= [];
    state.imageTasks ??= [];
    state.assetMetadata ??= {};
    state.imports ??= {};
    state.templates ??= [];
    this.persist(owner);
    return state;
  }
  persist(owner) {
    const file = path.join(this.directory(owner), "workspace.json");
    fs.writeFileSync(file + ".tmp", JSON.stringify(this.stores.get(owner)), {
      mode: 0o600,
    });
    // Windows indexers can briefly hold the destination without delete sharing.
    // Keep atomic replacement and surface persistent failures; never delete the old checkpoint.
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(file + ".tmp", file);
        break;
      } catch (error) {
        if (attempt >= 6 || !["EPERM", "EACCES", "EBUSY"].includes(error.code))
          throw error;
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          10 * (attempt + 1),
        );
      }
    }
  }
  url(owner, relative) {
    return `keagent://media/${owner}/${relative}`;
  }
  view(owner, state) {
    return {
      ...state,
      assetMetadata: undefined,
      imports: undefined,
      production: undefined,
      imageTasks: state.imageTasks.map(({ id, sceneId, status, error }) => ({
        id,
        sceneId,
        status,
        error,
      })),
      drafts: state.drafts.map((d) => ({
        ...d,
        scenes: d.scenes.map((s) => ({
          ...s,
          url: this.url(owner, `assets/${s.asset}`),
          originalUrl:
            s.kind === "expanded" && assetName.test(s.sourceAsset || "")
              ? this.url(owner, `assets/${s.sourceAsset}`)
              : undefined,
        })),
      })),
      jobs: state.jobs.slice(0, 100).map((job) => ({
        ...job,
        videoUrl:
          job.status === "succeeded"
            ? this.url(owner, `jobs/${job.id}/final.mp4`)
            : undefined,
        coverUrl:
          job.status === "succeeded"
            ? this.url(owner, `jobs/${job.id}/cover.jpg`)
            : undefined,
        audioUrl: job.duration
          ? this.url(owner, `jobs/${job.id}/narration.wav`)
          : undefined,
      })),
    };
  }
  draftView(owner, draft) {
    return this.view(owner, { drafts: [draft], jobs: [], imageTasks: [] })
      .drafts[0];
  }
  jobView(owner, job) {
    return this.view(owner, { drafts: [], jobs: [job], imageTasks: [] })
      .jobs[0];
  }
  async capabilities(mode) {
    this.capabilityPromise ??= media
      .capabilities(path.join(this.root, "runtime"))
      .catch((error) => {
        this.capabilityPromise = null;
        throw error;
      });
    const local = await this.capabilityPromise;
    const cloud = this.remote
      ? await this.remote(
          "capabilities",
          mode === "runtime"
            ? { runtimeOnly: true }
            : mode === true
              ? { summary: true, openingRecipe: true }
              : mode
                ? { ...mode, openingRecipe: true }
                : {},
        )
      : {};
    return {
      ...local,
      templates:
        mode === true || mode === "runtime"
          ? cloud.templates || []
          : (cloud.templates || []).map((template) => ({
              ...template,
              opening: template.production.config.openingTemplate,
              scene: template.production.config.sceneTemplate,
              closing: template.production.config.closingTemplate,
            })),
      defaultConfig: domain.defaultConfig,
      ai: !!cloud.ai,
      volcTts: !!cloud.volcTts,
      minimaxOpening: !!cloud.minimaxOpening,
      managedVoices: !!cloud.managedVoices,
      beike: !!cloud.beike,
      imageExpansion: !!cloud.imageExpansion,
    };
  }
  async importFile(owner, file, room, kind = "panorama") {
    const stat = await fsp.stat(file);
    domain.ensure(
      stat.isFile() && stat.size <= 50 * 1024 * 1024 && stat.size > 32,
      "图片需小于 50 MB",
    );
    return this.importBytes(owner, await fsp.readFile(file), room, kind);
  }
  async importOpeningClip(owner, state, assertCurrent, referenceOnly) {
    const file = await this.dialogs.openIntro();
    assertCurrent();
    if (!file) return state.openingClip ?? null;
    const maxMB = referenceOnly ? 8 : 50;
    const maxSeconds = referenceOnly ? 5 : 30;
    const maxBytes = maxMB * 1024 * 1024;
    const stat = await fsp.stat(file);
    domain.ensure(
      path.extname(file).toLowerCase() === ".mp4" &&
        stat.isFile() &&
        stat.size > 0 &&
        stat.size <= maxBytes,
      `请选择 ${maxMB} MB 以内的 MP4 视频`,
    );
    const bytes = await fsp.readFile(file);
    domain.ensure(bytes.length <= maxBytes, `视频文件超过 ${maxMB} MB`);
    const directory = path.join(this.directory(owner), "opening");
    await fsp.mkdir(directory, { recursive: true });
    const id = domain.hash(bytes);
    const temp = path.join(directory, `${crypto.randomUUID()}.part.mp4`);
    const target = path.join(directory, `${id}.mp4`);
    try {
      await fsp.writeFile(temp, bytes, { flag: "wx" });
      const info = await media
        .probe(temp, directory, AbortSignal.timeout(12000), "mov")
        .catch(() => null);
      const duration = Number(info?.format?.duration);
      domain.ensure(
        info?.format?.format_name?.split(",").includes("mp4") &&
          info.streams.some(
            (s) => s.codec_type === "video" && !s.disposition?.attached_pic,
          ) &&
          duration >= 2 &&
          duration <= maxSeconds,
        `请选择 2–${maxSeconds} 秒、含有效画面的 MP4 视频`,
      );
      assertCurrent();
      if (!(await media.exists(target))) await fsp.rename(temp, target);
      assertCurrent();
      const previous = state.openingClip;
      state.openingClip = {
        id,
        name: path.basename(file).slice(-120),
        duration,
        bytes: bytes.length,
      };
      try {
        this.persist(owner);
      } catch (error) {
        state.openingClip = previous;
        throw error;
      }
      return state.openingClip;
    } finally {
      await fsp.rm(temp, { force: true });
    }
  }
  async importOpeningPhoto(owner, state, assertCurrent) {
    const file = await this.dialogs.openIntroPhoto();
    assertCurrent();
    if (!file) return state.openingPhoto ?? null;
    const maxBytes = 3 * 1024 * 1024;
    const stat = await fsp.stat(file);
    domain.ensure(
      stat.isFile() && stat.size <= maxBytes,
      "请选择 3 MB 以内的 JPEG 或 PNG 照片",
    );
    const bytes = await fsp.readFile(file);
    const jpeg = bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
    const png = bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    domain.ensure(
      bytes.length <= maxBytes && (jpeg || png),
      "请选择 3 MB 以内的 JPEG 或 PNG 照片",
    );
    const directory = path.join(this.directory(owner), "opening");
    await fsp.mkdir(directory, { recursive: true });
    const id = domain.hash(bytes);
    const temp = path.join(
      directory,
      `${crypto.randomUUID()}.part.${jpeg ? "jpg" : "png"}`,
    );
    try {
      await fsp.writeFile(temp, bytes, { flag: "wx" });
      const info = await media
        .probe(temp, directory, AbortSignal.timeout(12000), "image2")
        .catch(() => null);
      const { width, height } = info?.streams?.[0] || {};
      domain.ensure(
        width >= 256 &&
          height >= 256 &&
          width <= 4096 &&
          height <= 4096 &&
          width * 5 >= height * 2 &&
          height * 5 >= width * 2,
        "请选择宽高 256–4096 像素且比例适中的经纪人照片",
      );
      assertCurrent();
      const target = path.join(directory, `${id}.photo`);
      if (!(await media.exists(target))) await fsp.rename(temp, target);
      assertCurrent();
      const previous = state.openingPhoto;
      state.openingPhoto = { id, name: path.basename(file).slice(-120) };
      try {
        this.persist(owner);
      } catch (error) {
        state.openingPhoto = previous;
        throw error;
      }
      return state.openingPhoto;
    } finally {
      await fsp.rm(temp, { force: true });
    }
  }
  async importBytes(owner, data, room, kind = "panorama") {
    domain.ensure(
      ["panorama", "photo", "expanded", "reference"].includes(kind),
      "图片类型无效",
    );
    domain.ensure(
      data.length > 32 && data.length <= 50 * 1024 * 1024,
      "图片需小于50MB",
    );
    const jpeg = data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    const png = data
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    domain.ensure(jpeg || png, "仅支持 JPEG / PNG 图片");
    const asset = `${domain.hash(data)}.${jpeg ? "jpg" : "png"}`;
    const target = path.join(this.directory(owner), "assets");
    await fsp.mkdir(target, { recursive: true });
    await fsp.writeFile(path.join(target, asset), data, { mode: 0o600 });
    const info = await media.probe(
      path.join(target, asset),
      this.directory(owner),
    );
    const stream = info.streams[0];
    const minSide = kind === "reference" ? 128 : 512;
    domain.ensure(
      ["mjpeg", "png"].includes(stream.codec_name) &&
        stream.width >= minSide &&
        stream.height >= minSide &&
        stream.width <= 16384 &&
        stream.height <= 16384 &&
        (kind !== "panorama" ||
          (stream.width === stream.height * 2 && stream.width >= 2048)),
      "全景图需为2:1且宽度至少2048像素；普通照片短边至少512像素，参考图至少128像素",
    );
    const state = this.store(owner);
    const entry = (state.assetMetadata[asset] ??= { kinds: [] });
    Object.assign(entry, {
      width: stream.width,
      height: stream.height,
      byteSize: data.length,
    });
    if (!entry.kinds.includes(kind)) entry.kinds.push(kind);
    this.persist(owner);
    return {
      kind,
      id: crypto.randomUUID(),
      asset,
      room,
      description: "",
      yaw: 0,
      width: stream.width,
      height: stream.height,
      url: this.url(owner, `assets/${asset}`),
    };
  }
  openingLocations(owner, scenes) {
    const { assetMetadata } = this.store(owner);
    const result = new Map();
    for (const scene of scenes) {
      const asset = scene.kind === "photo" ? scene.asset : scene.sourceAsset;
      const metadata = assetMetadata[asset];
      if (!assetName.test(asset || "") || !metadata?.kinds?.includes("photo"))
        continue;
      const ratio = metadata.width / metadata.height;
      if (ratio >= 0.4 && ratio <= 2.5 && !result.has(asset))
        result.set(asset, {
          asset,
          label: scene.room,
          url: this.url(owner, `assets/${asset}`),
        });
    }
    return [...result.values()];
  }
  scenes(owner, input, allowPhoto = false) {
    domain.ensure(
      Array.isArray(input) && input.length >= 1 && input.length <= 20,
      "请添加 1–20 个空间",
    );
    const seen = new Set();
    return input.map((s) => {
      domain.ensure(uuid.test(s.id) && !seen.has(s.id), "空间 ID 无效或重复");
      seen.add(s.id);
      const kind = s.kind || "panorama";
      const metadata = this.store(owner).assetMetadata[s.asset];
      domain.ensure(
        kind !== "panorama" || !metadata?.kinds.includes("expanded"),
        "AI扩图结果不能作为真实全景图使用",
      );
      domain.ensure(
        ["panorama", "photo", "expanded"].includes(kind) &&
          (metadata ? metadata.kinds.includes(kind) : kind === "panorama"),
        "图片来源类型无效，请重新导入",
      );
      domain.ensure(
        allowPhoto || kind !== "photo",
        "普通照片须先完成AI扩图并审核，不能直接制作视频",
      );
      domain.ensure(
        allowPhoto || kind !== "expanded" || s.approved === true,
        "请先审核AI扩图结果",
      );
      domain.ensure(
        assetName.test(s.asset) &&
          fs.existsSync(path.join(this.directory(owner), "assets", s.asset)),
        "全景原图不存在，请重新导入",
      );
      domain.ensure(
        typeof s.yaw === "number" &&
          Number.isFinite(s.yaw) &&
          Math.abs(s.yaw) <= 180,
        "初始视角应为 -180° 到 180°",
      );
      return {
        kind,
        approved: s.approved === true,
        sourceAsset: kind === "expanded" ? s.sourceAsset : undefined,
        id: s.id,
        asset: s.asset,
        room: domain.text(s.room, "空间名称", 80),
        description: domain.optionalText(s.description, "空间说明", 1500),
        yaw: s.yaw,
        direction:
          s.direction === undefined
            ? undefined
            : (domain.ensure([1, -1].includes(s.direction), "空间镜头方向无效"),
              s.direction),
      };
    });
  }
  async sample(owner) {
    const manifest = JSON.parse(
      await fsp.readFile(path.join(this.sampleRoot, "manifest.json"), "utf8"),
    );
    const scenes = [];
    for (const asset of manifest.assets) {
      domain.ensure(/^[a-z0-9_]+\.jpg$/.test(asset.file), "测试素材文件名无效");
      const file = path.join(this.sampleRoot, asset.file);
      domain.ensure(
        crypto
          .createHash("md5")
          .update(await fsp.readFile(file))
          .digest("hex") === asset.md5,
        "测试素材校验失败",
      );
      scenes.push({
        ...(await this.importFile(owner, file, asset.name)),
        description: asset.narration.join(""),
        yaw: asset.yawStart,
      });
    }
    return {
      property: {
        id: "panorama-cc0-sample",
        title: "全景工作流测试",
        description: manifest.purpose,
        areaSqm: 0,
        priceCents: 0,
        layout: "",
        sellingPoints: [],
        sample: true,
      },
      scenes,
    };
  }
  async loadSample(owner, assertCurrent = () => {}) {
    const state = this.store(owner);
    if (state.imports["panorama-cc0-sample"])
      return state.imports["panorama-cc0-sample"];
    const sample = await this.sample(owner);
    assertCurrent();
    state.imports["panorama-cc0-sample"] = {
      ...sample,
      materialMode: "panorama",
    };
    this.persist(owner);
    return state.imports["panorama-cc0-sample"];
  }
  draft(owner, id, revision) {
    const draft = this.store(owner).drafts.find((d) => d.id === id);
    domain.ensure(
      draft && draft.revision === revision,
      "草稿已更新，请刷新后重试",
    );
    return draft;
  }
  async handle(
    userId,
    method,
    input = {},
    property,
    assertCurrent = () => {},
    productionItem,
  ) {
    assertCurrent();
    const owner = this.owner(userId);
    const state = this.store(owner);
    if (method.startsWith("factory-"))
      return this.queue.handle(
        userId,
        owner,
        method.slice(8),
        input,
        assertCurrent,
      );
    if (method === "template-save") {
      const result = templateLibrary.save(state, input);
      this.persist(owner);
      return result;
    }
    if (sources.methods.has(method)) {
      const flightKey = `${owner}:${method}`;
      domain.ensure(
        !this.sourceFlight.has(flightKey),
        "素材操作处理中，请稍候",
      );
      const pending = sources.handle(this, owner, method, input, assertCurrent);
      this.sourceFlight.set(flightKey, pending);
      try {
        return await pending;
      } finally {
        this.sourceFlight.delete(flightKey);
      }
    }
    if (method === "state") return this.view(owner, state);
    if (method === "opening-clip-import")
      return this.importOpeningClip(
        owner,
        state,
        assertCurrent,
        input.referenceOnly === true,
      );
    if (method === "opening-photo-import")
      return this.importOpeningPhoto(owner, state, assertCurrent);
    if (method === "capabilities") return this.capabilities();
    if (method === "preview-system") {
      const caps = await this.capabilities();
      domain.ensure(
        !caps.managedVoices,
        "请选择管理员上架的公共音色或本人音色",
      );
      domain.ensure(
        caps.voices.some(
          (v) => v.name === input.voice && v.language === input.language,
        ),
        "系统音色不存在",
      );
      const directory = path.join(this.directory(owner), "preview");
      await fsp.mkdir(directory, { recursive: true });
      const sample =
        input.language === "en-US"
          ? "Hello, let me introduce this property to you."
          : "您好，我是您的房产顾问，欢迎一起了解这套房源。";
      const controller = new AbortController();
      this.previews.add(controller);
      try {
        const result = await media.synthesize(
          { text: sample },
          {
            ...domain.defaultConfig,
            voice: input.voice,
            language: input.language,
          },
          directory,
          controller.signal,
        );
        controller.signal.throwIfAborted();
        assertCurrent();
        return { url: this.url(owner, `preview/${result.audio}`) };
      } finally {
        this.previews.delete(controller);
      }
    }
    if (method === "sample") return this.sample(owner);
    if (method === "property-import") {
      domain.ensure(
        input.propertyId !== "panorama-cc0-sample",
        "内置测试素材不可替换，请为真实房源另外导入素材",
      );
      return factory.importProperty(
        this,
        owner,
        property,
        input,
        assertCurrent,
      );
    }
    if (method === "import") {
      const files = await this.dialogs.open();
      assertCurrent();
      const results = [];
      for (const file of files.slice(0, 20))
        results.push(
          await this.importFile(
            owner,
            file,
            path.basename(file, path.extname(file)).slice(0, 80),
            input.kind === "photo" ? "photo" : "panorama",
          ),
        );
      return results;
    }
    if (method === "generate")
      return this.createDraft(owner, input, property, false, assertCurrent);
    if (method === "prepare") {
      const key =
        owner +
        ":prepare:" +
        domain.hash({
          propertyId: input.propertyId,
          config: input.config,
          templateVersion: input.templateVersion,
        });
      const previous = this.sourceFlight.get(key);
      if (previous) return previous;
      const pending = this.createDraft(
        owner,
        input,
        property,
        true,
        assertCurrent,
      );
      this.sourceFlight.set(key, pending);
      try {
        return await pending;
      } finally {
        this.sourceFlight.delete(key);
      }
    }
    if (method === "save") {
      const draft = this.draft(owner, input.id, input.revision);
      this.queue.assertEditable(owner, draft.id);
      const c = domain.config(input.config, [{ id: draft.config.templateId }]);
      if (draft.sample && draft.property.id === "panorama-cc0-sample")
        domain.ensure(
          c.ttsProvider === draft.config.ttsProvider &&
            c.voice === draft.config.voice,
          "内置测试任务使用本机测试配音，请重新选择测试模板",
        );
      if (draft.templateSnapshot)
        domain.ensure(
          Object.entries(draft.templateSnapshot.production.config).every(
            ([key, value]) => c[key] === value,
          ),
          "已确认模板的制作规则不可修改，请重新选择模板",
        );
      domain.ensure(
        c.leadSceneId === (draft.config.leadSceneId || ""),
        "开场镜头改变后，请重新生成文案",
      );
      domain.ensure(
        c.openingClip === draft.config.openingClip &&
          c.openingPhoto === draft.config.openingPhoto &&
          domain.hash(c.openingLocation || null) ===
            domain.hash(draft.config.openingLocation || null) &&
          c.roomOpening === draft.config.roomOpening,
        "开场视频已随任务保存，请创建新任务更换",
      );
      domain.ensure(
        !c.coverSceneId || draft.scenes.some((s) => s.id === c.coverSceneId),
        "封面空间不存在",
      );
      domain.ensure(
        c.language === draft.config.language &&
          c.materialMode === (draft.config.materialMode || "panorama") &&
          c.templateId === draft.config.templateId &&
          c.scriptProvider === draft.config.scriptProvider &&
          ["openingTemplate", "sceneTemplate", "closingTemplate"].every(
            (k) => c[k] === draft.config[k],
          ),
        "语言或文案模板改变后，请重新生成分段文案",
      );
      const previous = {
        segments: draft.segments,
        config: draft.config,
        revision: draft.revision,
      };
      draft.segments = domain.validateSegments(input.segments, draft.segments);
      draft.config = c;
      draft.revision++;
      try {
        this.persist(owner);
      } catch (error) {
        Object.assign(draft, previous);
        throw error;
      }
      return this.draftView(owner, draft);
    }
    if (method === "start") {
      const draft = this.draft(owner, input.id, input.revision);
      this.queue.assertExecution(owner, draft.id, productionItem);
      const existing = state.jobs.find(
        (job) =>
          job.draftId === draft.id &&
          job.draftRevision === draft.revision &&
          job.status !== "canceled",
      );
      if (existing) return existing;
      domain.ensure(
        (draft.confirmation !== "whole" && !draft.config.openingPhoto) ||
          input.confirmed === true,
        "请先确认整条视频的文案",
      );
      await this.preflight(draft, owner, draft.confirmation === "whole");
      this.draft(owner, input.id, input.revision);
      assertCurrent();
      this.queue.assertExecution(owner, draft.id, productionItem);
      domain.ensure(!this.active.size, "本机正在生成视频，请稍后再试");
      const job = {
        id: crypto.randomUUID(),
        draftId: draft.id,
        draftRevision: draft.revision,
        property: structuredClone(draft.property),
        sample: draft.sample,
        confirmation: draft.confirmation,
        confirmedAt:
          draft.confirmation === "whole" || draft.config.openingPhoto
            ? new Date().toISOString()
            : undefined,
        config: structuredClone(draft.config),
        scenes: structuredClone(draft.scenes),
        segments: structuredClone(draft.segments),
        templateVersion: draft.templateVersion,
        templateSnapshot: draft.templateSnapshot
          ? structuredClone(draft.templateSnapshot)
          : undefined,
        status: "running",
        stage:
          draft.confirmation === "whole" &&
          draft.config.materialMode === "expand"
            ? "images"
            : "tts",
        progress: 0,
        createdAt: new Date().toISOString(),
      };
      state.jobs.unshift(job);
      try {
        if (productionItem)
          this.queue.update(owner, productionItem, { jobId: job.id });
        else this.persist(owner);
      } catch (error) {
        state.jobs.shift();
        throw error;
      }
      this.execute(owner, job);
      return job;
    }
    const job = state.jobs.find((j) => j.id === input.id);
    domain.ensure(job, "本机任务不存在");
    if (method === "cancel") {
      this.queue.assertExecution(owner, job.draftId, productionItem);
      domain.ensure(job.status === "running", "只有执行中的任务可以取消");
      job.status = "canceled";
      try {
        if (productionItem)
          this.queue.update(owner, productionItem, {
            phase: "canceled",
            error: undefined,
          });
        else this.persist(owner);
      } catch (error) {
        job.status = "running";
        throw error;
      }
      this.active.get(job.id)?.controller.abort();
      return null;
    }
    if (method === "retry") {
      this.queue.assertExecution(owner, job.draftId, productionItem);
      domain.ensure(
        job.status === "failed" || job.status === "canceled",
        "只有失败或已取消任务可以重试",
      );
      domain.ensure(!this.active.has(job.id), "正在停止上一次执行，请稍后重试");
      await this.preflight(
        job,
        owner,
        job.confirmation === "whole" && !!job.confirmedAt,
      );
      assertCurrent();
      this.queue.assertExecution(owner, job.draftId, productionItem);
      domain.ensure(!this.active.size, "本机正在生成视频，请稍后再试");
      const previous = { status: job.status, error: job.error };
      job.status = "running";
      job.error = undefined;
      try {
        this.persist(owner);
      } catch (error) {
        Object.assign(job, previous);
        throw error;
      }
      this.execute(owner, job);
      return job;
    }
    if (method === "export") {
      domain.ensure(job.status === "succeeded", "任务尚未生成成片");
      const output = await this.dialogs.save("全景讲解.mp4");
      assertCurrent();
      if (output)
        await fsp.copyFile(
          path.join(this.directory(owner), "jobs", job.id, "final.mp4"),
          output,
        );
      return !!output;
    }
    throw new Error("未知全景工作流操作");
  }
  async createDraft(
    owner,
    input,
    property,
    preparing,
    assertCurrent,
    item,
    preparationSignal,
  ) {
    const state = this.store(owner);
    const controller = new AbortController();
    this.previews.add(controller);
    const signal = preparationSignal
      ? AbortSignal.any([preparationSignal, controller.signal])
      : controller.signal;
    try {
      property ??= state.properties.find((p) => p.id === input.propertyId);
      domain.ensure(
        property && typeof property.title === "string",
        "房源不存在，请重新选择",
      );
      let templateSnapshot;
      if (preparing) {
        domain.ensure(this.remote, "请连接服务并选择管理员已上架的模板");
        templateSnapshot =
          item?.templateSnapshot ||
          (await this.remote(
            "template",
            {
              id: input.config?.templateId,
              version: input.templateVersion,
              openingRecipe: true,
            },
            signal,
          ));
        assertCurrent();
        domain.ensure(
          templateSnapshot?.id === input.config?.templateId &&
            [1, 2].includes(templateSnapshot.production?.schemaVersion),
          "模板制作规则无效，请刷新后重试",
        );
      }
      const c = domain.config(
        {
          ...input.config,
          ...(templateSnapshot?.production.config || {}),
        },
        templateSnapshot ? [templateSnapshot] : state.templates,
      );
      if (preparing && property.id === "panorama-cc0-sample") {
        domain.ensure(
          property.sample === true && c.videoMode === "voiceover",
          "内置测试房源请选择配音模板",
        );
        const caps = await this.capabilities("runtime");
        assertCurrent();
        const voice = caps.voices.find((v) => v.language === c.language);
        domain.ensure(
          voice,
          "内置测试需要对应语言的本机声音，请使用中文模板并安装系统中文语音",
        );
        c.ttsProvider = "system";
        c.voice = voice.name;
        c.scriptProvider = "template";
      }
      if (preparing && !property.sample) c.scriptProvider = "ai";
      domain.ensure(
        !c.openingLocation || templateSnapshot?.production.opening,
        "请选择已上架的 MiniMax 开场模板",
      );
      domain.ensure(
        c.videoMode !== "avatar" ||
          c.openingClip ||
          c.openingLocation ||
          c.roomOpening,
        "请选择真人开场视频，或改用房源画面开场",
      );
      assertCurrent();
      domain.ensure(
        c.scriptProvider !== "ai" || this.remote,
        "未连接云端 AI 服务",
      );
      const scenes = this.scenes(
        owner,
        preparing
          ? await factory.load(this, owner, property, assertCurrent, signal)
          : input.scenes,
        preparing,
      );
      if (preparing) {
        c.materialMode = scenes.some((s) => s.kind !== "panorama")
          ? "expand"
          : "panorama";
        c.leadSceneId = "";
        c.coverSceneId = "";
        c.coverTitle = "";
        for (const scene of scenes) scene.direction = c.direction;
        if (c.openingLocation?.source === "property") {
          const options = this.openingLocations(owner, scenes);
          c.openingLocation.asset =
            options.find(({ asset }) => asset === c.openingLocation.asset)
              ?.asset || options[0]?.asset;
        }
      }
      for (const key of ["leadSceneId", "coverSceneId"])
        domain.ensure(
          !c[key] || scenes.some((s) => s.id === c[key]),
          "开场或封面空间已移除，请重新选择",
        );
      domain.ensure(
        preparing ||
          scenes.every((s) =>
            c.materialMode === "expand"
              ? s.kind === "expanded" || (preparing && s.kind === "photo")
              : s.kind === "panorama",
          ),
        "素材与所选制作方式不一致",
      );
      const expected = domain.segments(property, scenes, c);
      const segments =
        preparing && !property.sample
          ? domain.validateSegments(
              await this.remote(
                "script-vision",
                {
                  property: Object.fromEntries(
                    [
                      "title",
                      "propertyNumber",
                      "city",
                      "district",
                      "community",
                      "layout",
                      "areaSqm",
                      "priceCents",
                      "description",
                      "sellingPoints",
                      "details",
                      "lastVerifiedAt",
                      "source",
                    ].map((key) => [key, property[key]]),
                  ),
                  templateId: templateSnapshot.id,
                  templateVersion: templateSnapshot.version,
                  openingRecipe: !!templateSnapshot.production.opening,
                  images: await factory.scriptImages(
                    this,
                    owner,
                    scenes,
                    state.imports[property.id]?.references || [],
                    signal,
                  ),
                },
                AbortSignal.any([signal, AbortSignal.timeout(65000)]),
              ),
              expected,
            )
          : c.scriptProvider === "ai"
            ? domain.validateSegments(
                await this.remote(
                  "script",
                  {
                    property,
                    scenes: scenes.map(({ room, description }) => ({
                      room,
                      description,
                    })),
                    template: c,
                    language: c.language,
                    segments: expected,
                  },
                  AbortSignal.any([signal, AbortSignal.timeout(65000)]),
                ),
                expected,
              )
            : domain.validateSegments(expected, expected);
      assertCurrent();
      const draft = {
        id: crypto.randomUUID(),
        revision: 1,
        property: structuredClone(property),
        sample: property.sample === true,
        confirmation: preparing ? "whole" : undefined,
        scenes,
        config: c,
        templateSnapshot: templateSnapshot
          ? structuredClone(templateSnapshot)
          : undefined,
        templateVersion: String(
          templateSnapshot?.version ||
            state.templates.find((t) => t.id === c.templateId)?.version ||
            domain.templates.find((t) => t.id === c.templateId)?.version ||
            "1",
        ),
        segments,
        createdAt: new Date().toISOString(),
      };
      state.drafts.unshift(draft);
      try {
        if (item)
          this.queue.update(owner, item, {
            draftId: draft.id,
            config: c,
            phase: "review",
          });
        else this.persist(owner);
      } catch (error) {
        state.drafts.shift();
        throw error;
      }
      return this.draftView(owner, draft);
    } finally {
      this.previews.delete(controller);
    }
  }
  async preflight(
    draft,
    owner,
    pendingImages = false,
    reviewOnly = false,
    checks = {},
  ) {
    if (owner) {
      this.scenes(owner, draft.scenes, pendingImages);
      for (const scene of draft.scenes) {
        const bytes = await fsp.readFile(
          path.join(this.directory(owner), "assets", scene.asset),
        );
        domain.ensure(
          domain.hash(bytes) === scene.asset.split(".")[0],
          "制作素材已改变，请重新导入并审核",
        );
      }
    }
    domain.ensure(
      reviewOnly || this.active.size === 0,
      "本机正在生成视频，请等待完成后再提交",
    );
    const caps = await (checks.capabilities ??= this.capabilities("runtime"));
    domain.ensure(
      !pendingImages ||
        !draft.scenes.some((s) => s.kind === "photo") ||
        caps.imageExpansion,
      "图片处理服务尚未配置，请联系管理员",
    );
    domain.ensure(
      reviewOnly || this.active.size === 0,
      "本机正在生成视频，请等待完成后再提交",
    );
    domain.ensure(
      caps.ffmpeg && caps.ffprobe,
      "未找到 FFmpeg / FFprobe，请配置运行时路径后重启客户端",
    );
    if (draft.config.ttsProvider === "system")
      domain.ensure(
        (!caps.managedVoices ||
          (draft.sample === true &&
            draft.property.id === "panorama-cc0-sample")) &&
          caps.voices.some(
            (v) =>
              v.name === draft.config.voice &&
              v.language === draft.config.language,
          ),
        "所选语言没有可用的本机声音，请更换音色或配音服务",
      );
    else if (draft.config.ttsProvider === "personal") {
      domain.ensure(this.remote, "未连接本人音色服务");
      const catalog = await (checks.voices ??= this.remote("voice-list", {}));
      domain.ensure(
        catalog.cloneEnabled &&
          catalog.voices.some(
            (v) =>
              v.id === draft.config.voice &&
              v.status === "ready" &&
              v.language === draft.config.language,
          ),
        "本人音色不存在或尚未就绪，请重新选择",
      );
    } else {
      domain.ensure(
        caps.volcTts && draft.config.voice,
        "请选择公共音色，并确认配音服务已配置",
      );
      const catalog = await (checks.voices ??= this.remote("voice-list", {}));
      domain.ensure(
        catalog.publicVoices.some(
          (voice) =>
            voice.id === draft.config.voice &&
            voice.language === draft.config.language,
        ),
        "公共音色已下架或不存在，请重新选择",
      );
    }
    if (draft.config.openingClip) {
      domain.ensure(
        await media.exists(
          path.join(
            this.directory(owner),
            "opening",
            `${draft.config.openingClip}.mp4`,
          ),
        ),
        "本机开场视频已丢失，请重新导入原视频后重试",
      );
    } else if (!draft.config.openingLocation) {
      domain.ensure(
        draft.config.videoMode !== "avatar" || draft.config.roomOpening,
        "请选择真人开场视频，或改用房源画面开场",
      );
    }
    if (draft.config.openingPhoto) {
      domain.ensure(caps.minimaxOpening, "请在管理后台启用 MiniMax 开场服务");
      const dir = this.directory(owner);
      domain.ensure(
        await media.exists(
          path.join(dir, "opening", `${draft.config.openingPhoto}.photo`),
        ),
        "经纪人照片已丢失，请重新导入原照片",
      );
      const location = draft.config.openingLocation;
      if (location)
        domain.ensure(
          assetName.test(location.asset || "") &&
            (await media.exists(path.join(dir, "assets", location.asset))),
          "没有可用的开场地点图，请补充房源原图或改用房源开场",
        );
    }
  }
  async miniMaxOpening(dir, config, opening, signal, templateSnapshot) {
    const cache = path.join(dir, "cache");
    const audio = await fsp.readFile(path.join(cache, opening.audio));
    const location = config.openingLocation;
    const key = domain.hash([
      location ? "minimax-h3-768p-location-v1" : "minimax-h3-768p-v1",
      location
        ? [templateSnapshot.id, templateSnapshot.version, location.asset]
        : config.openingClip,
      config.openingPhoto,
      domain.hash(audio),
      config.aspectRatio,
    ]);
    const target = path.join(cache, `minimax-${key}.mp4`);
    if (await media.exists(target)) return target;
    const photo = await fsp.readFile(
      path.join(dir, "opening", `${config.openingPhoto}.photo`),
    );
    domain.ensure(
      photo.length <= 3 * 1024 * 1024 &&
        domain.hash(photo) === config.openingPhoto,
      "经纪人照片内容已变更，请重新导入原照片",
    );
    let reference;
    if (location) {
      reference = {
        templateId: templateSnapshot.id,
        templateVersion: templateSnapshot.version,
      };
      if (location.source === "property") {
        const file = path.join(dir, "assets", location.asset);
        domain.ensure(
          domain.hash(await fsp.readFile(file)) ===
            location.asset.split(".")[0],
          "地点原图已变更，请重新导入原图",
        );
        reference.location = await media.scriptImage(file, dir, signal);
      }
    } else {
      const video = await fsp.readFile(
        path.join(dir, "opening", `${config.openingClip}.mp4`),
      );
      domain.ensure(
        video.length <= 8 * 1024 * 1024 &&
          domain.hash(video) === config.openingClip,
        "参考视频内容已变更，请重新导入原文件",
      );
      reference = { video: video.toString("base64") };
    }
    const { requestKey } = await this.remote(
      "opening-submit",
      {
        ...reference,
        photo: photo.toString("base64"),
        audio: audio.toString("base64"),
        ratio: config.aspectRatio,
        authorized: true,
      },
      signal,
    );
    domain.ensure(
      typeof requestKey === "string" && /^[a-f0-9]{64}$/.test(requestKey),
      "MiniMax 开场请求标识无效",
    );
    const polling = AbortSignal.any([
      signal,
      AbortSignal.timeout(12 * 60 * 1000),
    ]);
    let result;
    try {
      for (;;) {
        polling.throwIfAborted();
        result = await this.remote("opening-query", { requestKey }, polling);
        if (result.status === "succeeded") break;
        domain.ensure(
          result.status === "queued" || result.status === "running",
          result.message || "MiniMax 开场未完成",
        );
        await delay(5000, undefined, { signal: polling });
      }
    } catch (error) {
      if (!signal.aborted && polling.aborted)
        throw new Error("MiniMax 尚未返回结果，重试会继续查询原任务");
      throw error;
    }
    const temp = target + ".part.mp4";
    try {
      await providers.downloadMiniMaxVideo(result.videoUrl, temp, signal);
      const info = await media.probe(temp, cache, signal, "mov");
      domain.ensure(
        info.streams.some(
          (s) => s.codec_type === "video" && !s.disposition?.attached_pic,
        ) && Number(info.format.duration) >= opening.duration - 0.12,
        "MiniMax 开场视频无法读取或短于解说音频",
      );
      signal.throwIfAborted();
      await fsp.rename(temp, target);
      return target;
    } finally {
      await fsp.rm(temp, { force: true });
    }
  }
  execute(owner, job) {
    const controller = new AbortController();
    const signal = controller.signal;
    this.active.set(job.id, { owner, controller });
    const dir = this.directory(owner);
    const cache = path.join(dir, "cache");
    const jobDir = path.join(dir, "jobs", job.id);
    const update = (stage, progress) => {
      signal.throwIfAborted();
      job.stage = stage;
      job.progress = Math.round(progress);
      this.persist(owner);
    };
    const promise = (async () => {
      await fsp.mkdir(cache, { recursive: true });
      await fsp.mkdir(jobDir, { recursive: true });
      const automaticImages =
        job.confirmation === "whole" && job.config.materialMode === "expand";
      if (automaticImages) {
        update("images", 0);
        await factory.expand(this, owner, job, signal, (progress) =>
          update("images", progress * 25),
        );
        this.scenes(owner, job.scenes);
      }
      const audio = [];
      for (const [index, segment] of job.segments.entries()) {
        update(
          "tts",
          automaticImages
            ? 25 + (index / job.segments.length) * 15
            : (index / job.segments.length) * 30,
        );
        const narration = await media.synthesize(
          segment,
          job.config,
          cache,
          signal,
          this.remote,
        );
        if (
          index === 0 &&
          job.config.openingPhoto &&
          !(narration.duration >= 2 && narration.duration <= 6)
        ) {
          job.reviewOpening = !!job.config.openingLocation;
          throw new Error(
            `MiniMax 开场解说须为 2–6 秒，当前约 ${narration.duration.toFixed(1)} 秒，请调整开场文案后重新审核`,
          );
        }
        audio.push(narration);
      }
      let openingFile;
      if (job.config.openingPhoto) {
        update("opening", 32);
        openingFile = await this.miniMaxOpening(
          dir,
          job.config,
          audio[0],
          signal,
          job.templateSnapshot,
        );
      }
      update("render", 40);
      let last = 0;
      const result = await media.render(
        job,
        audio,
        dir,
        jobDir,
        signal,
        (index, fraction) => {
          if (Date.now() - last > 1000) {
            last = Date.now();
            update("render", 40 + ((index + fraction) / audio.length) * 58);
          }
        },
        openingFile,
      );
      signal.throwIfAborted();
      Object.assign(job, result, {
        status: "succeeded",
        stage: "cover",
        progress: 100,
        completedAt: new Date().toISOString(),
      });
      this.persist(owner);
    })()
      .catch((error) => {
        if (job.status !== "canceled") {
          job.status = "failed";
          job.error = signal.aborted
            ? "任务已中断；可重试并复用已完成素材"
            : error.message;
        }
        this.persist(owner);
      })
      .finally(() => {
        this.active.delete(job.id);
        this.queue.pump();
      });
    this.active.get(job.id).promise = promise;
    return promise;
  }
  stop() {
    this.queue.stop();
    for (const { controller } of this.active.values()) controller.abort();
    for (const controller of this.previews) controller.abort();
  }
  completedArtifactOutput(userId, jobId) {
    const owner = this.owner(userId);
    domain.ensure(
      typeof jobId === "string" && uuid.test(jobId),
      "制作结果引用无效",
    );
    const job = this.store(owner).jobs.find((item) => item.id === jobId);
    domain.ensure(job && job.status === "succeeded", "本机制作任务尚未完成");
    domain.ensure(
      !job.sample &&
        !job.property?.sample &&
        job.property?.id !== "panorama-cc0-sample",
      "示例成片不能登记为正式成果",
    );
    // This producer-owned port exports completed files only. Consumers never read checkpoints.
    return {
      source: {
        producer: "panorama",
        taskId: job.id,
        revision: job.draftRevision,
      },
      content: {
        title: job.property.title,
        script: job.segments.map((segment) => segment.text).join("\n\n"),
        property: { id: job.property.id, title: job.property.title },
      },
      files: {
        video: path.join(this.directory(owner), "jobs", job.id, "final.mp4"),
        cover: path.join(this.directory(owner), "jobs", job.id, "cover.jpg"),
      },
      sample: false,
    };
  }
  mediaFile(userId, url) {
    const owner = this.owner(userId);
    const prefix = `/${owner}/`;
    domain.ensure(url.pathname.startsWith(prefix), "无权访问此素材");
    const relative = url.pathname.slice(prefix.length);
    domain.ensure(
      /^assets\/[a-f0-9]{64}\.(jpg|png)$/.test(relative) ||
        /^preview\/segment-[a-f0-9]{64}\.wav$/.test(relative) ||
        /^jobs\/[a-f0-9-]{36}\/(final\.mp4|cover\.jpg|narration\.wav)$/.test(
          relative,
        ),
      "素材地址无效",
    );
    return path.join(this.directory(owner), relative);
  }
}
module.exports = { PanoramaWorkflow };
