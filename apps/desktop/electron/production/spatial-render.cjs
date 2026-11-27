const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const { ensure, hash } = require("../panorama/domain.cjs");
const media = require("../panorama/media.cjs");
const {
  maxSpatialAssetBytes,
  maxSpatialAssets,
  maxSpatialBytes,
  validateSpatialScene,
  sourceURL,
} = require("./spatial-source.cjs");
const { prepareViewer, captureFrame } = require("./spatial-viewer.cjs");

// Capture the original public viewer; no vendor SDK or signed Work is modified or bundled.
const workIdPattern = /^[a-f0-9]{64}$/;
const filePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,159}$/;
const vector = (value) =>
  Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
const distance = (a, b) => Math.hypot(...a.map((n, index) => n - b[index]));

async function readSpatialAsset(file, { bytes, sha256 }) {
  ensure(
    (await fs.stat(file)).size === bytes,
    "空间原始素材已变更，请重新导入 VR 链接",
  );
  const content = await fs.readFile(file);
  ensure(
    content.length === bytes && hash(content) === sha256,
    "空间原始素材已变更，请重新导入 VR 链接",
  );
  return content;
}

async function verifyWorks(runs, ownerDir) {
  const works = new Map();
  const spatialRoot = path.resolve(ownerDir, "spatial");
  for (const run of runs) {
    const scene = run.scene || run;
    validateSpatialScene(ownerDir, scene);
    const spatial = scene.spatial;
    ensure(
      spatial && workIdPattern.test(spatial.workId),
      "缺少真实空间点位，请重新导入 VR 链接",
    );
    let saved = works.get(spatial.workId);
    if (!saved) {
      const directory = path.join(spatialRoot, spatial.workId);
      const canonicalDirectory = await fs.realpath(directory);
      ensure(
        canonicalDirectory.startsWith(
          (await fs.realpath(spatialRoot)) + path.sep,
        ),
        "空间素材目录无效",
      );
      const bytes = await fs.readFile(path.join(directory, "work.json"));
      ensure(
        hash(bytes) === spatial.workId,
        "空间模型记录已变更，请重新导入 VR 链接",
      );
      const work = JSON.parse(bytes.toString("utf8"));
      const assets = work._keagent?.assets;
      ensure(
        Array.isArray(assets) &&
          assets.length >= 13 &&
          assets.length <= maxSpatialAssets,
        "空间素材清单不完整",
      );
      const files = new Map([["work.json", path.join(directory, "work.json")]]);
      const assetsByFile = new Map();
      let total = 0;
      for (const asset of assets) {
        ensure(
          filePattern.test(asset.file) &&
            !files.has(asset.file) &&
            workIdPattern.test(asset.sha256) &&
            Number.isSafeInteger(asset.bytes) &&
            asset.bytes > 0 &&
            asset.bytes <= maxSpatialAssetBytes,
          "空间素材文件名或校验信息无效",
        );
        const file = path.join(directory, asset.file);
        ensure(
          (await fs.realpath(file)).startsWith(canonicalDirectory + path.sep),
          "空间素材路径无效",
        );
        total += asset.bytes;
        ensure(
          total <= maxSpatialBytes,
          "空间原始素材超过大小限制，请重新导入 VR 链接",
        );
        await readSpatialAsset(file, asset);
        files.set(asset.file, file);
        assetsByFile.set(asset.file, asset);
      }
      ensure(
        files.has(work.model?.file_url) &&
          work.model.material_textures?.every((file) => files.has(file)),
        "空间模型或纹理缺失",
      );
      ensure(Array.isArray(work.observers), "空间点位记录缺失");
      const provenanceFile = path.join(directory, "source.json");
      ensure(
        (await fs.realpath(provenanceFile)).startsWith(
          canonicalDirectory + path.sep,
        ),
        "空间来源记录路径无效",
      );
      const provenance = JSON.parse(await fs.readFile(provenanceFile, "utf8"));
      ensure(
        provenance.schemaVersion === 1 &&
          provenance.workId === spatial.workId &&
          provenance.workCode === work.code &&
          Array.isArray(provenance.assets) &&
          provenance.assets.length === assets.length,
        "空间来源记录不匹配，请重新导入 VR 链接",
      );
      const source = sourceURL(provenance.source).href;
      const urls = new Map();
      for (const asset of assets) {
        const origin = provenance.assets.find(
          (item) => item.file === asset.file,
        );
        ensure(
          origin &&
            origin.sha256 === asset.sha256 &&
            origin.bytes === asset.bytes,
          "空间原始文件来源不匹配",
        );
        urls.set(asset.file, sourceURL(origin.source, true).href);
      }
      const faces = ["right", "left", "up", "down", "front", "back"];
      const expected = {
        code: work.code,
        observers: work.observers,
        modelURL: urls.get(work.model.file_url),
        textureURLs: work.model.material_textures.map((file) => urls.get(file)),
        panoramas: work.panorama.list.map((pano) => ({
          index: pano.index,
          ...Object.fromEntries(
            faces.map((face) => [face, urls.get(pano[face])]),
          ),
        })),
      };
      saved = { directory, work, files, assetsByFile, urls, source, expected };
      works.set(spatial.workId, saved);
    }
    const from = saved.work.observers.find(
      (point) => point.index === spatial.panoIndex,
    );
    const to = saved.work.observers.find(
      (point) => point.index === spatial.targetPanoIndex,
    );
    ensure(
      from &&
        to &&
        vector(from.position) &&
        vector(to.position) &&
        from.accessible_nodes?.includes(to.index) &&
        distance(from.position, to.position) > 0.05,
      "所选空间点位之间没有可用的真实移动路径",
    );
    ensure(Number.isFinite(scene.yaw), "空间镜头朝向无效");
  }
  return works;
}

