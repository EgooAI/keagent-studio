export { douyinApi, douyinDesktop } from "./douyin";
import { serviceRequest } from "./transport";
export {
  artifactExchange,
  createArtifactExchange,
  type ArtifactTransport,
} from "./artifacts";
import type {
  AgentProfile,
  ImportResult,
  Lead,
  Platform,
  ProductionBatch,
  ProductionConfig,
  ProductionTask,
  Property,
  PublishInput,
  PublishTask,
  Resource,
  ResourceType,
  Stage,
  Voice,
  Workspace,
} from "@keagent/shared-types";
import { createInitialWorkspace } from "./fixtures";

export { createInitialWorkspace, defaultConfig } from "./fixtures";
export const DEMO_STORAGE_KEY = "keagent.demo.workspace.v1";
const listeners = new Set<() => void>();
let memory: Workspace | undefined;
const clone = <T>(value: T): T => structuredClone(value);
const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
const required = <T>(value: T | undefined, message: string): T => {
  if (value === undefined) throw new Error(message);
  return value;
};
const nonempty = (text: string, label: string) => {
  const value = text.trim();
  if (!value) throw new Error(`请填写${label}`);
  return value;
};

function readWorkspace(): Workspace {
  if (typeof window === "undefined")
    return (memory ??= createInitialWorkspace());
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(DEMO_STORAGE_KEY);
  } catch {
    throw new Error("无法读取本地演示数据，请检查浏览器的存储权限。");
  }
  if (raw === null) {
    const state = createInitialWorkspace();
    store(state);
    return state;
  }
  try {
    const state: unknown = JSON.parse(raw);
    if (!validWorkspace(state)) throw new Error();
    return state;
  } catch {
    throw new Error(
      "本地演示数据版本不兼容或已损坏。原数据未清除，请导出备份或确认后重置演示数据。",
    );
  }
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
const reference = (value: unknown) =>
  object(value) &&
  typeof value.id === "string" &&
  typeof value.version === "string";
