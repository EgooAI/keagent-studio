import { promises as fs, createReadStream } from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type {
  LocalMediaAssetResolver,
  MediaAsset,
  MediaAssetKind,
  MediaAssetMetadata,
  ResolvedLocalMedia,
} from "@keagent/shared-types";

export interface MediaIdentity {
  userId: string;
  deviceId: string;
  generation: number;
}
export class ArtifactMediaError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}
export type MediaProbe = (
  file: string,
  kind: MediaAssetKind,
) => Promise<Omit<MediaAssetMetadata, "byteSize" | "sha256">>;
interface Entry {
  schemaVersion: 1;
  ownerId: string;
  deviceId: string;
  token: string;
  relative: string;
  metadata: MediaAssetMetadata;
  assetId?: string;
}
export async function mediaHash(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const part of createReadStream(file)) hash.update(part);
  return hash.digest("hex");
}
export async function writeMediaJSON(
  file: string,
  value: unknown,
): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(value), {
      mode: 0o600,
      flush: true,
    });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}
const tokenPattern = /^[A-Za-z0-9_-]{16,128}$/;
const keyPattern = /^[A-Za-z0-9_-]{16,100}$/;
function sameMetadata(
  left: MediaAssetMetadata,
  right: MediaAssetMetadata,
): boolean {
  return (
    [
      "kind",
      "mimeType",
      "byteSize",
      "sha256",
      "width",
      "height",
      "durationMs",
    ] as const
  ).every((key) => left[key] === right[key]);
}
/** Shared Main-only registry. It never reads production jobs or accepts renderer paths. */
export class LocalMediaRegistry implements LocalMediaAssetResolver {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private root: string,
    private identity: () => Promise<MediaIdentity>,
    private probe: MediaProbe,
  ) {}
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action, action);
    this.queue = next.catch(() => {});
    return next;
  }
  async context(): Promise<{ identity: MediaIdentity; directory: string }> {
    const identity = { ...(await this.identity()) };
    if (!identity.userId || !identity.deviceId)
      throw new ArtifactMediaError(
        "DEVICE_REQUIRED",
        "请先登录已登记的桌面设备",
      );
    const scope = createHash("sha256")
      .update(JSON.stringify([identity.userId, identity.deviceId]))
      .digest("hex");
    return { identity, directory: path.join(this.root, scope) };
  }
  async assertIdentity(expected: MediaIdentity): Promise<void> {
    const current = await this.identity();
    if (
      current.userId !== expected.userId ||
      current.deviceId !== expected.deviceId ||
      current.generation !== expected.generation
    )
      throw new ArtifactMediaError(
        "SESSION_CHANGED",
        "登录状态已改变，请重新操作",
        403,
      );
  }
  private metadataFile(directory: string, token: string): string {
    if (!tokenPattern.test(token))
      throw new ArtifactMediaError("INVALID_INPUT", "文件令牌无效", 422);
    return path.join(directory, "tokens", `${token}.json`);
  }
  private managedPath(directory: string, relative: string): string {
    if (!/^files\/[a-f0-9]{32}\.(mp4|jpg|png|srt|vtt)$/.test(relative))
      throw new ArtifactMediaError(
        "REGISTRY_CORRUPTED",
        "本机文件登记损坏，请重新定位原文件",
      );
    const file = path.resolve(directory, relative);
    if (!file.startsWith(path.resolve(directory) + path.sep))
      throw new ArtifactMediaError("REGISTRY_CORRUPTED", "本机文件登记越界");
    return file;
  }
  private async read(
    directory: string,
    token: string,
    identity: MediaIdentity,
  ): Promise<Entry> {
    let entry: Entry;
    try {
      entry = JSON.parse(
        await fs.readFile(this.metadataFile(directory, token), "utf8"),
      ) as Entry;
    } catch {
      throw new ArtifactMediaError(
        "ASSET_UNAVAILABLE",
        "本机没有该文件的登记，请定位原文件恢复",
      );
    }
    if (
      entry.schemaVersion !== 1 ||
      entry.token !== token ||
      entry.ownerId !== identity.userId ||
      entry.deviceId !== identity.deviceId
    )
      throw new ArtifactMediaError(
        "WRONG_DEVICE",
        "文件登记不属于当前用户或设备",
      );
    this.managedPath(directory, entry.relative);
    return entry;
  }
  private async verify(directory: string, entry: Entry): Promise<string> {
    const file = this.managedPath(directory, entry.relative);
    try {
      const stat = await fs.lstat(file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size !== entry.metadata.byteSize ||
        (await mediaHash(file)) !== entry.metadata.sha256
      )
        throw new Error();
    } catch {
      throw new ArtifactMediaError(
        "ASSET_UNAVAILABLE",
        "已登记文件丢失或内容改变，请定位原文件恢复",
      );
    }
    return file;
  }
  async ingest(
    requestKey: string,
    source: string,
    kind: MediaAssetKind,
  ): Promise<{ fileToken: string; metadata: MediaAssetMetadata }> {
    return this.serial(async () => {
      if (!keyPattern.test(requestKey) || !path.isAbsolute(source))
        throw new ArtifactMediaError("INVALID_INPUT", "成片登记参数无效", 422);
      const { identity, directory } = await this.context();
      const requestFile = path.join(
        directory,
        "requests",
        `${createHash("sha256").update(requestKey).digest("hex")}.json`,
      );
      let prior: { token: string; kind: MediaAssetKind } | undefined;
      try {
        prior = JSON.parse(await fs.readFile(requestFile, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw new ArtifactMediaError(
            "REGISTRY_CORRUPTED",
            "登记请求记录损坏",
          );
      }
      if (prior) {
        if (prior.kind !== kind)
          throw new ArtifactMediaError(
            "IDEMPOTENCY_CONFLICT",
            "登记请求已用于其他资产类型",
          );
        const entry = await this.read(directory, prior.token, identity);
        await this.verify(directory, entry);
        await this.assertIdentity(identity);
        return { fileToken: entry.token, metadata: entry.metadata };
      }
      const stat = await fs.stat(source).catch(() => undefined);
      if (!stat?.isFile() || stat.size < 1)
        throw new ArtifactMediaError(
          "ASSET_UNAVAILABLE",
          "制作结果文件不存在或为空",
        );
      const token = randomBytes(24).toString("hex");
      const extension =
        kind === "video"
          ? "mp4"
          : kind === "cover"
            ? path.extname(source).toLowerCase() === ".png"
              ? "png"
              : "jpg"
            : path.extname(source).toLowerCase() === ".vtt"
              ? "vtt"
              : "srt";
      let relative = `files/${randomBytes(16).toString("hex")}.${extension}`;
      let target = this.managedPath(directory, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      try {
        await fs.copyFile(source, target);
        const details = await this.probe(target, kind);
        const actualExtension =
          details.mimeType === "image/png"
            ? "png"
            : details.mimeType === "image/jpeg"
              ? "jpg"
              : details.mimeType === "text/vtt"
                ? "vtt"
                : details.mimeType === "application/x-subrip"
                  ? "srt"
                  : "mp4";
        if (path.extname(target) !== "." + actualExtension) {
          const next =
            target.slice(0, target.lastIndexOf(".")) + "." + actualExtension;
          await fs.rename(target, next);
          target = next;
          relative =
            relative.slice(0, relative.lastIndexOf(".")) +
            "." +
            actualExtension;
        }
        const copied = await fs.stat(target);
        const metadata: MediaAssetMetadata = {
          ...details,
          byteSize: copied.size,
          sha256: await mediaHash(target),
        };
        if (details.kind !== kind)
          throw new ArtifactMediaError(
            "INVALID_MEDIA",
            "文件类型与登记用途不匹配",
            422,
          );
        await this.assertIdentity(identity);
        const entry: Entry = {
          schemaVersion: 1,
          ownerId: identity.userId,
          deviceId: identity.deviceId,
          token,
          relative,
          metadata,
        };
        await writeMediaJSON(this.metadataFile(directory, token), entry);
        await writeMediaJSON(requestFile, { token, kind });
        return { fileToken: token, metadata };
      } catch (error) {
        await fs.rm(target, { force: true });
        throw error;
      }
    });
  }
  async bind(asset: MediaAsset): Promise<void> {
    return this.serial(async () => {
      const { identity, directory } = await this.context();
      this.requireOwner(asset, identity);
      const entry = await this.read(
        directory,
        asset.location.fileToken,
        identity,
      );
      if (
        !sameMetadata(entry.metadata, asset) ||
        (entry.assetId && entry.assetId !== asset.id)
      )
        throw new ArtifactMediaError(
          "IDEMPOTENCY_CONFLICT",
          "文件令牌已经绑定其他资产或内容",
        );
      await this.verify(directory, entry);
      await this.assertIdentity(identity);
      entry.assetId = asset.id;
      await writeMediaJSON(this.metadataFile(directory, entry.token), entry);
    });
  }
  private requireOwner(asset: MediaAsset, identity: MediaIdentity): void {
    if (
      asset.ownerId !== identity.userId ||
      asset.location?.kind !== "local" ||
      asset.location.deviceId !== identity.deviceId
    )
      throw new ArtifactMediaError(
        "WRONG_DEVICE",
        "请在拥有该成片的原设备操作",
      );
  }
  async resolve(asset: MediaAsset): Promise<ResolvedLocalMedia> {
    const { identity, directory } = await this.context();
    this.requireOwner(asset, identity);
    const entry = await this.read(
      directory,
      asset.location.fileToken,
      identity,
    );
    if (entry.assetId !== asset.id || !sameMetadata(entry.metadata, asset))
      throw new ArtifactMediaError("ASSET_CHANGED", "资产与本机登记版本不一致");
    const absolutePath = await this.verify(directory, entry);
    await this.assertIdentity(identity);
    return {
      assetId: asset.id,
      absolutePath,
      sha256: entry.metadata.sha256,
      byteSize: entry.metadata.byteSize,
    };
  }
  async restore(asset: MediaAsset, source: string): Promise<void> {
    return this.serial(async () => {
      const { identity, directory } = await this.context();
      this.requireOwner(asset, identity);
      this.metadataFile(directory, asset.location.fileToken);
      let entry: Entry | undefined;
      try {
        entry = await this.read(directory, asset.location.fileToken, identity);
      } catch (error) {
        if ((error as ArtifactMediaError).code !== "ASSET_UNAVAILABLE")
          throw error;
      }
      if (
        entry &&
        ((entry.assetId && entry.assetId !== asset.id) ||
          !sameMetadata(entry.metadata, asset))
      )
        throw new ArtifactMediaError(
          "IDEMPOTENCY_CONFLICT",
          "本机令牌已用于其他资产",
        );
      const extension =
        asset.kind === "video"
          ? "mp4"
          : asset.mimeType === "image/png"
            ? "png"
            : asset.mimeType === "image/jpeg"
              ? "jpg"
              : asset.mimeType === "text/vtt"
                ? "vtt"
                : "srt";
      const relative =
        entry?.relative ||
        `files/${randomBytes(16).toString("hex")}.${extension}`;
      const target = this.managedPath(directory, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const temp = `${target}.restore`;
      try {
        await fs.copyFile(source, temp);
        const stat = await fs.stat(temp);
        if (
          stat.size !== asset.byteSize ||
          (await mediaHash(temp)) !== asset.sha256
        )
          throw new ArtifactMediaError(
            "FILE_MISMATCH",
            "所选文件与验收版本不一致，请选择原始文件",
            422,
          );
        await this.assertIdentity(identity);
        await fs.rename(temp, target);
        const {
          id: _id,
          ownerId: _owner,
          location: _location,
          availability: _available,
          schemaVersion: _schema,
          createdAt: _created,
          ...metadata
        } = asset;
        await writeMediaJSON(
          this.metadataFile(directory, asset.location.fileToken),
          {
            schemaVersion: 1,
            ownerId: identity.userId,
            deviceId: identity.deviceId,
            token: asset.location.fileToken,
            relative,
            assetId: asset.id,
            metadata,
          } satisfies Entry,
        );
      } finally {
        await fs.rm(temp, { force: true });
      }
    });
  }
}