function shotOptions(run, config) {
  ensure(
    Number.isInteger(run.frames) &&
      run.frames >= 2 &&
      Number.isInteger(run.fps) &&
      run.fps >= 1 &&
      run.fps <= 60 &&
      run.frames / run.fps <= 60,
    "空间镜头时长或帧率无效",
  );
  const portrait = config.aspectRatio === "9:16";
  const shortSide = config.resolution === "1080p" ? 1080 : 720;
  const longSide = (shortSide / 9) * 16;
  const [width, height] = portrait
    ? [shortSide, longSide]
    : [longSide, shortSide];
  const hFov = portrait ? 84 : 100;
  return {
    workId: run.scene.spatial.workId,
    from: run.scene.spatial.panoIndex,
    to: run.scene.spatial.targetPanoIndex,
    yaw: run.scene.yaw,
    frames: run.frames,
    fps: run.fps,
    width,
    height,
    vFov:
      (2 *
        Math.atan((Math.tan((hFov * Math.PI) / 360) * height) / width) *
        180) /
      Math.PI,
  };
}

async function validClip(file, shot, signal) {
  if (!(await media.exists(file))) return false;
  const info = await media.probe(file, path.dirname(file), signal);
  return (
    info.streams.some(
      (stream) =>
        stream.codec_type === "video" &&
        stream.width === shot.width &&
        stream.height === shot.height &&
        Number(stream.nb_frames) === shot.frames,
    ) && Math.abs(Number(info.format.duration) - shot.frames / shot.fps) < 0.1
  );
}

async function bounded(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function assertFrameVisible(pixels) {
  const stride = Math.max(1, Math.floor(pixels.length / 4 / 4096)) * 4;
  let samples = 0;
  let visible = 0;
  for (let offset = 0; offset < pixels.length; offset += stride) {
    samples++;
    if (Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]) > 8)
      visible++;
  }
  ensure(
    samples > 0 && visible / samples >= 0.01,
    "空间模型输出了空白画面，请检查模型加载后重试",
  );
}

