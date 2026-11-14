export type CommentPanelStatus =
  | "not_checked"
  | "visible"
  | "explicitly_empty"
  | "not_visible"
  | "loading"
  | "load_failed"
  | "restricted"
  | "unknown";

export interface CommentObservation {
  id: string;
  accountId: string;
  deviceId: string;
  targetUrl: string;
  inputWorkId: string;
  verifiedWorkId?: string;
  author?: { name: string; url: string };
  title?: string;
  state: "queued" | "running" | "finished" | "stopped";
  panelStatus: CommentPanelStatus;
  startedAt: string;
  endedAt?: string;
  reason?: string;
  errorCode?: string;
  screenshotSaved?: boolean;
}
