/** V1 exchange contract. Independent of production jobs and platform accounts. */
export type MediaAssetKind = "video" | "cover" | "subtitle";
export type ArtifactReviewState = "pending" | "approved" | "rejected";
export type ArtifactExchangeErrorCode =
  | "INVALID_INPUT"
  | "DEVICE_REQUIRED"
  | "NOT_FOUND"
  | "WRONG_DEVICE"
  | "ASSET_UNAVAILABLE"
  | "REVISION_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "SOURCE_VERSION_EXISTS";
export interface LocalAssetLocation {
  kind: "local";
  deviceId: string;
  /** Opaque device-local registry key, never a path or URL. */
  fileToken: string;
}
export interface MediaAssetMetadata {
  kind: MediaAssetKind;
  mimeType:
    | "video/mp4"
    | "image/jpeg"
    | "image/png"
    | "text/vtt"
    | "application/x-subrip";
  byteSize: number;
  sha256: string;
  width?: number;
  height?: number;
  durationMs?: number;
}
export interface MediaAsset extends MediaAssetMetadata {
  schemaVersion: 1;
  id: string;
  ownerId: string;
  location: LocalAssetLocation;
  /** Device-reported availability, not proof that the server inspected bytes. */
  availability: {
    state: "available" | "missing";
    revision: number;
    reportedAt: string;
  };
  createdAt: string;
}
export interface RegisterMediaAssetInput extends MediaAssetMetadata {
  requestKey: string;
  fileToken: string;
}
export interface ArtifactSource {
  /** Producer namespace; does not require any particular production table. */
  producer: string;
  taskId: string;
  revision: number;
}
export interface ArtifactContent {
  title: string;
  script: string;
  property?: { id: string; title: string };
}
export interface ArtifactAssets {
  video: string;
  cover: string;
  subtitle?: string;
}
export interface VideoArtifact {
  schemaVersion: 1;
  /** Identifies one immutable output version, never the mutable production job. */
  id: string;
  ownerId: string;
  source: ArtifactSource;
  content: ArtifactContent;
  assets: ArtifactAssets;
  review: {
    state: ArtifactReviewState;
    revision: number;
    reviewedAt?: string;
    note?: string;
  };
  createdAt: string;
}
export interface CreateArtifactInput {
  requestKey: string;
  billingTaskId?: string;
  source: ArtifactSource;
  content: ArtifactContent;
  assets: ArtifactAssets;
}
export interface ArtifactListInput {
  limit?: number;
  offset?: number;
  review?: ArtifactReviewState;
  producer?: string;
}
export interface ArtifactList {
  items: VideoArtifact[];
  total: number;
  limit: number;
  offset: number;
}
export interface ReviewArtifactInput {
  id: string;
  expectedRevision: number;
  state: ArtifactReviewState;
  note?: string;
}
export interface ReportAssetAvailabilityInput {
  id: string;
  expectedRevision: number;
  state: "available" | "missing";
}
export interface CreateArtifactHandoffInput {
  requestKey: string;
  artifactId: string;
  expectedReviewRevision: number;
}
/** Immutable receipt, not a publish task, upload, or platform authorization. */
export interface ArtifactHandoff {
  schemaVersion: 1;
  id: string;
  ownerId: string;
  deviceId: string;
  artifact: VideoArtifact;
  assets: MediaAsset[];
  createdAt: string;
}
/** Both worktrees depend on this port rather than one another's job models. */
export interface ArtifactExchange {
  registerAsset(input: RegisterMediaAssetInput): Promise<MediaAsset>;
  getAsset(id: string): Promise<MediaAsset>;
  reportAvailability(input: ReportAssetAvailabilityInput): Promise<MediaAsset>;
  createArtifact(input: CreateArtifactInput): Promise<VideoArtifact>;
  getArtifact(id: string): Promise<VideoArtifact>;
  listArtifacts(input?: ArtifactListInput): Promise<ArtifactList>;
  reviewArtifact(input: ReviewArtifactInput): Promise<VideoArtifact>;
  createHandoff(input: CreateArtifactHandoffInput): Promise<ArtifactHandoff>;
  getHandoff(id: string): Promise<ArtifactHandoff>;
}

/** Main/worker process only. Never serialize absolutePath to Renderer or cloud. */
export interface ResolvedLocalMedia {
  assetId: string;
  absolutePath: string;
  sha256: string;
  byteSize: number;
}
/** Implementation belongs to the local asset registry, not a production job. */
export interface LocalMediaAssetResolver {
  resolve(asset: MediaAsset): Promise<ResolvedLocalMedia>;
}
