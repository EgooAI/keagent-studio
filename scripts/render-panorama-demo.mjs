import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const assetsDir = path.join(root, "apps/desktop/public/media/panoramas");
const output = path.join(root, "output/panorama-demo");
const manifest = JSON.parse(
  await readFile(path.join(assetsDir, "manifest.json"), "utf8"),
);
const fps = 25;
await mkdir(output, { recursive: true });

async function run(command, args) {
  return exec(command, args, {
    cwd: output,
    windowsHide: true,
    timeout: 180000,
    maxBuffer: 2 * 1024 * 1024,
  });
}
async function probe(file) {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-show_streams",
    "-show_format",
    "-of",
    "json",
    file,
  ]);
  return JSON.parse(stdout);
}
function assTime(seconds) {
  const value = Math.round(seconds * 100);
  return `${Math.floor(value / 360000)}:${String(Math.floor(value / 6000) % 60).padStart(2, "0")}:${String(Math.floor(value / 100) % 60).padStart(2, "0")}.${String(value % 100).padStart(2, "0")}`;
}
async function frame(file, seconds) {
  const { stdout } = await exec(
    "ffmpeg",
    [
      "-v",
      "error",
      "-ss",
      String(seconds),
      "-i",
      file,
      "-an",
      "-frames:v",
      "1",
      "-vf",
      "crop=720:650:0:250,scale=72:65",
      "-pix_fmt",
      "gray",
      "-f",
      "rawvideo",
      "-",
    ],
    {
      cwd: output,
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      encoding: "buffer",
    },
  );
  assert.equal(stdout.length, 72 * 65, "Could not decode a motion-check frame");
  return stdout;
}

const timeline = [];
for (const asset of manifest.assets) {
  assert.match(asset.id, /^[a-z0-9_]+$/);
  assert.match(asset.file, /^[a-z0-9_]+\.jpg$/);
  assert.ok(
    asset.narration.every(
      (text) =>
        typeof text === "string" && text.trim() && !/[{}\\\r\n]/.test(text),
    ),
  );
  const image = path.join(assetsDir, asset.file);
  assert.equal(
    createHash("md5")
      .update(await readFile(image))
      .digest("hex"),
    asset.md5,
    "Source asset checksum changed",
  );
  const imageInfo = (await probe(image)).streams[0];
  assert.equal(
    imageInfo.width,
    imageInfo.height * 2,
    "Expected an equirectangular panorama",
  );
  const captions = [];
  let duration = 0;
  for (const [index, text] of asset.narration.entries()) {
    const audio = `${asset.id}-${index}.wav`;
    const seconds = Number((await probe(audio)).format.duration);
    assert.ok(
      Number.isFinite(seconds) && seconds > 0,
      "Missing or empty narration; run synthesize-panorama-demo.ps1 first",
    );
    captions.push({ text, start: duration, end: duration + seconds, audio });
    duration += seconds;
  }
  const audioList = `${asset.id}-audio.ffconcat`;
  await writeFile(
    path.join(output, audioList),
    `ffconcat version 1.0\n${captions.map((caption) => `file '${caption.audio}'`).join("\n")}\n`,
  );
  await run("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "concat",
    "-safe",
    "1",
    "-i",
    audioList,
    "-c:a",
    "pcm_s16le",
    `${asset.id}.wav`,
  ]);
  const combinedAudioDuration = Number(
    (await probe(`${asset.id}.wav`)).format.duration,
  );
  assert.ok(Math.abs(combinedAudioDuration - duration) < 0.002);

  const frameCount = Math.ceil(duration * fps);
  const commands = Array.from({ length: frameCount - 1 }, (_, index) => {
    const frameIndex = index + 1;
    const yaw =
      asset.yawStart +
      ((asset.yawEnd - asset.yawStart) * frameIndex) / (frameCount - 1);
    return `${(frameIndex / fps).toFixed(6)} v360@camera yaw ${yaw.toFixed(6)};`;
  });
  await writeFile(
    path.join(output, `${asset.id}.commands`),
    `${commands.join("\n")}\n`,
  );
  const subtitles = `[Script Info]
ScriptType: v4.00+
PlayResX: 720
PlayResY: 1280
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Microsoft YaHei,34,&H00FFFFFF,&H00FFFFFF,&H00202020,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,44,44,110,1
Style: Label,Microsoft YaHei,25,&H00FFFFFF,&H00FFFFFF,&H00202020,&H80000000,0,0,0,0,100,100,0,0,1,2,1,8,35,35,65,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,${assTime(duration)},Label,,0,0,0,,${asset.name}\\N独立场景 · 非在售房源
${captions.map((caption) => `Dialogue: 0,${assTime(caption.start)},${assTime(caption.end)},Caption,,0,0,0,,${caption.text}`).join("\n")}
`;
  await writeFile(path.join(output, `${asset.id}.ass`), subtitles);
  const filter = `scale=4096:2048,loop=loop=-1:size=1:start=0,setpts=N/(${fps}*TB),sendcmd=f=${asset.id}.commands,v360@camera=input=e:output=flat:w=720:h=1280:h_fov=70:v_fov=103:yaw=${asset.yawStart}:reset_rot=1,setsar=1,ass=${asset.id}.ass`;
  console.log(
    `Rendering ${asset.id}: ${duration.toFixed(2)}s of narration drives ${frameCount} frames`,
  );
  await run("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-i",
    image,
    "-i",
    `${asset.id}.wav`,
    "-vf",
    filter,
    "-t",
    duration.toFixed(6),
    "-r",
    String(fps),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "21",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-ar",
    "44100",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    `${asset.id}.mp4`,
  ]);
  const info = await probe(`${asset.id}.mp4`);
  const video = info.streams.find((stream) => stream.codec_type === "video");
  const audio = info.streams.find((stream) => stream.codec_type === "audio");
  assert.equal(video.width, 720);
  assert.equal(video.height, 1280);
  assert.ok(audio, "The rendered scene is missing its narration");
  assert.ok(
    Math.abs(Number(video.duration) - duration) < 1 / fps + 0.01,
    "Video did not follow narration duration",
  );
  const first = await frame(`${asset.id}.mp4`, 0.2);
  const last = await frame(`${asset.id}.mp4`, duration - 0.2);
  const motionDifference =
    first.reduce(
      (sum, value, index) => sum + Math.abs(value - last[index]),
      0,
    ) / first.length;
  assert.ok(motionDifference > 5, "The panorama did not visibly rotate");
  await run("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-ss",
    String(duration / 2),
    "-i",
    `${asset.id}.mp4`,
    "-frames:v",
    "1",
    `${asset.id}-preview.jpg`,
  ]);
  timeline.push({
    id: asset.id,
    image: asset.file,
    audio: `${asset.id}.wav`,
    video: `${asset.id}.mp4`,
    duration,
    captions,
    motionDifference,
  });
}

