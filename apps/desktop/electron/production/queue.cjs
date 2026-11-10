const { randomUUID } = require("node:crypto");
const {
  ensure,
  hash,
  validateSegments,
  config,
} = require("../panorama/domain.cjs");

const MAX_BATCH = 200;
const unfinished = new Set([
  "pending",
  "preparing",
  "queued",
  "running",
  "archiving",
]);
const statusOf = {
  running: "running",
  failed: "failed",
  canceled: "canceled",
  succeeded: "done",
};
const filters = {
  preparing: ["pending", "preparing"],
  review: ["review"],
  queued: ["queued"],
  running: ["running"],
  done: ["done", "archiving", "archived"],
  failed: ["failed", "archiveFailed"],
  canceled: ["canceled"],
};
const groupOf = Object.fromEntries(
  Object.entries(filters).flatMap(([key, phases]) =>
    phases.map((phase) => [phase, key]),
  ),
);
const now = () => new Date().toISOString();
const reason = (error) => (error instanceof Error ? error.message : "操作失败");
const validID = (id) =>
  typeof id === "string" && id.length > 0 && id.length <= 160;

class ProductionQueue {
  constructor(workflow) {
    this.workflow = workflow;
    this.preparing = new Map();
    this.rendering = false;
    this.archiving = false;
    this.generation = 0;
  }

  data(owner) {
    const state = this.workflow.store(owner);
    if (!state.production) {
      const used = new Set(state.jobs.map((job) => job.draftId));
      const legacy = (value, phase, job) => ({
        id: value.id,
        property: value.property,
        config: value.config,
        templateName: value.templateSnapshot?.name || value.config.templateId,
        templateVersion: value.templateVersion,
        templateSnapshot: value.templateSnapshot,
        createdAt: value.createdAt,
        draftId: job?.draftId || value.id,
        jobId: job?.id,
        approvedRevision: job?.draftRevision,
        phase,
        error: job?.error,
        legacy: true,
      });
      state.production = {
        paused: false,
        interrupted: 0,
        sequence: 0,
        batches: [],
        items: [
          ...state.jobs.map((job) => legacy(job, statusOf[job.status], job)),
          ...state.drafts
            .filter(
              (draft) => draft.confirmation === "whole" && !used.has(draft.id),
            )
            .map((draft) => legacy(draft, "review")),
        ].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      };
      this.workflow.persist(owner);
    }
    const data = state.production;
    if (!this.loaded?.has(owner)) {
      this.loaded ??= new Set();
      this.loaded.add(owner);
      const jobs = new Map(state.jobs.map((job) => [job.id, job]));
      let interrupted = 0;
      for (const item of data.items) {
        if (item.phase === "preparing") item.phase = "pending";
        else if (item.phase === "running") {
          const job = jobs.get(item.jobId);
          item.phase =
            job?.status === "succeeded"
              ? job.sample
                ? "done"
                : "archiving"
              : "queued";
        } else if (!unfinished.has(item.phase)) continue;
        interrupted++;
      }
      if (interrupted) {
        data.interrupted = interrupted;
        data.paused = true;
        this.workflow.persist(owner);
      }
    }
    return data;
  }

  update(owner, target, patch) {
    const previous = Object.fromEntries(
      Object.keys(patch).map((key) => [key, target[key]]),
    );
    Object.assign(target, patch);
    try {
      this.workflow.persist(owner);
    } catch (error) {
      Object.assign(target, previous);
      throw error;
    }
  }

  assertEditable(owner, draftId) {
    const item = this.workflow
      .store(owner)
      .production?.items.find((row) => row.draftId === draftId);
    ensure(!item || item.phase === "review", "请先撤回排队任务，再修改文案");
  }

  assertExecution(owner, draftId, item) {
    const linked = this.workflow
      .store(owner)
      .production?.items.some((row) => row.draftId === draftId);
    ensure(
      !linked || (item?.draftId === draftId && item.phase === "running"),
      "请在工厂任务队列中开始或重试制作",
    );
  }

