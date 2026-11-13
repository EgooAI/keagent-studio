const path = require("node:path");
const fs = require("node:fs/promises");
const domain = require("../panorama/domain.cjs");
const media = require("../panorama/media.cjs");
const providers = require("../panorama/providers.cjs");

function selectScenes(scenes, ids) {
  domain.ensure(
    Array.isArray(ids) &&
      ids.length >= 2 &&
      ids.length <= 7 &&
      new Set(ids).size === ids.length,
    "每套房源请选择 2–7 张不重复的 VR 全景图",
  );
  const selected = scenes.filter((scene) => ids.includes(scene.id));
  domain.ensure(
    selected.length === ids.length,
    "所选图片已失效或不属于当前房源，请重新选择图片",
  );
  return selected;
}

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
  const images = panoramas.map((url) => ({ url, kind: "panorama" }));
  const fingerprint = domain.hash({ panoramas });
  const savedPanoramas = (saved?.scenes || []).filter(
    (scene) => !scene.kind || scene.kind === "panorama",
  );
  if (
    savedPanoramas.length &&
    ((!images.length && !saved.remoteFingerprint) ||
      (saved.remoteFingerprint === fingerprint &&
        (saved.remoteSceneIds || saved.scenes.length === images.length)))
  )
    return savedPanoramas;
  const scenes = savedPanoramas.filter((scene) =>
    saved.remoteSceneIds
      ? !saved.remoteSceneIds.includes(scene.id)
      : !saved.remoteFingerprint,
  );
  domain.ensure(
    scenes.length + images.length > 0,
    "这套房源还没有 VR 全景图，请先到房源详情补充素材",
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
        bytes = await providers.downloadImage(url, signal);
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
      scenes: [
        ...(saved?.scenes || []).filter((s) => s.kind && s.kind !== "panorama"),
        ...scenes,
      ],
      materialMode: "panorama",
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
    const asset = scene.asset;
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
  const kind = input.kind || "panorama";
  domain.ensure(
    ["panorama", "reference"].includes(kind),
    "制作素材仅支持 VR 全景图；户型图可作为文案参考",
  );
  const files = await workflow.dialogs.open();
  assertCurrent();
  const state = workflow.store(owner);
  const saved = state.imports[property.id];
  const previous = saved?.scenes || [];
  const references = saved?.references || [];
  const count =
    previous.filter((s) => !s.kind || s.kind === "panorama").length +
    references.length;
  domain.ensure(
    count + files.length <= 20,
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
  if (!added.length) return { count };
  const referenceOnly = kind === "reference";
  const all = referenceOnly ? previous : [...previous, ...added];
  state.imports[property.id] = {
    ...saved,
    property,
    scenes: all,
    references: referenceOnly ? [...references, ...added] : references,
    materialMode: "panorama",
  };
  state.properties = [
    property,
    ...state.properties.filter((p) => p.id !== property.id),
  ];
  workflow.persist(owner);
  return { count: count + added.length };
}
module.exports = { load, importProperty, scriptImages, selectScenes };