function validConfig(value: unknown): value is ProductionConfig {
  return (
    object(value) &&
    strings(value.propertyIds) &&
    ["voiceover", "avatar"].includes(String(value.videoMode)) &&
    reference(value.promptTemplate) &&
    reference(value.videoTemplate) &&
    reference(value.styleTemplate) &&
    reference(value.coverTemplate) &&
    (value.subtitleTemplate === undefined ||
      reference(value.subtitleTemplate)) &&
    typeof value.voiceId === "string" &&
    (value.avatarId === undefined || typeof value.avatarId === "string") &&
    typeof value.requireScriptReview === "boolean" &&
    ["9:16", "16:9"].includes(String(value.aspectRatio)) &&
    ["720p", "1080p"].includes(String(value.outputResolution))
  );
}
function validWorkspace(value: unknown): value is Workspace {
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    !object(value.profile) ||
    !validConfig(value.draft) ||
    !validConfig(value.profile.defaults) ||
    !object(value.requests) ||
    typeof value.updatedAt !== "string"
  )
    return false;
  const fields = (row: Record<string, unknown>, names: string[]) =>
    names.every((key) => typeof row[key] === "string");
  const numbers = (row: Record<string, unknown>, names: string[]) =>
    names.every(
      (key) => typeof row[key] === "number" && Number.isFinite(row[key]),
    );
  const rows = (
    key: string,
    check: (row: Record<string, unknown>) => boolean,
  ) =>
    Array.isArray(value[key]) &&
    value[key].every(
      (row: unknown) => object(row) && typeof row.id === "string" && check(row),
    );
  const property = (row: unknown) =>
    object(row) &&
    fields(row, [
      "id",
      "propertyNumber",
      "title",
      "city",
      "district",
      "community",
      "layout",
      "description",
      "image",
      "lastVerifiedAt",
    ]) &&
    numbers(row, ["priceCents", "areaSqm", "videoCount"]) &&
    strings(row.images) &&
    strings(row.sellingPoints) &&
    ["ready", "incomplete"].includes(String(row.importStatus));
  if (
    !fields(value.profile, [
      "name",
      "brokerage",
      "city",
      "regions",
      "phone",
      "introduction",
    ]) ||
    !Object.values(value.requests).every((item) => typeof item === "string")
  )
    return false;
  return (
    rows("properties", property) &&
    rows(
      "resources",
      (row) =>
        fields(row, [
          "name",
          "description",
          "category",
          "version",
          "thumbnail",
        ]) &&
        ["video", "style", "cover", "subtitle", "prompt"].includes(
          String(row.type),
        ) &&
        strings(row.compatibleModes) &&
        numbers(row, ["downloadProgress", "sizeMb"]) &&
        typeof row.installed === "boolean" &&
        typeof row.published === "boolean" &&
        ["idle", "downloading", "installed", "failed"].includes(
          String(row.downloadStatus),
        ),
    ) &&
    rows(
      "tasks",
      (row) =>
        validConfig(row.configSnapshot) &&
        property(row.propertySnapshot) &&
        fields(row, ["batchId", "propertyId", "script", "createdAt"]) &&
        numbers(row, ["scriptRevision", "productionRevision", "progress"]) &&
        [
          "queued",
          "running",
          "awaiting_review",
          "succeeded",
          "failed",
          "canceled",
        ].includes(String(row.status)) &&
        ["prepare", "script", "tts", "avatar", "render", "cover"].includes(
          String(row.stage),
        ) &&
        (row.history === undefined ||
          (Array.isArray(row.history) &&
            row.history.every(
              (revision: unknown) =>
                object(revision) &&
                typeof revision.revision === "number" &&
                typeof revision.script === "string",
            ))),
    ) &&
    rows(
      "batches",
      (row) =>
        validConfig(row.configSnapshot) &&
        strings(row.taskIds) &&
        typeof row.createdAt === "string",
    ) &&
    rows(
      "publishTasks",
      (row) =>
        fields(row, [
          "productionTaskId",
          "accountId",
          "title",
          "description",
          "createdAt",
        ]) &&
        numbers(row, ["productionRevision", "progress"]) &&
        strings(row.hashtags) &&
        ["douyin", "xiaohongshu"].includes(String(row.platform)) &&
        [
          "queued",
          "running",
          "draft_saved",
          "published",
          "failed",
          "unknown",
          "canceled",
        ].includes(String(row.status)),
    ) &&
    rows(
      "voices",
      (row) =>
        fields(row, ["name", "description"]) &&
        ["ready", "processing"].includes(String(row.status)) &&
        typeof row.isDefault === "boolean",
    ) &&
    rows(
      "avatars",
      (row) =>
        fields(row, ["name", "image"]) &&
        ["ready", "processing"].includes(String(row.status)) &&
        typeof row.isDefault === "boolean",
    ) &&
    rows(
      "accounts",
      (row) =>
        fields(row, ["name", "lastCheckedAt"]) &&
        ["douyin", "xiaohongshu"].includes(String(row.platform)) &&
        typeof row.connected === "boolean",
    ) &&
    rows(
      "leads",
      (row) =>
        fields(row, [
          "name",
          "commentText",
          "sourceVideo",
          "budget",
          "region",
          "housingRequirements",
          "aiSummary",
          "contactPermission",
          "reply",
        ]) &&
        ["high", "medium", "low"].includes(String(row.intentLevel)) &&
        ["new", "contacted", "following", "closed"].includes(
          String(row.followupStatus),
        ) &&
        Array.isArray(row.followups) &&
        row.followups.every(
          (followup: unknown) =>
            object(followup) && fields(followup, ["id", "note", "createdAt"]),
        ),
    ) &&
    rows(
      "analysisJobs",
      (row) =>
        fields(row, ["name", "url", "createdAt"]) &&
        ["running", "succeeded"].includes(String(row.status)),
    )
  );
}

