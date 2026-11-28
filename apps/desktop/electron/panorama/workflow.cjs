const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const domain = require("./domain.cjs");
const media = require("./media.cjs");
const {
  openingCaptionText,
  openingCaptionPages,
} = require("../production/opening-caption-lines.mjs");
const music = require("./music.cjs");
const sources = require("../production/sources.cjs");
const coverReasons = require("../production/cover-reasons.json");
const templateLibrary = require("../production/templates.cjs");
const factory = require("../production/factory.cjs");
const spatialSource = require("../production/spatial-source.cjs");
const spatialRender = require("../production/spatial-render.cjs");
const { ProductionQueue } = require("../production/queue.cjs");
const uuid = /^[a-f0-9-]{36}$/;
const assetName = /^[a-f0-9]{64}\.(jpg|png)$/;

// Earlier ASR versions cut at 12 characters, even in the middle of a word.
function joinOpeningTails(cues) {
  if (!cues) return cues;
  const joined = [];
  for (const cue of cues) {
    const previous = joined.at(-1);
    if (
      previous &&
      /^[\p{Script=Han}]{9,12}$/u.test(previous.text) &&
      /^[\p{Script=Han}]{1,5}[，。？！、；]?$/u.test(cue.text) &&
      previous.text.length + cue.text.length > 12 &&
      cue.start >= previous.end &&
      cue.start - previous.end < 0.35
    ) {
      previous.text += cue.text;
      previous.end = cue.end;
    } else joined.push({ ...cue });
  }
  return joined;
}
function cleanOpeningCaptions(cues) {
  return cues
    ?.map((cue) => ({ ...cue, text: openingCaptionText(cue.text) }))
    .filter((cue) => cue.text);
}
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
    this.openingFlights = new Map();
    this.vrImports = new Map();
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
    for (const clip of Object.values(state.openingAssets ?? {})) {
      if (clip.captionLayout === 3) continue;
      for (const key of ["captions", "restoreCaptions"]) {
        const cues =
          clip.captionLayout === 2 ? clip[key] : joinOpeningTails(clip[key]);
        clip[key] = cleanOpeningCaptions(cues);
      }
      clip.captionLayout = 3;
    }
    // Older listing covers stored the reviewed reason in the property snapshot.
    for (const record of [...state.drafts, ...state.jobs]) {
      if (record.templateSnapshot?.cover?.imageSource === "listing-frame")
        record.coverReason ??= record.property.details?.saleReason;
    }
    for (const job of state.jobs) {
      if (job.status === "running") {
        job.status = "failed";
        job.error = "客户端退出导致中断，可重试并复用已完成素材";
      }
      if (job.status !== "succeeded")
        job.config = domain.currentSpeechConfig(job.config);
    }
    for (const record of [
      ...state.drafts,
      ...(state.templates || []),
      ...(state.production?.items || []).filter(
        (item) =>
          !["done", "archiving", "archived", "archiveFailed"].includes(
            item.phase,
          ),
      ),
    ])
      record.config = domain.currentSpeechConfig(record.config);
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
  withPropertyCovers(userId, properties) {
    const owner = this.owner(userId);
    let imports;
    try {
      imports = this.store(owner).imports;
    } catch {
      // The cloud property list remains usable if the local store can't be read.
    }
    return properties.map((property) => {
      const scenes = imports?.[property.id]?.scenes || [];
      const photo =
        scenes.find((scene) => scene.kind === "photo") ||
        scenes.find((scene) => !scene.kind || scene.kind === "panorama");
      const image =
        photo && assetName.test(photo.asset)
          ? this.url(owner, `assets/${photo.asset}`)
          : property.images?.[0] || property.image;
      const hasPanorama =
        scenes.some((scene) => !scene.kind || scene.kind === "panorama") ||
        !!property.panoramas?.length;
      return {
        ...property,
        image,
        importStatus: property.sample || hasPanorama ? "ready" : "incomplete",
      };
    });
  }
  view(owner, state) {
    return {
      ...state,
      assetMetadata: undefined,
      imports: undefined,
      production: undefined,
      factoryCatalog: undefined,
      mixMusic: undefined,
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
  async capabilities(mode, catalogVersion, signal) {
    this.capabilityPromise ??= media
      .capabilities(path.join(this.root, "runtime"))
      .catch((error) => {
        this.capabilityPromise = null;
        throw error;
      });
    const [local, desktopConfig] = await Promise.all([
      this.capabilityPromise,
      this.desktopConfig?.(),
    ]);
    const cloud = this.remote
      ? await this.remote(
          "capabilities",
          mode === "runtime"
            ? { runtimeOnly: true }
            : mode === true
              ? {
                  summary: true,
                  openingRecipe: true,
                  bundleCatalog: true,
                  catalogVersion,
                }
              : mode
                ? { ...mode, openingRecipe: true }
                : {},
          signal,
        )
      : {};
    return {
      ...local,
      ...(cloud.library ? { library: cloud.library } : {}),
      ...(cloud.catalogVersion ? { catalogVersion: cloud.catalogVersion } : {}),
      templates:
        mode === true || mode === "runtime"
          ? cloud.templates || []
          : (cloud.templates || []).map((template) => ({
              ...template,
              opening: template.production.config.openingTemplate,
              scene: template.production.config.sceneTemplate,
              closing: template.production.config.closingTemplate,
            })),
      catalogRefreshSeconds: desktopConfig?.catalogRefreshSeconds ?? 60,
      defaultConfig: {
        ...domain.defaultConfig,
        ...desktopConfig?.renderDefaults,
      },
      ai: !!cloud.ai,
      bailianTts: !!cloud.bailianTts,
      minimaxOpening: !!cloud.minimaxOpening,
      managedVoices: !!cloud.managedVoices,
      beike: !!cloud.beike,
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
  async importOpeningClip(owner, state, assertCurrent, saveToLibrary) {
    const file = await this.dialogs.openIntro();
    assertCurrent();
    if (!file) return null;
    const maxMB = 50;
    const maxSeconds = 30;
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
      const duration = media.openingDuration(info);
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
      const clip = { id, name: path.basename(file).slice(-120), duration };
      const known = state.openingAssets?.[id];
      this.saveOpeningAsset(owner, state, { ...known, ...clip });
      if (saveToLibrary) {
        const previous = state.openingVideos ?? [];
        this.saveOpeningVideos(owner, state, [
          ...previous.filter((video) => video.id !== id),
          clip,
        ]);
      }
      return this.openingView(owner, state, clip);
    } finally {
      await fsp.rm(temp, { force: true });
    }
  }
  openingView(owner, state, clip) {
    return {
      ...clip,
      ...(state.openingAssets?.[clip.id]?.captions && {
        captions: state.openingAssets[clip.id].captions,
        ...(!state.openingAssets[clip.id].timedPhrases && {
          needsWordTiming: true,
        }),
      }),
      url: this.openingVideoURL(owner, clip.id),
    };
  }
  saveOpeningAsset(owner, state, clip) {
    const assets = (state.openingAssets ??= {});
    const previous = assets[clip.id];
    assets[clip.id] = { ...clip, captionLayout: 3 };
    try {
      this.persist(owner);
    } catch (error) {
      if (previous) assets[clip.id] = previous;
      else delete assets[clip.id];
      throw error;
    }
  }
  async openingCaptionAction(owner, state, method, input, assertCurrent) {
    const file = this.openingVideoFile(owner, input.id);
    const clip =
      state.openingAssets?.[input.id] ??
      state.openingVideos?.find((v) => v.id === input.id);
    domain.ensure(clip, "开场视频不存在，请重新导入");
    if (method === "opening-video-save") {
      this.saveOpeningVideos(owner, state, [
        ...(state.openingVideos || []).filter((v) => v.id !== clip.id),
        { id: clip.id, name: clip.name, duration: clip.duration },
      ]);
      return null;
    }
    if (method === "opening-captions-save") {
      domain.ensure(
        domain.hash(clip.captions ?? null) ===
          domain.hash(input.previous ?? null),
        "字幕已更新，请重新打开核对",
      );
      const texts = input.texts;
      domain.ensure(
        Array.isArray(texts) &&
          (!texts.length || texts.length === clip.captions?.length),
        "字幕条数已变化，请重新打开核对",
      );
      const captions = texts.map((value, index) => ({
        ...clip.captions[index],
        text: domain.text(
          typeof value === "string" ? openingCaptionText(value) : value,
          "开场字幕",
          100,
        ),
      }));
      const restoreCaptions = clip.captions?.length
        ? clip.captions
        : clip.restoreCaptions;
      this.saveOpeningAsset(owner, state, {
        ...clip,
        captions,
        restoreCaptions: captions.length ? undefined : restoreCaptions,
      });
      return captions;
    }
    const regroup = input.regroup === true;
    if (regroup) {
      domain.ensure(
        domain.hash(clip.captions ?? null) ===
          domain.hash(input.previous ?? null),
        "字幕已更新，请重新打开核对",
      );
      if (clip.timedPhrases) return clip.captions;
    }
    if (!regroup && clip.captions && !(input.retry && !clip.captions.length))
      return clip.captions;
    if (input.retry && clip.restoreCaptions?.length) {
      const captions = clip.restoreCaptions;
      this.saveOpeningAsset(owner, state, {
        ...clip,
        captions,
        restoreCaptions: undefined,
      });
      return captions;
    }
    const pending = this.openingFlights.get(file);
    if (pending) return pending;
    const run = (async () => {
      const signal = AbortSignal.timeout(65000);
      const cache = path.join(this.directory(owner), "cache");
      await fsp.mkdir(cache, { recursive: true });
      const info = await media.probe(file, cache, signal, "mov");
      let captions = [];
      let timedPhrases;
      if (info.streams.some((s) => s.codec_type === "audio")) {
        const { audio } = await media.openingAudio(
          file,
          clip.id,
          cache,
          signal,
        );
        const wav = await fsp.readFile(path.join(cache, audio));
        assertCurrent();
        const response = await this.remote(
          "opening-asr",
          { audio: wav.toString("base64"), wordTiming: true },
          signal,
        );
        if (Array.isArray(response)) {
          domain.ensure(!regroup, "本地服务尚未支持逐词识别，请更新服务后重试");
          captions = cleanOpeningCaptions(
            domain.openingCaptions(response, clip.duration),
          );
        } else {
          timedPhrases = response?.phrases;
          captions = domain.openingCaptions(
            openingCaptionPages(timedPhrases, clip.duration),
            clip.duration,
          );
        }
      }
      assertCurrent();
      const current = state.openingAssets?.[clip.id] ?? clip;
      if (current.captions !== clip.captions) {
        domain.ensure(!regroup, "字幕已更新，请重新打开核对");
        return current.captions;
      }
      domain.ensure(
        !regroup || captions.length,
        "未识别到原声，已保留现有字幕",
      );
      this.saveOpeningAsset(owner, state, {
        ...current,
        captions,
        timedPhrases,
      });
      return captions;
    })();
    this.openingFlights.set(file, run);
    try {
      return await run;
    } finally {
      this.openingFlights.delete(file);
    }
  }
  saveOpeningVideos(owner, state, videos) {
    const previous = state.openingVideos;
    state.openingVideos = videos;
    try {
      this.persist(owner);
    } catch (error) {
      state.openingVideos = previous;
      throw error;
    }
  }
  async musicTracks(owner, state) {
    await Promise.all(
      music.builtIns.map((track) => this.resolveMusic(owner, track.id)),
    );
    return [
      ...music.builtIns.map((track) => ({ ...track, builtin: true })),
      ...(state.musicTracks ?? []),
    ].map((track) => ({ ...track, url: this.url(owner, `music/${track.id}`) }));
  }
  resolveMusic(owner, id) {
    return music.resolve(this.root, this.directory(owner), id);
  }
  async batchMusic(owner, id) {
    domain.ensure(
      music.builtIns.some((track) => track.id === id) ||
        this.store(owner).musicTracks?.some((track) => track.id === id),
      "所选背景音乐已移除，请重新选择",
    );
    await this.resolveMusic(owner, id);
  }
  saveMusicTracks(owner, state, tracks) {
    const previous = state.musicTracks;
    state.musicTracks = tracks;
    try {
      this.persist(owner);
    } catch (error) {
      state.musicTracks = previous;
      throw error;
    }
  }
  openingVideoURL(owner, id) {
    return this.url(owner, `opening/${id}.mp4`);
  }
  openingVideoFile(owner, id) {
    domain.ensure(
      typeof id === "string" && /^[a-f0-9]{64}$/.test(id),
      "开场视频引用无效",
    );
    return path.join(this.directory(owner), "opening", `${id}.mp4`);
  }
  async importBytes(owner, data, room, kind = "panorama") {
    domain.ensure(
      ["panorama", "photo", "reference"].includes(kind),
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
  scenes(owner, input) {
    domain.ensure(
      Array.isArray(input) && input.length >= 2 && input.length <= 7,
      "每条视频请选择 2–7 张 VR 全景图",
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
        kind === "panorama" &&
          (!metadata || metadata.kinds.includes("panorama")),
        "视频制作仅支持原始 VR 全景图，请到房源详情补充素材后重新生成文案",
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
        ...(s.spatial
          ? {
              spatial: spatialSource.validateSpatialScene(
                this.directory(owner),
                s,
              ),
            }
          : {}),
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
    if (method === "property-vr-status")
      return this.vrImports.get(owner + ":" + input.propertyId)?.status ?? null;
    if (method === "property-vr-import")
      return this.importVr(owner, property, input, assertCurrent);
    if (sources.methods.has(method)) {
      const flightKey = `${owner}:${method}`;
      domain.ensure(
        !this.sourceFlight.has(flightKey),
        "素材操作处理中，请稍候",
      );
      const pending = sources.handle(
        this,
        owner,
        method,
        input,
        assertCurrent,
        undefined,
        property,
      );
      this.sourceFlight.set(flightKey, pending);
      try {
        return await pending;
      } finally {
        this.sourceFlight.delete(flightKey);
      }
    }
    if (method === "completed-outputs")
      return state.jobs
        .filter((job) => job.status === "succeeded")
        .map((job) => ({
          taskId: job.id,
          revision: job.draftRevision,
          propertyId: job.property.id,
        }));
    if (method === "state") return this.view(owner, state);
    if (method === "music-tracks") return this.musicTracks(owner, state);
    if (method === "music-import") {
      const source = await this.dialogs.openMusic();
      assertCurrent();
      if (!source) return null;
      const track = await music.importTrack(
        this.root,
        this.directory(owner),
        source,
        assertCurrent,
      );
      const tracks = state.musicTracks ?? [];
      const existing = tracks.find((item) => item.id === track.id);
      if (!existing) this.saveMusicTracks(owner, state, [...tracks, track]);
      return existing ?? track;
    }
    if (method === "music-rename" || method === "music-remove") {
      const tracks = state.musicTracks ?? [];
      domain.ensure(
        tracks.some((track) => track.id === input.id),
        "本机音乐不存在",
      );
      this.saveMusicTracks(
        owner,
        state,
        method === "music-remove"
          ? // shortcut: retain removed files for task retries until local media cleanup is available.
            tracks.filter((track) => track.id !== input.id)
          : tracks.map((track) =>
              track.id === input.id
                ? { ...track, name: domain.text(input.name, "曲目名称", 80) }
                : track,
            ),
      );
      return null;
    }
    if (method === "opening-clip-import")
      return this.importOpeningClip(
        owner,
        state,
        assertCurrent,
        input.saveToLibrary === true,
      );
    if (method === "opening-videos")
      return (state.openingVideos ?? []).map((clip) =>
        this.openingView(owner, state, clip),
      );
    if (
      [
        "opening-captions",
        "opening-captions-save",
        "opening-video-save",
      ].includes(method)
    )
      return this.openingCaptionAction(
        owner,
        state,
        method,
        input,
        assertCurrent,
      );
    if (method === "opening-video-remove") {
      this.saveOpeningVideos(
        owner,
        state,
        (state.openingVideos ?? []).filter((clip) => clip.id !== input.id),
      );
      return null;
    }
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
      domain.ensure(
        !input.kind || input.kind === "panorama",
        "制作素材仅支持 VR 全景图",
      );
      const files = await this.dialogs.open();
      assertCurrent();
      const results = [];
      for (const file of files.slice(0, 20))
        results.push(
          await this.importFile(
            owner,
            file,
            path.basename(file, path.extname(file)).slice(0, 80),
            "panorama",
          ),
        );
      return results;
    }
    if (method === "generate")
      return this.createDraft(owner, input, property, false, assertCurrent);
    if (method === "prepare") {
      const overrides = domain.renderOverrides(input.renderOverrides);
      const key =
        owner +
        ":prepare:" +
        domain.hash({
          propertyId: input.propertyId,
          config: input.config,
          templateVersion: input.templateVersion,
          sceneIds: input.sceneIds,
          ...(overrides ? { renderOverrides: overrides } : {}),
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
      if (draft.templateSnapshot) {
        const recipe = domain.currentSpeechConfig(
          draft.templateSnapshot.production.config,
        );
        domain.ensure(
          Object.entries(recipe).every(
            ([key, value]) =>
              domain.renderOverrideKeys.includes(key) || c[key] === value,
          ) &&
            (c.cameraMode ?? "panorama") === (recipe.cameraMode ?? "panorama"),
          "已确认模板的制作规则不可修改，请重新选择模板",
        );
        if (recipe.cameraMode === undefined) delete c.cameraMode;
      }
      domain.ensure(
        domain.hash(c.backgroundMusic ?? null) ===
          domain.hash(draft.config.backgroundMusic ?? null),
        "背景音乐已随任务保存，请创建新任务更换",
      );
      domain.ensure(
        c.leadSceneId === (draft.config.leadSceneId || ""),
        "开场镜头改变后，请重新生成文案",
      );
      domain.ensure(
        c.openingVideo === draft.config.openingVideo &&
          domain.hash(c.openingCaptions ?? null) ===
            domain.hash(draft.config.openingCaptions ?? null) &&
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
      let scenes = draft.scenes;
      if (input.scenes !== undefined) {
        domain.ensure(
          Array.isArray(input.scenes) &&
            input.scenes.length === draft.scenes.length &&
            input.scenes.every(
              (scene, index) =>
                scene?.id === draft.scenes[index].id &&
                ["asset", "kind", "room", "description"].every(
                  (key) =>
                    scene[key] === undefined ||
                    scene[key] === draft.scenes[index][key],
                ),
            ),
          "审核时只能调整镜头角度和方向，不能替换或重排房源素材",
        );
        for (const [index, scene] of input.scenes.entries()) {
          if (scene.spatial === undefined) continue;
          const original = draft.scenes[index].spatial;
          domain.ensure(
            original &&
              scene.spatial &&
              ["workId", "panoIndex", "targets"].every(
                (key) =>
                  domain.hash(scene.spatial[key] ?? null) ===
                  domain.hash(original[key] ?? null),
              ),
            "审核时不能替换 VR 空间或原始拍摄点",
          );
        }
        scenes = this.scenes(
          owner,
          draft.scenes.map((scene, index) => ({
            ...scene,
            yaw: input.scenes[index].yaw,
            direction:
              input.scenes[index].direction === undefined
                ? scene.direction
                : input.scenes[index].direction,
            ...(scene.spatial
              ? {
                  spatial: {
                    ...scene.spatial,
                    targetPanoIndex:
                      input.scenes[index].spatial?.targetPanoIndex ??
                      scene.spatial.targetPanoIndex,
                  },
                }
              : {}),
          })),
        );
      }
      let coverReason = draft.coverReason;
      if (input.coverReason !== undefined) {
        domain.ensure(
          draft.templateSnapshot?.cover?.imageSource === "listing-frame",
          "该封面没有售卖原因",
        );
        coverReason = domain.text(input.coverReason, "封面售卖原因", 24);
        domain.ensure(!/[\r\n\t]/.test(coverReason), "封面售卖原因请写在一行");
      }
      const previous = {
        coverReason: draft.coverReason,
        segments: draft.segments,
        scenes: draft.scenes,
        config: draft.config,
        revision: draft.revision,
      };
      draft.segments = domain.validateSegments(input.segments, draft.segments);
      draft.scenes = scenes;
      draft.coverReason = coverReason;
      draft.config = c;
      draft.revision++;
      try {
        const item = state.production?.items.find(
          (row) => row.draftId === draft.id,
        );
        if (item) this.queue.update(owner, item, { config: c });
        else this.persist(owner);
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
      await this.preflight(draft, owner);
      this.draft(owner, input.id, input.revision);
      assertCurrent();
      this.queue.assertExecution(owner, draft.id, productionItem);
      domain.ensure(!this.active.size, "本机正在生成视频，请稍后再试");
      const job = {
        id: crypto.randomUUID(),
        draftId: draft.id,
        draftRevision: draft.revision,
        coverReason: draft.coverReason,
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
        stage: "tts",
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
      this.execute(owner, job, productionItem);
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
      await this.preflight(job, owner);
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
      this.execute(owner, job, productionItem);
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
    const draftId = crypto.randomUUID();
    const billingContext = this.billingContext(draftId, item);
    const overrides = domain.renderOverrides(
      item
        ? Object.fromEntries(
            domain.renderOverrideKeys.map((key) => [key, item.config[key]]),
          )
        : input.renderOverrides,
    );
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
      const resolvedConfig = {
        ...input.config,
        ...(templateSnapshot?.production.config || {}),
        ...overrides,
      };
      // Omitted cameraMode in a published snapshot still means panorama.
      if (
        templateSnapshot &&
        templateSnapshot.production.config.cameraMode === undefined
      )
        delete resolvedConfig.cameraMode;
      const c = domain.config(
        resolvedConfig,
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
        !c.openingPhoto &&
          (c.videoMode !== "avatar" ||
            c.openingVideo ||
            (item && (c.openingClip || c.roomOpening))),
        "请选择开场视频后重新创建任务",
      );
      if (c.openingVideo)
        domain.ensure(
          await media.exists(this.openingVideoFile(owner, c.openingVideo)),
          "本机开场视频已丢失，请重新上传",
        );
      assertCurrent();
      domain.ensure(
        c.scriptProvider !== "ai" || this.remote,
        "未连接云端 AI 服务",
      );
      const scenes = this.scenes(
        owner,
        preparing
          ? item
            ? item.scenes
            : factory.selectScenes(
                await factory.load(
                  this,
                  owner,
                  property,
                  assertCurrent,
                  signal,
                ),
                input.sceneIds,
              )
          : input.scenes,
      );
      domain.ensure(
        c.cameraMode !== "spatial" || scenes.every((scene) => scene.spatial),
        "空间走动带看需要完整 VR 空间，请先在房源素材中导入 VR 链接",
      );
      if (preparing) {
        c.materialMode = "panorama";
        c.leadSceneId = "";
        c.coverSceneId = "";
        c.coverTitle = "";
        for (const scene of scenes) scene.direction = c.direction;
      }
      for (const key of ["leadSceneId", "coverSceneId"])
        domain.ensure(
          !c[key] || scenes.some((scene) => scene.id === c[key]),
          "开场或封面空间已移除，请重新选择",
        );
      const expected = domain.segments(property, scenes, c);
      const segments =
        preparing && !property.sample
          ? domain.validateSegments(
              await this.remote(
                "script-vision",
                {
                  billingContext,
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
                  openingRecipe:
                    !!c.openingVideo || !!templateSnapshot.production.opening,
                  ...(c.openingVideo ? { omitOpening: true } : {}),
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
                    billingContext,
                    property,
                    scenes: scenes.map(({ room, description }) => ({
                      room,
                      description,
                    })),
                    template: Object.fromEntries(
                      Object.entries(c).filter(
                        ([key]) =>
                          key !== "backgroundMusic" &&
                          (!c.openingVideo ||
                            (key !== "openingVideo" &&
                              key !== "openingCaptions" &&
                              key !== "openingTemplate")),
                      ),
                    ),
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
        id: draftId,
        revision: 1,
        ...(templateSnapshot?.cover?.imageSource === "listing-frame"
          ? {
              coverReason:
                item?.coverReason ??
                coverReasons[crypto.randomInt(coverReasons.length)],
            }
          : {}),
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
  async preflight(draft, owner, reviewOnly = false, checks = {}) {
    if (draft.templateSnapshot?.cover?.imageSource === "listing-frame")
      domain.text(draft.coverReason, "封面售卖原因", 24);
    domain.ensure(
      draft.config.cameraMode !== "spatial" ||
        draft.scenes.every((scene) => scene.spatial),
      "空间走动带看需要完整 VR 空间，请先导入 VR 链接",
    );
    if (owner) {
      this.scenes(owner, draft.scenes);
      for (const scene of draft.scenes) {
        const bytes = await fsp.readFile(
          path.join(this.directory(owner), "assets", scene.asset),
        );
        domain.ensure(
          domain.hash(bytes) === scene.asset.split(".")[0],
          "制作素材已改变，请重新导入并审核",
        );
      }
      if (draft.config.cameraMode === "spatial")
        await spatialRender.verifyWorks(
          draft.scenes.map((scene) => ({ scene })),
          this.directory(owner),
        );
    }
    domain.ensure(
      reviewOnly || this.active.size === 0,
      "本机正在生成视频，请等待完成后再提交",
    );
    const caps = await (checks.capabilities ??= this.capabilities("runtime"));
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
      const voice = (catalog.voices || []).find(
        (v) => v.id === draft.config.voice,
      );
      domain.ensure(
        catalog.cloneEnabled &&
          voice?.status === "ready" &&
          voice.language === draft.config.language,
        voice?.error || "本人音色不存在或尚未就绪，请在全景工厂选择可用音色",
      );
    } else {
      domain.ensure(
        caps.bailianTts && draft.config.voice,
        "请选择公共音色，并确认配音服务已配置",
      );
      const catalog = await (checks.voices ??= this.remote("voice-list", {}));
      domain.ensure(
        catalog.publicVoices.some(
          (voice) =>
            voice.id === draft.config.voice &&
            voice.language === draft.config.language,
        ),
        "公共音色已下架或不存在，请在全景工厂重新选择可用音色",
      );
    }
    domain.ensure(
      !draft.config.openingPhoto,
      "旧版生成开场已停用，请改用房源开场，或新建任务选择开场视频",
    );
    const clip = draft.config.openingVideo || draft.config.openingClip;
    if (draft.config.backgroundMusic)
      await this.resolveMusic(owner, draft.config.backgroundMusic.id);
    if (clip) {
      domain.ensure(
        await media.exists(this.openingVideoFile(owner, clip)),
        "本机开场视频已丢失，请重新导入原视频后重试",
      );
    } else {
      domain.ensure(
        draft.config.videoMode !== "avatar" || draft.config.roomOpening,
        "请选择开场视频，或改用房源画面开场",
      );
    }
  }
  billingContext(draftId, productionItem) {
    const safeId = (id) =>
      typeof id === "string" && /^[a-zA-Z0-9_.:-]{1,160}$/.test(id);
    return {
      taskId: safeId(productionItem?.id) ? productionItem.id : draftId,
      batchId: safeId(productionItem?.batchId)
        ? productionItem.batchId
        : undefined,
      ...productionItem?.billingEstimate,
    };
  }
  execute(owner, job, productionItem) {
    const billingContext = this.billingContext(job.draftId, productionItem);
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
      this.scenes(owner, job.scenes);
      domain.ensure(!job.config.openingPhoto, "旧版生成开场已停用");
      const musicFile = job.config.backgroundMusic
        ? await this.resolveMusic(owner, job.config.backgroundMusic.id)
        : undefined;
      const audio = [];
      if (job.config.openingVideo)
        audio.push({
          ...(await media.openingAudio(
            this.openingVideoFile(owner, job.config.openingVideo),
            job.config.openingVideo,
            cache,
            signal,
          )),
          id: "opening",
          kind: "opening",
          sceneId: job.scenes[0].id,
          captions: job.config.openingCaptions ?? [],
        });
      for (const [index, segment] of job.segments.entries()) {
        update("tts", (index / job.segments.length) * 30);
        const narration = await media.synthesize(
          segment,
          job.config,
          cache,
          signal,
          this.remote,
          billingContext,
        );
        audio.push(narration);
      }
      update("render", 40);
      let spatialClips;
      if (job.config.cameraMode === "spatial") {
        const runs = media.spatialRuns(
          job,
          audio,
          Boolean(job.config.openingVideo || job.config.openingClip),
        );
        const rendered = await spatialRender.renderRuns(
          runs,
          dir,
          job.config,
          signal,
          (fraction) => update("render", 40 + fraction * 40),
        );
        spatialClips = [];
        for (const [index, run] of runs.entries())
          for (const segment of run.segments)
            spatialClips[segment.index] = {
              ...rendered[index],
              offsetFrames: segment.offsetFrames,
              frames: segment.frames,
            };
      }
      const renderStart = spatialClips ? 80 : 40;
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
            update(
              "render",
              renderStart +
                ((index + fraction) / audio.length) * (98 - renderStart),
            );
          }
        },
        spatialClips,
        musicFile,
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
  importVr(owner, property, input, assertCurrent) {
    domain.ensure(
      property && property.id === input.propertyId && !property.sample,
      "请选择有效房源",
    );
    const key = owner + ":" + property.id;
    const source = spatialSource.sourceURL(property.details?.vrUrl).href;
    const current = this.vrImports.get(key);
    if (current?.pending) {
      domain.ensure(
        current.source === source,
        "该房源的其他 VR 链接正在导入，请稍后再试",
      );
      return input.background ? current.status : current.pending;
    }
    const saved = this.store(owner).imports[property.id];
    const imported =
      saved?.spatial?.source === source
        ? saved.scenes.filter(
            (scene) => scene.spatial?.workId === saved.spatial.workId,
          )
        : [];
    if (imported.length) {
      const count = imported.length;
      const status = { phase: "succeeded", completed: count, total: count };
      this.vrImports.set(key, { source, status });
      return input.background
        ? status
        : { count, scenes: imported, workId: saved.spatial.workId };
    }
    const job = {
      source,
      status: { phase: "downloading", completed: 0, total: 0 },
    };
    this.vrImports.set(key, job);
    job.pending = spatialSource
      .importProperty(
        this,
        owner,
        property,
        input,
        assertCurrent,
        (phase, completed, total) => {
          job.status = { phase, completed, total };
        },
      )
      .then((result) => {
        job.status = {
          phase: "succeeded",
          completed: result.count,
          total: result.count,
        };
        return result;
      })
      .catch((error) => {
        job.status = {
          ...job.status,
          phase: "failed",
          error: error.message || "导入失败",
        };
        throw error;
      })
      .finally(() => {
        delete job.pending;
      });
    if (!input.background) return job.pending;
    // The initiating window can close before a background import settles.
    job.pending.catch(() => {});
    return job.status;
  }
  stop() {
    this.queue.stop();
    this.vrImports.clear();
    for (const { controller } of this.active.values()) controller.abort();
    for (const controller of this.previews) controller.abort();
  }
  completedArtifactOutput(userId, jobId) {
    const owner = this.owner(userId);
    domain.ensure(
      typeof jobId === "string" && uuid.test(jobId),
      "制作结果引用无效",
    );
    const state = this.store(owner);
    const job = state.jobs.find((item) => item.id === jobId);
    domain.ensure(job && job.status === "succeeded", "本机制作任务尚未完成");
    domain.ensure(
      !job.sample &&
        !job.property?.sample &&
        job.property?.id !== "panorama-cc0-sample",
      "示例成片不能登记为正式成果",
    );
    // This producer-owned port exports completed files only. Consumers never read checkpoints.
    const productionItem = state.production?.items?.find(
      (item) => item.jobId === job.id,
    );
    return {
      source: {
        producer: "panorama",
        taskId: job.id,
        revision: job.draftRevision,
      },
      billingTaskId: this.billingContext(job.draftId, productionItem).taskId,
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
    if (relative.startsWith("music/"))
      return music.file(this.root, this.directory(owner), relative.slice(6));
    domain.ensure(
      /^assets\/[a-f0-9]{64}\.(jpg|png)$/.test(relative) ||
        /^opening\/[a-f0-9]{64}\.mp4$/.test(relative) ||
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
