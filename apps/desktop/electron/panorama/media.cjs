const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { ensure, hash, sentences, motion, audioKey } = require("./domain.cjs");
const presentation = require("../production/presentation.cjs");
const ffmpeg = () => process.env.FFMPEG_PATH || "ffmpeg";
const ffprobe = () => process.env.FFPROBE_PATH || "ffprobe";
function run(command, args, cwd, signal, onTime, encoding = "utf8") {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        cwd,
        signal,
        encoding,
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
async function scriptImage(file, cwd, signal) {
  const jpeg = await run(
    ffmpeg(),
    [
      "-v",
      "error",
      "-i",
      file,
      "-frames:v",
      "1",
      "-vf",
      "scale=1280:1280:force_original_aspect_ratio=decrease",
      "-c:v",
      "mjpeg",
      "-q:v",
      "8",
      "-f",
      "image2pipe",
      "pipe:1",
    ],
    cwd,
    signal,
    undefined,
    "buffer",
  );
  ensure(
    jpeg.length > 0 && jpeg.length <= 512 * 1024,
    "房源原图无法压缩到文案服务允许的大小",
  );
  return jpeg.toString("base64");
}
async function probe(file, cwd, signal, format) {
  return JSON.parse(
    await run(
      ffprobe(),
      [
        "-v",
        "error",
        ...(format ? ["-f", format] : []),
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        file,
      ],
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
function openingDuration(info) {
  const video = info?.streams?.find(
    (stream) =>
      stream.codec_type === "video" && !stream.disposition?.attached_pic,
  );
  if (!video) return NaN;
  return Number(video.duration) || Number(info.format?.duration);
}
async function openingAudio(file, id, cwd, signal) {
  const info = await probe(file, cwd, signal, "mov");
  const duration = openingDuration(info);
  ensure(duration >= 2 && duration <= 30, "本机开场视频的画面或时长无效");
  const audio = `opening-${id}.wav`;
  const target = path.join(cwd, audio);
  if (!(await exists(target))) {
    const temp = target + ".part.wav";
    const hasAudio = info.streams.some(
      (stream) => stream.codec_type === "audio",
    );
    try {
      await run(
        ffmpeg(),
        [
          "-v",
          "error",
          "-y",
          ...(hasAudio
            ? ["-f", "mov", "-i", file]
            : ["-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono"]),
          "-map",
          "0:a:0",
          "-af",
          "aresample=24000:async=1:first_pts=0,apad",
          "-ac",
          "1",
          "-c:a",
          "pcm_s16le",
          "-t",
          String(duration),
          temp,
        ],
        cwd,
        signal,
      );
      signal.throwIfAborted();
      await fs.rename(temp, target);
    } finally {
      await fs.rm(temp, { force: true });
    }
  }
  return { duration, audio };
}
async function synthesize(segment, c, cwd, signal, remote, billingContext) {
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
          "当前系统不支持 Windows 配音，请选择百炼配音",
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
            ...(billingContext ? { billingContext } : {}),
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

async function shortTourCaptions(narration, cwd, signal) {
  const captions = presentation.shortCaptions(narration.captions);
  if (captions.length === narration.captions.length) return captions;

  try {
    const metadata = await run(
      ffmpeg(),
      [
        "-v",
        "error",
        "-i",
        narration.audio,
        "-af",
        "silencedetect=n=-35dB:d=0.08,ametadata=mode=print:file=-",
        "-f",
        "null",
        "-",
      ],
      cwd,
      signal,
    );
    const pauses = [];
    let start;
    for (const [, mark, value] of metadata.matchAll(
      /lavfi\.silence_(start|end)=([\d.]+)/g,
    )) {
      if (mark === "start") start = Number(value);
      else if (start !== undefined) {
        pauses.push({ start, end: Number(value) });
        start = undefined;
      }
    }
    return presentation.shortCaptions(narration.captions, pauses);
  } catch {
    signal?.throwIfAborted();
    // The existing audio timing is still usable if pause detection is unavailable.
    return captions;
  }
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
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Caption,${presentation.subtitleFont},${size},&H00FFFFFF,&H00FFFFFF,&H00202020,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,40,40,${Math.round(height * 0.08)},1\nStyle: Label,${presentation.subtitleFont},${Math.round(size * 0.8)},&H00FFFFFF,&H00FFFFFF,&H00202020,&H80000000,0,0,0,0,100,100,0,0,1,2,1,8,35,35,45,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,${assTime(segment.duration)},Label,,0,0,0,,${escapeASS(label)}\n${segment.captions.map((s) => `Dialogue: 0,${assTime(s.start + offset)},${assTime(s.end + offset)},Caption,,0,0,0,,${escapeASS(s.text)}`).join("\n")}\n`;
}
function shortTourCameras(scenes, audio, config, hasOpeningVideo) {
  const cameras = [];
  const yaw = new Map();
  const isVideo = (segment) => hasOpeningVideo && segment.kind === "opening";
  for (let index = 0; index < audio.length;) {
    if (isVideo(audio[index])) {
      cameras.push(null);
      index++;
      continue;
    }
    const scene = scenes.find((s) => s.id === audio[index].sceneId);
    ensure(scene, "素材与文案关联丢失");
    let end = index + 1;
    let duration = audio[index].duration;
    while (
      end < audio.length &&
      audio[end].sceneId === scene.id &&
      !isVideo(audio[end])
    ) {
      duration += audio[end].duration;
      end++;
    }
    // A room and its closing narration share one continuous, evenly paced turn.
    const speed = Math.min(config.speed, config.maxSweep / duration);
    for (; index < end; index++) {
      const camera = motion(
        yaw.get(scene.id) ?? scene.yaw,
        audio[index].duration,
        {
          ...config,
          speed,
          direction: scene.direction || config.direction,
        },
      );
      cameras.push(camera);
      yaw.set(scene.id, camera.end);
    }
  }
  return cameras;
}
const wrapYaw = (angle) => ((((angle + 180) % 360) + 360) % 360) - 180;
function cameraCommands(camera, frames, fps, speed) {
  return (
    Array.from({ length: Math.max(1, frames - 1) }, (_, i) => {
      const t = (i + 1) / fps;
      // FFmpeg rejects out-of-range yaw commands, even during a continuous turn.
      const angle = wrapYaw(
        camera.start +
          Math.min(t * speed, Math.abs(camera.sweep)) * Math.sign(camera.sweep),
      );
      return `${t.toFixed(6)} v360@camera yaw ${angle.toFixed(6)};`;
    }).join("\n") + "\n"
  );
}
function spatialRuns(job, audio, hasOpeningVideo) {
  const fps = job.config.design === "short-tour" ? 30 : 25;
  const runs = [];
  let elapsed = 0;
  let frame = 0;
  let current;
  for (const [index, segment] of audio.entries()) {
    const nextFrame = Math.round((elapsed + segment.duration) * fps);
    const frames = Math.max(1, nextFrame - frame);
    if (hasOpeningVideo && segment.kind === "opening") current = undefined;
    else {
      const scene = job.scenes.find((s) => s.id === segment.sceneId);
      ensure(scene?.spatial, "镜头缺少 VR 空间与拍摄点信息");
      if (!current || current.scene.id !== scene.id) {
        current = { scene, frames: 0, fps, duration: 0, segments: [] };
        runs.push(current);
      }
      current.segments.push({ index, offsetFrames: current.frames, frames });
      current.frames += frames;
      current.duration += segment.duration;
    }
    frame = nextFrame;
    elapsed += segment.duration;
  }
  return runs;
}
function fieldOfView(width, height, shortTour) {
  const hFov = width < height ? (shortTour ? 84 : 70) : 100;
  const vFov =
    shortTour && width < height
      ? (2 *
          Math.atan((Math.tan((hFov * Math.PI) / 360) * height) / width) *
          180) /
        Math.PI
      : width < height
        ? 103
        : 62;
  return { hFov, vFov };
}
function coverProjection(width, height, hFov, vFov, yaw) {
  return `v360=input=e:output=flat:w=${width}:h=${height}:h_fov=${hFov}:v_fov=${vFov}:yaw=${yaw}`;
}
async function previewCoverImage(ownerDir, scene, portrait, shortTour) {
  const [w, h] = portrait ? [360, 640] : [640, 360];
  const { hFov, vFov } = fieldOfView(w, h, shortTour);
  const jpeg = await run(
    ffmpeg(),
    [
      "-v",
      "error",
      "-i",
      path.join(ownerDir, "assets", scene.asset),
      "-vf",
      coverProjection(w, h, hFov, vFov, scene.yaw),
      "-frames:v",
      "1",
      "-f",
      "image2pipe",
      "-c:v",
      "mjpeg",
      "pipe:1",
    ],
    ownerDir,
    undefined,
    undefined,
    "buffer",
  );
  return "data:image/jpeg;base64," + jpeg.toString("base64");
}
async function render(
  job,
  audio,
  ownerDir,
  jobDir,
  signal,
  onProgress,
  spatialClips,
  musicFile,
) {
  const c = job.config;
  const spatial = c.cameraMode === "spatial";
  const shortTour = c.design === "short-tour";
  const fps = shortTour ? 30 : 25;
  const [width, height] =
    c.aspectRatio === "9:16"
      ? c.resolution === "720p"
        ? [720, 1280]
        : [1080, 1920]
      : c.resolution === "720p"
        ? [1280, 720]
        : [1920, 1080];
  const { hFov, vFov } = fieldOfView(width, height, shortTour);
  const cameras =
    shortTour && !spatial
      ? shortTourCameras(
          job.scenes,
          audio,
          c,
          Boolean(c.openingVideo || c.openingClip),
        )
      : null;
  const cache = path.join(ownerDir, "cache");
  const clips = [];
  const timeline = [];
  const yaw = new Map();
  let elapsed = 0;
  let frame = 0;
  for (const [index, narration] of audio.entries()) {
    const uploadedOpening = narration.kind === "opening" && c.openingVideo;
    const segment =
      !uploadedOpening && shortTour && c.subtitles
        ? {
            ...narration,
            captions: await shortTourCaptions(narration, cache, signal),
          }
        : narration;
    const scene = job.scenes.find((s) => s.id === segment.sceneId);
    ensure(scene, "素材与文案关联丢失");
    const direction = scene.direction || c.direction;
    ensure(
      !scene.kind || scene.kind === "panorama",
      "视频制作仅支持原始 VR 全景图",
    );
    const nextFrame = Math.round((elapsed + segment.duration) * fps);
    const frames = Math.max(1, nextFrame - frame);
    const camera = spatial
      ? null
      : shortTour
        ? cameras[index]
        : motion(yaw.get(scene.id) ?? scene.yaw, segment.duration, {
            ...c,
            direction,
          });
    // Wrap the start angle for FFmpeg while preserving continuous turns across segments.
    const start = wrapYaw(camera?.start ?? scene.yaw);
    const localOpening =
      uploadedOpening || (segment.kind === "opening" && c.openingClip);
    const openingVideo =
      localOpening && path.join(ownerDir, "opening", `${localOpening}.mp4`);
    const spatialClip =
      !openingVideo && spatial ? spatialClips?.[index] : undefined;
    ensure(
      !spatial || openingVideo || spatialClip,
      "空间走动镜头未完成，无法合成",
    );
    if (!openingVideo && camera) yaw.set(scene.id, camera.end);
    const label = shortTour
      ? job.sample
        ? "独立测试场景，非在售房源"
        : ""
      : `${scene.room}${job.sample ? " · 独立测试场景，非在售房源" : ""}`;
    const key = hash([
      shortTour ? "render-v4-short-tour-30fps" : "render-v5-panorama",
      scene.kind || "panorama",
      scene.asset,
      segment,
      start,
      c.speed,
      direction,
      c.maxSweep,
      width,
      height,
      c.subtitles,
      label,
      localOpening || null,
      ...(uploadedOpening ? ["uploaded-opening"] : []),
      presentation.card(job, segment.kind),
      ...(shortTour ? [camera, hFov, vFov] : []),
      ...(spatialClip
        ? [
            "spatial-v1",
            path.basename(spatialClip.file),
            spatialClip.offsetFrames,
            frames,
          ]
        : []),
    ]);
    const name = `clip-${key}.mp4`;
    if (!(await exists(path.join(cache, name)))) {
      const cmd = `camera-${key}.commands`;
      const ass = `caption-${key}.ass`;
      await fs.writeFile(
        path.join(cache, cmd),
        camera
          ? cameraCommands(
              camera,
              frames,
              fps,
              shortTour ? Math.abs(camera.sweep) / camera.duration : c.speed,
            )
          : "",
      );
      await fs.writeFile(
        path.join(cache, ass),
        presentation.decorate(
          subtitles(
            c.subtitles ? segment : { ...segment, captions: [] },
            width,
            height,
            label,
            elapsed - frame / fps,
          ),
          segment,
          width,
          height,
          presentation.card(job, segment.kind),
        ),
      );
      const base = spatialClip
        ? `trim=start_frame=${spatialClip.offsetFrames}:end_frame=${spatialClip.offsetFrames + frames},setpts=PTS-STARTPTS,scale=${width}:${height},setsar=1`
        : openingVideo
          ? `scale=${width}:${height}:force_original_aspect_ratio=${shortTour && !uploadedOpening ? `increase,crop=${width}:${height}` : `decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`},setsar=1,tpad=stop_mode=clone:stop=-1`
          : `scale=4096:2048,loop=loop=-1:size=1:start=0,${shortTour ? "settb=AVTB," : ""}setpts=N/(${fps}*TB),sendcmd=f=${cmd},v360@camera=input=e:output=flat:w=${width}:h=${height}:h_fov=${hFov}:v_fov=${vFov}:yaw=${start}:reset_rot=1,setsar=1`;
      const temp = `clip-${key}.part.mp4`;
      await run(
        ffmpeg(),
        [
          "-v",
          "error",
          "-y",
          ...(localOpening ? ["-f", "mov"] : []),
          "-i",
          openingVideo ||
            spatialClip?.file ||
            path.join(ownerDir, "assets", scene.asset),
          ...(localOpening ? ["-map", "0:V:0"] : []),
          "-vf",
          base +
            (!uploadedOpening &&
            (c.subtitles || job.sample || c.design === "standard" || shortTour)
              ? `,ass=${ass}`
              : ""),
          "-an",
          "-frames:v",
          String(frames),
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
      camera: openingVideo ? null : camera,
      ...(spatialClip
        ? {
            spatial: {
              ...spatialClip.spatial,
              offsetFrames: spatialClip.offsetFrames,
              frames,
            },
          }
        : {}),
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
  ensure(!c.backgroundMusic || musicFile, "本机背景音乐不可用");
  const musicOffset =
    (c.openingVideo || c.openingClip) && audio[0]?.kind === "opening"
      ? audio[0].duration
      : 0;
  const musicDuration = elapsed - musicOffset;
  const mixMusic = !!musicFile && musicDuration > 0;
  const fade = Math.min(0.4, musicDuration / 2);
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
      ...(mixMusic
        ? [
            "-stream_loop",
            "-1",
            "-i",
            musicFile,
            "-filter_complex",
            [
              `[2:a:0]aformat=sample_rates=48000:channel_layouts=stereo,atrim=duration=${musicDuration}`,
              `afade=t=in:d=${fade},afade=t=out:st=${musicDuration - fade}:d=${fade}`,
              `volume=${c.backgroundMusic.volume / 100},adelay=${Math.round(musicOffset * 1000)}:all=1[music]`,
            ].join(",") +
              ";[1:a:0]aformat=sample_rates=48000:channel_layouts=stereo[voice];" +
              "[voice][music]amix=inputs=2:duration=first:normalize=0,alimiter=limit=1:level=0:latency=1[final_audio]",
          ]
        : []),
      "-map",
      "0:v:0",
      "-map",
      mixMusic ? "[final_audio]" : "1:a:0",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-ar",
      mixMusic ? "48000" : "24000",
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
  const cover = job.templateSnapshot?.cover;
  if (
    cover ? cover.imageSource !== "frame" : c.design === "standard" || shortTour
  ) {
    const scene = cover
      ? cover.imageSource === "last"
        ? job.scenes.at(-1)
        : job.scenes[0]
      : job.scenes.find((s) => s.id === (c.coverSceneId || c.leadSceneId)) ||
        job.scenes[0];
    const caption = "cover.ass";
    const label = job.sample ? "独立测试场景，非在售房源" : "";
    await fs.writeFile(
      path.join(jobDir, caption),
      presentation.decorate(
        subtitles({ duration: 1, captions: [] }, width, height, label, 0),
        null,
        width,
        height,
        presentation.card(job, "cover"),
      ),
    );
    const spatialCover =
      spatialClips?.[
        audio.findIndex(
          (segment) =>
            segment.sceneId === scene.id && segment.kind !== "opening",
        )
      ];
    const base = spatialCover
      ? `select=eq(n\\,0),scale=${width}:${height},setsar=1`
      : coverProjection(width, height, hFov, vFov, scene.yaw);
    await run(
      ffmpeg(),
      [
        "-v",
        "error",
        "-y",
        "-i",
        spatialCover?.file || path.join(ownerDir, "assets", scene.asset),
        "-vf",
        `${base},ass=${caption}`,
        "-frames:v",
        "1",
        "cover.jpg",
      ],
      jobDir,
      signal,
    );
  } else
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
  previewCoverImage,
  run,
  scriptImage,
  probe,
  duration,
  capabilities,
  synthesize,
  openingDuration,
  openingAudio,
  render,
  shortTourCameras,
  cameraCommands,
  spatialRuns,
  exists,
  subtitles,
  escapeASS,
};