async function encode(window, file, shot, signal, onFrame) {
  const child = spawn(
    process.env.FFMPEG_PATH || "ffmpeg",
    [
      "-v",
      "error",
      "-y",
      "-f",
      "rawvideo",
      "-pixel_format",
      "rgba",
      "-video_size",
      `${shot.width}x${shot.height}`,
      "-framerate",
      String(shot.fps),
      "-i",
      "pipe:0",
      "-an",
      "-frames:v",
      String(shot.frames),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "21",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      file,
    ],
    { signal, windowsHide: true, stdio: ["pipe", "ignore", "pipe"] },
  );
  let errorText = "";
  child.stderr.on("data", (data) => {
    errorText = (errorText + data.toString()).slice(-4000);
  });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stdin.on("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`空间镜头编码失败（${code}）${errorText}`)),
    );
  });
  void done.catch(() => {});
  const positions = [];
  try {
    for (let index = 0; index < shot.frames; index++) {
      signal.throwIfAborted();
      const frame = await bounded(
        window.webContents.executeJavaScript(
          `(${captureFrame.toString()})(${index})`,
        ),
        60000,
        "空间画面渲染超时，请检查显卡或重试任务",
      );
      const pixels = Buffer.from(frame.pixels);
      ensure(
        pixels.length === shot.width * shot.height * 4 &&
          vector(frame.position),
        "空间视频帧无效",
      );
      if (
        index === 0 ||
        index === Math.floor(shot.frames / 2) ||
        index === shot.frames - 1
      ) {
        assertFrameVisible(pixels);
        positions.push(frame.position);
      }
      await new Promise((resolve, reject) =>
        child.stdin.write(pixels, (error) =>
          error ? reject(error) : resolve(),
        ),
      );
      onFrame(index + 1);
    }
    child.stdin.end();
    await done;
    return positions;
  } catch (error) {
    child.kill();
    await done.catch(() => {});
    throw error;
  }
}

