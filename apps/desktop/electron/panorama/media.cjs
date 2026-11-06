const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { ensure, hash, sentences, motion, audioKey } = require("./domain.cjs");
const ffmpeg = () => process.env.FFMPEG_PATH || "ffmpeg";
const ffprobe = () => process.env.FFPROBE_PATH || "ffprobe";
function run(command, args, cwd, signal, onTime) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        cwd,
        signal,
        windowsHide: true,
        timeout: 30 * 60 * 1000,
        maxBuffer: 2 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error)
          reject(
            new Error(
              signal?.aborted
                ? "任务已取消"
                : `${path.basename(command)} 执行失败（${error.code || "error"}）；请检查运行时和素材`,
            ),
          );
        else resolve(stdout);
      },
    );
    if (onTime) {
      let pending = "";
      child.stdout.on("data", (chunk) => {
        pending += chunk;
        const lines = pending.split("\n");
        pending = lines.pop();
        for (const line of lines)
          if (line.startsWith("out_time_us=") && !signal?.aborted) {
            try {
              onTime(Number(line.slice(12)) / 1000000);
            } catch (error) {
              child.kill();
              reject(error);
            }
          }
      });
    }
  });
}
async function probe(file, cwd, signal) {
  return JSON.parse(
    await run(
      ffprobe(),
      ["-v", "error", "-show_streams", "-show_format", "-of", "json", file],
      cwd,
      signal,
    ),
  );
}
async function duration(file, cwd, signal) {
  const info = await probe(file, cwd, signal);
  const value = Number(info.format.duration);
  ensure(
    info.streams.some((s) => s.codec_type === "audio") &&
      value > 0 &&
      value <= 600,
    "配音为空或超过10分钟",
  );
  return value;
}
async function speech(input, cwd, signal) {
  const file = path.join(cwd, `speech-${hash(input)}.json`);
  await fs.writeFile(file, JSON.stringify(input));
  try {
    return await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        path.join(__dirname, "speech.ps1"),
        "-InputPath",
        file,
      ],
      cwd,
      signal,
    );
  } finally {
    await fs.unlink(file).catch(() => {});
  }
}
async function capabilities(cwd) {
  await fs.mkdir(cwd, { recursive: true });
  const checks = await Promise.allSettled([
    run(ffmpeg(), ["-version"], cwd),
    run(ffprobe(), ["-version"], cwd),
    process.platform === "win32"
      ? speech({ list: true }, cwd)
      : Promise.resolve("[]"),
  ]);
  return {
    ffmpeg: checks[0].status === "fulfilled",
    ffprobe: checks[1].status === "fulfilled",
    voices:
      checks[2].status === "fulfilled"
        ? JSON.parse(checks[2].value.replace(/^\uFEFF/, ""))
        : [],
  };
}
async function exists(file) {
  return fs
    .stat(file)
    .then((s) => s.size > 44)
    .catch(() => false);
}
async function concatAudio(files, output, cwd, signal) {
  const list = `${path.basename(output)}.ffconcat`;
  ensure(
    files.every((f) => /^[a-z0-9-]+\.wav$/.test(f)),
    "音频缓存文件名无效",
  );
  await fs.writeFile(
    path.join(cwd, list),
    files.map((f) => `file '${f}'`).join("\n"),
  );
  await run(
    ffmpeg(),
    [
      "-v",
      "error",
      "-y",
      "-f",
      "concat",
      "-safe",
      "1",
      "-i",
      list,
      "-c:a",
      "pcm_s16le",
      "-ar",
      "24000",
      "-ac",
      "1",
      output,
    ],
    cwd,
    signal,
  );
}
async function synthesize(segment, c, cwd, signal, remote) {
  const key = audioKey(segment, c);
  const parts = sentences(segment.text);
  ensure(parts.length, "文案没有可朗读的内容");
  const captions = [];
  let seconds = 0;
  for (const part of parts) {
    const name = `audio-${audioKey({ text: part }, c)}.wav`;
    const file = path.join(cwd, name);
    if (!(await exists(file))) {
      const temp = file + ".part.wav";
      if (c.ttsProvider === "system") {
        ensure(
          process.platform === "win32",
          "当前系统不支持 Windows 配音，请选择火山 TTS",
        );
        await speech(
          {
            text: part,
            voice: c.voice,
            rate: Math.round(Math.log2(c.rate) * 5),
            output: temp,
          },
          cwd,
          signal,
        );
      } else {
        const pcm = file + ".pcm";
        ensure(remote, "未连接云端配音服务");
        const response = await remote(
          "tts",
          {
            text: part,
            voice: c.voice,
            rate: c.rate,
            language: c.language,
            kind: c.ttsProvider === "personal" ? "personal" : "builtin",
          },
          signal,
        );
        ensure(
          typeof response.pcm === "string" &&
            response.pcm.length > 0 &&
            response.pcm.length < 16000000,
          "云端返回无效音频",
        );
        await fs.writeFile(pcm, Buffer.from(response.pcm, "base64"));
        await run(
          ffmpeg(),
          [
            "-v",
            "error",
            "-y",
            "-f",
            "s16le",
            "-ar",
            "24000",
            "-ac",
            "1",
            "-i",
            pcm,
            temp,
          ],
          cwd,
          signal,
        );
        await fs.unlink(pcm);
      }
      await duration(temp, cwd, signal);
      signal.throwIfAborted();
      await fs.rename(temp, file);
    }
    const length = await duration(file, cwd, signal);
    captions.push({
      text: part,
      start: seconds,
      end: seconds + length,
      file: name,
    });
    seconds += length;
  }
  const audio = `segment-${key}.wav`;
  if (!(await exists(path.join(cwd, audio))))
    await concatAudio(
      captions.map((s) => s.file),
      audio,
      cwd,
      signal,
    );
  return { ...segment, audio, audioKey: key, duration: seconds, captions };
}
function assTime(seconds) {
  const n = Math.max(0, Math.round(seconds * 100));
  return `${Math.floor(n / 360000)}:${String(Math.floor(n / 6000) % 60).padStart(2, "0")}:${String(Math.floor(n / 100) % 60).padStart(2, "0")}.${String(n % 100).padStart(2, "0")}`;
}
const escapeASS = (value) =>
  value
    .replaceAll("\\", "＼")
    .replaceAll("{", "｛")
    .replaceAll("}", "｝")
    .replace(/\r?\n/g, "\\N");