  summary(item, job, draft) {
    return {
      id: item.id,
      batchId: item.batchId,
      propertyId: item.property.id,
      propertyTitle: item.property.title,
      propertyNumber: item.property.propertyNumber,
      templateName: item.templateName,
      templateVersion: item.templateVersion,
      createdAt: item.createdAt,
      phase: item.phase,
      progress: job?.progress || 0,
      stage: job?.stage,
      error: item.error || (item.phase === "failed" ? job?.error : undefined),
      revision: draft?.revision,
      artifactId: item.artifactId,
      started: !!item.jobId,
    };
  }

  async handle(userId, owner, method, input, assertCurrent) {
    ensure(
      input && typeof input === "object" && !Array.isArray(input),
      "请求参数无效",
    );
    const data = this.data(owner);
    const state = this.workflow.store(owner);
    const scope = { userId, owner, assertCurrent };
    if (method === "catalog")
      return {
        ...(await this.workflow.capabilities(true)),
        openingClip: state.openingClip,
        openingPhoto: state.openingPhoto,
      };
    if (method === "properties") {
      const readyIds = Object.entries(state.imports)
        .filter(([, value]) => value.scenes?.length)
        .map(([id]) => id);
      const result = await this.workflow.factoryProperties({
        search: input.search,
        district: input.district,
        material: input.material,
        page: input.page,
        all: input.all === true,
        readyIds,
        selectedIds: input.selectedIds,
      });
      if (input.all !== true) {
        for (const row of result.rows) {
          const scene = state.imports[row.id]?.scenes?.[0];
          if (scene?.asset)
            row.image = this.workflow.url(owner, "assets/" + scene.asset);
        }
      }
      return result;
    }
    if (method === "list") {
      const search = String(input.search || "")
        .trim()
        .toLowerCase();
      const jobs = new Map(state.jobs.map((job) => [job.id, job]));
      const drafts = new Map(state.drafts.map((draft) => [draft.id, draft]));
      const counts = { all: 0 };
      const matched = [];
      let after = false;
      let firstReview;
      let nextReview;
      let focused;
      for (const item of data.items) {
        if (item.id === input.afterId) after = true;
        if (item.id === input.focusId) focused = item;
        if (input.batchId && input.batchId !== item.batchId) continue;
        if (
          search &&
          !`${item.property.title} ${item.property.propertyNumber || ""} ${item.templateName}`
            .toLowerCase()
            .includes(search)
        )
          continue;
        const group = groupOf[item.phase];
        counts.all++;
        counts[group] = (counts[group] || 0) + 1;
        if (!input.status || input.status === group) {
          matched.push(item);
          if (item.phase === "review" && item.id !== input.afterId) {
            firstReview ??= item.id;
            if (after) nextReview ??= item.id;
          }
        }
      }
      const page = Math.max(
        1,
        Math.min(
          Math.ceil(matched.length / 50),
          Number.isSafeInteger(input.page) ? input.page : 1,
        ),
      );
      const summarize = (item) =>
        this.summary(item, jobs.get(item.jobId), drafts.get(item.draftId));
      return {
        rows: matched.slice((page - 1) * 50, page * 50).map(summarize),
        total: matched.length,
        page,
        counts,
        batches: data.batches.map(({ id, createdAt, count }) => ({
          id,
          createdAt,
          count,
        })),
        paused: data.paused,
        interrupted: data.interrupted,
        storageError: data.storageError,
        nextReviewId: nextReview || firstReview,
        focused: focused && summarize(focused),
      };
    }
    if (method === "detail") {
      const item = data.items.find((row) => row.id === input.id);
      ensure(item, "视频任务不存在");
      const draft = state.drafts.find((value) => value.id === item.draftId);
      const job = state.jobs.find((value) => value.id === item.jobId);
      const location = draft?.config.openingLocation;
      return {
        ...this.summary(item, job, draft),
        config: item.config,
        legacy: item.legacy,
        draft: draft && this.workflow.draftView(owner, draft),
        job: job && this.workflow.jobView(owner, job),
        openingLocationUrl:
          location?.asset &&
          this.workflow.url(owner, `assets/${location.asset}`),
        openingLocations:
          location?.source === "property"
            ? this.workflow.openingLocations(owner, draft.scenes)
            : undefined,
      };
    }
    if (method === "opening-location") {
      const item = data.items.find((row) => row.id === input.id);
      ensure(item?.phase === "review", "请先返回待审核，再更换地点图");
      const draft = this.workflow.draft(owner, item.draftId, input.revision);
      const location = draft.config.openingLocation;
      ensure(
        location?.source === "property" &&
          this.workflow
            .openingLocations(owner, draft.scenes)
            .some(({ asset }) => asset === input.asset),
        "请选择当前房源的原始实拍图",
      );
      if (location.asset === input.asset) return;
      const previous = draft.config;
      draft.config = {
        ...previous,
        openingLocation: { ...location, asset: input.asset },
      };
      draft.revision++;
      try {
        this.update(owner, item, {
          config: draft.config,
          approvedRevision: undefined,
        });
      } catch (error) {
        draft.config = previous;
        draft.revision--;
        throw error;
      }
      return null;
    }
    if (method === "pause" || method === "resume") {
      this.update(owner, data, {
        paused: method === "pause",
        ...(method === "resume"
          ? { interrupted: 0, storageError: undefined }
          : {}),
      });
      if (method === "resume") this.kick(scope);
      return null;
    }
    if (method === "create") {
      const result = await this.create(scope, input);
      if (!result.issues.length) this.kick(scope);
      return result;
    }
    if (method === "act") {
      ensure(
        Array.isArray(input.rows) &&
          input.rows.length > 0 &&
          input.rows.length <= MAX_BATCH,
        "请选择 1 至 200 条任务",
      );
      const items = new Map(data.items.map((item) => [item.id, item]));
      const results = [];
      const checks = {};
      // Persist approvals in selection order so confirmation and execution use the same FIFO.
      for (const ref of input.rows) {
        const id = ref?.id;
        try {
          assertCurrent();
          const item = items.get(id);
          ensure(item, "视频任务不存在");
          const createdId = await this.act(
            scope,
            item,
            input.action,
            ref.revision,
            checks,
          );
          this.kick(scope);
          results.push({ id, ok: true, createdId });
        } catch (error) {
          results.push({ id, ok: false, error: reason(error) });
        }
      }
      return results;
    }
    throw new Error("未知的工厂操作");
  }

