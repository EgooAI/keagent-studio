// Uses only bundled CC0 panoramas, a fixture catalog recipe and a local Windows voice.
// No paid provider or publishing requests are permitted.
import assert from "node:assert/strict";
import { readFile, mkdir, copyFile, writeFile } from "node:fs/promises";
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
const domain = require("../apps/desktop/electron/panorama/domain.cjs");
const catalog = require("../services/cloud/video_templates.json");
const root = path.resolve("output/builtin-factory-run");
await mkdir(root, { recursive: true });
const recipe = structuredClone(catalog[0]);
Object.assign(recipe.production.config, {
  openingTemplate: "这是测试视频。",
  sceneTemplate: "{room}。",
  closingTemplate: "测试结束。",
  aspectRatio: "16:9",
});
const calls = [];
const workflow = new PanoramaWorkflow(
  root,
  path.resolve("apps/desktop/public/media/panoramas"),
  {},
  async (method) => {
    calls.push(method);
    if (method === "template") return recipe;
    if (method === "capabilities")
      return { templates: [recipe], managedVoices: true, ai: true };
    throw new Error("Unexpected provider request: " + method);
  },
);
const caps = await workflow.capabilities();
const voice = caps.voices.find((v) => v.language === "zh-CN");
assert.ok(voice, "A local Chinese test voice is required");
const property = {
  id: "panorama-cc0-sample",
  title: "内置测试房源 · 全景素材",
  description: "两个独立 CC0 测试场景，不是同一套真实在售房源",
  areaSqm: 0,
  priceCents: 0,
  layout: "",
  sellingPoints: [],
  sample: true,
};
const materials = await workflow.loadSample(
  workflow.owner("builtin-regression"),
  () => {},
);
const draft = await workflow.handle(
  "builtin-regression",
  "prepare",
  {
    propertyId: property.id,
    sceneIds: materials.scenes.map((scene) => scene.id),
    templateVersion: recipe.version,
    config: {
      ...domain.defaultConfig,
      scriptProvider: "ai",
      ttsProvider: "bailian",
      voice: "cloud-voice",
    },
  },
  property,
);
assert.equal(draft.sample, true);
assert.equal(draft.config.scriptProvider, "template");
assert.equal(draft.config.ttsProvider, "system");
assert.equal(draft.scenes.length, 2);
assert.equal(draft.config.materialMode, "panorama");
const restored = await workflow.handle("builtin-regression", "source-restore", {
  propertyId: property.id,
});
assert.equal(restored.scenes[0].id, draft.scenes[0].id);
const job = await workflow.handle("builtin-regression", "start", {
  id: draft.id,
  revision: 1,
  confirmed: true,
});
await workflow.active.get(job.id)?.promise;
assert.equal(job.status, "succeeded", job.error);
assert.throws(
  () => workflow.completedArtifactOutput("builtin-regression", job.id),
  /测试|正式/,
);
assert.ok(
  calls.every((method) => ["capabilities", "template"].includes(method)),
);
await copyFile(
  path.join(
    workflow.directory(workflow.owner("builtin-regression")),
    "jobs",
    job.id,
    "final.mp4",
  ),
  path.join(root, "final.mp4"),
);
const report = {
  status: job.status,
  scenes: job.scenes.length,
  duration: job.duration,
  paidProviderCalls: 0,
  sample: true,
};
await writeFile(
  path.join(root, "result.json"),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report));