function subtitles(segment, width, height, label, offset) {
  const size = Math.round(width / (width < height ? 22 : 38));
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Caption,Microsoft YaHei,${size},&H00FFFFFF,&H00FFFFFF,&H00202020,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,40,40,${Math.round(height * 0.08)},1\nStyle: Label,Microsoft YaHei,${Math.round(size * 0.8)},&H00FFFFFF,&H00FFFFFF,&H00202020,&H80000000,0,0,0,0,100,100,0,0,1,2,1,8,35,35,45,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,${assTime(segment.duration)},Label,,0,0,0,,${escapeASS(label)}\n${segment.captions.map((s) => `Dialogue: 0,${assTime(s.start + offset)},${assTime(s.end + offset)},Caption,,0,0,0,,${escapeASS(s.text)}`).join("\n")}\n`;
}
async function render(
  job,
  audio,
  ownerDir,
  jobDir,
  signal,
  onProgress,
  avatarFile,
) {
  const c = job.config;
  const [width, height] =
    c.aspectRatio === "9:16"
      ? c.resolution === "720p"
        ? [720, 1280]
        : [1080, 1920]
      : c.resolution === "720p"
        ? [1280, 720]
        : [1920, 1080];
  const cache = path.join(ownerDir, "cache");
  const clips = [];
  const timeline = [];
  const yaw = new Map();
  let elapsed = 0;
  let frame = 0;
  for (const [index, segment] of audio.entries()) {
    const scene = job.scenes.find((s) => s.id === segment.sceneId);
    ensure(scene, "全景图与文案关联丢失");
    const nextFrame = Math.round((elapsed + segment.duration) * 25);
    const frames = Math.max(1, nextFrame - frame);
    const camera = motion(yaw.get(scene.id) ?? scene.yaw, segment.duration, c);
    yaw.set(scene.id, camera.end);
    // Wrap the start angle for FFmpeg while preserving continuous turns across segments.
    const start = ((((camera.start + 180) % 360) + 360) % 360) - 180;
    const avatar = segment.kind === "opening" && c.videoMode === "avatar";
    const label = `${scene.room}${job.sample ? " · 独立测试场景，非在售房源" : ""}`;
    const key = hash([
      "render-v1",
      scene.asset,
      segment,
      start,
      c.speed,
      c.direction,
      c.maxSweep,
      width,
      height,
      c.subtitles,
      label,
      avatar ? job.avatar?.taskId : null,
    ]);
    const name = `clip-${key}.mp4`;
    if (!(await exists(path.join(cache, name)))) {
      const cmd = `camera-${key}.commands`;
      const ass = `caption-${key}.ass`;
      await fs.writeFile(
        path.join(cache, cmd),
        Array.from({ length: Math.max(1, frames - 1) }, (_, i) => {
          const t = (i + 1) / 25;
          const angle = start + Math.min(t * c.speed, c.maxSweep) * c.direction;
          return `${t.toFixed(6)} v360@camera yaw ${angle.toFixed(6)};`;
        }).join("\n") + "\n",
      );
      await fs.writeFile(
        path.join(cache, ass),
        subtitles(segment, width, height, label, elapsed - frame / 25),
      );
      const base = avatar
        ? `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,tpad=stop_mode=clone:stop_duration=5`
        : `scale=4096:2048,loop=loop=-1:size=1:start=0,setpts=N/(25*TB),sendcmd=f=${cmd},v360@camera=input=e:output=flat:w=${width}:h=${height}:h_fov=${width < height ? 70 : 100}:v_fov=${width < height ? 103 : 62}:yaw=${start}:reset_rot=1,setsar=1`;
      const temp = `clip-${key}.part.mp4`;
      await run(
        ffmpeg(),
        [
          "-v",
          "error",
          "-y",
          "-i",
          avatar ? avatarFile : path.join(ownerDir, "assets", scene.asset),
          "-vf",
          base + (c.subtitles ? `,ass=${ass}` : ""),
          "-an",
          "-frames:v",
          String(frames),
          "-r",
          "25",
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "21",
          "-pix_fmt",
          "yuv420p",
          "-progress",
          "pipe:1",
          temp,
        ],
        cache,
        signal,
        (time) => onProgress(index, Math.min(time / segment.duration, 1)),
      );
      signal.throwIfAborted();
      await fs.rename(path.join(cache, temp), path.join(cache, name));
    }
    clips.push(name);
    timeline.push({
      id: segment.id,
      sceneId: scene.id,
      start: elapsed,
      duration: segment.duration,
      audio: segment.audio,
      camera: avatar ? null : camera,
      captions: segment.captions.map(({ text, start, end }) => ({
        text,
        start: elapsed + start,
        end: elapsed + end,
      })),
    });
    elapsed += segment.duration;
    frame = nextFrame;
    onProgress(index + 1, 0);
  }
  await concatAudio(
    audio.map((s) => s.audio),
    path.join(jobDir, "narration.wav"),
    cache,
    signal,
  );
  const list = path.join(jobDir, "clips.ffconcat");
  await fs.writeFile(
    list,
    clips
      .map(
        (name) =>
          `file '${path.join(cache, name).replaceAll("\\", "/").replaceAll("'", "'\\''")}'`,
      )
      .join("\n"),
  );
  await run(
    ffmpeg(),
    [
      "-v",
      "error",
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      list,
      "-i",
      path.join(jobDir, "narration.wav"),
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-ar",
      "24000",
      "-b:a",
      "128k",
      "-t",
      String(elapsed),
      "-movflags",
      "+faststart",
      "final.part.mp4",
    ],
    jobDir,
    signal,
  );
  const info = await probe("final.part.mp4", jobDir, signal);
  ensure(
    info.streams.some((s) => s.codec_type === "audio") &&
      info.streams.some(
        (s) =>
          s.codec_type === "video" && s.width === width && s.height === height,
      ) &&
      Math.abs(Number(info.format.duration) - elapsed) < 0.15,
    "成片音画或时长校验失败",
  );
  await fs.rename(
    path.join(jobDir, "final.part.mp4"),
    path.join(jobDir, "final.mp4"),
  );
  await run(
    ffmpeg(),
    [
      "-v",
      "error",
      "-y",
      "-ss",
      String(Math.min(1, elapsed / 2)),
      "-i",
      "final.mp4",
      "-frames:v",
      "1",
      "cover.jpg",
    ],
    jobDir,
    signal,
  );
  await fs.writeFile(
    path.join(jobDir, "timeline.json"),
    JSON.stringify(
      { duration: elapsed, width, height, segments: timeline },
      null,
      2,
    ),
  );
  return { duration: elapsed, timeline };
}
module.exports = {
  run,
  probe,
  duration,
  capabilities,
  synthesize,
  render,
  exists,
  subtitles,
  escapeASS,
};