function store(state: Workspace) {
  state.updatedAt = now();
  if (typeof window === "undefined") memory = state;
  else {
    try {
      window.localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(state));
    } catch {
      throw new Error(
        "演示数据保存失败，可能是存储权限或空间不足。此次更改未保存，请重试。",
      );
    }
  }
  listeners.forEach((listener) => listener());
}
async function withWorkspaceLock<T>(operation: () => T): Promise<T> {
  if (typeof window === "undefined") return operation();
  if (!window.isSecureContext || !window.navigator?.locks?.request)
    throw new Error(
      "当前环境不支持安全的多窗口保存，请使用 localhost、HTTPS 或桌面客户端打开。演示数据未修改。",
    );
  return window.navigator.locks.request("keagent-demo-workspace", operation);
}
async function change<T>(mutation: (state: Workspace) => T): Promise<T> {
  return withWorkspaceLock(() => {
    const state = clone(readWorkspace());
    const result = mutation(state);
    store(state);
    return clone(result);
  });
}
function storageChanged(event: StorageEvent) {
  if (event.key === DEMO_STORAGE_KEY)
    listeners.forEach((listener) => listener());
}
function taskFor(state: Workspace, taskId: string) {
  return required(
    state.tasks.find((task) => task.id === taskId),
    "任务不存在，请刷新后重试。",
  );
}
function checkScriptRevision(
  task: ProductionTask,
  expectedScriptRevision: number,
) {
  if (task.scriptRevision !== expectedScriptRevision)
    throw Object.assign(
      new Error("文案已在其他窗口更新，请刷新并重新确认后再保存或审核。"),
      { status: 409, code: "VERSION_CONFLICT" },
    );
}
function propertyFor(state: Workspace, propertyId: string) {
  return required(
    state.properties.find((property) => property.id === propertyId),
    "房源不存在，请重新选择。",
  );
}
function validateProperty(property: Property, state: Workspace) {
  property.title = nonempty(property.title, "房源名称");
  property.community = nonempty(property.community, "小区名称");
  property.propertyNumber = nonempty(property.propertyNumber, "房源号");
  if (
    state.properties.some(
      (item) =>
        item.id !== property.id &&
        item.propertyNumber === property.propertyNumber,
    )
  )
    throw new Error("此房源号已存在。");
  if (!Number.isInteger(property.priceCents) || property.priceCents < 0)
    throw new Error("房源价格格式不正确。");
  if (!Number.isFinite(property.areaSqm) || property.areaSqm <= 0)
    throw new Error("房源面积必须大于 0。");
  if (!Number.isInteger(property.videoCount) || property.videoCount < 0)
    throw new Error("视频素材数量格式不正确。");
}

function validateConfig(state: Workspace, config: ProductionConfig) {
  if (!validConfig(config))
    throw new Error("视频配置格式无效，请重新选择配置。");
  if (!config.propertyIds.length || config.propertyIds.length > 50)
    throw new Error("请选择 1–50 套房源。");
  if (new Set(config.propertyIds).size !== config.propertyIds.length)
    throw new Error("房源选择存在重复，请重新选择。");
  config.propertyIds.forEach((propertyId) => {
    const property = propertyFor(state, propertyId);
    if (property.importStatus !== "ready" || property.videoCount < 1)
      throw new Error(`${property.community}缺少可用视频素材，请先补充素材。`);
  });
  const refs: [ProductionConfig["videoTemplate"] | undefined, ResourceType][] =
    [
      [config.videoTemplate, "video"],
      [config.styleTemplate, "style"],
      [config.coverTemplate, "cover"],
      [config.promptTemplate, "prompt"],
      [config.subtitleTemplate, "subtitle"],
    ];
  refs.forEach(([ref, type]) => {
    if (!ref) return;
    const resource = state.resources.find(
      (row) =>
        row.id === ref.id && row.version === ref.version && row.type === type,
    );
    if (!resource || !resource.published)
      throw new Error("所选模板版本已不可用，请重新选择。");
    if (
      type !== "prompt" &&
      (!resource.installed || resource.downloadStatus !== "installed")
    )
      throw new Error(`请先安装资源「${resource.name}」。`);
    if (!resource.compatibleModes.includes(config.videoMode))
      throw new Error(`「${resource.name}」不支持当前视频模式。`);
  });
  if (
    !state.voices.some(
      (voice) => voice.id === config.voiceId && voice.status === "ready",
    )
  )
    throw new Error("请选择可用音色。");
}

function fingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    object(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
}
function requestResult(
  state: Workspace,
  scope: string,
  key: string,
  input: unknown,
): string | undefined {
  nonempty(key, "请求标识");
  const existing = state.requests[`${scope}:${key}`];
  if (!existing) return undefined;
  const prior = JSON.parse(existing) as { fingerprint: string; id: string };
  if (prior.fingerprint !== fingerprint(input))
    throw new Error("同一请求标识不能用于不同内容，请重新提交。");
  return prior.id;
}
function rememberRequest(
  state: Workspace,
  scope: string,
  key: string,
  input: unknown,
  resultId: string,
) {
  state.requests[`${scope}:${key}`] = JSON.stringify({
    fingerprint: fingerprint(input),
    id: resultId,
  });
}
function scriptFor(property: Property) {
  return `今天带你了解${property.community}的这套${property.layout}。建筑面积约${property.areaSqm}平方米，${property.sellingPoints.join("，")}。这不仅是空间的选择，也关乎日常生活的舒适感。想了解更多房源信息，欢迎进一步沟通。\n\n【模拟生成文案，请核验房源事实后再使用】`;
}
function invalidateOutputs(task: ProductionTask) {
  if (
    task.script.trim() &&
    !task.history?.some(
      (item) =>
        item.revision === task.productionRevision &&
        (item.scriptRevision === undefined ||
          item.scriptRevision === task.scriptRevision),
    )
  )
    (task.history ??= []).push({
      revision: task.productionRevision,
      scriptRevision: task.scriptRevision,
      script: task.script,
      videoUrl: task.videoUrl,
      coverUrl: task.coverUrl,
    });
  task.productionRevision += 1;
  delete task.videoUrl;
  delete task.coverUrl;
  delete task.completedAt;
  delete task.error;
  delete task.approvedRevision;
  task.progress = 0;
}
function saveScriptInState(task: ProductionTask, script: string) {
  if (task.status === "canceled")
    throw new Error("已取消的任务不能修改或恢复，请新建任务。");
  const text = nonempty(script, "文案");
  if (task.script !== text) {
    invalidateOutputs(task);
    task.script = text;
    task.scriptRevision += 1;
    task.stage = "script";
    task.status = task.configSnapshot.requireScriptReview
      ? "awaiting_review"
      : "queued";
  }
}

export function isPropertyPublished(state: Workspace, propertyId: string) {
  const taskIds = new Set(
    state.tasks
      .filter((task) => task.propertyId === propertyId)
      .map((task) => task.id),
  );
  return state.publishTasks.some(
    (task) => taskIds.has(task.productionTaskId) && task.status === "published",
  );
}

/** Mock ticks show simulated stage progress; no external AI or platform calls occur. */
export function advanceWorkspace(source: Workspace): Workspace {
  const state = clone(source);
  let changed = false;
  state.tasks.forEach((task) => {
    if (task.status !== "queued" && task.status !== "running") return;
    changed = true;
    if (task.status === "queued") {
      task.status = "running";
      task.progress = 0;
      return;
    }
    task.progress = Math.min(100, task.progress + 40);
    if (task.progress < 100) return;
    const stages: Stage[] = ["prepare", "script", "tts", "render", "cover"];
    if (task.stage === "script") {
      if (!task.script) task.script = scriptFor(task.propertySnapshot);
      if (
        task.configSnapshot.requireScriptReview &&
        task.approvedRevision !== task.scriptRevision
      ) {
        task.status = "awaiting_review";
        return;
      }
    }
    const index = stages.indexOf(task.stage === "avatar" ? "tts" : task.stage);
    if (index === stages.length - 1) {
      task.status = "succeeded";
      task.completedAt = now();
      task.videoUrl = "/media/demo-property.mp4";
      task.coverUrl = task.propertySnapshot.image;
    } else {
      task.stage = stages[index + 1];
      task.progress = 0;
    }
  });
  state.resources.forEach((resource) => {
    if (resource.downloadStatus !== "downloading") return;
    changed = true;
    resource.downloadProgress = Math.min(100, resource.downloadProgress + 35);
    if (resource.downloadProgress === 100) {
      resource.installed = true;
      resource.downloadStatus = "installed";
    }
  });
  state.publishTasks.forEach((task) => {
    if (task.status !== "queued" && task.status !== "running") return;
    changed = true;
    if (task.status === "queued") {
      task.status = "running";
      return;
    }
    task.progress = Math.min(100, task.progress + 35);
    if (task.progress === 100) {
      task.status = task.simulateFailure ? "unknown" : "draft_saved";
      if (task.simulateFailure)
        task.error =
          "模拟平台回执超时，结果待确认。请先核对结果，不要重新提交。";
    }
  });
  state.voices.forEach((voice) => {
    if (voice.status === "processing") {
      voice.status = "ready";
      changed = true;
    }
  });
  state.analysisJobs.forEach((job) => {
    if (job.status !== "running") return;
    changed = true;
    job.status = "succeeded";
    const sample = clone(state.leads[0] ?? createInitialWorkspace().leads[0]);
    state.leads.unshift({
      ...sample,
      id: id("lead"),
      name: "新分析示例线索",
      platform: job.platform,
      sourceVideo: job.name,
      reply: "",
      followups: [],
      followupStatus: "new",
    });
  });
  return changed ? state : source;
}