await writeFile(
  path.join(output, "scenes.ffconcat"),
  `ffconcat version 1.0\n${timeline.map((scene) => `file '${scene.video}'`).join("\n")}\n`,
);
await run("ffmpeg", [
  "-v",
  "error",
  "-y",
  "-f",
  "concat",
  "-safe",
  "1",
  "-i",
  "scenes.ffconcat",
  "-c",
  "copy",
  "-movflags",
  "+faststart",
  "panorama-narrated-demo.mp4",
]);
const finalInfo = await probe("panorama-narrated-demo.mp4");
const expectedDuration = timeline.reduce(
  (sum, scene) => sum + scene.duration,
  0,
);
assert.ok(
  Math.abs(Number(finalInfo.format.duration) - expectedDuration) < 0.15,
  "Combined timeline duration drifted",
);
const volume = await run("ffmpeg", [
  "-hide_banner",
  "-nostats",
  "-i",
  "panorama-narrated-demo.mp4",
  "-vn",
  "-af",
  "volumedetect",
  "-f",
  "null",
  "-",
]);
assert.match(
  volume.stderr,
  /mean_volume: -?\d+(\.\d+)? dB/,
  "The final narration is silent",
);
await writeFile(
  path.join(output, "timeline.json"),
  JSON.stringify(
    {
      purpose: manifest.purpose,
      audioSource: "Windows system zh-CN TTS (development only)",
      cloudAiUsed: false,
      avatarIncluded: false,
      fps,
      expectedDuration,
      actualDuration: Number(finalInfo.format.duration),
      scenes: timeline,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    file: path.join(output, "panorama-narrated-demo.mp4"),
    duration: Number(finalInfo.format.duration),
    scenes: timeline.length,
    checks: [
      "source checksums",
      "audio-driven duration",
      "moving panorama frames",
      "scene captions",
      "audible narration",
      "combined timeline",
    ],
  }),
);