async function renderRuns(
  runs,
  ownerDir,
  config,
  signal,
  onProgress = () => {},
) {
  signal = AbortSignal.any([signal, AbortSignal.timeout(20 * 60 * 1000)]);
  const works = await verifyWorks(runs, ownerDir);
  const shots = runs.map((run) => shotOptions(run, config));
  const { BrowserWindow, session } = require("electron");
  const isolated = session.fromPartition(`spatial-${randomUUID()}`, {
    cache: false,
  });
  isolated.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  );
  isolated.setPermissionCheckHandler(() => false);
  const allowedHosts = new Set(
    [...works.values()].map((work) => new URL(work.source).hostname),
  );
  allowedHosts.add("vr-static.realsee-cdn.cn");
  allowedHosts.add("vr-public.realsee-cdn.cn");
  for (const index of [1, 2, 3])
    allowedHosts.add(`vr-image-${index}.realsee-cdn.cn`);
  const frozenAssets = new Map();
  const replayedAssets = new Set();
  for (const saved of works.values()) {
    for (const [file, source] of saved.urls) {
      const url = new URL(source);
      const asset = saved.assetsByFile.get(file);
      for (const hostname of [
        url.hostname,
        "vr-image-1.realsee-cdn.cn",
        "vr-image-2.realsee-cdn.cn",
        "vr-image-3.realsee-cdn.cn",
      ]) {
        const key = `https://${hostname}${url.pathname}`;
        const previous = frozenAssets.get(key);
        ensure(
          !previous || previous.sha256 === asset.sha256,
          "空间源图链接存在冲突，请重新导入 VR 链接",
        );
        frozenAssets.set(key, {
          ...asset,
          filePath: saved.files.get(file),
          sourceKey: url.origin + url.pathname,
        });
      }
    }
  }
  isolated.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    callback({
      cancel:
        url.protocol !== "blob:" &&
        !(
          url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          !url.port &&
          allowedHosts.has(url.hostname)
        ),
    });
  });
  // The original viewer receives the exact verified image/model bytes at their original URLs.
  // All other permitted requests stay in this isolated session; no application files are exposed.
  await isolated.protocol.handle("https", async (request) => {
    const url = new URL(request.url);
    if (
      !allowedHosts.has(url.hostname) ||
      url.username ||
      url.password ||
      url.port
    )
      return new Response(null, { status: 403 });
    const asset = frozenAssets.get(url.origin + url.pathname);
    if (asset) {
      const bytes = await readSpatialAsset(asset.filePath, asset);
      replayedAssets.add(asset.sourceKey);
      const type =
        {
          ".avif": "image/avif",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".png": "image/png",
          ".webp": "image/webp",
        }[path.extname(asset.file)] || "application/octet-stream";
      return new Response(bytes, {
        headers: {
          "Content-Type": type,
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
        },
      });
    }
    if (/\/images\/cube_|\/materials\/|\.at3d$/i.test(url.pathname))
      return new Response(null, { status: 404 });
    return isolated.fetch(request, { bypassCustomProtocolHandlers: true });
  });
  const window = new BrowserWindow({
    show: false,
    width: shots[0]?.width || 720,
    height: shots[0]?.height || 1280,
    webPreferences: {
      session: isolated,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  let loadedSource;
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== loadedSource) event.preventDefault();
  });
  window.webContents.on("will-redirect", (event) => event.preventDefault());
  const abort = () => {
    if (!window.isDestroyed()) window.destroy();
  };
  signal.addEventListener("abort", abort, { once: true });
  const results = [];
  const totalFrames = shots.reduce((sum, shot) => sum + shot.frames, 0);
  let completedFrames = 0;
  await fs.mkdir(path.join(ownerDir, "cache"), { recursive: true });
  try {
    for (const shot of shots) {
      signal.throwIfAborted();
      const key = hash(["spatial-fly-v4-model-geometry", shot]);
      const file = path.join(ownerDir, "cache", `spatial-${key}.mp4`);
      const saved = works.get(shot.workId);
      const work = saved.work;
      const from = work.observers.find((point) => point.index === shot.from);
      const to = work.observers.find((point) => point.index === shot.to);
      const spatial = {
        workId: shot.workId,
        from: shot.from,
        to: shot.to,
        distanceMetres: distance(from.position, to.position),
      };
      if (!(await validClip(file, shot, signal))) {
        const temp = file + `.${randomUUID()}.part.mp4`;
        try {
          window.setContentSize(shot.width, shot.height);
          if (loadedSource !== saved.source) {
            loadedSource = saved.source;
            await bounded(
              window.loadURL(saved.source),
              60000,
              "原始 VR 查看器加载超时，请检查网络",
            );
          }
          const initialized = await bounded(
            window.webContents.executeJavaScript(
              `(${prepareViewer.toString()})(${JSON.stringify(shot)},${JSON.stringify(saved.expected)})`,
            ),
            90000,
            "空间模型加载超时，请检查网络或重新导入 VR 链接",
          );
          ensure(
            Math.abs(initialized.fov - shot.vFov) < 0.05,
            "原始 VR 查看器没有应用所选视角",
          );
          const requiredFiles = [
            work.model.file_url,
            ...work.model.material_textures,
          ];
          for (const index of [shot.from, shot.to]) {
            const pano = work.panorama.list.find(
              (point) => point.index === index,
            );
            for (const face of ["right", "left", "up", "down", "front", "back"])
              requiredFiles.push(pano[face]);
          }
          ensure(
            requiredFiles.every((file) => {
              const url = new URL(saved.urls.get(file));
              return replayedAssets.has(url.origin + url.pathname);
            }),
            "原始查看器未完整加载已核验的模型与全景图片",
          );
          const positions = await encode(window, temp, shot, signal, (count) =>
            onProgress((completedFrames + count) / totalFrames),
          );
          ensure(
            distance(positions[0], from.position) < 0.02 &&
              distance(positions.at(-1), to.position) < 0.02,
            "空间镜头没有完成真实位置移动",
          );
          ensure(
            await validClip(temp, shot, signal),
            "空间镜头尺寸、帧数或时长校验失败",
          );
          await fs.rename(temp, file);
          await fs.writeFile(
            file + ".json",
            JSON.stringify({ shot, spatial, positions }, null, 2),
          );
        } finally {
          await fs.rm(temp, { force: true });
        }
      }
      results.push({ file, spatial });
      completedFrames += shot.frames;
      onProgress(completedFrames / totalFrames);
    }
    return results;
  } finally {
    signal.removeEventListener("abort", abort);
    abort();
    isolated.protocol.unhandle("https");
  }
}

module.exports = { renderRuns, verifyWorks, shotOptions, assertFrameVisible };
