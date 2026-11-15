import type {
  WorkspaceAccount,
  WorkspaceComment,
  WorkspaceJob,
  WorkspaceLead,
  WorkspaceOutreach,
  WorkspacePage,
  WorkspaceQuery,
  WorkspaceWork,
} from "@keagent/shared-types";
import { desktopCloud } from "./douyin";

function workspace<T>(op: string, input: unknown) {
  return desktopCloud<T>("collection", "lead/workspace/" + op, input);
}

export const leadWorkspaceApi = {
  accounts: () => workspace<{ items: WorkspaceAccount[] }>("accounts", {}),
  overview: (input: { accountId: string }) =>
    workspace<{ pending: number; missingDraft: number; uncertain: number }>(
      "overview",
      input,
    ),
  works: (input: WorkspaceQuery) =>
    workspace<WorkspacePage<WorkspaceWork>>("works", input),
  comments: (input: WorkspaceQuery) =>
    workspace<WorkspacePage<WorkspaceComment>>("comments", input),
  leads: (input: WorkspaceQuery) =>
    workspace<WorkspacePage<WorkspaceLead>>("leads", input),
  jobs: (input: WorkspaceQuery) =>
    workspace<WorkspacePage<WorkspaceJob>>("jobs", input),
  outreach: (input: WorkspaceQuery) =>
    workspace<WorkspacePage<WorkspaceOutreach>>("outreach", input),
  saveReview: (input: {
    analysisId: string;
    draft?: string | null;
    skipped?: boolean;
  }) => workspace<{ ok: true }>("save-review", input),
};
