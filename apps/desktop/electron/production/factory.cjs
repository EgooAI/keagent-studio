const path = require("node:path");
const fs = require("node:fs/promises");
const { setTimeout: delay } = require("node:timers/promises");
const domain = require("../panorama/domain.cjs");
const media = require("../panorama/media.cjs");
const providers = require("../panorama/providers.cjs");
const sources = require("./sources.cjs");

async function load(
  workflow,
  owner,
  property,
  assertCurrent,
  preparationSignal,
) {
  if (property.id === "panorama-cc0-sample")
    return (await workflow.loadSample(owner, assertCurrent)).scenes;
  const state = workflow.store(owner);
  const saved = state.imports[property.id];
  const panoramas = Array.isArray(property.panoramas) ? property.panoramas : [];
  const photos = Array.isArray(property.images) ? property.images : [];
  const images = [
    ...panoramas.map((url) => ({ url, kind: "panorama" })),
    ...photos.map((url) => ({ url, kind: "photo" })),
  ];
  const fingerprint = domain.hash({ panoramas, photos });
  if (
    saved &&
    ((!images.length && !saved.remoteFingerprint) ||
      (saved.remoteFingerprint === fingerprint &&
        (saved.remoteSceneIds || saved.scenes.length === images.length)))
  )
    return saved.scenes;
  const scenes = (saved?.scenes || []).filter((scene) =>
    saved.remoteSceneIds
      ? !saved.remoteSceneIds.includes(scene.id)
      : !saved.remoteFingerprint,
  );
  domain.ensure(
    scenes.length + images.length > 0,
    "这套房源还没有制作图片，请先到房源详情补充素材",
  );
  domain.ensure(images.length <= 20, "每套房源最多使用20张制作图片");
  const controller = new AbortController();
  workflow.previews.add(controller);
  const signal = preparationSignal
    ? AbortSignal.any([preparationSignal, controller.signal])
    : controller.signal;
  try {
    const remoteSceneIds = [];
    for (const [index, { url, kind }] of images.entries()) {
      domain.ensure(
        typeof url === "string",
        "房源图片地址无效，请在房源详情更新素材",
      );
      let bytes;
      try {
        bytes = await providers.downloadImage(url, "beike", signal);
      } catch (error) {
        if (signal.aborted) throw error;
        throw new Error(
          `无法读取第${index + 1}张房源图片，请在房源详情补充可用素材`,
        );
      }
      assertCurrent();
      signal.throwIfAborted();
      const scene = await workflow.importBytes(
        owner,
        bytes,
        `图片 ${index + 1}`,
        kind,
      );
      if (!scenes.some((s) => s.asset === scene.asset && s.kind === kind)) {
        scenes.push(scene);
        remoteSceneIds.push(scene.id);
      }
    }
    domain.ensure(
      scenes.length + (saved?.references?.length || 0) <= 20,
      "每套房源最多使用20张图片（含参考图）",
    );
    state.imports[property.id] = {
      ...saved,
      property,
      scenes,
      materialMode: scenes.some((s) => s.kind !== "panorama")
        ? "expand"
        : "panorama",
      remoteFingerprint: fingerprint,
      remoteSceneIds,
    };
    workflow.persist(owner);
    return scenes;
  } finally {
    workflow.previews.delete(controller);
  }
}
async function scriptImages(workflow, owner, scenes, references, signal) {
  const images = [];
  const cwd = workflow.directory(owner);
  for (const scene of [...scenes, ...references]) {
    signal.throwIfAborted();
    const asset = scene.kind === "expanded" ? scene.sourceAsset : scene.asset;
    domain.ensure(
      /^[a-f0-9]{64}\.(jpg|png)$/.test(asset || ""),
      "找不到用于编写文案的原图，请重新导入素材",
    );
    const file = path.join(cwd, "assets", asset);
    domain.ensure(
      domain.hash(await fs.readFile(file)) === asset.split(".")[0],
      "房源原图已改变，请重新导入素材",
    );
    images.push({
      id: scene.id,
      room: scene.room,
      description: scene.description,
      kind:
        scene.kind === "panorama" || scene.kind === "reference"
          ? scene.kind
          : "photo",
      jpeg: await media.scriptImage(file, cwd, signal),
    });
  }
  return images;
}
async function importProperty(workflow, owner, property, input, assertCurrent) {
  domain.ensure(property, "房源不存在，请重新选择");
  const files = await workflow.dialogs.open();
  assertCurrent();
  const state = workflow.store(owner);
  const saved = state.imports[property.id];
  const previous = saved?.scenes || [];
  const references = saved?.references || [];
  const kind = input.kind || "photo";
  domain.ensure(
    ["photo", "panorama", "reference"].includes(kind),
    "图片类型无效",
  );
  domain.ensure(
    previous.length + references.length + files.length <= 20,
    "每套房源最多保存20张图片（含参考图）",
  );
  const added = [];
  for (const file of files) {
    const scene = await workflow.importFile(
      owner,
      file,
      path.basename(file, path.extname(file)).slice(0, 80) ||
        `图片 ${previous.length + added.length + 1}`,
      kind,
    );
    assertCurrent();
    added.push(scene);
  }
  if (!added.length) return { count: previous.length + references.length };
  const referenceOnly = kind === "reference";
  const all = referenceOnly ? previous : [...previous, ...added];
  state.imports[property.id] = {
    ...saved,
    property,
    scenes: all,
    references: referenceOnly ? [...references, ...added] : references,
    materialMode: all.some((s) => s.kind !== "panorama")
      ? "expand"
      : "panorama",
  };
  state.properties = [
    property,
    ...state.properties.filter((p) => p.id !== property.id),
  ];
  workflow.persist(owner);
  return { count: previous.length + references.length + added.length };
}
async function expand(workflow, owner, job, signal, onProgress) {
  const state = workflow.store(owner);
  for (const [index, scene] of job.scenes.entries()) {
    signal.throwIfAborted();
    if (scene.kind === "photo") {
      let task = state.imageTasks.find((t) => t.sceneId === scene.id);
      if (!task) {
        await sources.handle(
          workflow,
          owner,
          "image-submit",
          {
            scene,
            prompt:
              "延展原图左右边缘的室内环境，保留原有主体与水印，延续墙面、地面、光照和透视，不添加门窗、家具或人物。",
            top_scale: 1,
            bottom_scale: 1,
            left_scale: 1.5,
            right_scale: 1.5,
          },
          () => signal.throwIfAborted(),
          signal,
        );
        task = state.imageTasks.find((t) => t.sceneId === scene.id);
      }
      domain.ensure(task, "无法恢复图片处理任务");
      for (let attempt = 0; !task.result && attempt < 180; attempt++) {
        signal.throwIfAborted();
        domain.ensure(
          !["FAILED", "CANCELED", "UNKNOWN"].includes(task.status),
          task.error || "图片处理失败，请核对供应商任务后重试",
        );
        await sources.handle(
          workflow,
          owner,
          "image-refresh",
          { sceneIds: [scene.id] },
          () => signal.throwIfAborted(),
          signal,
        );
        domain.ensure(!task.error, task.error || "图片处理失败");
        if (!task.result) await delay(5000, undefined, { signal });
      }
      domain.ensure(task.result, "图片仍在处理中，重试将继续查询原任务");
      job.scenes[index] = {
        ...task.result,
        room: scene.room,
        description: scene.description,
        direction: scene.direction,
        approved: true,
      };
    } else if (scene.kind === "expanded")
      job.scenes[index] = { ...scene, approved: true };
    const completed = job.scenes[index];
    const bytes = await fs.readFile(
      path.join(workflow.directory(owner), "assets", completed.asset),
    );
    domain.ensure(
      domain.hash(bytes) === completed.asset.split(".")[0],
      "图片处理结果已改变，请在房源详情重新补充素材",
    );
    workflow.persist(owner);
    onProgress((index + 1) / job.scenes.length);
  }
}
module.exports = { load, importProperty, scriptImages, expand };
