import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import { nativeImage } from "electron";
import { ArtifactMediaError, type MediaProbe } from "./registry";
const execute = promisify(execFile);
export const probeMedia: MediaProbe = async (file, kind) => {
  if (kind === "video") {
    let data: {
      streams?: { codec_type: string; width?: number; height?: number }[];
      format?: { duration?: string; format_name?: string };
    };
    try {
      const { stdout } = await execute(
        process.env.FFPROBE_PATH || "ffprobe",
        ["-v", "error", "-show_streams", "-show_format", "-of", "json", file],
        { timeout: 20000, maxBuffer: 2 * 1024 * 1024, windowsHide: true },
      );
      data = JSON.parse(stdout);
    } catch {
      throw new ArtifactMediaError(
        "MEDIA_PROBE_FAILED",
        "无法验证视频，请检查FFprobe配置和成片文件",
        422,
      );
    }
    const stream = data.streams?.find((value) => value.codec_type === "video");
    const durationMs = Math.round(Number(data.format?.duration) * 1000);
    if (
      !data.format?.format_name?.split(",").includes("mp4") ||
      !stream?.width ||
      !stream.height ||
      stream.width > 16384 ||
      stream.height > 16384 ||
      !Number.isSafeInteger(durationMs) ||
      durationMs < 1 ||
      durationMs > 86400000
    )
      throw new ArtifactMediaError(
        "INVALID_MEDIA",
        "成片须为有有效尺寸和时长的MP4视频",
        422,
      );
    return {
      kind,
      mimeType: "video/mp4",
      width: stream.width,
      height: stream.height,
      durationMs,
    };
  }
  if (kind === "cover" && (await fs.stat(file)).size > 20 * 1024 * 1024)
    throw new ArtifactMediaError("INVALID_MEDIA", "封面超过20MiB", 422);
  const data = await fs.readFile(file);
  if (kind === "cover") {
    if (data.length > 20 * 1024 * 1024)
      throw new ArtifactMediaError("INVALID_MEDIA", "封面超过20MiB", 422);
    const png = data
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = data[0] === 255 && data[1] === 216 && data[2] === 255;
    const image = nativeImage.createFromBuffer(data);
    const size = image.getSize();
    if (
      (!png && !jpeg) ||
      image.isEmpty() ||
      size.width < 1 ||
      size.height < 1 ||
      size.width > 16384 ||
      size.height > 16384
    )
      throw new ArtifactMediaError(
        "INVALID_MEDIA",
        "封面须为有效JPG或PNG图片",
        422,
      );
    return {
      kind,
      mimeType: png ? "image/png" : "image/jpeg",
      width: size.width,
      height: size.height,
    };
  }
  const text = data.toString("utf8");
  if (
    text.includes("\0") ||
    (!text.startsWith("WEBVTT") && !/\d\d:\d\d:\d\d,\d{3}\s+-->/.test(text))
  )
    throw new ArtifactMediaError(
      "INVALID_MEDIA",
      "字幕须为有效VTT或SRT文件",
      422,
    );
  return {
    kind,
    mimeType: text.startsWith("WEBVTT") ? "text/vtt" : "application/x-subrip",
  };
};
