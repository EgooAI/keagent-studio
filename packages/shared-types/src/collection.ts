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