const mockApi = {
  async getWorkspace() {
    return withWorkspaceLock(() => clone(readWorkspace()));
  },
  subscribe(listener: () => void) {
    if (!listeners.size && typeof window !== "undefined")
      window.addEventListener("storage", storageChanged);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size && typeof window !== "undefined")
        window.removeEventListener("storage", storageChanged);
    };
  },
  async tick() {
    return withWorkspaceLock(() => {
      const state = readWorkspace();
      const next = advanceWorkspace(state);
      if (next !== state) store(next);
    });
  },
  async resetDemo() {
    return withWorkspaceLock(() => {
      const state = createInitialWorkspace();
      store(state);
      return clone(state);
    });
  },
  async saveDraft(config: ProductionConfig) {
    if (!validConfig(config))
      throw new Error("配置草稿格式无效，未覆盖已保存的草稿。");
    return withWorkspaceLock(() => {
      const state = clone(readWorkspace());
      if (fingerprint(state.draft) === fingerprint(config))
        return clone(state.draft);
      state.draft = clone(config);
      store(state);
      return clone(state.draft);
    });
  },
  async importProperties(numbers: string[]): Promise<ImportResult> {
    if (numbers.length > 500)
      throw new Error("每次最多导入 500 条房源号，请拆分后导入。");
    return change((state) => {
      const result: ImportResult = {
        imported: 0,
        duplicates: 0,
        failed: [],
        propertyIds: [],
      };
      const samples = createInitialWorkspace().properties.slice(0, 4);
      for (const raw of numbers) {
        const number = raw.trim();
        if (!number) continue;
        if (!/^[a-zA-Z0-9-]{4,32}$/.test(number)) {
          result.failed.push(number);
          continue;
        }
        const duplicate = state.properties.find(
          (property) => property.propertyNumber === number,
        );
        if (duplicate) {
          result.duplicates += 1;
          result.propertyIds.push(duplicate.id);
          continue;
        }
        const sample = clone(samples[result.imported % samples.length]);
        const property = {
          ...sample,
          id: id("property"),
          propertyNumber: number,
          title: `${sample.community} · 新导入示例`,
          lastVerifiedAt: now(),
        };
        state.properties.unshift(property);
        result.imported += 1;
        result.propertyIds.push(property.id);
      }
      return result;
    });
  },
  async createProperty(
    input: Pick<Property, "title" | "community" | "propertyNumber"> &
      Partial<Property>,
  ) {
    return change((state) => {
      if (
        state.properties.some(
          (property) => property.propertyNumber === input.propertyNumber.trim(),
        )
      )
        throw new Error("此房源号已存在。");
      const property: Property = {
        ...clone(createInitialWorkspace().properties[0]),
        ...input,
        id: id("property"),
        title: nonempty(input.title, "房源名称"),
        community: nonempty(input.community, "小区名称"),
        propertyNumber: nonempty(input.propertyNumber, "房源号"),
        videoCount: input.videoCount ?? 0,
        importStatus: (input.videoCount ?? 0) > 0 ? "ready" : "incomplete",
        lastVerifiedAt: now(),
      };
      validateProperty(property, state);
      state.properties.unshift(property);
      return property;
    });
  },
  async updateProperty(propertyId: string, patch: Partial<Property>) {
    return change((state) => {
      const property = propertyFor(state, propertyId);
      Object.assign(property, patch, { id: propertyId, lastVerifiedAt: now() });
      validateProperty(property, state);
      property.importStatus = property.videoCount > 0 ? "ready" : "incomplete";
      return property;
    });
  },
  async createBatch(
    config: ProductionConfig,
    requestKey: string,
  ): Promise<ProductionBatch> {
    return change((state) => {
      const existing = requestResult(state, "batch", requestKey, config);
      if (existing)
        return required(
          state.batches.find((batch) => batch.id === existing),
          "原批次不存在。",
        );
      validateConfig(state, config);
      const snapshot = clone(config);
      delete snapshot.avatarId;
      const batch: ProductionBatch = {
        id: id("batch"),
        configSnapshot: snapshot,
        taskIds: [],
        createdAt: now(),
      };
      for (const propertyId of snapshot.propertyIds) {
        const task: ProductionTask = {
          id: id("task"),
          batchId: batch.id,
          propertyId,
          propertySnapshot: clone(propertyFor(state, propertyId)),
          configSnapshot: clone(snapshot),
          status: "queued",
          stage: "prepare",
          script: "",
          scriptRevision: 1,
          productionRevision: 1,
          createdAt: batch.createdAt,
          progress: 0,
        };
        state.tasks.unshift(task);
        batch.taskIds.push(task.id);
      }
      state.batches.unshift(batch);
      state.draft = clone(snapshot);
      rememberRequest(state, "batch", requestKey, config, batch.id);
      return batch;
    });
  },
  async saveScript(
    taskId: string,
    script: string,
    expectedScriptRevision: number,
  ) {
    return change((state) => {
      const task = taskFor(state, taskId);
      checkScriptRevision(task, expectedScriptRevision);
      saveScriptInState(task, script);
      return task;
    });
  },
  async approveScript(
    taskId: string,
    script: string,
    expectedScriptRevision: number,
  ) {
    return change((state) => {
      const task = taskFor(state, taskId);
      checkScriptRevision(task, expectedScriptRevision);
      if (task.status !== "awaiting_review")
        throw new Error("当前任务不在待审核状态，请刷新后重试。");
      saveScriptInState(task, script);
      task.approvedRevision = task.scriptRevision;
      task.status = "queued";
      task.stage = "tts";
      task.progress = 0;
      return task;
    });
  },
  async regenerateScript(taskId: string, expectedScriptRevision: number) {
    return change((state) => {
      const task = taskFor(state, taskId);
      checkScriptRevision(task, expectedScriptRevision);
      if (task.status === "canceled")
        throw new Error("已取消任务不能重新生成。");
      invalidateOutputs(task);
      task.script = "";
      task.scriptRevision += 1;
      task.stage = "script";
      task.status = "queued";
      return task;
    });
  },
  async retryTask(taskId: string) {
    return change((state) => {
      const task = taskFor(state, taskId);
      if (task.status !== "failed") throw new Error("只有失败任务可以重试。");
      task.status = "queued";
      task.progress = 0;
      delete task.error;
      return task;
    });
  },
  async cancelTask(taskId: string) {
    return change((state) => {
      const task = taskFor(state, taskId);
      if (task.status === "succeeded") throw new Error("已完成任务无需取消。");
      task.status = "canceled";
      return task;
    });
  },
  async createPublish(
    taskId: string,
    platform: Platform,
    input: PublishInput,
    requestKey: string,
  ): Promise<PublishTask> {
    return change((state) => {
      const payload = { taskId, platform, input };
      const existing = requestResult(state, "publish", requestKey, payload);
      if (existing)
        return required(
          state.publishTasks.find((task) => task.id === existing),
          "原发布任务不存在。",
        );
      const production = taskFor(state, taskId);
      if (production.status !== "succeeded" || !production.videoUrl)
        throw new Error("请等待视频生成完成后再提交。");
      if (
        !state.accounts.some(
          (account) =>
            account.id === input.accountId &&
            account.platform === platform &&
            account.connected,
        )
      )
        throw new Error("所选平台账号未连接，请前往设置连接。");
      if (
        state.publishTasks.some(
          (task) =>
            task.productionTaskId === taskId &&
            task.productionRevision === production.productionRevision &&
            task.platform === platform &&
            task.accountId === input.accountId &&
            ["queued", "running", "unknown"].includes(task.status),
        )
      )
        throw new Error("该平台存在执行中或待确认任务，请先核对原任务。");
      const task: PublishTask = {
        ...clone(input),
        id: id("publish"),
        productionTaskId: taskId,
        productionRevision: production.productionRevision,
        platform,
        title: nonempty(input.title, "发布标题"),
        status: "queued",
        createdAt: now(),
        progress: 0,
      };
      state.publishTasks.unshift(task);
      rememberRequest(state, "publish", requestKey, payload, task.id);
      return task;
    });
  },
  async reconcilePublish(publishId: string) {
    return change((state) => {
      const task = required(
        state.publishTasks.find((item) => item.id === publishId),
        "发布任务不存在。",
      );
      if (task.status !== "unknown")
        throw new Error("仅待确认任务需要核对结果。");
      task.status = "draft_saved";
      delete task.error;
      return task;
    });
  },
  async downloadResource(resourceId: string) {
    return change((state) => {
      const resource = required(
        state.resources.find((item) => item.id === resourceId),
        "资源不存在。",
      );
      if (!resource.published) throw new Error("资源已下架，不能下载。");
      if (!resource.installed) {
        resource.downloadStatus = "downloading";
        resource.downloadProgress = 0;
      }
      return resource;
    });
  },
  async createLeadAnalysis(url: string, name: string, platform: Platform) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("请输入有效的视频链接。");
    }
    if (!["https:", "http:"].includes(parsed.protocol))
      throw new Error("视频链接只支持 HTTP 或 HTTPS。");
    return change((state) => {
      const job = {
        id: id("analysis"),
        name: nonempty(name, "任务名称"),
        url,
        platform,
        status: "running" as const,
        createdAt: now(),
      };
      state.analysisJobs.unshift(job);
      return job;
    });
  },
  async suggestReply(leadId: string) {
    return change((state) => {
      const lead = required(
        state.leads.find((item) => item.id === leadId),
        "线索不存在。",
      );
      lead.reply = `你好，看到你对${lead.region === "未识别" ? "这套房源" : lead.region + "的房源"}感兴趣。${lead.housingRequirements}这一点我们可以进一步聊聊。方便的话，你可以补充一下预算和看房时间，我帮你整理合适的选择。\n\n（模拟建议，请结合实际情况编辑后使用）`;
      return lead.reply;
    });
  },
  async updateLead(leadId: string, patch: Partial<Lead>) {
    return change((state) => {
      const lead = required(
        state.leads.find((item) => item.id === leadId),
        "线索不存在。",
      );
      Object.assign(lead, patch, { id: leadId });
      return lead;
    });
  },
  async addFollowup(leadId: string, note: string) {
    return change((state) => {
      const lead = required(
        state.leads.find((item) => item.id === leadId),
        "线索不存在。",
      );
      const followup = {
        id: id("followup"),
        note: nonempty(note, "跟进备注"),
        createdAt: now(),
      };
      lead.followups.unshift(followup);
      return followup;
    });
  },
  async updateProfile(patch: Partial<AgentProfile>) {
    return change((state) => {
      if (patch.defaults && !validConfig(patch.defaults))
        throw new Error("默认配置格式无效。");
      Object.assign(state.profile, clone(patch));
      return state.profile;
    });
  },
  async updateFactoryPreferences(input: {
    templateId: string;
    templateVersion: string;
    voiceId: string;
  }) {
    return change((state) => {
      Object.assign(state.profile.defaults, {
        videoTemplate: { id: input.templateId, version: input.templateVersion },
        voiceId: input.voiceId,
        requireScriptReview: true,
      });
      return state.profile.defaults;
    });
  },
  async addVoice(name: string) {
    return change((state) => {
      const voice: Voice = {
        id: id("voice"),
        name: nonempty(name, "音色名称"),
        description: "模拟克隆音色，未调用声音服务",
        status: "processing",
        isDefault: false,
      };
      state.voices.push(voice);
      return voice;
    });
  },
  async updateVoice(voiceId: string, patch: Partial<Voice>) {
    return change((state) => {
      const voice = required(
        state.voices.find((item) => item.id === voiceId),
        "音色不存在。",
      );
      if (patch.isDefault) {
        state.voices.forEach((item) => {
          item.isDefault = item.id === voiceId;
        });
        state.profile.defaults.voiceId = voiceId;
      }
      Object.assign(voice, patch, { id: voiceId });
      return voice;
    });
  },
  async removeVoice(voiceId: string) {
    return change((state) => {
      if (
        state.profile.defaults.voiceId === voiceId ||
        state.draft.voiceId === voiceId ||
        state.tasks.some((task) => task.configSnapshot.voiceId === voiceId)
      )
        throw new Error("此音色仍被默认配置、草稿或任务引用，暂不能删除。");
      state.voices = state.voices.filter((voice) => voice.id !== voiceId);
    });
  },
  async connectAccount(platform: Platform) {
    return change((state) => {
      let account = state.accounts.find((item) => item.platform === platform);
      if (account) {
        account.connected = true;
        account.lastCheckedAt = now();
      } else {
        account = {
          id: id("account"),
          platform,
          name: "新连接的演示账号",
          connected: true,
          lastCheckedAt: now(),
        };
        state.accounts.push(account);
      }
      return account;
    });
  },
  async disconnectAccount(accountId: string) {
    return change((state) => {
      const account = required(
        state.accounts.find((item) => item.id === accountId),
        "平台账号不存在。",
      );
      if (
        state.publishTasks.some(
          (task) =>
            task.accountId === accountId &&
            ["queued", "running", "unknown"].includes(task.status),
        )
      )
        throw new Error("该账号仍有执行中或待确认任务，请先处理。");
      account.connected = false;
      return account;
    });
  },
  async updateResource(resourceId: string, patch: Partial<Resource>) {
    return change((state) => {
      const resource = required(
        state.resources.find((item) => item.id === resourceId),
        "资源不存在。",
      );
      if (patch.version && patch.version !== resource.version)
        throw new Error("资源版本不可覆盖，请创建新版本资源。");
      const publishedOnce =
        resource.published ||
        resource.publishedOnce ||
        patch.published === true;
      if (
        (resource.published || resource.publishedOnce) &&
        Object.keys(patch).some((key) => key !== "published")
      )
        throw new Error("已发布版本内容不可覆盖，请创建新资源。");
      Object.assign(resource, clone(patch), { id: resourceId, publishedOnce });
      return resource;
    });
  },
  async createResource(
    input: Pick<Resource, "name" | "type" | "category"> & Partial<Resource>,
  ) {
    return change((state) => {
      const resource: Resource = {
        description: "",
        version: "1.0.0",
        thumbnail: "/media/interior-1.jpg",
        compatibleModes: ["voiceover", "avatar"],
        installed: false,
        downloadStatus: "idle",
        downloadProgress: 0,
        published: false,
        sizeMb: 10,
        ...clone(input),
        id: id("resource"),
        name: nonempty(input.name, "资源名称"),
      };
      state.resources.unshift(resource);
      return resource;
    });
  },
};

