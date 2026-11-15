import type {
  AnalysisJobSummary,
  CommentDetail,
  CommentSourceState,
  LeadAnalysisRow,
  OutreachTask,
} from "./collection";

export interface WorkspaceAccount {
  id: string;
  nickname: string;
  platform: "douyin" | "xhs";
}

export interface WorkspaceQuery {
  accountId: string;
  workId?: string;
  analysisId?: string;
  jobId?: string;
  search?: string;
  status?: string;
  cursor?: string;
  limit?: number;
}

export interface WorkspacePage<T> {
  items: T[];
  nextCursor?: string;
}

interface WorkspaceSource {
  accountId: string;
  workId: string;
  title: string;
  sourceState: CommentSourceState;
  canAnalyze: boolean;
  canContact: boolean;
}

export interface WorkspaceWork extends WorkspaceSource {
  lastSyncedAt?: string;
  readCount: number;
  addedCount: number;
  commentCount: number;
}

export interface WorkspaceComment extends CommentDetail, WorkspaceSource {}

export interface WorkspaceOutreach extends OutreachTask {
  accountId: string;
  workId: string;
  commenterName: string;
  method: string;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  finishedAt: string | null;
}

export interface WorkspaceLead extends LeadAnalysisRow, WorkspaceSource {
  commentRowId: string;
  manualDraft: string | null;
  reviewStatus: "pending" | "skipped" | "queued";
  outreach?: WorkspaceOutreach;
  outreachStatus?: OutreachTask["status"];
}

export interface WorkspaceJob extends AnalysisJobSummary {
  title: string;
  criteria: string;
}