  async create({ owner, assertCurrent }, input) {
    const data = this.data(owner);
    ensure(
      validID(input.requestId) &&
        Array.isArray(input.pairs) &&
        input.pairs.length > 0 &&
        input.pairs.length <= MAX_BATCH,
      "每批可提交 1 至 200 条视频",
    );
    ensure(
      (input.voiceId === undefined ||
        input.voiceId === "" ||
        validID(input.voiceId)) &&
        (input.openingClip === undefined ||
          (typeof input.openingClip === "string" &&
            /^[a-f0-9]{64}$/.test(input.openingClip))) &&
        (input.openingPhoto === undefined ||
          (typeof input.openingPhoto === "string" &&
            /^[a-f0-9]{64}$/.test(input.openingPhoto))),
      "音色或开场视频引用无效",
    );
    ensure(
      !input.openingPhoto || input.openingAuthorized === true,
      "请确认经纪人照片和开场素材的使用授权",
    );
    for (const pair of input.pairs)
      ensure(
        pair &&
          validID(pair.propertyId) &&
          validID(pair.templateId) &&
          validID(pair.version),
        "房源或模板引用无效",
      );
    const fingerprint = hash([
      input.pairs,
      input.voiceId,
      input.openingClip ?? input.avatarId,
      ...(input.openingPhoto ? [input.openingPhoto] : []),
      ...(input.openingRecipe === true ? ["opening-recipe"] : []),
    ]);
    const existing = () => {
      const previous = data.batches.find(
        (batch) => batch.id === input.requestId,
      );
      if (!previous) return;
      ensure(
        previous.fingerprint === fingerprint,
        "提交标识已用于另一批任务，请重新创建",
      );
      return { batchId: previous.id, issues: [] };
    };
    const previous = existing();
    if (previous) return previous;
    ensure(this.workflow.factoryProperties, "房源服务未连接");
    const [propertyData, caps, voices] = await Promise.all([
      this.workflow.factoryProperties({
        ids: [...new Set(input.pairs.map((pair) => pair.propertyId))],
      }),
      this.workflow.capabilities({
        templateIds: [...new Set(input.pairs.map((pair) => pair.templateId))],
      }),
      this.workflow.remote("voice-list", {}),
    ]);
    assertCurrent();
    const raced = existing();
    if (raced) return raced;
    const properties = new Map(propertyData.rows.map((p) => [p.id, p]));
    const templates = new Map(
      caps.templates.map((t) => [JSON.stringify([t.id, t.version]), t]),
    );
    const defaults = propertyData.defaults || {};
    const state = this.workflow.store(owner);
    const openingClip = state.openingClip?.id;
    const fixedOpenings = new Map();
    const items = [];
    const issues = [];
    const seen = new Set();
    const createdAt = now();
    for (const pair of input.pairs) {
      const key = JSON.stringify([
        pair.propertyId,
        pair.templateId,
        pair.version,
      ]);
      if (seen.has(key)) continue;
      seen.add(key);
      const property = properties.get(pair.propertyId);
      const template = templates.get(
        JSON.stringify([pair.templateId, pair.version]),
      );
      const issue = (error) =>
        issues.push({
          propertyId: pair.propertyId,
          templateId: pair.templateId,
          version: pair.version,
          propertyTitle: property?.title,
          templateName: template?.name,
          error,
        });
      if (!property) {
        issue("房源已移除，请重新选择");
        continue;
      }
      const sample = property.id === "panorama-cc0-sample";
      const remoteMedia = [property.images, property.panoramas].some(
        (assets) => Array.isArray(assets) && assets.length > 0,
      );
      if (
        !sample &&
        !state.imports[property.id]?.scenes?.length &&
        (property.importStatus !== "ready" || !remoteMedia)
      ) {
        issue("缺少制作图片，请补充房源素材");
        continue;
      }
      if (!template) {
        issue("模板已更新或下架，请重新选择");
        continue;
      }
      const recipe = template.production.config;
      const templateOpening = template.production.opening;
      const openingPhoto =
        templateOpening || input.openingRecipe !== true
          ? input.openingPhoto
          : undefined;
      const voiceId = input.voiceId || defaults.voiceId;
      const own = (voices.voices || []).filter(
        (v) =>
          v.status === "ready" &&
          voices.cloneEnabled &&
          v.language === recipe.language,
      );
      const pub = (voices.publicVoices || []).filter(
        (v) => v.language === recipe.language,
      );
      const personal =
        own.find((v) => v.id === voiceId) ||
        (!input.voiceId && recipe.ttsProvider === "personal"
          ? own[0]
          : undefined);
      const publicVoice =
        pub.find((v) => v.id === voiceId) ||
        (!input.voiceId ? pub[0] : undefined);
      const system = caps.voices.find(
        (v) =>
          v.language === recipe.language &&
          (!input.voiceId || sample || v.name === input.voiceId),
      );
      if (sample && (templateOpening || openingPhoto)) {
        issue("MiniMax 开场请选择真实房源");
        continue;
      }
      if (sample && recipe.videoMode === "avatar") {
        issue("测试房源仅支持配音模板");
        continue;
      }
      if (sample || !caps.managedVoices) {
        if (!system) {
          issue("没有与模板语言匹配的本机音色");
          continue;
        }
      } else if (!personal && !publicVoice) {
        issue("所选音色不可用或与模板语言不匹配");
        continue;
      }
      if (!sample && caps.managedVoices && !personal && !caps.volcTts) {
        issue("公共配音服务未配置");
        continue;
      }
      if (
        (templateOpening || openingPhoto) &&
        (!caps.minimaxOpening || !caps.managedVoices)
      ) {
        issue("请在管理后台启用 MiniMax 开场和豆包语音");
        continue;
      }
      if (
        templateOpening &&
        (!openingPhoto || openingPhoto !== state.openingPhoto?.id)
      ) {
        issue("请选择经纪人照片并确认素材使用授权");
        continue;
      }
      if (
        !templateOpening &&
        openingPhoto &&
        (openingPhoto !== state.openingPhoto?.id ||
          input.openingClip !== openingClip ||
          !openingClip ||
          state.openingClip.duration > 5 ||
          state.openingClip.bytes > 8 * 1024 * 1024)
      ) {
        issue("请选择 2–5 秒的参考视频和经纪人照片，素材更新后请刷新");
        continue;
      }
      if (
        !sample &&
        recipe.videoMode === "avatar" &&
        !templateOpening &&
        (!openingClip || input.openingClip !== openingClip)
      ) {
        issue(
          openingClip
            ? "真人开场视频已更新，请刷新后重新创建"
            : "请先导入真人开场视频",
        );
        continue;
      }
      if (!sample && !caps.ai) {
        issue("AI 文案服务未配置");
        continue;
      }
      let openingLocation;
      let templateSnapshot = template;
      if (templateOpening) {
        const { location } = templateOpening;
        openingLocation = { source: location.source };
        if (location.source === "fixed") {
          if (!fixedOpenings.has(template.id)) {
            ensure(
              typeof location.image === "string",
              "模板固定地点图缺失，请联系管理员",
            );
            const image = await this.workflow.importBytes(
              owner,
              Buffer.from(location.image, "base64"),
              "模板固定地点图",
              "reference",
            );
            fixedOpenings.set(template.id, image.asset);
          }
          openingLocation.asset = fixedOpenings.get(template.id);
          templateSnapshot = {
            ...template,
            production: {
              ...template.production,
              opening: { ...templateOpening, location: { source: "fixed" } },
            },
          };
        }
      }
      const resolved = config(
        {
          ...caps.defaultConfig,
          ...recipe,
          templateId: template.id,
          scriptProvider: sample ? "template" : "ai",
          ttsProvider:
            sample || !caps.managedVoices
              ? "system"
              : personal
                ? "personal"
                : "volcengine",
          voice:
            sample || !caps.managedVoices
              ? system.name
              : (personal || publicVoice).id,
          openingClip:
            !templateOpening && (recipe.videoMode === "avatar" || openingPhoto)
              ? openingClip
              : undefined,
          openingPhoto,
          openingLocation,
        },
        [template],
      );
      items.push({
        id: randomUUID(),
        batchId: input.requestId,
        property,
        config: resolved,
        templateVersion: template.version,
        templateName: template.name,
        templateSnapshot,
        phase: "pending",
        createdAt,
      });
    }
    if (issues.length) return { issues };
    assertCurrent();
    const completed = existing();
    if (completed) return completed;
    data.batches.unshift({
      id: input.requestId,
      createdAt,
      count: items.length,
      fingerprint,
    });
    data.items.unshift(...items);
    try {
      this.workflow.persist(owner);
    } catch (error) {
      data.batches.shift();
      data.items.splice(0, items.length);
      throw error;
    }
    return { batchId: input.requestId, issues: [] };
  }

