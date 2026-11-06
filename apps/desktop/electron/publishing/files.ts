import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { nativeImage, dialog, type BrowserWindow } from "electron";
import type {
  DouyinPublishRecord,
  LocalMediaAssetResolver,
  MediaAsset,
} from "@keagent/shared-types";
import {
  PublishingError,
  type PublishingIdentity,
  type PublishFiles,
} from "./core";
export async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
export function atomicJSON(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flush: true });
  fs.renameSync(temp, file);
}
export class PublishingFiles {
  constructor(
    private readonly root: string,
    private readonly identity: () => Promise<PublishingIdentity>,
    private readonly window: BrowserWindow,
  ) {}
  directoryFor(
    identity: Pick<PublishingIdentity, "userId" | "deviceId">,
  ): string {
    return path.join(
      this.root,
      createHash("sha256")
        .update(`${identity.userId}:${identity.deviceId}`)
        .digest("hex"),
    );
  }
  async directory(): Promise<string> {
    return this.directoryFor(await this.identity());
  }
  async cover(): Promise<{ ref: string; url: string }> {
    const root = await this.directory();
    const selected = await dialog.showOpenDialog(this.window, {
      title: "选择本次发布封面",
      properties: ["openFile"],
      filters: [{ name: "封面图片", extensions: ["jpg", "jpeg", "png"] }],
    });
    if (selected.canceled || !selected.filePaths[0])
      throw new PublishingError("SELECTION_CANCELED", "已取消选择封面");
    const file = selected.filePaths[0];
    const stat = await fsp.stat(file);
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024)
      throw new PublishingError(
        "INVALID_COVER",
        "封面应为不超过20MiB的JPG或PNG图片",
        422,
      );
    const data = await fsp.readFile(file);
    const png = data
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpg = data[0] === 255 && data[1] === 216 && data[2] === 255;
    if ((!png && !jpg) || nativeImage.createFromBuffer(data).isEmpty())
      throw new PublishingError("INVALID_COVER", "无法读取封面图片", 422);
    const ref = randomBytes(16).toString("hex");
    const target = path.join(root, "covers", `${ref}.${png ? "png" : "jpg"}`);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, data, { mode: 0o600 });
    atomicJSON(path.join(root, "covers", `${ref}.json`), {
      ext: png ? "png" : "jpg",
      sha256: createHash("sha256").update(data).digest("hex"),
    });
    return { ref, url: `keagent://douyin/cover/${ref}` };
  }
  private async coverPath(
    root: string,
    ref: string,
  ): Promise<{ file: string; hash: string; ext: string }> {
    if (!/^[a-f0-9]{32}$/.test(ref))
      throw new PublishingError("INVALID_COVER", "封面引用无效", 422);
    try {
      const meta = JSON.parse(
        await fsp.readFile(path.join(root, "covers", `${ref}.json`), "utf8"),
      ) as { ext: string; sha256: string };
      if (!["png", "jpg"].includes(meta.ext)) throw new Error();
      const file = path.join(root, "covers", `${ref}.${meta.ext}`);
      if ((await hashFile(file)) !== meta.sha256) throw new Error();
      return { file, hash: meta.sha256, ext: meta.ext };
    } catch {
      throw new PublishingError(
        "COVER_MISSING",
        "本次发布封面已丢失或改变，请重新选择",
      );
    }
  }
  async copyAsset(
    asset: MediaAsset,
    resolver: LocalMediaAssetResolver,
    target: string,
  ): Promise<void> {
    let resolved;
    try {
      resolved = await resolver.resolve(asset);
    } catch {
      throw new PublishingError(
        "ASSET_UNAVAILABLE",
        "无法读取本机成片文件，请恢复文件或回到原设备",
      );
    }
    if (
      resolved.assetId !== asset.id ||
      resolved.sha256 !== asset.sha256 ||
      resolved.byteSize !== asset.byteSize ||
      !path.isAbsolute(resolved.absolutePath)
    )
      throw new PublishingError("ASSET_CHANGED", "文件解析结果与交接不一致");
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(resolved.absolutePath, target);
    const stat = await fsp.stat(target);
    if (
      stat.size !== asset.byteSize ||
      (await hashFile(target)) !== asset.sha256
    ) {
      await fsp.unlink(target);
      throw new PublishingError(
        "ASSET_CHANGED",
        "本机文件大小或哈希与已验收成片不一致",
      );
    }
  }
  async snapshot(
    requestKey: string,
    assets: MediaAsset[],
    resolver: LocalMediaAssetResolver,
    coverRef?: string,
    identity?: PublishingIdentity,
  ): Promise<PublishFiles> {
    if (!/^[A-Za-z0-9_-]{16,100}$/.test(requestKey))
      throw new PublishingError("INVALID_INPUT", "请求键无效", 422);
    const root = identity
      ? this.directoryFor(identity)
      : await this.directory();
    const folder = path.join(root, "executions", requestKey);
    const video = assets.find((asset) => asset.kind === "video")!,
      cover = assets.find((asset) => asset.kind === "cover")!;
    const selectedCover = coverRef
      ? await this.coverPath(root, coverRef)
      : undefined;
    const videoPath = path.join(folder, "video.mp4"),
      coverPath = path.join(
        folder,
        `cover.${selectedCover?.ext || (cover.mimeType === "image/png" ? "png" : "jpg")}`,
      );
    await this.copyAsset(video, resolver, videoPath);
    if (selectedCover) {
      await this.copyAsset(
        cover,
        resolver,
        path.join(
          folder,
          `handoff-cover.${cover.mimeType === "image/png" ? "png" : "jpg"}`,
        ),
      );
      const source = selectedCover;
      await fsp.copyFile(source.file, coverPath);
      if ((await hashFile(coverPath)) !== source.hash)
        throw new PublishingError("ASSET_CHANGED", "替换封面已改变");
    } else await this.copyAsset(cover, resolver, coverPath);
    // Optional subtitles are verified through the same port, never uploaded as a second video.
    for (const subtitle of assets.filter((asset) => asset.kind === "subtitle"))
      await this.copyAsset(subtitle, resolver, path.join(folder, "subtitle"));
    return { video: videoPath, cover: coverPath };
  }
  async preview(
    assets: MediaAsset[],
    resolver: LocalMediaAssetResolver,
  ): Promise<{ video: string; cover: string }> {
    const root = await this.directory();
    const output = { video: "", cover: "" };
    for (const kind of ["video", "cover"] as const) {
      const asset = assets.find((value) => value.kind === kind);
      if (!asset) continue;
      const ext =
        kind === "video"
          ? "mp4"
          : asset.mimeType === "image/png"
            ? "png"
            : "jpg";
      const target = path.join(root, "preview", `${asset.id}.${ext}`);
      await this.copyAsset(asset, resolver, target);
      atomicJSON(path.join(root, "preview", `${asset.id}.json`), {
        ext,
        sha256: asset.sha256,
      });
      output[kind] = `keagent://douyin/preview/${asset.id}`;
    }
    return output;
  }
  async media(url: URL): Promise<string> {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 2 || !/^[a-f0-9]{32}$/.test(parts[1]))
      throw new Error("Invalid media reference");
    const root = await this.directory();
    if (parts[0] === "cover")
      return (await this.coverPath(root, parts[1])).file;
    if (parts[0] !== "preview") throw new Error("Invalid media kind");
    const meta = JSON.parse(
      await fsp.readFile(
        path.join(root, "preview", `${parts[1]}.json`),
        "utf8",
      ),
    ) as { ext: string; sha256: string };
    if (!["mp4", "jpg", "png"].includes(meta.ext))
      throw new Error("Invalid media type");
    return path.join(root, "preview", `${parts[1]}.${meta.ext}`);
  }
  async cleanup(
    requestKey: string,
    identity?: PublishingIdentity,
  ): Promise<void> {
    if (!/^[A-Za-z0-9_-]{16,100}$/.test(requestKey)) return;
    const parent = path.resolve(
      identity ? this.directoryFor(identity) : await this.directory(),
      "executions",
    );
    const target = path.resolve(parent, requestKey);
    if (path.dirname(target) !== parent)
      throw new Error("Invalid cleanup target");
    await fsp.rm(target, { recursive: true, force: true });
  }
  journal(root: string, record: DouyinPublishRecord): void {
    atomicJSON(path.join(root, "pending", `${record.id}.json`), record);
  }
  pending(root: string): DouyinPublishRecord[] {
    try {
      return fs
        .readdirSync(path.join(root, "pending"))
        .filter((name) => /^[a-f0-9]{32}\.json$/.test(name))
        .flatMap((name) => {
          try {
            return [
              JSON.parse(
                fs.readFileSync(path.join(root, "pending", name), "utf8"),
              ) as DouyinPublishRecord,
            ];
          } catch {
            return [];
          }
        });
    } catch {
      return [];
    }
  }
  acknowledged(root: string, id: string): void {
    if (/^[a-f0-9]{32}$/.test(id))
      fs.rmSync(path.join(root, "pending", `${id}.json`), { force: true });
  }
}
