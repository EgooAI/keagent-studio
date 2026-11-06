// Real FFmpeg regression with local test images and synthetic test audio.
// Does not call Beike, an AI image service, or a speech provider.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const media = require("../apps/desktop/electron/panorama/media.cjs");
const domain = require("../apps/desktop/electron/panorama/domain.cjs");
const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "output/production-source-verification");
await mkdir(output, { recursive: true });
const photo = path.join(
  root,
  "output/property-samples/beike-official-pic-verify/living-room-01.jpg",
);
const pano = path.join(root, "apps/desktop/public/media/panoramas/lebombo.jpg");
const results = [];
for (const [kind, input, aspectRatio] of [
  ["panorama", pano, "16:9"],
  ["expanded", photo, "16:9"],
  ["expanded", photo, "9:16"],
]) {
  const directory = path.join(
    output,
    `${kind}-${aspectRatio.replace(":", "x")}`,
  );
  const cache = path.join(directory, "cache");
  const jobDir = path.join(directory, "job");
  await Promise.all([
    mkdir(cache, { recursive: true }),
    mkdir(jobDir, { recursive: true }),
    mkdir(path.join(directory, "assets"), { recursive: true }),
  ]);
  const bytes = await readFile(input);
  const asset = `${domain.hash(bytes)}.jpg`;
  await copyFile(input, path.join(directory, "assets", asset));
  const audio = [];
  for (const [index, duration] of [0.6, 1.4, 0.6].entries()) {
    const file = `fixture-${index}.wav`;
    await media.run(
      process.env.FFMPEG_PATH || "ffmpeg",
      [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=440:duration=${duration}`,
        "-ar",
        "24000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        file,
      ],
      cache,
    );
    audio.push({
      id: `s${index}`,
      sceneId: "scene",
      kind: ["opening", "scene", "closing"][index],
      text: "渲染测试",
      audio: file,
      duration,
      captions: [{ text: "渲染测试", start: 0, end: duration }],
    });
  }
  const job = {
    sample: true,
    property: {
      title: "标准带看模板回归",
      areaSqm: 0,
      priceCents: 0,
      layout: "",
    },
    scenes: [
      {
        id: "scene",
        kind,
        asset,
        room: "受控测试素材",
        yaw: 0,
        approved: true,
      },
    ],
    config: { ...domain.defaultConfig, aspectRatio, subtitles: false },
  };
  const result = await media.render(
    job,
    audio,
    directory,
    jobDir,
    new AbortController().signal,
    () => {},
  );
  const info = await media.probe(path.join(jobDir, "final.mp4"), jobDir);
  const stream = info.streams.find((s) => s.codec_type === "video");
  assert.equal(stream.width, aspectRatio === "16:9" ? 1280 : 720);
  assert.equal(stream.height, aspectRatio === "16:9" ? 720 : 1280);
  assert.ok(info.streams.some((s) => s.codec_type === "audio"));
  assert.ok(Math.abs(Number(info.format.duration) - 2.6) < 0.15);
  const cover = await media.probe(path.join(jobDir, "cover.jpg"), jobDir);
  assert.equal(cover.streams[0].width, stream.width);
  assert.equal(cover.streams[0].height, stream.height);
  const coverASS = await readFile(path.join(jobDir, "cover.ass"), "utf8");
  assert.ok(coverASS.includes("标准带看模板回归"));
  assert.ok(coverASS.includes("Style: Accent"));
  const frames = [];
  for (const [index, time] of [0.75, 1.85].entries()) {
    const name = `frame-${index}.raw`;
    await media.run(
      process.env.FFMPEG_PATH || "ffmpeg",
      [
        "-v",
        "error",
        "-y",
        "-ss",
        String(time),
        "-i",
        path.join(jobDir, "final.mp4"),
        "-frames:v",
        "1",
        "-vf",
        "scale=96:96",
        "-pix_fmt",
        "gray",
        "-f",
        "rawvideo",
        name,
      ],
      directory,
    );
    frames.push(await readFile(path.join(directory, name)));
  }
  const difference =
    frames[0].reduce(
      (sum, value, i) => sum + Math.abs(value - frames[1][i]),
      0,
    ) / frames[0].length;
  assert.ok(difference > 0.5, "Camera did not visibly move");
  if (kind === "expanded") {
    const captionFiles = (await readdir(cache)).filter((file) =>
      file.endsWith(".ass"),
    );
    assert.ok(
      (await readFile(path.join(cache, captionFiles[0]), "utf8")).includes(
        "AI扩图示意",
      ),
    );
    assert.ok(result.timeline.every((segment) => segment.camera === null));
  }
  await media.run(
    process.env.FFMPEG_PATH || "ffmpeg",
    [
      "-v",
      "error",
      "-y",
      "-ss",
      "1",
      "-i",
      path.join(jobDir, "final.mp4"),
      "-frames:v",
      "1",
      path.join(directory, "preview.png"),
    ],
    directory,
  );
  results.push({
    kind,
    aspectRatio,
    difference,
    video: path.join(jobDir, "final.mp4"),
    duration: result.duration,
  });
}
await writeFile(
  path.join(output, "result.json"),
  JSON.stringify(
    {
      note: "受控渲染验证。expanded 使用普通照片充当供应商输出夹具，不代表已调用或验证真实扩图质量。",
      results,
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify(results, null, 2));