  async act({ userId, owner, assertCurrent }, item, action, revision, checks) {
    const state = this.workflow.store(owner);
    const data = state.production;
    const patch = (values) => this.update(owner, item, values);
    const enqueue = (values) =>
      patch({
        ...values,
        phase: "queued",
        order: ++data.sequence,
        error: undefined,
      });
    if (action === "confirm") {
      ensure(
        Number.isSafeInteger(revision) && revision > 0,
        "文案版本无效，请刷新后重试",
      );
      if (item.approvedRevision === revision && item.phase !== "review") return;
      ensure(item.phase === "review", "任务已离开待审核状态");
      const draft = this.workflow.draft(owner, item.draftId, revision);
      validateSegments(draft.segments, draft.segments);
      await this.workflow.preflight(draft, owner, true, true, checks);
      assertCurrent();
      if (item.approvedRevision === revision && item.phase !== "review") return;
      ensure(item.phase === "review", "任务已离开待审核状态");
      this.workflow.draft(owner, item.draftId, revision);
      enqueue({ approvedRevision: revision });
    } else if (action === "withdraw") {
      ensure(
        item.phase === "queued" && !item.jobId,
        "只有尚未开始的任务可以撤回",
      );
      const draft = this.workflow.draft(
        owner,
        item.draftId,
        item.approvedRevision,
      );
      draft.revision++;
      try {
        patch({ phase: "review", approvedRevision: undefined });
      } catch (error) {
        draft.revision--;
        throw error;
      }
    } else if (action === "cancel") {
      ensure(
        ["pending", "preparing", "review", "queued", "running"].includes(
          item.phase,
        ),
        "当前任务不可取消",
      );
      const job = state.jobs.find((value) => value.id === item.jobId);
      if (job?.status === "running")
        await this.workflow.handle(
          userId,
          "cancel",
          { id: job.id },
          undefined,
          assertCurrent,
          item,
        );
      else {
        patch({ phase: "canceled", error: undefined });
        this.preparing.get(item.id)?.controller.abort();
      }
    } else if (action === "retry") {
      ensure(
        ["failed", "canceled", "archiveFailed"].includes(item.phase),
        "当前任务不可重试",
      );
      if (item.phase === "archiveFailed")
        patch({ phase: "archiving", error: undefined });
      else if (item.approvedRevision) {
        enqueue({});
      } else
        patch({ phase: item.draftId ? "review" : "pending", error: undefined });
    } else if (action === "room-opening" || action === "edit-opening") {
      ensure(
        (item.phase === "failed" ||
          (action === "room-opening" && item.phase === "review")) &&
          !this.workflow.active.has(item.jobId),
        "请等待任务停止后再调整开场",
      );
      ensure(
        Number.isSafeInteger(revision) && revision > 0,
        "文案版本无效，请刷新后重试",
      );
      const draft = this.workflow.draft(owner, item.draftId, revision);
      ensure(
        draft.config.openingPhoto ||
          (action === "room-opening" &&
            draft.config.videoMode === "avatar" &&
            !draft.config.roomOpening),
        "当前任务无法调整开场",
      );
      const previousConfig = draft.config;
      if (action === "room-opening") {
        draft.config = { ...draft.config, roomOpening: true };
        delete draft.config.openingClip;
        delete draft.config.openingPhoto;
        delete draft.config.openingLocation;
      }
      draft.revision++;
      try {
        patch({
          config: draft.config,
          phase: "review",
          approvedRevision: undefined,
          jobId: undefined,
          error: undefined,
        });
      } catch (error) {
        draft.config = previousConfig;
        draft.revision--;
        throw error;
      }
    } else if (action === "copy") {
      ensure(item.templateSnapshot, "原模板快照不可用，请重新选择模板");
      const original = state.drafts.find((value) => value.id === item.draftId);
      const copy = {
        ...item,
        id: randomUUID(),
        batchId: undefined,
        createdAt: now(),
        jobId: undefined,
        draftId: undefined,
        approvedRevision: undefined,
        artifactId: undefined,
        phase: original ? "review" : "pending",
        error: undefined,
        legacy: false,
      };
      const draft = original && {
        ...structuredClone(original),
        id: randomUUID(),
        revision: 1,
        createdAt: copy.createdAt,
      };
      if (draft) {
        copy.draftId = draft.id;
        state.drafts.unshift(draft);
      }
      data.items.unshift(copy);
      try {
        this.workflow.persist(owner);
      } catch (error) {
        data.items.shift();
        if (draft) state.drafts.shift();
        throw error;
      }
      return copy.id;
    } else if (action === "archive") {
      ensure(
        item.legacy && item.phase === "done" && !item.property.sample,
        "当前成片不能登记",
      );
      patch({ phase: "archiving" });
    } else throw new Error("未知的任务操作");
  }