export const isLive = import.meta.env?.VITE_API_MODE !== "mock";
export {
  authBaseURL,
  authRequest,
  clearAccessToken,
  serviceRequest,
  ServiceRequestError,
  type SessionUser,
} from "./transport";
const remoteListeners = new Set<() => void>();
export const demoApi: typeof mockApi = isLive
  ? new Proxy(mockApi, {
      get(_target, name: keyof typeof mockApi) {
        if (name === "tick") return async () => {};
        if (name === "subscribe")
          return (listener: () => void) => {
            remoteListeners.add(listener);
            const timer = window.setInterval(listener, 10000);
            return () => {
              remoteListeners.delete(listener);
              clearInterval(timer);
            };
          };
        return async (...args: unknown[]) => {
          try {
            const value = window.desktop?.request
              ? await window.desktop.request(name, args)
              : name === "getWorkspace"
                ? await serviceRequest("/v1/workspace")
                : await serviceRequest(`/v1/commands/${name}`, args);
            if (name !== "getWorkspace") remoteListeners.forEach((fn) => fn());
            return value;
          } catch (error) {
            if (error instanceof Error && error.message.includes("重新登录"))
              window.dispatchEvent(new Event("keagent:unauthorized"));
            throw error;
          }
        };
      },
    })
  : mockApi;
