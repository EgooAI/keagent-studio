// Render an already downloaded real expansion. Does not call any paid provider.
// Sample approval here is solely for the marked technical demonstration.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "output/production-live-direct-verification");
const settings = parseEnv(
  await readFile(path.join(root, ".env.local"), "utf8"),
);
for (const key of ["FFMPEG_PATH", "FFPROBE_PATH"])
  if (settings[key]) process.env[key] = settings[key];
const require = createRequire(import.meta.url);
const {
  PanoramaWorkflow,
} = require("../apps/desktop/electron/panorama/workflow.cjs");
const domain = require("../apps/desktop/electron/panorama/domain.cjs");
const media = require("../apps/desktop/electron/panorama/media.cjs");
const user = "production-live-smoke";
const workflow = new PanoramaWorkflow(path.join(output, "workflow"), "", {});
const owner = workflow.owner(user);
const state = workflow.store(owner);
const task = state.imageTasks.find((t) => t.result);
assert.ok(task, "Run verify-live-production-sources.mjs --direct first");
const source = task.result;
assert.throws(() => workflow.scenes(owner, [source]), /审核/);
const scene = {
  ...source,
  room: "官方示例客厅",
  approved: true,
  description: "画面两侧由人工智能扩展，新增物品不代表真实房况。",
};
workflow.scenes(owner, [scene]);
const caps = await media.capabilities(path.join(output, "runtime"));
const voice = caps.voices.find((v) => v.language === "zh-CN");
assert.ok(voice, "A local Chinese test voice is required");
const property = {
  ...state.properties[0],
  title: "官方示例客厅",
  sample: true,
};
const baseConfig = {
  ...domain.defaultConfig,
  materialMode: "expand",
  ttsProvider: "system",
  voice: voice.name,
  videoMode: "voiceover",
  openingTemplate: "这是贝壳官方照片的扩图测试。",
  sceneTemplate: "{description}",
  closingTemplate: "画面仅作技术演示。",
  agentName: "测试经纪人",
  agentContact: "仅供内部演示",
  coverTitle: "标准带看｜客厅示例",
};
const draft = await workflow.handle(
  user,
  "generate",
  { propertyId: property.id, config: baseConfig, scenes: [scene] },
  property,
);
// Keep FFmpeg/libass paths below the Windows legacy 260-character limit.
const renderDirectory = path.join(output, "render");
await mkdir(path.join(renderDirectory, "assets"), { recursive: true });
await copyFile(
  path.join(workflow.directory(owner), "assets", scene.asset),
  path.join(renderDirectory, "assets", scene.asset),
);
const cache = path.join(renderDirectory, "cache");
await mkdir(cache, { recursive: true });
const audio = [];
for (const segment of draft.segments)
  audio.push(
    await media.synthesize(
      segment,
      baseConfig,
      cache,
      new AbortController().signal,
    ),
  );
const results = [];
for (const aspectRatio of ["16:9", "9:16"]) {
  const directory = path.join(output, `video-${aspectRatio.replace(":", "x")}`);
  await mkdir(directory, { recursive: true });
  const result = await media.render(
    { ...draft, sample: true, config: { ...baseConfig, aspectRatio } },
    audio,
    renderDirectory,
    directory,
    new AbortController().signal,
    () => {},
  );
  const file = path.join(directory, "final.mp4");
  const info = await media.probe(file, directory);
  const stream = info.streams.find((s) => s.codec_type === "video");
  assert.equal(stream.width, aspectRatio === "16:9" ? 1280 : 720);
  assert.equal(stream.height, aspectRatio === "16:9" ? 720 : 1280);
  assert.ok(info.streams.some((s) => s.codec_type === "audio"));
  assert.ok(Math.abs(Number(info.format.duration) - result.duration) < 0.15);
  assert.ok(result.timeline.every((s) => s.camera === null));
  const frames = [];
  for (const [index, time] of [
    1,
    result.duration / 2,
    result.duration - 1,
  ].entries()) {
    const image = path.join(directory, `frame-${index}.png`);
    await media.run(
      process.env.FFMPEG_PATH || "ffmpeg",
      [
        "-v",
        "error",
        "-y",
        "-ss",
        String(time),
        "-i",
        file,
        "-frames:v",
        "1",
        image,
      ],
      directory,
    );
    const raw = path.join(directory, `frame-${index}.gray`);
    await media.run(
      process.env.FFMPEG_PATH || "ffmpeg",
      [
        "-v",
        "error",
        "-y",
        "-i",
        image,
        "-vf",
        "scale=96:96",
        "-pix_fmt",
        "gray",
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        raw,
      ],
      directory,
    );
    frames.push(await readFile(raw));
  }
  const movement =
    frames[0].reduce(
      (sum, pixel, i) => sum + Math.abs(pixel - frames[2][i]),
      0,
    ) / frames[0].length;
  assert.ok(movement > 1, "Expanded image did not visibly pan");
  const boundaryDifferences = [];
  for (const [index, segment] of result.timeline.slice(1).entries()) {
    const pair = [];
    for (const [side, offset] of [-0.02, 0.02].entries()) {
      const raw = path.join(directory, `boundary-${index}-${side}.gray`);
      await media.run(
        process.env.FFMPEG_PATH || "ffmpeg",
        [
          "-v",
          "error",
          "-y",
          "-ss",
          String(segment.start + offset),
          "-i",
          file,
          "-vf",
          "scale=96:96",
          "-pix_fmt",
          "gray",
          "-frames:v",
          "1",
          "-f",
          "rawvideo",
          raw,
        ],
        directory,
      );
      pair.push(await readFile(raw));
    }
    const difference =
      pair[0].reduce((sum, pixel, i) => sum + Math.abs(pixel - pair[1][i]), 0) /
      pair[0].length;
    assert.ok(difference < 20, "Camera jumped at an audio-segment boundary");
    boundaryDifferences.push(difference);
  }
  results.push({
    aspectRatio,
    file,
    width: stream.width,
    height: stream.height,
    duration: result.duration,
    movement,
    boundaryDifferences,
    voice: voice.name,
  });
  console.log(JSON.stringify(results.at(-1)));
}
const reportFile = path.join(output, "result.json");
const report = JSON.parse(await readFile(reportFile, "utf8"));
report.review = {
  use: "technical-sample-only",
  observation:
    "主体和原水印保留；扩展区域新增香蕉、墙面装饰，不能视作真实房况审核通过。",
  aiLabelRequired: true,
};
report.videos = results;
await writeFile(reportFile, JSON.stringify(report, null, 2) + "\n");