  kick(scope) {
    this.scope = scope;
    this.pump();
  }

  pump() {
    const scope = this.scope;
    if (!scope) return;
    const { owner } = scope;
    const data = this.data(owner);
    try {
      scope.assertCurrent();
    } catch {
      return;
    }
    if (!data.paused) {
      while (this.preparing.size < 2 && !data.storageError) {
        const activeProperties = new Set(
          [...this.preparing.values()].map((value) => value.propertyId),
        );
        const next = data.items.reduce(
          (first, item) =>
            item.phase === "pending" &&
            !this.preparing.has(item.id) &&
            !activeProperties.has(item.property.id) &&
            (!first || item.createdAt < first.createdAt)
              ? item
              : first,
          undefined,
        );
        if (!next) break;
        this.run(scope, next, "prepare");
      }
      if (!this.rendering && !this.workflow.active.size) {
        const next = data.items.reduce(
          (first, item) =>
            item.phase === "queued" && (!first || item.order < first.order)
              ? item
              : first,
          undefined,
        );
        if (next) this.run(scope, next, "render");
      }
    }
    if (
      !data.interrupted &&
      !data.storageError &&
      !this.archiving &&
      this.workflow.archiveOutput
    ) {
      const next = data.items.find((item) => item.phase === "archiving");
      if (next) this.run(scope, next, "archive");
    }
  }

