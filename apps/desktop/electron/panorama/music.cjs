const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { ensure, hash } = require("./domain.cjs");
const media = require("./media.cjs");

const builtIns = [
  { id: "warm-v1", name: "暖意", duration: 45.2 },
  { id: "bright-v1", name: "晴日", duration: 34.3 },
  { id: "calm-v1", name: "静庭", duration: 53.3 },
];
const localId = /^[a-f0-9]{64}\.(mp3|wav)$/;
const missingMusic =
  "本机背景音乐已丢失，请重新导入原曲后重试，或新建任务更换曲目";

function file(root, ownerDir, id) {
  const builtIn = builtIns.some((track) => track.id === id);
  ensure(
    builtIn || (typeof id === "string" && localId.test(id)),
    "背景音乐引用无效",
  );
  return builtIn
    ? path.join(root, "builtin-music", id + ".mp3")
    : path.join(ownerDir, "music", id);
}

async function install(temp, target) {
  if (await media.exists(target)) return;
  try {
    await fs.rename(temp, target);
  } catch (error) {
    if (!(await media.exists(target))) throw error;
  }
}

async function resolve(root, ownerDir, id) {
  const target = file(root, ownerDir, id);
  if (
    builtIns.some((track) => track.id === id) &&
    !(await media.exists(target))
  ) {
    // FFmpeg needs a real path when the source is inside Electron's ASAR.
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temp = target + "." + randomUUID() + ".part";
    try {
      const bytes = await fs.readFile(
        path.join(__dirname, "music", id + ".mp3"),
      );
      await fs.writeFile(temp, bytes, { flag: "wx" });
      await install(temp, target);
    } finally {
      await fs.rm(temp, { force: true });
    }
  }
  ensure(await media.exists(target), missingMusic);
  return target;
}

async function importTrack(root, ownerDir, source, assertCurrent) {
  const extension = path.extname(source).toLowerCase();
  const maxBytes = 50 * 1024 * 1024;
  const stat = await fs.stat(source);
  ensure(
    [".mp3", ".wav"].includes(extension) &&
      stat.isFile() &&
      stat.size > 0 &&
      stat.size <= maxBytes,
    "请选择 50 MB 以内的 MP3 或 WAV 音频",
  );
  const bytes = await fs.readFile(source);
  ensure(
    bytes.length > 0 && bytes.length <= maxBytes,
    "音乐文件为空或超过 50 MB",
  );
  const id = hash(bytes) + extension;
  const target = file(root, ownerDir, id);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = path.join(path.dirname(target), randomUUID() + extension);
  try {
    await fs.writeFile(temp, bytes, { flag: "wx" });
    const info = await media
      .probe(
        temp,
        path.dirname(temp),
        AbortSignal.timeout(12000),
        extension.slice(1),
      )
      .catch(() => null);
    const duration = Number(info?.format?.duration);
    ensure(
      Number.isFinite(duration) &&
        duration > 0 &&
        info.streams.some((stream) => stream.codec_type === "audio"),
      "无法读取音频，请检查文件格式或重新导出",
    );
    assertCurrent();
    await install(temp, target);
    assertCurrent();
    return {
      id,
      name:
        path.basename(source, path.extname(source)).trim().slice(0, 80) ||
        "我的音乐",
      duration,
    };
  } finally {
    await fs.rm(temp, { force: true });
  }
}

module.exports = { builtIns, file, resolve, importTrack };
