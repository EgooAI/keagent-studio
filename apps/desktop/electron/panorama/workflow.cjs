const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const domain = require("./domain.cjs");
const media = require("./media.cjs");
const providers = require("./providers.cjs");
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
    this.capabilityPromise = null;
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
    for (const job of state.jobs)
      if (job.status === "running") {
        job.status = "failed";
        job.error = "客户端退出导致中断，可重试并复用已完成素材";
      }
    this.stores.set(owner, state);
    this.persist(owner);
    return state;
  }
  persist(owner) {
    const file = path.join(this.directory(owner), "workspace.json");
    fs.writeFileSync(file + ".tmp", JSON.stringify(this.stores.get(owner)), {
      mode: 0o600,
    });
    fs.renameSync(file + ".tmp", file);
  }
  url(owner, relative) {
    return `keagent://media/${owner}/${relative}`;
  }
  view(owner, state) {
    return {
      ...state,
      drafts: state.drafts.map((d) => ({
        ...d,
        scenes: d.scenes.map((s) => ({
          ...s,
          url: this.url(owner, `assets/${s.asset}`),
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
  async capabilities() {
    this.capabilityPromise ??= media
      .capabilities(path.join(this.root, "runtime"))
      .catch((error) => {
        this.capabilityPromise = null;
        throw error;
      });
    const local = await this.capabilityPromise;
    const cloud = this.remote ? await this.remote("capabilities", {}) : {};
    return {
      ...local,
      templates: domain.templates,
      defaultConfig: domain.defaultConfig,
      ai: !!cloud.ai,
      volcTts: !!cloud.volcTts,
      volcSpeaker: cloud.volcSpeaker || "",
      volcAvatar: !!cloud.volcAvatar,
      avatarId: cloud.avatarId || "",
    };
  }
  async importFile(owner, file, room) {
    const stat = await fsp.stat(file);
    domain.ensure(
      stat.isFile() && stat.size <= 50 * 1024 * 1024 && stat.size > 32,
      "图片需小于 50 MB",
    );
    const data = await fsp.readFile(file);
    const jpeg = data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    const png = data
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    domain.ensure(jpeg || png, "仅支持 JPEG / PNG 全景图");
    const asset = `${domain.hash(data)}.${jpeg ? "jpg" : "png"}`;
    const target = path.join(this.directory(owner), "assets");
    await fsp.mkdir(target, { recursive: true });
    await fsp.writeFile(path.join(target, asset), data, { mode: 0o600 });
    const info = await media.probe(
      path.join(target, asset),
      this.directory(owner),
    );
    const stream = info.streams[0];
    domain.ensure(
      ["mjpeg", "png"].includes(stream.codec_name) &&
        stream.width === stream.height * 2 &&
        stream.width >= 2048 &&
        stream.width <= 16384,
      "需要宽高比 2:1、宽度 2048–16384 的等距柱状全景图；普通照片不能作为全景旋转",
    );
    return {
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
      Array.isArray(input) && input.length >= 1 && input.length <= 20,
      "请添加 1–20 个空间",
    );
    const seen = new Set();
    return input.map((s) => {
      domain.ensure(uuid.test(s.id) && !seen.has(s.id), "空间 ID 无效或重复");
      seen.add(s.id);
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
        id: s.id,
        asset: s.asset,
        room: domain.text(s.room, "空间名称", 80),
        description: domain.text(s.description, "空间说明", 1500),
        yaw: s.yaw,
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
  draft(owner, id, revision) {
    const draft = this.store(owner).drafts.find((d) => d.id === id);
    domain.ensure(
      draft && draft.revision === revision,
      "草稿已更新，请刷新后重试",
    );
    return draft;
  }
  async handle(userId, method, input = {}, property, assertCurrent = () => {}) {
    assertCurrent();
    const owner = this.owner(userId);
    const state = this.store(owner);
    if (method === "state") return this.view(owner, state);
    if (method === "capabilities") return this.capabilities();
    if (method === "sample") return this.sample(owner);
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
          ),
        );
      return results;
    }
    if (method === "generate") {
      domain.ensure(
        property && typeof property.title === "string",
        "房源不存在，请重新选择",
      );
      const c = domain.config(input.config);
      domain.ensure(
        c.scriptProvider !== "ai" || this.remote,
        "未连接云端 AI 服务",
      );
      const scenes = this.scenes(owner, input.scenes);
      const expected = domain.segments(property, scenes, c);
      const segments =
        c.scriptProvider === "ai"
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
                AbortSignal.timeout(65000),
              ),
              expected,
            )
          : expected;
      assertCurrent();
      const draft = {
        id: crypto.randomUUID(),
        revision: 1,
        property: structuredClone(property),
        sample: property.sample === true,
        scenes,
        config: c,
        templateVersion: "1",
        segments,
        createdAt: new Date().toISOString(),
      };
      state.drafts.unshift(draft);
      this.persist(owner);
      return this.view(owner, { ...state, drafts: [draft] }).drafts[0];
    }
    if (method === "save") {
      const draft = this.draft(owner, input.id, input.revision);
      const c = domain.config(input.config);
      domain.ensure(
        c.language === draft.config.language &&
          c.templateId === draft.config.templateId &&
          c.scriptProvider === draft.config.scriptProvider &&
          ["openingTemplate", "sceneTemplate", "closingTemplate"].every(
            (k) => c[k] === draft.config[k],
          ),
        "语言或文案模板改变后，请重新生成分段文案",
      );
      draft.segments = domain.validateSegments(input.segments, draft.segments);
      draft.config = c;
      draft.revision++;
      this.persist(owner);
      return this.view(owner, { ...state, drafts: [draft] }).drafts[0];
    }
    if (method === "start") {
      const draft = this.draft(owner, input.id, input.revision);
      const existing = state.jobs.find(
        (job) =>
          job.draftId === draft.id &&
          job.draftRevision === draft.revision &&
          job.status !== "canceled",
      );
      if (existing) return existing;
      await this.preflight(draft);
      this.draft(owner, input.id, input.revision);
      assertCurrent();
      const avatarKey = domain.hash([
        "clone-v1",
        domain.audioKey(draft.segments[0], draft.config),
        draft.config.avatarId,
      ]);
      const previousAvatar = state.jobs.find(
        (j) => j.avatar?.key === avatarKey,
      )?.avatar;
      if (draft.config.videoMode === "avatar")
        domain.ensure(
          !previousAvatar?.submitting || previousAvatar.taskId,
          "相同开场的数字人提交结果未知，请先核对火山控制台，避免重复扣费",
        );
      const job = {
        id: crypto.randomUUID(),
        draftId: draft.id,
        draftRevision: draft.revision,
        property: structuredClone(draft.property),
        sample: draft.sample,
        config: structuredClone(draft.config),
        scenes: structuredClone(draft.scenes),
        segments: structuredClone(draft.segments),
        templateVersion: draft.templateVersion,
        status: "running",
        stage: "tts",
        progress: 0,
        createdAt: new Date().toISOString(),
        avatar:
          draft.config.videoMode === "avatar"
            ? { ...structuredClone(previousAvatar), key: avatarKey }
            : undefined,
      };
      state.jobs.unshift(job);
      this.persist(owner);
      this.execute(owner, job);
      return job;
    }
    const job = state.jobs.find((j) => j.id === input.id);
    domain.ensure(job, "本机任务不存在");
    if (method === "cancel") {
      domain.ensure(job.status === "running", "只有执行中的任务可以取消");
      job.status = "canceled";
      this.active.get(job.id)?.controller.abort();
      this.persist(owner);
      return null;
    }
    if (method === "retry") {
      domain.ensure(
        job.status === "failed" || job.status === "canceled",
        "只有失败或已取消任务可以重试",
      );
      domain.ensure(!this.active.has(job.id), "正在停止上一次执行，请稍后重试");
      domain.ensure(
        !job.avatar?.submitting || job.avatar.taskId,
        "数字人提交结果未知，已停止自动重提；请先在火山控制台核对，避免重复扣费",
      );
      await this.preflight(job);
      assertCurrent();
      job.status = "running";
      job.error = undefined;
      this.persist(owner);
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
  async preflight(draft) {
    domain.ensure(
      this.active.size === 0,
      "本机正在生成视频，请等待完成后再提交",
    );
    const caps = await this.capabilities();
    domain.ensure(
      this.active.size === 0,
      "本机正在生成视频，请等待完成后再提交",
    );
    domain.ensure(
      caps.ffmpeg && caps.ffprobe,
      "未找到 FFmpeg / FFprobe，请配置运行时路径后重启客户端",
    );
    if (draft.config.ttsProvider === "system")
      domain.ensure(
        caps.voices.some(
          (v) =>
            v.name === draft.config.voice &&
            v.language === draft.config.language,
        ),
        "所选语言没有可用的本机声音，请更换音色或配音服务",
      );
    else
      domain.ensure(caps.volcTts && draft.config.voice, "火山 TTS 未配置完整");
    if (draft.config.videoMode === "avatar")
      domain.ensure(
        caps.volcAvatar && draft.config.avatarId,
        "请配置火山数字人 AK、SK、TOS 私有桶以及形象 ID",
      );
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
      const audio = [];
      for (const [index, segment] of job.segments.entries()) {
        update("tts", (index / job.segments.length) * 30);
        audio.push(
          await media.synthesize(
            segment,
            job.config,
            cache,
            signal,
            this.remote,
          ),
        );
      }
      let avatarFile;
      if (job.config.videoMode === "avatar") {
        update("avatar", 32);
        avatarFile = path.join(cache, `avatar-${job.avatar.key}.mp4`);
        if (!(await media.exists(avatarFile))) {
          const opening = audio[0];
          domain.ensure(
            opening.duration <= 30,
            "数字人开场配音超过30秒，请缩短开场文案后重新提交",
          );
          if (!job.avatar?.taskId) {
            domain.ensure(
              !job.avatar?.submitting,
              "数字人提交结果未知，请先核对火山控制台",
            );
            const uploaded = await this.remote(
              "audio",
              {
                audio: (
                  await fsp.readFile(path.join(cache, opening.audio))
                ).toString("base64"),
              },
              signal,
            );
            job.avatar = { ...job.avatar, submitting: true };
            this.persist(owner);
            const data = await this.remote(
              "avatar-submit",
              { resourceId: job.config.avatarId, audioUrl: uploaded.url },
              signal,
            );
            domain.ensure(
              data?.task_id,
              "数字人未返回任务 ID，请核对火山控制台",
            );
            job.avatar = {
              ...job.avatar,
              taskId: data.task_id,
              submitting: false,
            };
            this.persist(owner);
          }
          let result;
          for (let attempt = 0; attempt < 360; attempt++) {
            signal.throwIfAborted();
            result = providers.avatarResult(
              await this.remote(
                "avatar-query",
                { taskId: job.avatar.taskId },
                signal,
              ),
            );
            if (result?.status === "done") break;
            domain.ensure(
              !["not_found", "expired"].includes(result?.status),
              "数字人任务已过期或不存在，请在火山控制台核对",
            );
            await delay(5000, undefined, { signal });
          }
          domain.ensure(
            result?.status === "done" && result.url,
            "数字人任务尚未完成，重试会继续查询原任务",
          );
          await providers.downloadVideo(
            result.url,
            avatarFile + ".part.mp4",
            signal,
          );
          const info = await media.probe(
            avatarFile + ".part.mp4",
            jobDir,
            signal,
          );
          domain.ensure(
            info.streams.some((s) => s.codec_type === "video") &&
              Math.abs(Number(info.format.duration) - opening.duration) <= 1,
            "数字人视频时长与开场音频不符",
          );
          await fsp.rename(avatarFile + ".part.mp4", avatarFile);
        }
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
        avatarFile,
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
      .finally(() => this.active.delete(job.id));
    this.active.get(job.id).promise = promise;
    return promise;
  }
  stop() {
    for (const { controller } of this.active.values()) controller.abort();
  }
  mediaFile(userId, url) {
    const owner = this.owner(userId);
    const prefix = `/${owner}/`;
    domain.ensure(url.pathname.startsWith(prefix), "无权访问此素材");
    const relative = url.pathname.slice(prefix.length);
    domain.ensure(
      /^assets\/[a-f0-9]{64}\.(jpg|png)$/.test(relative) ||
        /^jobs\/[a-f0-9-]{36}\/(final\.mp4|cover\.jpg|narration\.wav)$/.test(
          relative,
        ),
      "素材地址无效",
    );
    return path.join(this.directory(owner), relative);
  }
}
module.exports = { PanoramaWorkflow };
