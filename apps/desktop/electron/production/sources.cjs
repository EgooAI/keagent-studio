const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const domain = require("../panorama/domain.cjs");
const providers = require("../panorama/providers.cjs");

const methods = new Set([
  "beike-import",
  "image-submit",
  "image-refresh",
  "source-restore",
]);
async function handle(
  workflow,
  owner,
  method,
  input,
  assertCurrent,
  parentSignal,
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
      scenes: saved.scenes.map((scene) => {
        const result = state.imageTasks.find(
          (t) => t.sceneId === scene.id,
        )?.result;
        const value = result || scene;
        return { ...value, url: workflow.url(owner, `assets/${value.asset}`) };
      }),
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
        ...(result.images || []).map((image) => ({ ...image, kind: "photo" })),
      ];
      const referenceImages = result.referenceImages || [];
      const references = [];
      domain.ensure(
        images.length >= 1 && images.length + referenceImages.length <= 20,
        "房源需有出镜图片，最多支持20张图片（含参考图）",
      );
      for (const image of [...images, ...referenceImages]) {
        const bytes = await providers.downloadImage(image.url, "beike", signal);
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
      const materialMode = scenes.some((scene) => scene.kind === "photo")
        ? "expand"
        : "panorama";
      const saved = {
        property: result.property,
        scenes,
        references,
        materialMode,
        panoramaAvailability: result.panoramaAvailability,
      };
      state.imports[result.property.id] = saved;
      workflow.persist(owner);
      return saved;
    }
    if (method === "image-submit") {
      const source = workflow.scenes(owner, [input.scene], true)[0];
      domain.ensure(source.kind === "photo", "只能对原始普通照片进行扩图");
      const previous = state.imageTasks.find((t) => t.sceneId === source.id);
      domain.ensure(
        !previous,
        "这张素材已有扩图记录，请刷新结果；重新制作请重新导入素材",
      );
      const bytes = await fs.readFile(
        path.join(workflow.directory(owner), "assets", source.asset),
      );
      domain.ensure(
        domain.hash(bytes) === source.asset.split(".")[0],
        "原图已改变，请重新导入",
      );
      const metadata = state.assetMetadata[source.asset];
      domain.ensure(
        bytes.length <= 10 * 1024 * 1024 &&
          metadata.width <= 4096 &&
          metadata.height <= 4096,
        "扩图原图需不超过10MB，宽高不超过4096像素",
      );
      domain.text(input.prompt, "扩图说明", 600);
      const scales = [
        input.top_scale,
        input.bottom_scale,
        input.left_scale,
        input.right_scale,
      ];
      domain.ensure(
        scales.every((v) => Number.isFinite(v) && v >= 1 && v <= 2) &&
          scales.some((v) => v > 1),
        "请设置至少一个方向的扩展比例（1–2）",
      );
      const task = {
        id: crypto.randomUUID(),
        sceneId: source.id,
        source,
        provider: "dashscope",
        model: "wanx2.1-imageedit",
        parameters: {
          prompt: input.prompt,
          top_scale: input.top_scale,
          bottom_scale: input.bottom_scale,
          left_scale: input.left_scale,
          right_scale: input.right_scale,
        },
        status: "submitting",
        createdAt: new Date().toISOString(),
      };
      state.imageTasks.unshift(task);
      workflow.persist(owner);
      try {
        const result = await workflow.remote(
          "image-submit",
          {
            requestKey: task.id,
            image: bytes.toString("base64"),
            prompt: input.prompt,
            top_scale: input.top_scale,
            bottom_scale: input.bottom_scale,
            left_scale: input.left_scale,
            right_scale: input.right_scale,
          },
          signal,
        );
        assertCurrent();
        signal.throwIfAborted();
        task.status = result.status;
      } catch (error) {
        task.error =
          "提交未确认。刷新可恢复已保存的云端任务；不会自动重新提交。";
        throw error;
      } finally {
        workflow.persist(owner);
      }
      return task;
    }
    const tasks = state.imageTasks.filter(
      (t) =>
        ["submitting", "PENDING", "RUNNING", "SUCCEEDED"].includes(t.status) &&
        !t.result &&
        (!Array.isArray(input.sceneIds) || input.sceneIds.includes(t.sceneId)),
    );
    for (const task of tasks.slice(0, 3)) {
      try {
        const result = await workflow.remote(
          "image-query",
          { requestKey: task.id },
          signal,
        );
        signal.throwIfAborted();
        assertCurrent();
        task.status = result.status;
        task.error = undefined;
        if (result.status === "SUCCEEDED") {
          const bytes = await providers.downloadImage(
            result.imageUrl,
            "dashscope",
            signal,
          );
          signal.throwIfAborted();
          assertCurrent();
          task.result = {
            ...(await workflow.importBytes(
              owner,
              bytes,
              task.source.room,
              "expanded",
            )),
            id: task.source.id,
            description: task.source.description,
            sourceAsset: task.source.asset,
            approved: false,
          };
        } else if (["FAILED", "CANCELED", "UNKNOWN"].includes(result.status)) {
          task.error = "扩图未完成，请在百炼控制台核对任务；原图保留。";
        } else if (result.status === "submitting") {
          task.error = "提交结果未知，请在百炼控制台核对；不会自动重提。";
        }
      } catch (error) {
        if (signal.aborted) throw error;
        task.error = error.message;
      }
      workflow.persist(owner);
    }
    return state.imageTasks.map((t) => ({
      id: t.id,
      sceneId: t.sceneId,
      status: t.status,
      error: t.error,
      result: t.result
        ? { ...t.result, url: workflow.url(owner, `assets/${t.result.asset}`) }
        : undefined,
    }));
  } finally {
    workflow.previews.delete(controller);
  }
}
module.exports = { methods, handle };
