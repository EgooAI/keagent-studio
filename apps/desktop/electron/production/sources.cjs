const domain = require("../panorama/domain.cjs");
const providers = require("../panorama/providers.cjs");

const methods = new Set(["beike-import", "source-restore"]);
async function handle(
  workflow,
  owner,
  method,
  input,
  assertCurrent,
  parentSignal,
  property,
) {
  const state = workflow.store(owner);
  if (method === "source-restore") {
    if (input.propertyId === "panorama-cc0-sample")
      await workflow.loadSample(owner, assertCurrent);
    const saved = state.imports[input.propertyId];
    domain.ensure(saved, "没有这套房源的本机素材记录");
    return {
      ...saved,
      references: (saved.references || []).map((scene) => ({
        ...scene,
        url: workflow.url(owner, `assets/${scene.asset}`),
      })),
      materialMode: "panorama",
      scenes: saved.scenes
        .filter((scene) => !scene.kind || scene.kind === "panorama")
        .map((scene) => ({
          ...scene,
          url: workflow.url(owner, `assets/${scene.asset}`),
        })),
    };
  }
  domain.ensure(workflow.remote, "未连接云端素材服务");
  const controller = new AbortController();
  workflow.previews.add(controller);
  const signal = parentSignal
    ? AbortSignal.any([controller.signal, parentSignal])
    : controller.signal;
  try {
    if (method === "beike-import") {
      const result = await workflow.remote("beike-import", input, signal);
      assertCurrent();
      const scenes = [];
      const images = [
        ...(result.panoramas || []).map((image) => ({
          ...image,
          kind: "panorama",
        })),
      ];
      const referenceImages = result.referenceImages || [];
      const references = [];
      domain.ensure(
        images.length >= 1 && images.length + referenceImages.length <= 20,
        "房源需有 VR 全景图，请在房源详情补充；最多支持20张图片（含参考图）",
      );
      for (const image of [...images, ...referenceImages]) {
        const bytes = await providers.downloadImage(image.url, signal);
        signal.throwIfAborted();
        assertCurrent();
        const reference = !image.kind;
        (reference ? references : scenes).push({
          ...(await workflow.importBytes(
            owner,
            bytes,
            image.room,
            image.kind || "reference",
          )),
          description: image.description || "",
        });
      }
      assertCurrent();
      state.properties = [
        result.property,
        ...state.properties.filter((p) => p.id !== result.property.id),
      ];
      const saved = {
        property: result.property,
        scenes,
        references,
        materialMode: "panorama",
        panoramaAvailability: result.panoramaAvailability,
      };
      state.imports[result.property.id] = saved;
      workflow.persist(owner);
      return saved;
    }
  } finally {
    workflow.previews.delete(controller);
  }
}
module.exports = { methods, handle };
