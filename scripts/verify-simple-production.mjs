// Real local end-to-end factory execution using an already completed expansion.
// No Beike, image generation, cloud speech or publishing request is made.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { createRequire } from "node:module";
import path from "node:path";
const settings = parseEnv(await readFile(".env.local", "utf8"));
for (const key of ["FFMPEG_PATH", "FFPROBE_PATH"])
  if (settings[key]) process.env[key] = settings[key];
const require = createRequire(import.meta.url);
const {
  PanoramaWorkflow,
} = require("../apps/desktop/electron/panorama/workflow.cjs");
const media = require("../apps/desktop/electron/panorama/media.cjs");
const domain = require("../apps/desktop/electron/panorama/domain.cjs");
const catalog = require("../services/cloud/video_templates.json");
const root = path.resolve("output/factory-run");
await mkdir(root, { recursive: true });
const calls = [];
const testTemplate = structuredClone(catalog[0]);
Object.assign(testTemplate.production.config, {
  openingTemplate: "这是自动制作流程测试。",
  sceneTemplate: "{room}。{description}",
  closingTemplate: "仅作技术演示。",
  aspectRatio: "16:9",
});
const workflow = new PanoramaWorkflow(root, "", {}, async (method) => {
  calls.push(method);
  if (method === "template") return structuredClone(testTemplate);
  assert.equal(
    method,
    "capabilities",
    "No paid calls are permitted in this regression",
  );
  return { managedVoices: false, imageExpansion: true };
});
const owner = workflow.owner("local-factory-regression");
const property = {
  id: "factory-sample",
  title: "单次确认制作流程测试",
  description: "技术样例，非在售房源",
  areaSqm: 0,
  priceCents: 0,
  layout: "",
  sellingPoints: [],
  sample: true,
};
let state = workflow.store(owner);
if (!state.imports[property.id]) {
  const photo = await workflow.importBytes(
    owner,
    await readFile(
      "output/property-samples/beike-official-pic-verify/living-room-01.jpg",
    ),
    "示例客厅",
    "photo",
  );
  const expanded = await workflow.importBytes(
    owner,
    await readFile("output/production-live-direct-verification/expanded.png"),
    photo.room,
    "expanded",
  );
  state.imports[property.id] = {
    property,
    scenes: [{ ...photo, description: "扩展部分由人工智能生成。" }],
    materialMode: "expand",
  };
  state.imageTasks.push({
    id: "cached-completed-expansion",
    sceneId: photo.id,
    source: photo,
    status: "SUCCEEDED",
    result: {
      ...expanded,
      id: photo.id,
      sourceAsset: photo.asset,
      approved: false,
    },
  });
  workflow.persist(owner);
}
const caps = await workflow.capabilities();
const voice = caps.voices.find((v) => v.language === "zh-CN");
assert.ok(voice);
const config = {
  ...domain.defaultConfig,
  voice: voice.name,
  scriptProvider: "template",
  openingTemplate: "这是自动制作流程测试。",
  sceneTemplate: "{description}",
  closingTemplate: "仅作技术演示。",
  aspectRatio: "16:9",
};
const draft = await workflow.handle(
  "local-factory-regression",
  "prepare",
  { propertyId: property.id, config },
  property,
);
assert.equal(draft.scenes[0].kind, "photo");
await assert.rejects(
  () =>
    workflow.handle("local-factory-regression", "start", {
      id: draft.id,
      revision: 1,
    }),
  /确认整条/,
);
const job = await workflow.handle("local-factory-regression", "start", {
  id: draft.id,
  revision: 1,
  confirmed: true,
});
await workflow.active.get(job.id)?.promise;
assert.equal(job.status, "succeeded", job.error);
assert.equal(job.scenes[0].kind, "expanded");
assert.equal(job.scenes[0].approved, true);
assert.equal(
  calls.every((method) => ["capabilities", "template"].includes(method)),
  true,
);
const file = path.join(workflow.directory(owner), "jobs", job.id, "final.mp4");
const info = await media.probe(file, root);
assert.ok(info.streams.some((s) => s.codec_type === "audio"));
const result = path.join(root, "final.mp4");
await copyFile(file, result);
await copyFile(
  path.join(workflow.directory(owner), "jobs", job.id, "cover.jpg"),
  path.join(root, "cover.jpg"),
);
const report = {
  status: job.status,
  confirmation: job.confirmation,
  duration: job.duration,
  video: result,
  paidProviderCalls: 0,
  notes:
    "Cached real AI expansion, local Windows test voice, actual factory execution and FFmpeg rendering.",
};
await writeFile(
  path.join(root, "result.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
