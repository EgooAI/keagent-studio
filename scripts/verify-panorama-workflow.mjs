import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { stat, readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const {
  PanoramaWorkflow,
} = require("../apps/desktop/electron/panorama/workflow.cjs");
const media = require("../apps/desktop/electron/panorama/media.cjs");
const domain = require("../apps/desktop/electron/panorama/domain.cjs");
const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "output/workflow-verification");
await mkdir(output, { recursive: true });
const workflow = new PanoramaWorkflow(
  output,
  path.join(root, "apps/desktop/public/media/panoramas"),
  {},
);
const user = "workflow-verification";
const caps = await workflow.handle(user, "capabilities");
assert.ok(caps.ffmpeg && caps.ffprobe, "FFmpeg and FFprobe required");
const voice = caps.voices.find((v) => v.language === "zh-CN");
assert.ok(voice);
const sample = await workflow.handle(user, "sample");
const config = { ...caps.defaultConfig, voice: voice.name, speed: 5 };
let draft = await workflow.handle(
  user,
  "generate",
  { config, scenes: sample.scenes },
  sample.property,
);
const content = [
  "这是全景工作流测试。",
  "第一个独立测试空间。",
  "第二个独立测试空间。",
  "本片仅用于开发测试。",
];
draft = await workflow.handle(user, "save", {
  id: draft.id,
  revision: draft.revision,
  config,
  segments: draft.segments.map((s, i) => ({ ...s, text: content[i] })),
});
const job = await workflow.handle(user, "start", {
  id: draft.id,
  revision: draft.revision,
});
console.log(`Rendering real workflow ${job.id}`);
await workflow.active.get(job.id).promise;
assert.equal(job.status, "succeeded", job.error);
const ownerDir = workflow.directory(workflow.owner(user));
const result = path.join(ownerDir, "jobs", job.id, "final.mp4");
assert.ok((await stat(result)).size > 10000);
const timeline = JSON.parse(
  await readFile(path.join(ownerDir, "jobs", job.id, "timeline.json"), "utf8"),
);
assert.equal(timeline.segments.length, 4);
for (const segment of timeline.segments) {
  assert.ok(segment.duration > 0);
  assert.ok(
    Math.abs(
      segment.camera.sweep -
        Math.min(segment.duration * config.speed, config.maxSweep),
    ) < 0.001,
  );
  assert.ok(segment.captions.length > 0);
}
const frames = [];
for (const [index, seconds] of [
  0.3,
  timeline.segments[1].start + timeline.segments[1].duration * 0.8,
].entries()) {
  const file = `motion-${index}.raw`;
  await media.run(
    process.env.FFMPEG_PATH || "ffmpeg",
    [
      "-v",
      "error",
      "-y",
      "-ss",
      String(seconds),
      "-i",
      result,
      "-an",
      "-frames:v",
      "1",
      "-vf",
      "crop=iw:ih/2:0:ih/4,scale=72:64",
      "-pix_fmt",
      "gray",
      "-f",
      "rawvideo",
      file,
    ],
    output,
  );
  frames.push(await readFile(path.join(output, file)));
}
assert.equal(frames[0].length, 72 * 64);
const motionDifference =
  frames[0].reduce(
    (sum, value, index) => sum + Math.abs(value - frames[1][index]),
    0,
  ) / frames[0].length;
assert.ok(motionDifference > 2, "Rendered panorama did not visibly rotate");
await media.run(
  process.env.FFMPEG_PATH || "ffmpeg",
  [
    "-v",
    "error",
    "-y",
    "-i",
    result,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "24000",
    "-f",
    "f32le",
    "audio-check.raw",
  ],
  output,
);
const samples = await readFile(path.join(output, "audio-check.raw"));
let energy = 0;
for (let offset = 0; offset + 4 <= samples.length; offset += 4)
  energy += samples.readFloatLE(offset) ** 2;
const audioRMS = Math.sqrt(energy / (samples.length / 4));
assert.ok(audioRMS > 0.001, "Rendered narration is silent");
const cache = path.join(ownerDir, "cache");
const audio = [
  ...new Set(
    timeline.segments.flatMap((s) =>
      s.captions.map(
        (caption) =>
          `audio-${domain.audioKey({ text: caption.text }, config)}.wav`,
      ),
    ),
  ),
];
const mtimes = await Promise.all(
  audio.map(async (f) => [f, (await stat(path.join(cache, f))).mtimeMs]),
);
const changed = { ...config, speed: 8, direction: -1, aspectRatio: "16:9" };
draft = await workflow.handle(user, "save", {
  id: draft.id,
  revision: draft.revision,
  config: changed,
  segments: draft.segments,
});
const rerender = await workflow.handle(user, "start", {
  id: draft.id,
  revision: draft.revision,
});
await workflow.active.get(rerender.id).promise;
assert.equal(rerender.status, "succeeded", rerender.error);
for (const [file, mtime] of mtimes)
  assert.equal(
    (await stat(path.join(cache, file))).mtimeMs,
    mtime,
    "Motion-only edit synthesized audio again",
  );
assert.ok(Math.abs(rerender.duration - job.duration) < 0.001);
await writeFile(
  path.join(output, "result.json"),
  JSON.stringify(
    {
      firstVideo: result,
      motionDifference,
      audioRMS,
      secondVideo: path.join(ownerDir, "jobs", rerender.id, "final.mp4"),
      duration: job.duration,
      reusedAudioFiles: audio.length,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    video: result,
    duration: job.duration,
    reusedAudioFiles: audio.length,
  }),
);