  run(scope, item, step) {
    const controller = step === "prepare" ? new AbortController() : undefined;
    if (controller)
      this.preparing.set(item.id, { propertyId: item.property.id, controller });
    else if (step === "render") this.rendering = true;
    else this.archiving = true;
    const { owner, userId } = scope;
    const generation = this.generation;
    const state = this.workflow.store(owner);
    const patch = (values) => this.update(owner, item, values);
    let claimedPhase = step === "archive" ? "archiving" : undefined;
    const assertCurrent = () => {
      scope.assertCurrent();
      controller?.signal.throwIfAborted();
      ensure(
        this.scope?.owner === owner &&
          generation === this.generation &&
          item.phase !== "canceled" &&
          (!claimedPhase || item.phase === claimedPhase),
        "任务已取消或账号已切换",
      );
    };
    const execute = async () => {
      assertCurrent();
      if (step === "prepare") {
        patch({ phase: "preparing" });
        claimedPhase = "preparing";
        await this.workflow.createDraft(
          owner,
          {
            propertyId: item.property.id,
            config: item.config,
            templateVersion: item.templateVersion,
          },
          item.property,
          true,
          assertCurrent,
          item,
          controller.signal,
        );
      } else if (step === "render") {
        patch({ phase: "running" });
        claimedPhase = "running";
        const job = item.jobId
          ? await this.workflow.handle(
              userId,
              "retry",
              { id: item.jobId },
              undefined,
              assertCurrent,
              item,
            )
          : await this.workflow.handle(
              userId,
              "start",
              {
                id: item.draftId,
                revision: item.approvedRevision,
                confirmed: true,
              },
              undefined,
              assertCurrent,
              item,
            );
        await this.workflow.active.get(job.id)?.promise;
        assertCurrent();
        if (job.status === "failed" && job.reviewOpening) {
          const draft = this.workflow.draft(
            owner,
            item.draftId,
            item.approvedRevision,
          );
          draft.revision++;
          try {
            patch({
              phase: "review",
              jobId: undefined,
              approvedRevision: undefined,
              error: job.error,
            });
          } catch (error) {
            draft.revision--;
            throw error;
          }
          return;
        }
        if (job.status !== "succeeded")
          throw new Error(job.error || "视频制作未完成");
        patch({ phase: job.sample ? "done" : "archiving" });
      } else {
        const artifact = await this.workflow.archiveOutput(
          userId,
          item.jobId,
          assertCurrent,
        );
        assertCurrent();
        patch({ phase: "archived", artifactId: artifact.id });
      }
    };
    void execute()
      .catch((error) => {
        if (
          generation !== this.generation ||
          controller?.signal.aborted ||
          item.phase === "canceled" ||
          (claimedPhase && item.phase !== claimedPhase)
        )
          return;
        const job = state.jobs.find((value) => value.id === item.jobId);
        const phase =
          step === "archive" || job?.status === "succeeded"
            ? job?.sample
              ? "done"
              : "archiveFailed"
            : "failed";
        try {
          assertCurrent();
          patch({
            phase,
            error: reason(error),
          });
        } catch (checkpointError) {
          if (generation !== this.generation) return;
          item.phase = phase;
          item.error = reason(error);
          state.production.paused = true;
          state.production.storageError =
            "无法保存生产记录：" + reason(checkpointError);
        }
      })
      .finally(() => {
        if (step === "prepare") this.preparing.delete(item.id);
        else if (step === "render") this.rendering = false;
        else this.archiving = false;
        this.pump();
      });
  }

  stop() {
    if (!this.scope) return;
    this.generation++;
    const { owner } = this.scope;
    this.scope = undefined;
    const data = this.data(owner);
    const jobs = new Map(
      this.workflow.store(owner).jobs.map((job) => [job.id, job]),
    );
    const interrupted = data.items.filter((item) => unfinished.has(item.phase));
    for (const item of interrupted) {
      if (item.phase === "preparing") item.phase = "pending";
      if (item.phase === "running") {
        const job = jobs.get(item.jobId);
        item.phase =
          job?.status === "succeeded"
            ? job.sample
              ? "done"
              : "archiving"
            : "queued";
      }
    }
    if (interrupted.length) {
      data.paused = true;
      data.interrupted = interrupted.length;
      try {
        this.workflow.persist(owner);
      } catch (error) {
        console.error(error);
      }
    }
  }
}

module.exports = { ProductionQueue };
