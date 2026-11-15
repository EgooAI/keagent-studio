import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type {
  CreatorHubStartResult,
  OutreachTask,
} from "@keagent/shared-types";

export interface LeadStarted {
  workId: string;
  accountId: string;
  result: CreatorHubStartResult;
  observedAt: string;
}

interface CommentLeadData {
  step: number;
  url: string;
  accountId: string;
  accepted: boolean;
  retentionDays: number;
  consentDays: number;
  criteria: string;
  maxComments: number;
  showAll: boolean;
  settingsHydrated: boolean;
  started?: LeadStarted;
  jobId: string;
  deferredIds: string[];
  activeId: string;
  drafts: Record<string, string>;
  submitted: Record<string, OutreachTask>;
  startKey: string;
  analyzeKey: string;
  submitKeys: Record<string, string>;
}

interface CommentLeadState extends CommentLeadData {
  update: (patch: Partial<CommentLeadData>) => void;
  reset: () => void;
}

const initial: CommentLeadData = {
  step: 0,
  url: "",
  accountId: "",
  accepted: false,
  retentionDays: 7,
  consentDays: 30,
  criteria: "",
  maxComments: 200,
  showAll: false,
  settingsHydrated: false,
  started: undefined,
  jobId: "",
  deferredIds: [],
  activeId: "",
  drafts: {},
  submitted: {},
  startKey: "",
  analyzeKey: "",
  submitKeys: {},
};

export const useCommentLeadStore = create<CommentLeadState>()(
  persist(
    (set) => ({
      ...initial,
      update: (patch) => set(patch),
      reset: () => set(initial),
    }),
    {
      name: "keagent.comment-lead.v1",
      storage: createJSONStorage(() => sessionStorage),
      partialize: ({ update: _update, reset: _reset, ...data }) => data,
    },
  ),
);
