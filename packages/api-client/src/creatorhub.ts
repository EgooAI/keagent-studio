import type {
  AnalysisJob,
  AnalysisJobSummary,
  CreatorHubConsent,
  CreatorHubStartInput,
  CreatorHubStartResult,
  CreatorHubStatus,
  LeadAnalysisPage,
  LeadIntent,
  LeadSettings,
  LeadTrial,
  WorkMonitorSummary,
  CommentDetailPage,
  OutreachTask,
} from "@keagent/shared-types";
import { desktopCloud, douyinDesktop } from "./douyin";

export const creatorHubApi = {
  status: () => douyinDesktop<CreatorHubStatus>("social.status"),
  reply: (input: {
    accountId: string;
    workId: string;
    commentId: string;
    text: string;
    requestKey: string;
  }) =>
    douyinDesktop<import("@keagent/shared-types").DouyinQueueRow>(
      "social.reply",
      input,
    ),
  monitors: () => douyinDesktop<WorkMonitorSummary[]>("social.monitors"),
  workHistory: () => douyinDesktop<WorkMonitorSummary[]>("social.workHistory"),
  scan: (id: string) =>
    douyinDesktop<CreatorHubStartResult>("social.scan", { id }),
  remove: (id: string) => douyinDesktop("social.remove", { id }),
  comments: (accountId: string, workId: string, cursor?: string) =>
    desktopCloud<CommentDetailPage>("collection", "comments/list", {
      accountId,
      workId,
      cursor,
      limit: 50,
    }),
  start: (input: CreatorHubStartInput) =>
    douyinDesktop<CreatorHubStartResult>("social.start", input),
  consent: (accountId: string, workId: string) =>
    desktopCloud<CreatorHubConsent>("collection", "lead/consent/get", {
      accountId,
      workId,
    }),
  revokeConsent: (accountId: string, workId: string) =>
    desktopCloud<unknown>("collection", "lead/consent/revoke", {
      accountId,
      workId,
    }),
  settings: () =>
    desktopCloud<LeadSettings>("collection", "lead/settings/get", {}),
  trial: () => desktopCloud<LeadTrial>("collection", "lead/settings/trial", {}),
  saveSettings: (input: unknown) =>
    desktopCloud<unknown>("collection", "lead/settings/save", input),
  analyze: (input: {
    accountId: string;
    workId: string;
    criteria: string;
    maxComments: number;
    requestKey: string;
  }) =>
    desktopCloud<AnalysisJob>("collection", "comments/analyze-batch", input),
  job: (jobId: string) =>
    desktopCloud<AnalysisJob>("collection", "comments/analysis/job", { jobId }),
  jobs: (input: { accountId?: string; workId?: string; limit?: number } = {}) =>
    desktopCloud<{ items: AnalysisJobSummary[] }>(
      "collection",
      "comments/analysis/jobs",
      input,
    ),
  retryAnalysis: (jobId: string, analysisIds?: string[]) =>
    desktopCloud<AnalysisJob>(
      "collection",
      "comments/analysis/retry",
      analysisIds ? { jobId, analysisIds } : { jobId },
    ),
  retryDraft: (analysisId: string) =>
    desktopCloud<{ draft: string }>(
      "collection",
      "comments/analysis/retry-draft",
      { analysisId },
    ),
  analyses: (input: {
    jobId: string;
    qualified?: boolean;
    status?: string;
    intent?: LeadIntent;
    cursor?: string;
    limit?: number;
  }) =>
    desktopCloud<LeadAnalysisPage>(
      "collection",
      "comments/analysis/list",
      input,
    ),
  cancelAnalysis: (jobId: string) =>
    desktopCloud<AnalysisJob>("collection", "comments/analysis/cancel", {
      jobId,
    }),
  submitOutreach: (input: {
    analysisId: string;
    draft: string;
    requestKey: string;
  }) => douyinDesktop<OutreachTask>("outreach.submit", input),
  outreach: (input: { accountId: string; workId?: string; limit?: number }) =>
    desktopCloud<{ items: OutreachTask[] }>(
      "collection",
      "outreach/list",
      input,
    ),
  refreshOutreach: (outreachId: string, attempt: number) =>
    douyinDesktop<OutreachTask>("outreach.refresh", { outreachId, attempt }),
  cancelOutreach: (outreachId: string, attempt: number) =>
    douyinDesktop<OutreachTask>("outreach.cancel", { outreachId, attempt }),
  confirmOutreach: (
    outreachId: string,
    attempt: number,
    status: "sent" | "failed",
  ) =>
    douyinDesktop<OutreachTask>("outreach.confirm", {
      outreachId,
      attempt,
      status,
    }),
};
