import type {
  AnalysisJob,
  CreatorHubConsent,
  CreatorHubStartInput,
  CreatorHubStartResult,
  CreatorHubStatus,
  LeadAnalysisPage,
  LeadIntent,
  LeadSettings,
  OutreachTask,
} from "@keagent/shared-types";
import { desktopCloud, douyinDesktop } from "./douyin";

export const creatorHubApi = {
  status: () => douyinDesktop<CreatorHubStatus>("creatorhub.status"),
  login: () => douyinDesktop<CreatorHubStatus>("creatorhub.login"),
  start: (input: CreatorHubStartInput) =>
    douyinDesktop<CreatorHubStartResult>("creatorhub.start", input),
  saveConsent: (input: unknown) =>
    desktopCloud<unknown>("collection", "creatorhub/consent/save", input),
  consent: (accountId: string, workId: string) =>
    desktopCloud<CreatorHubConsent>("collection", "creatorhub/consent/get", {
      accountId,
      workId,
    }),
  revokeConsent: (accountId: string, workId: string) =>
    desktopCloud<unknown>("collection", "creatorhub/consent/revoke", {
      accountId,
      workId,
    }),
  settings: () =>
    desktopCloud<LeadSettings>("collection", "lead/settings/get", {}),
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
  retryAnalysis: (jobId: string, analysisIds?: string[]) =>
    desktopCloud<AnalysisJob>(
      "collection",
      "comments/analysis/retry",
      analysisIds ? { jobId, analysisIds } : { jobId },
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
