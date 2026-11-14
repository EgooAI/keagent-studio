import type {
  CommentObservation,
  CommentPanelStatus,
} from "./comment-observation";

export type CollectionTargetKind = "video" | "creator" | "keyword";
export interface CollectionTargetInput {
  kind: CollectionTargetKind;
  value: string;
  name: string;
  accountId: string;
}

export interface CollectionTarget extends CollectionTargetInput {
  id: string;
  deviceId: string;
  state: "active" | "paused" | "archived";
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type CollectionRunState =
  | "queued"
  | "running"
  | "succeeded"
  | "partial"
  | "failed"
  | "blocked"
  | "canceled"
  | "interrupted";

export interface CollectionRun {
  id: string;
  targetId: string;
  targetName: string;
  targetArchived?: boolean;
  targetVersion: number;
  targetUrl: string;
  inputWorkId: string;
  accountId: string;
  deviceId: string;
  state: CollectionRunState;
  panelStatus: CommentPanelStatus;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  verifiedWorkId?: string;
  title?: string;
  author?: CommentObservation["author"];
  errorCode?: string;
  reason?: string;
}

export interface MonitoredVideo {
  id: string;
  targetUrl: string;
  title?: string;
  author: NonNullable<CommentObservation["author"]>;
  lastRunId: string;
  lastObservedAt: string;
  accountId: string;
  deviceId: string;
  panelStatus: CommentPanelStatus;
}

export interface CollectionPage<T> {
  items: T[];
  nextCursor?: string;
}

export type CommentCoverage = "unknown" | "partial" | "complete";
export type CommentSourceState =
  "unconfigured" | "active" | "expired" | "revoked";

export interface CommentDetail {
  id: string;
  comment_id: string | null;
  parent_comment_id: string | null;
  comment_text: string | null;
  commenter_name: string | null;
  commenter_profile: string | null;
  comment_time: string | null;
  like_count: number | null;
  reply_count: number | null;
  truncated: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  updatedAt: string;
}

export interface CommentDetailPage extends CollectionPage<CommentDetail> {
  canAnalyze: boolean;
  canContact: boolean;
  sourceState: CommentSourceState;
  sourceLabel?: string;
  coverage: CommentCoverage;
  lastSyncedAt?: string;
}

export interface CommentAnalysis {
  intent:
    | "buy"
    | "rent"
    | "sell"
    | "let"
    | "viewing"
    | "question"
    | "unrelated"
    | "unclear";
  evidence: string;
  draft: string;
}

export interface CommentSyncResult {
  coverage: CommentCoverage;
  readCount: number;
  addedCount: number;
  updatedCount: number;
  syncedAt: string;
}
