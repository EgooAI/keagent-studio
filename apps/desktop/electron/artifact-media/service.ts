import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  ArtifactContent,
  ArtifactExchange,
  ArtifactSource,
  MediaAsset,
  MediaAssetKind,
  VideoArtifact,
} from "@keagent/shared-types";
import {
  ArtifactMediaError,
  LocalMediaRegistry,
  writeMediaJSON,
  type MediaIdentity,
} from "./registry";
export interface CompletedArtifactOutput {
  source: ArtifactSource;
  content: ArtifactContent;
  files: { video: string; cover: string; subtitle?: string };
  sample: boolean;
}
export type RegistryExchange = Pick<
  ArtifactExchange,
  | "registerAsset"
  | "createArtifact"
  | "getArtifact"
  | "getAsset"
  | "reportAvailability"
>;
/** Producer adapter writes the shared contract; publishing never imports the producer. */
export class ArtifactRegistrationService {
  private pending = new Map<
    string,
    { fingerprint: string; promise: Promise<VideoArtifact> }
  >();
  constructor(
    readonly registry: LocalMediaRegistry,
    private exchange: RegistryExchange,
  ) {}
  async register(
    output: CompletedArtifactOutput,
    expected?: MediaIdentity,
  ): Promise<VideoArtifact> {
    if (output.sample)
      throw new ArtifactMediaError(
        "SAMPLE_NOT_PUBLISHABLE",
        "示例成片不登记为正式成果",
        422,
      );
    if (
      !/^[a-z][a-z0-9_-]{0,39}$/.test(output.source.producer) ||
      !output.source.taskId ||
      !Number.isSafeInteger(output.source.revision) ||
      output.source.revision < 1 ||
      !output.content.title.trim() ||
      !output.content.script.trim()
    )
      throw new ArtifactMediaError(
        "INVALID_INPUT",
        "制作成片的来源或内容不完整",
        422,
      );
    output = structuredClone(output);
    const { identity, directory } = await this.registry.context();
    if (expected) await this.registry.assertIdentity(expected);
    const key = createHash("sha256")
      .update(
        JSON.stringify([identity.userId, identity.deviceId, output.source]),
      )
      .digest("hex");
    const existing = this.pending.get(key);
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({ source: output.source, content: output.content }),
      )
      .digest("hex");
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new ArtifactMediaError(
          "SOURCE_OUTPUT_CHANGED",
          "正在登记的同一来源版本包含不同内容",
        );
      return existing.promise;
    }
    const task = this.perform(output, identity, directory, key);
    this.pending.set(key, { fingerprint, promise: task });
    try {
      return await task;
    } finally {
      this.pending.delete(key);
    }
  }
  private async perform(
    output: CompletedArtifactOutput,
    identity: MediaIdentity,
    directory: string,
    key: string,
  ): Promise<VideoArtifact> {
    const receiptFile = path.join(directory, "outputs", `${key}.json`);
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({ source: output.source, content: output.content }),
      )
      .digest("hex");
    let receipt: { fingerprint: string; artifactId: string } | undefined;
    try {
      receipt = JSON.parse(await fs.readFile(receiptFile, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new ArtifactMediaError("REGISTRY_CORRUPTED", "成片登记回执损坏");
    }
    if (receipt) {
      if (receipt.fingerprint !== fingerprint)
        throw new ArtifactMediaError(
          "SOURCE_OUTPUT_CHANGED",
          "同一来源版本的内容已改变，请由制作端创建新版本",
        );
      await this.registry.assertIdentity(identity);
      return this.exchange.getArtifact(receipt.artifactId);
    }
    const assets: Partial<Record<MediaAssetKind, string>> = {};
    for (const kind of ["video", "cover", "subtitle"] as const) {
      const file = output.files[kind];
      if (!file) continue;
      await this.registry.assertIdentity(identity);
      const requestKey = createHash("sha256")
        .update(`${key}:${kind}`)
        .digest("hex");
      const local = await this.registry.ingest(requestKey, file, kind);
      await this.registry.assertIdentity(identity);
      const asset = await this.exchange.registerAsset({
        requestKey,
        fileToken: local.fileToken,
        ...local.metadata,
      });
      await this.registry.assertIdentity(identity);
      await this.registry.bind(asset);
      assets[kind] = asset.id;
    }
    if (!assets.video || !assets.cover)
      throw new ArtifactMediaError(
        "INVALID_INPUT",
        "制作成片缺少视频或封面",
        422,
      );
    await this.registry.assertIdentity(identity);
    const artifact = await this.exchange.createArtifact({
      requestKey: createHash("sha256").update(`${key}:artifact`).digest("hex"),
      source: output.source,
      content: output.content,
      assets: {
        video: assets.video,
        cover: assets.cover,
        ...(assets.subtitle ? { subtitle: assets.subtitle } : {}),
      },
    });
    await this.registry.assertIdentity(identity);
    await writeMediaJSON(receiptFile, { fingerprint, artifactId: artifact.id });
    return artifact;
  }
  async restore(asset: MediaAsset, file: string): Promise<MediaAsset> {
    const { identity } = await this.registry.context();
    await this.registry.restore(asset, file);
    await this.registry.assertIdentity(identity);
    if (asset.availability.state === "available") return asset;
    try {
      return await this.exchange.reportAvailability({
        id: asset.id,
        expectedRevision: asset.availability.revision,
        state: "available",
      });
    } catch (error) {
      if ((error as { code?: string }).code !== "REVISION_CONFLICT")
        throw error;
      await this.registry.assertIdentity(identity);
      const current = await this.exchange.getAsset(asset.id);
      if (current.availability.state !== "available") throw error;
      return current;
    }
  }
}
