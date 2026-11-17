import "./leads/lead-utilities.css";
import { WorkMonitors } from "./WorkMonitors";
import { useEffect, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Empty,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Progress,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import "./comment-lead.css";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  creatorHubApi,
  isLive,
  ServiceRequestError,
} from "@keagent/api-client";
import type {
  CreatorHubConsent,
  LeadAnalysisRow,
  OutreachStatus,
  OutreachTask,
} from "@keagent/shared-types";
import { PageHeader } from "../components/common";
import { useCommentLeadStore } from "../lib/commentLeadStore";
import { desktopPublishingAvailable } from "../lib/douyin";

const intentLabels: Record<string, string> = {
  buy: "求购",
  rent: "求租",
  sell: "出售",
  let: "出租",
  viewing: "约看",
  question: "咨询",
  unrelated: "无关",
  unclear: "不明确",
};
const intentColors: Record<string, string> = {
  buy: "magenta",
  rent: "blue",
  sell: "orange",
  let: "gold",
  viewing: "purple",
  question: "cyan",
  unrelated: "default",
  unclear: "default",
};
const outreachLabels: Record<OutreachStatus, string> = {
  approved: "待发送",
  submitted: "排队中",
  sending: "发送中",
  sent: "已发送",
  uncertain: "结果待确认",
  failed: "失败",
  canceled: "已取消",
};
const consentLabels: Record<CreatorHubConsent["state"], string> = {
  active: "有效",
  revoked: "已撤销",
  expired: "已过期",
  unconfigured: "未配置",
};
const consentColors: Record<CreatorHubConsent["state"], string> = {
  active: "success",
  revoked: "error",
  expired: "warning",
  unconfigured: "default",
};
const coverageLabels: Record<string, string> = {
  partial: "部分覆盖（可能不含全部回复）",
  complete: "完整",
  unknown: "未知",
};
const definitiveSubmitCodes = new Set([
  "CREATORHUB_URL_INVALID",
  "ACCOUNT_UNAVAILABLE",
  "QUEUE_FULL",
  "COMMENT_PROFILE_UNAVAILABLE",
  "COMMENT_PURPOSE_DENIED",
  "COMMENT_NOT_QUALIFIED",
  "COMMENT_CHANGED",
  "INVALID_INPUT",
  "FORBIDDEN",
  "OUTREACH_EXISTS",
]);
const terminalOutreachStatuses = new Set<OutreachStatus>([
  "sent",
  "uncertain",
  "failed",
  "canceled",
]);
const outreachStatusRank: Record<OutreachStatus, number> = {
  approved: 0,
  submitted: 1,
  sending: 2,
  uncertain: 3,
  failed: 3,
  canceled: 3,
  sent: 4,
};
function preferOutreach(
  current: OutreachTask | undefined,
  incoming: OutreachTask,
) {
  if (!current) return incoming;
  if (current.attempt !== incoming.attempt)
    return incoming.attempt > current.attempt ? incoming : current;
  const currentRank = outreachStatusRank[current.status] ?? -1;
  const incomingRank = outreachStatusRank[incoming.status] ?? -1;
  return incomingRank > currentRank ? incoming : current;
}
function definitiveSubmitError(error: unknown) {
  if (!(error instanceof ServiceRequestError)) return false;
  if (error.code === "CREATORHUB_REJECTED")
    return [400, 403, 404, 422].includes(error.status);
  return definitiveSubmitCodes.has(error.code ?? "");
}
function isOutreachExists(error: unknown) {
  return (
    error instanceof ServiceRequestError && error.code === "OUTREACH_EXISTS"
  );
}
function outreachRefreshable(status: OutreachStatus) {
  return (
    status === "submitted" || status === "sending" || status === "uncertain"
  );
}
function outreachDraftEditable(task: OutreachTask | undefined) {
  return (
    !task ||
    task.status === "approved" ||
    task.status === "failed" ||
    task.status === "canceled"
  );
}
function boundedError(value: string, limit = 120) {
  const chars = Array.from(value);
  return chars.length > limit ? `${chars.slice(0, limit).join("")}…` : value;
}
function commentWithEvidence(row: LeadAnalysisRow) {
  const { commentText, evidence } = row;
  const index = evidence ? commentText.indexOf(evidence) : -1;
  if (index < 0) return commentText;
  return (
    <>
      {commentText.slice(0, index)}
      <mark>{evidence}</mark>
      {commentText.slice(index + evidence.length)}
    </>
  );
}
const rateLimitNote =
  "私信与视频发布共用本机队列。同一账号两条私信至少间隔 15 分钟，每小时最多 2 条，24 小时最多 8 条。";

export default function CommentLeadPage() {
  if (!isLive || !desktopPublishingAvailable()) {
    return (
      <>
        <PageHeader
          title="评论获客"
          description="从抖音作品或小红书笔记抓取评论，分析后人工审核私信草稿。"
        />
        <Alert
          showIcon
          type="info"
          title="请在桌面客户端打开评论获客"
          description="评论抓取、分析与私信提交需要已登录的桌面客户端。"
        />
      </>
    );
  }
  return <CommentLeadWorkspace />;
}

function CommentLeadWorkspace() {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [monitorsOpen, setMonitorsOpen] = useState(false);
  const [monitor, setMonitor] = useState(false);
  const lead = useCommentLeadStore();
  const update = lead.update;
  const {
    step,
    url,
    accountId,
    accepted,
    retentionDays,
    consentDays,
    criteria,
    maxComments,
    showAll,
    started,
    jobId,
    drafts,
    submitted,
  } = lead;
  const [batchSelect, setBatchSelect] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [reviewFilter, setReviewFilter] = useState("all");
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchProgress, setBatchProgress] = useState("");
  const submitKeyFor = (analysisId: string) => {
    const current = useCommentLeadStore.getState();
    const existing = current.submitKeys[analysisId];
    if (existing) return existing;
    const key = crypto.randomUUID();
    current.update({
      submitKeys: { ...current.submitKeys, [analysisId]: key },
    });
    return key;
  };
  const clearSubmitKey = (analysisId: string) => {
    const current = useCommentLeadStore.getState();
    if (!current.submitKeys[analysisId]) return;
    const next = { ...current.submitKeys };
    delete next[analysisId];
    current.update({ submitKeys: next });
  };
  const saveSubmitted = (analysisId: string, task: OutreachTask) => {
    const current = useCommentLeadStore.getState();
    current.update({ submitted: { ...current.submitted, [analysisId]: task } });
  };
  const resetLead = () => {
    useCommentLeadStore.getState().reset();
    setSelectedKeys([]);
    setReviewFilter("all");
    setBatchSelect(false);
    setBatchOpen(false);
    setBatchRunning(false);
    setBatchProgress("");
    queryClient.removeQueries({ queryKey: ["creatorhub", "job"] });
    queryClient.removeQueries({ queryKey: ["creatorhub", "analyses"] });
    queryClient.removeQueries({ queryKey: ["creatorhub", "outreach"] });
    queryClient.removeQueries({ queryKey: ["creatorhub", "consent"] });
  };
  const start = useMutation({
    mutationFn: async (analyzeAfterRead: boolean) => {
      const current = useCommentLeadStore.getState();
      const requestKey = current.startKey || crypto.randomUUID();
      if (!current.startKey) current.update({ startKey: requestKey });
      const result = await creatorHubApi.start({
        url: current.url,
        monitor,
        accountId: current.accountId,
        requestKey,
        consent: {
          accepted: current.accepted,
          retentionDays: current.retentionDays,
          expiresAt: new Date(
            Date.now() + current.consentDays * 86400000,
          ).toISOString(),
        },
      });
      return { result, requestKey, analyzeAfterRead };
    },
    onSuccess: ({ result, requestKey, analyzeAfterRead }) => {
      const current = useCommentLeadStore.getState();
      if (current.startKey !== requestKey) return;
      current.update({
        startKey: "",
        started: {
          workId: result.awemeId,
          accountId: result.accountId,
          result,
          observedAt: new Date().toISOString(),
        },
        step: 1,
      });
      void queryClient.invalidateQueries({ queryKey: ["work-monitors"] });
      if (analyzeAfterRead && result.readCount > 0) analyze.mutate();
      else setMonitorsOpen(true);
    },
    onError: () => {
      void queryClient.invalidateQueries({
        queryKey: ["creatorhub", "status"],
      });
    },
    retry: false,
  });
  const status = useQuery({
    queryKey: ["creatorhub", "status"],
    queryFn: creatorHubApi.status,
    retry: false,
    refetchInterval: (query) => {
      if (start.isPending) return 1000;
      return query.state.data?.health === "offline" ? 5000 : false;
    },
  });
  const settings = useQuery({
    queryKey: ["creatorhub", "settings"],
    queryFn: creatorHubApi.settings,
    retry: false,
  });
  useEffect(() => {
    if (!settings.data || lead.settingsHydrated) return;
    update({
      settingsHydrated: true,
      criteria: settings.data.criteria,
      maxComments: settings.data.maxComments,
    });
  }, [settings.data, lead.settingsHydrated, update]);
  const presets = [
    {
      label: "有明确房产需求的人",
      value: settings.data?.defaultCriteria ?? "",
    },
    { label: "想约看房源的人", value: "想约看房源的人" },
    { label: "询问租金或售价的人", value: "询问租金或售价的人" },
  ];
  const customCriteria =
    lead.settingsHydrated &&
    !presets.some((option) => option.value === criteria);
  const accounts = status.data?.accounts ?? [];
  useEffect(() => {
    if (accountId) return;
    const preferred = status.data?.selectedAccountId;
    if (preferred && accounts.some((account) => account.id === preferred)) {
      update({ accountId: preferred });
      return;
    }
    if (accounts.length === 1) update({ accountId: accounts[0].id });
  }, [status.data, accounts, accountId, update]);
  useEffect(() => {
    if (!status.data || !accountId) return;
    if (!accounts.some((account) => account.id === accountId))
      update({ accountId: "" });
  }, [accounts, accountId, status.data, update]);
  const consentKey = [
    "creatorhub",
    "consent",
    started?.accountId,
    started?.workId,
  ] as const;
  const consent = useQuery({
    queryKey: consentKey,
    queryFn: () => creatorHubApi.consent(started!.accountId, started!.workId),
    enabled: !!started,
    retry: false,
  });
  const revokeConsent = useMutation({
    mutationFn: () =>
      creatorHubApi.revokeConsent(started!.accountId, started!.workId),
    onSuccess: () => {
      queryClient.setQueryData<CreatorHubConsent>(consentKey, (current) => ({
        ...current,
        state: "revoked",
      }));
      setBatchOpen(false);
      setSelectedKeys([]);
      void queryClient.invalidateQueries({ queryKey: consentKey });
      void message.warning("已撤销来源授权");
    },
    retry: false,
  });
  const consentActive = consent.data?.state === "active" && !consent.isError;
  const analyze = useMutation({
    mutationFn: async () => {
      const current = useCommentLeadStore.getState();
      if (!current.started) throw new Error("请先完成评论抓取");
      const requestKey = current.analyzeKey || crypto.randomUUID();
      if (!current.analyzeKey) current.update({ analyzeKey: requestKey });
      const grant = await queryClient.fetchQuery({
        queryKey: [
          "creatorhub",
          "consent",
          current.started.accountId,
          current.started.workId,
        ],
        queryFn: () =>
          creatorHubApi.consent(
            current.started!.accountId,
            current.started!.workId,
          ),
        staleTime: 0,
      });
      if (grant.state !== "active")
        throw new Error("来源授权已失效，请重新抓取评论。");
      if (useCommentLeadStore.getState().analyzeKey !== requestKey)
        throw new Error("当前任务已切换");
      const job = await creatorHubApi.analyze({
        accountId: current.started.accountId,
        workId: current.started.workId,
        criteria: current.criteria,
        maxComments: current.maxComments,
        requestKey,
      });
      return { job, requestKey };
    },
    onSuccess: ({ job, requestKey }) => {
      const current = useCommentLeadStore.getState();
      if (current.analyzeKey === requestKey)
        current.update({ analyzeKey: "", jobId: job.id, step: 2 });
    },
    retry: false,
  });
  const job = useQuery({
    queryKey: ["creatorhub", "job", jobId],
    queryFn: () => creatorHubApi.job(jobId),
    enabled: !!jobId,
    refetchInterval: (query) =>
      ["queued", "running"].includes(query.state.data?.status || "")
        ? 2000
        : false,
  });
  useEffect(() => {
    if (step === 2 && job.data?.status === "done") update({ step: 3 });
  }, [step, job.data?.status, update]);
  const cancel = useMutation({
    mutationFn: () => creatorHubApi.cancelAnalysis(jobId),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ["creatorhub", "job", jobId],
      }),
    retry: false,
  });
  const retry = useMutation({
    mutationFn: () => creatorHubApi.retryAnalysis(jobId),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ["creatorhub", "job", jobId],
      }),
    retry: false,
  });
  const failedItems = useQuery({
    queryKey: ["creatorhub", "analyses", "failed", jobId],
    queryFn: () =>
      creatorHubApi.analyses({ jobId, status: "failed", limit: 500 }),
    enabled:
      consentActive &&
      step === 2 &&
      !!jobId &&
      ["partial", "failed"].includes(job.data?.status || ""),
    retry: false,
  });
  const retryItem = useMutation({
    mutationFn: (analysisId: string) =>
      creatorHubApi.retryAnalysis(jobId, [analysisId]),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["creatorhub", "job", jobId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["creatorhub", "analyses", "failed", jobId],
      });
      void message.success("已重新提交该条分析");
    },
    retry: false,
  });
  const results = useQuery({
    queryKey: ["creatorhub", "analyses", jobId, showAll],
    queryFn: () =>
      creatorHubApi.analyses({
        jobId,
        qualified: showAll ? undefined : true,
        limit: 500,
      }),
    enabled:
      consentActive &&
      !!jobId &&
      ["done", "partial"].includes(job.data?.status || ""),
  });
  const retryDraft = useMutation({
    mutationFn: creatorHubApi.retryDraft,
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["creatorhub", "analyses"] }),
    retry: false,
  });
  const canContact =
    consentActive && consent.data?.purposes?.manualContact === true;
  const outreachKey = [
    "creatorhub",
    "outreach",
    started?.accountId,
    started?.workId,
  ] as const;
  const outreach = useQuery({
    queryKey: outreachKey,
    queryFn: () =>
      creatorHubApi.outreach({
        accountId: started!.accountId,
        workId: started!.workId,
        limit: 500,
      }),
    enabled: step === 3 && !!started,
    retry: false,
  });
  const updateOutreachCache = (task: OutreachTask) => {
    queryClient.setQueryData<{ items: OutreachTask[] }>(
      outreachKey,
      (current) => {
        if (!current) return current;
        const index = current.items.findIndex(
          (item) => item.analysisId === task.analysisId,
        );
        if (index < 0) return current;
        const items = [...current.items];
        items[index] = task;
        return { ...current, items };
      },
    );
  };
  const confirm = useMutation({
    mutationFn: (input: { task: OutreachTask; status: "sent" | "failed" }) =>
      creatorHubApi.confirmOutreach(
        input.task.id,
        input.task.attempt,
        input.status,
      ),
    onSuccess: (task) => {
      clearSubmitKey(task.analysisId);
      saveSubmitted(task.analysisId, task);
      updateOutreachCache(task);
      void queryClient.invalidateQueries({ queryKey: outreachKey });
      void message.success(
        task.status === "sent" ? "已确认发送" : "已确认失败",
      );
    },
    retry: false,
  });
  const refreshTask = useMutation({
    mutationFn: (task: OutreachTask) =>
      creatorHubApi.refreshOutreach(task.id, task.attempt),
    onSuccess: (task, previous) => {
      saveSubmitted(task.analysisId || previous.analysisId, task);
      updateOutreachCache(task);
      void queryClient.invalidateQueries({ queryKey: outreachKey });
      if (
        task.status !== previous.status &&
        terminalOutreachStatuses.has(task.status)
      )
        void message.info(`任务状态已更新：${outreachLabels[task.status]}`);
    },
    onError: (error) => void message.error(error.message),
    retry: false,
  });
  const cancelTask = useMutation({
    mutationFn: (task: OutreachTask) =>
      creatorHubApi.cancelOutreach(task.id, task.attempt),
    onSuccess: (task) => {
      saveSubmitted(task.analysisId, task);
      updateOutreachCache(task);
      void queryClient.invalidateQueries({ queryKey: outreachKey });
      void message.success("已取消发送");
    },
    onError: (error) => void message.error(error.message),
    retry: false,
  });
  const tasksByAnalysis = new Map<string, OutreachTask>();
  for (const [analysisId, task] of Object.entries(submitted))
    tasksByAnalysis.set(analysisId, task);
  for (const task of outreach.data?.items ?? []) {
    const current = tasksByAnalysis.get(task.analysisId);
    tasksByAnalysis.set(task.analysisId, preferOutreach(current, task));
  }
  useEffect(() => {
    if (!results.data) return;
    const visible = new Set(results.data.items.map((row) => row.id));
    setSelectedKeys((current) => {
      const next = current.filter((key) => visible.has(key));
      return next.length === current.length ? current : next;
    });
  }, [results.data]);
  const selectableRow = (row: LeadAnalysisRow) => {
    if (
      !row.qualified ||
      row.status === "failed" ||
      lead.deferredIds.includes(row.id)
    )
      return false;
    const task = tasksByAnalysis.get(row.id);
    if (task && task.status !== "failed" && task.status !== "canceled")
      return false;
    const draft = (drafts[row.id] ?? task?.draft ?? row.draft).trim();
    return !!draft && !!row.commenterProfile;
  };
  const reviewState = (row: LeadAnalysisRow) => {
    const task = tasksByAnalysis.get(row.id);
    if (task) return outreachLabels[task.status];
    if (row.status === "failed") return "分析失败";
    if (!row.qualified) return "未达标";
    if (lead.deferredIds.includes(row.id)) return "暂不联系";
    return row.draftError ? "待补草稿" : "待审核";
  };
  const rows = results.data?.items ?? [];
  const visibleRows = rows.filter(
    (row) => reviewFilter === "all" || reviewState(row) === reviewFilter,
  );
  const active =
    visibleRows.find((row) => row.id === lead.activeId) ?? visibleRows[0];
  const activeTask = active && tasksByAnalysis.get(active.id);
  const editable =
    !!active &&
    active.qualified &&
    canContact &&
    active.status !== "failed" &&
    outreachDraftEditable(activeTask);
  const activeDraft = active
    ? ((editable ? drafts[active.id] : undefined) ??
      activeTask?.draft ??
      active.draft)
    : "";
  const selectedIds = new Set(selectedKeys);
  const selectable = visibleRows.filter(selectableRow);
  const selectableIds = selectable.map((row) => row.id);
  const selectedRows = selectable.filter((row) => selectedIds.has(row.id));
  const checkedIds = new Set(selectedRows.map((row) => row.id));
  const switchFilter = (value: string) => {
    setReviewFilter(value);
    setSelectedKeys([]);
  };
  const runBatchSubmit = async () => {
    const rows = selectedRows;
    if (rows.length === 0 || actionsDisabled) return;
    setBatchRunning(true);
    const processed: string[] = [];
    const nextSubmitted: Record<string, OutreachTask> = {};
    let success = 0;
    let uncertain = 0;
    let failed = 0;
    let skipped = 0;
    try {
      for (const [index, row] of rows.entries()) {
        setBatchProgress(`正在提交 ${index + 1}/${rows.length}`);
        const task = tasksByAnalysis.get(row.id);
        const draft = (drafts[row.id] ?? task?.draft ?? row.draft).trim();
        const requestKey = submitKeyFor(row.id);
        try {
          const result = await creatorHubApi.submitOutreach({
            analysisId: row.id,
            draft,
            requestKey,
          });
          processed.push(row.id);
          if (
            result.status === "submitted" ||
            result.status === "sending" ||
            result.status === "sent"
          ) {
            clearSubmitKey(row.id);
            nextSubmitted[row.id] = result;
            success++;
          } else if (result.status === "uncertain") {
            // Keep the key: the same key must not trigger a new send.
            nextSubmitted[row.id] = result;
            uncertain++;
          } else {
            clearSubmitKey(row.id);
            failed++;
          }
        } catch (error) {
          processed.push(row.id);
          if (
            error instanceof ServiceRequestError &&
            error.code === "OUTREACH_UNCERTAIN"
          ) {
            // Keep the key; the list refresh below surfaces the uncertain task.
            uncertain++;
          } else {
            if (definitiveSubmitError(error)) clearSubmitKey(row.id);
            if (isOutreachExists(error)) skipped++;
            else failed++;
          }
        }
      }
      const current = useCommentLeadStore.getState();
      current.update({
        submitted: { ...current.submitted, ...nextSubmitted },
      });
    } finally {
      setBatchRunning(false);
      setBatchProgress("");
      setBatchOpen(false);
      setSelectedKeys((current) =>
        current.filter((key) => !processed.includes(key)),
      );
      void queryClient.invalidateQueries({ queryKey: outreachKey });
    }
    const parts = [
      `已受理 ${success}`,
      `待确认 ${uncertain}`,
      `失败 ${failed}`,
    ];
    if (skipped) parts.push(`跳过 ${skipped}`);
    void message.info(`批量提交：${parts.join("，")}`);
  };
  const submit = useMutation({
    mutationFn: (input: {
      row: LeadAnalysisRow;
      draft: string;
      requestKey?: string;
    }) => {
      const requestKey = input.requestKey || submitKeyFor(input.row.id);
      return creatorHubApi.submitOutreach({
        analysisId: input.row.id,
        draft: input.draft.trim(),
        requestKey,
      });
    },
    onSuccess: (task, { row }) => {
      if (
        task.status === "submitted" ||
        task.status === "sending" ||
        task.status === "sent"
      ) {
        clearSubmitKey(row.id);
        saveSubmitted(row.id, task);
        void message.success("已加入本机账号执行队列");
      } else if (task.status === "uncertain") {
        // Keep the key: the same key must not trigger a new send.
        saveSubmitted(row.id, task);
        void message.warning("结果待确认，请到平台会话核对后再确认");
      } else {
        // failed/canceled (or an unexpected non-approved status)
        clearSubmitKey(row.id);
        void message.error("上次提交未完成，请重试");
      }
      void queryClient.invalidateQueries({ queryKey: outreachKey });
    },
    onError: (error, { row }) => {
      // Definitive failures leave Go in `failed`; a new attempt needs a new key.
      if (definitiveSubmitError(error)) {
        clearSubmitKey(row.id);
        void queryClient.invalidateQueries({ queryKey: outreachKey });
      }
      if (isOutreachExists(error)) {
        void message.info("该评论已有私信任务，已刷新状态");
      }
    },
    retry: false,
  });
  const actionsDisabled =
    !canContact || !outreach.data || outreach.isError || batchRunning;
  const renderActions = (row: LeadAnalysisRow) => {
    if (row.status === "failed") {
      const error = row.error || "分析失败";
      return (
        <Tooltip title={error}>
          <Typography.Text
            type="danger"
            style={{ display: "inline-block", maxWidth: 150 }}
            ellipsis
          >
            分析失败：{error}
          </Typography.Text>
        </Tooltip>
      );
    }
    const task = tasksByAnalysis.get(row.id);
    if (task) {
      const draft = (drafts[row.id] ?? task.draft ?? row.draft).trim();
      return (
        <Space orientation="vertical" size={4}>
          {(task.status === "uncertain" || task.status === "failed") &&
            task.error && (
              <Tooltip title={boundedError(task.error)}>
                <Typography.Text
                  type="danger"
                  style={{ display: "inline-block", maxWidth: 150 }}
                  ellipsis
                >
                  {boundedError(task.error)}
                </Typography.Text>
              </Tooltip>
            )}
          {["approved", "submitted", "sending"].includes(task.status) &&
            task.creatorhubTaskId && (
              <Popconfirm
                title="取消发送？"
                description="将取消本机队列中的这条私信，取消后可在本页重新提交。"
                okText="确认"
                cancelText="取消"
                onConfirm={() => cancelTask.mutate(task)}
              >
                <Button
                  size="small"
                  danger
                  disabled={actionsDisabled}
                  loading={
                    cancelTask.isPending && cancelTask.variables?.id === task.id
                  }
                >
                  取消发送
                </Button>
              </Popconfirm>
            )}
          {outreachRefreshable(task.status) && (
            <Button
              size="small"
              disabled={actionsDisabled}
              loading={
                refreshTask.isPending && refreshTask.variables?.id === task.id
              }
              onClick={() => refreshTask.mutate(task)}
            >
              刷新状态
            </Button>
          )}
          {task.status === "uncertain" && (
            <Space size={4} wrap>
              <Popconfirm
                title="确认私信已发送？"
                description="确认后任务将标记为已发送，且无法撤销。"
                okText="确认"
                cancelText="取消"
                onConfirm={() => confirm.mutate({ task, status: "sent" })}
              >
                <Button
                  size="small"
                  type="primary"
                  disabled={actionsDisabled}
                  loading={
                    confirm.isPending && confirm.variables?.task.id === task.id
                  }
                >
                  确认已发送
                </Button>
              </Popconfirm>
              <Popconfirm
                title="确认私信发送失败？"
                description="确认后任务将标记为失败，且无法撤销。"
                okText="确认"
                cancelText="取消"
                onConfirm={() => confirm.mutate({ task, status: "failed" })}
              >
                <Button
                  size="small"
                  disabled={actionsDisabled}
                  loading={
                    confirm.isPending && confirm.variables?.task.id === task.id
                  }
                >
                  确认失败
                </Button>
              </Popconfirm>
            </Space>
          )}
          {task.status === "approved" && task.requestKey && (
            <Button
              size="small"
              type="primary"
              loading={submit.isPending && submit.variables?.row.id === row.id}
              disabled={actionsDisabled || !row.commenterProfile || !draft}
              onClick={() =>
                submit.mutate({ row, draft, requestKey: task.requestKey })
              }
            >
              继续发送
            </Button>
          )}
          {task.status === "approved" && !task.requestKey && (
            <Typography.Text type="warning">
              缺少请求标识，无法继续发送，请重新分析后再提交
            </Typography.Text>
          )}
          {(task.status === "failed" || task.status === "canceled") && (
            <Button
              size="small"
              type="primary"
              loading={submit.isPending && submit.variables?.row.id === row.id}
              disabled={actionsDisabled || !row.commenterProfile || !draft}
              onClick={() => submit.mutate({ row, draft })}
            >
              重新提交
            </Button>
          )}
        </Space>
      );
    }
    if (!row.qualified || lead.deferredIds.includes(row.id)) return null;
    const noProfile = !row.commenterProfile;
    const draft = (drafts[row.id] ?? row.draft).trim();
    return (
      <Space orientation="vertical" size={4}>
        <Button
          type="primary"
          disabled={actionsDisabled || noProfile || !draft}
          loading={submit.isPending && submit.variables?.row.id === row.id}
          onClick={() => submit.mutate({ row, draft })}
        >
          确认加入发送队列
        </Button>
        {noProfile && (
          <Typography.Text type="danger">
            缺少评论者主页，无法私信
          </Typography.Text>
        )}
      </Space>
    );
  };
  return (
    <div className="lead-utility-page lead-comment-page">
      <PageHeader
        title="评论获客"
        description={
          step === 0
            ? "从抖音作品或小红书笔记的评论里发现有明确房产需求的人。"
            : undefined
        }
        actions={
          <Space>
            <Button onClick={() => setMonitorsOpen(true)}>作品评论监控</Button>
            {step > 0 && (
              <Popconfirm
                title="开始新的任务？"
                description="当前抓取结果、分析进度和草稿将被清空。"
                okText="开始新任务"
                cancelText="取消"
                onConfirm={resetLead}
              >
                <Button
                  disabled={
                    analyze.isPending || batchRunning || submit.isPending
                  }
                >
                  开始新任务
                </Button>
              </Popconfirm>
            )}
          </Space>
        }
      />
      {status.isPending && (
        <Typography.Paragraph type="secondary">
          <Spin size="small" /> 正在读取本机平台账号…
        </Typography.Paragraph>
      )}
      {status.error && (
        <Alert
          type="error"
          showIcon
          title={status.error.message}
          action={<Button onClick={() => void status.refetch()}>重试</Button>}
          style={{ marginBottom: 16 }}
        />
      )}
      {settings.error && (
        <Alert
          type="error"
          showIcon
          title={settings.error.message}
          action={<Button onClick={() => void settings.refetch()}>重试</Button>}
          style={{ marginBottom: 16 }}
        />
      )}
      {(step === 0 || step === 1) && (
        <section className="lead-setup panel">
          <h2>{step === 0 ? "从视频评论中找客户" : "继续筛选这条视频"}</h2>
          <fieldset
            disabled={start.isPending || analyze.isPending}
            className="lead-fields"
          >
            {step === 0 && (
              <>
                <div className="lead-source-fields">
                  <div>
                    <label htmlFor="lead-url">作品详情页链接</label>
                    <Input
                      id="lead-url"
                      size="large"
                      value={url}
                      onChange={(e) =>
                        update({ url: e.target.value, startKey: "" })
                      }
                      placeholder="粘贴作品详情页链接"
                    />
                  </div>
                  <div>
                    <label htmlFor="lead-account">本机平台账号</label>
                    <Select
                      id="lead-account"
                      size="large"
                      value={accountId || undefined}
                      placeholder="选择账号"
                      disabled={start.isPending}
                      onChange={(value) =>
                        update({ accountId: value, startKey: "" })
                      }
                      options={accounts.map((a) => ({
                        value: a.id,
                        label:
                          (a.platform === "xhs" ? "小红书" : "抖音") +
                          " · " +
                          a.nickname,
                      }))}
                    />
                  </div>
                </div>
              </>
            )}
            {step === 1 && started && (
              <p>
                已读取 {started.result.readCount} 条评论，可以直接继续分析。
              </p>
            )}
            <div>
              <span className="lead-field-title" id="lead-criteria-label">
                这次想找什么客户？
              </span>
              <div
                className="lead-presets"
                role="group"
                aria-labelledby="lead-criteria-label"
              >
                {presets.map((option) => (
                  <Button
                    key={option.label}
                    aria-pressed={criteria === option.value}
                    disabled={!lead.settingsHydrated}
                    onClick={() =>
                      update({ criteria: option.value, analyzeKey: "" })
                    }
                  >
                    {option.label}
                  </Button>
                ))}
                <Button
                  aria-pressed={customCriteria}
                  disabled={!lead.settingsHydrated}
                  onClick={() => {
                    if (!customCriteria)
                      update({ criteria: "", analyzeKey: "" });
                  }}
                >
                  自定义条件
                </Button>
              </div>
              {customCriteria && (
                <Input.TextArea
                  id="lead-criteria"
                  aria-label="自定义筛选条件"
                  value={criteria}
                  disabled={start.isPending || analyze.isPending}
                  placeholder="例如：问到这套房的学区或约看时间的人"
                  onChange={(e) =>
                    update({ criteria: e.target.value, analyzeKey: "" })
                  }
                  autoSize={{ minRows: 2, maxRows: 6 }}
                />
              )}
            </div>
            <details className="lead-options">
              <summary>更多设置 · 最多分析 {maxComments} 条</summary>
              <div className="lead-options-fields">
                <label htmlFor="lead-max">
                  最多分析条数
                  <InputNumber
                    id="lead-max"
                    min={1}
                    max={500}
                    value={maxComments}
                    onChange={(v) =>
                      update({ maxComments: v || 200, analyzeKey: "" })
                    }
                  />
                </label>
                {step === 0 && (
                  <>
                    <label htmlFor="lead-retention">
                      默认留存天数
                      <InputNumber
                        id="lead-retention"
                        min={1}
                        max={90}
                        value={retentionDays}
                        onChange={(v) => update({ retentionDays: v || 7 })}
                      />
                    </label>
                    <label htmlFor="lead-consent-days">
                      授权有效期（天）
                      <InputNumber
                        id="lead-consent-days"
                        min={1}
                        max={365}
                        value={consentDays}
                        onChange={(v) => update({ consentDays: v || 30 })}
                      />
                    </label>
                  </>
                )}
              </div>
            </details>
            {step === 0 && (
              <Checkbox
                aria-label="来源授权"
                checked={accepted}
                onChange={(e) => update({ accepted: e.target.checked })}
              >
                我已获准读取评论、用 AI 筛选并在人工审核后联系评论者。评论留存{" "}
                {retentionDays} 天，授权有效 {consentDays} 天。
              </Checkbox>
            )}
            {status.data?.health === "offline" && (
              <Alert
                type="warning"
                showIcon
                title="无法读取本机平台账号"
                action={
                  <Button onClick={() => void status.refetch()}>
                    刷新状态
                  </Button>
                }
              />
            )}
            {step === 0 &&
              status.data?.health === "ready" &&
              !accounts.length && (
                <Button onClick={() => navigate("/settings/platforms")}>
                  登录并保存平台账号
                </Button>
              )}
            {step === 0 && (
              <Checkbox
                checked={monitor}
                onChange={(e) => setMonitor(e.target.checked)}
              >
                持续监控这条作品（每 15 分钟检查一次）
              </Checkbox>
            )}
            {start.isPending && status.data?.progress && (
              <Typography.Text type="secondary">
                抓取进度：{status.data.progress}
              </Typography.Text>
            )}
            <div>
              <Button
                type="primary"
                size="large"
                disabled={
                  !lead.settingsHydrated ||
                  !criteria.trim() ||
                  (step === 0
                    ? !url.trim() ||
                      !accountId ||
                      !accepted ||
                      status.data?.health !== "ready"
                    : !consentActive)
                }
                loading={start.isPending || analyze.isPending}
                onClick={() =>
                  step === 0 ? start.mutate(true) : analyze.mutate()
                }
              >
                {start.isPending
                  ? "正在读取评论"
                  : analyze.isPending
                    ? "正在开始分析"
                    : step === 0
                      ? "从评论中找客户"
                      : "开始分析"}
              </Button>
            </div>
            {step === 0 && (
              <Button
                disabled={
                  !accountId || !url.trim() || !accepted || start.isPending
                }
                onClick={() => start.mutate(false)}
              >
                只读取评论
              </Button>
            )}
            {(start.error || analyze.error) && (
              <Alert
                showIcon
                type="error"
                title={(start.error || analyze.error)?.message}
              />
            )}
          </fieldset>
        </section>
      )}
      {started && (
        <>
          {started.result.warning && (
            <Alert type="warning" showIcon title={started.result.warning} />
          )}
          <details className="lead-source-details" key={started.workId}>
            <summary>
              作品与来源授权 ·{" "}
              {consent.data ? consentLabels[consent.data.state] : "查看详情"}
            </summary>
            <div className="lead-source-body">
              <Typography.Link
                href={
                  started.workId.startsWith("xhs-")
                    ? "https://www.xiaohongshu.com/explore/" +
                      started.workId.slice(4)
                    : "https://www.douyin.com/video/" + started.workId
                }
                target="_blank"
                rel="noreferrer"
              >
                查看原作品
              </Typography.Link>
              {started.result.coverage !== "unknown" && (
                <p>
                  读取 {started.result.readCount} 条 · 新增{" "}
                  {started.result.addedCount} 条 · 已存在{" "}
                  {started.result.updatedCount} 条 ·{" "}
                  {coverageLabels[started.result.coverage]} ·{" "}
                  {new Date(started.observedAt).toLocaleString()}
                </p>
              )}
              <Space orientation="vertical" size={4}>
                {consent.isPending && (
                  <Typography.Text type="secondary">
                    <Spin size="small" /> 正在加载授权状态…
                  </Typography.Text>
                )}
                {consent.data && (
                  <>
                    <Space size={4}>
                      <Typography.Text>来源授权：</Typography.Text>
                      <Tag color={consentColors[consent.data.state]}>
                        {consentLabels[consent.data.state]}
                      </Tag>
                    </Space>
                    {consent.data.state === "active" && (
                      <>
                        <Typography.Text type="secondary">
                          默认留存 {consent.data.retentionDays ?? retentionDays}{" "}
                          天，授权有效期至{" "}
                          {consent.data.expiresAt
                            ? new Date(consent.data.expiresAt).toLocaleString()
                            : "未知"}
                        </Typography.Text>
                        <Popconfirm
                          title="撤销来源授权？"
                          description="撤销后该来源不再提供已保存的评论，并停止新的分析或私信提交；已保存评论按留存策略清理。"
                          okText="确认"
                          cancelText="取消"
                          onConfirm={() => revokeConsent.mutate()}
                        >
                          <Button danger loading={revokeConsent.isPending}>
                            撤销授权
                          </Button>
                        </Popconfirm>
                      </>
                    )}
                    {consent.data.state === "revoked" && (
                      <Alert
                        type="error"
                        showIcon
                        title="来源授权已撤销，无法继续分析或提交私信。"
                      />
                    )}
                    {consent.data.state === "expired" && (
                      <Alert
                        type="error"
                        showIcon
                        title="来源授权已过期，请重新抓取评论后再分析。"
                      />
                    )}
                    {consent.data.state === "unconfigured" && (
                      <Alert
                        type="warning"
                        showIcon
                        title="尚未配置来源授权。"
                      />
                    )}
                  </>
                )}
                {revokeConsent.error && (
                  <Alert
                    type="error"
                    showIcon
                    title={revokeConsent.error.message}
                  />
                )}
              </Space>
            </div>
          </details>
          {consent.error && (
            <Alert
              type="error"
              showIcon
              title={consent.error.message}
              action={
                <Button onClick={() => void consent.refetch()}>
                  重新读取授权
                </Button>
              }
            />
          )}
          {consent.data && !consentActive && (
            <Alert
              showIcon
              type="warning"
              title="来源授权已失效，请重新抓取评论后再操作。"
            />
          )}
        </>
      )}
      {step === 2 && (
        <Card
          title={
            job.data?.status === "running" || job.data?.status === "queued"
              ? "正在从评论中筛选客户"
              : "评论分析进度"
          }
        >
          <Space orientation="vertical" style={{ width: "100%" }}>
            {job.isPending && <Spin />}
            {job.error && (
              <Alert
                type="error"
                showIcon
                title={job.error.message}
                action={
                  <Button onClick={() => void job.refetch()}>重试</Button>
                }
              />
            )}
            {job.data?.error && (
              <Alert type="error" showIcon title={job.data.error} />
            )}
            {job.data && (
              <Typography.Text>
                已处理 {job.data.processed} / {job.data.total}，达标{" "}
                {job.data.qualified}，失败 {job.data.failed}
              </Typography.Text>
            )}
            {job.data && (
              <Progress
                percent={
                  job.data.total
                    ? Math.round((job.data.processed * 100) / job.data.total)
                    : 0
                }
                showInfo={false}
              />
            )}
            {job.data && ["queued", "running"].includes(job.data.status) && (
              <Button
                loading={cancel.isPending}
                onClick={() => cancel.mutate()}
              >
                取消分析
              </Button>
            )}
            {cancel.error && (
              <Alert type="error" showIcon title={cancel.error.message} />
            )}
            {job.data && ["partial", "failed"].includes(job.data.status) && (
              <Button
                loading={retry.isPending}
                disabled={!consentActive}
                onClick={() => retry.mutate()}
              >
                重试分析
              </Button>
            )}
            {retry.error && (
              <Alert type="error" showIcon title={retry.error.message} />
            )}
            {failedItems.error && (
              <Alert
                type="error"
                showIcon
                title={failedItems.error.message}
                action={
                  <Button onClick={() => void failedItems.refetch()}>
                    重试
                  </Button>
                }
              />
            )}
            {consentActive &&
              failedItems.data &&
              failedItems.data.items.length > 0 && (
                <Card size="small" title="失败条目">
                  <Table<LeadAnalysisRow>
                    rowKey="id"
                    size="small"
                    pagination={false}
                    dataSource={failedItems.data.items}
                    columns={[
                      {
                        title: "评论",
                        dataIndex: "commentText",
                        ellipsis: true,
                      },
                      {
                        title: "用户",
                        dataIndex: "commenterName",
                        width: 120,
                      },
                      {
                        title: "错误",
                        dataIndex: "error",
                        render: (value: string) => (
                          <Tooltip title={value || "分析失败"}>
                            <Typography.Text
                              type="danger"
                              style={{ display: "inline-block", maxWidth: 220 }}
                              ellipsis
                            >
                              {value || "分析失败"}
                            </Typography.Text>
                          </Tooltip>
                        ),
                      },
                      {
                        title: "操作",
                        key: "action",
                        width: 90,
                        render: (_: unknown, row) => (
                          <Button
                            size="small"
                            loading={
                              retryItem.isPending &&
                              retryItem.variables === row.id
                            }
                            disabled={!consentActive}
                            onClick={() => retryItem.mutate(row.id)}
                          >
                            重试
                          </Button>
                        ),
                      },
                    ]}
                  />
                </Card>
              )}
            {retryItem.error && (
              <Alert type="error" showIcon title={retryItem.error.message} />
            )}
            {job.data && ["done", "partial"].includes(job.data.status) && (
              <Button type="primary" onClick={() => update({ step: 3 })}>
                查看达标评论
              </Button>
            )}
            {job.data &&
              ["done", "partial", "failed", "canceled"].includes(
                job.data.status,
              ) && (
                <Button onClick={() => update({ step: 1, jobId: "" })}>
                  重新分析
                </Button>
              )}
          </Space>
        </Card>
      )}
      {step === 3 && (
        <section className="lead-review">
          <div className="lead-review-heading">
            <div>
              <h2>线索审核</h2>
              <p>
                {job.data
                  ? `已处理 ${job.data.processed} 条评论，找到 ${job.data.qualified} 位符合条件的评论者。${job.data.failed ? `另有 ${job.data.failed} 条判断失败。` : ""}`
                  : "选择评论者后可核对原话、编辑私信。"}
              </p>
            </div>
            <Space wrap>
              {job.data?.status === "partial" && (
                <Button onClick={() => update({ step: 2 })}>
                  查看失败条目
                </Button>
              )}
              <Button
                disabled={batchRunning}
                onClick={() => {
                  switchFilter("all");
                  setBatchSelect(false);
                  update({ step: 1, jobId: "", analyzeKey: "", activeId: "" });
                }}
              >
                调整筛选条件
              </Button>
            </Space>
          </div>
          {job.error && (
            <Alert
              type="error"
              showIcon
              title={job.error.message}
              action={
                <Button onClick={() => void job.refetch()}>重新读取任务</Button>
              }
            />
          )}
          {results.isPending && consentActive && !job.error && <Spin />}
          {results.error && (
            <Alert
              type="error"
              showIcon
              title={results.error.message}
              action={
                <Button onClick={() => void results.refetch()}>重试</Button>
              }
            />
          )}
          {outreach.error && (
            <Alert
              type="error"
              showIcon
              title={outreach.error.message}
              action={
                <Button onClick={() => void outreach.refetch()}>重试</Button>
              }
            />
          )}
          {submit.error && !isOutreachExists(submit.error) && (
            <Alert type="error" showIcon title={submit.error.message} />
          )}
          {confirm.error && (
            <Alert type="error" showIcon title={confirm.error.message} />
          )}
          {cancelTask.error && (
            <Alert type="error" showIcon title={cancelTask.error.message} />
          )}
          {results.data && consentActive && (
            <div className="lead-review-layout">
              <section aria-label="评论者列表" className="lead-people">
                <div className="lead-list-tools">
                  <h3>
                    评论者 <span>{visibleRows.length}</span>
                  </h3>
                  <Select
                    size="small"
                    aria-label="按处理状态筛选"
                    value={reviewFilter}
                    onChange={switchFilter}
                    options={[
                      { value: "all", label: "全部状态" },
                      ...Array.from(
                        new Set([
                          "待审核",
                          "暂不联系",
                          ...rows.map(reviewState),
                        ]),
                      ).map((value) => ({ value, label: value })),
                    ]}
                  />
                </div>
                <div className="lead-list-options">
                  <Checkbox
                    checked={showAll}
                    onChange={(e) => {
                      switchFilter("all");
                      update({ showAll: e.target.checked });
                    }}
                  >
                    显示未达标评论
                  </Checkbox>
                  <Button
                    type="text"
                    size="small"
                    disabled={batchRunning}
                    aria-pressed={batchSelect}
                    onClick={() => {
                      setBatchSelect(!batchSelect);
                      setSelectedKeys([]);
                    }}
                  >
                    {batchSelect ? "退出批量" : "批量选择"}
                  </Button>
                </div>
                {batchSelect && visibleRows.length > 0 && (
                  <div className="lead-batch-tools">
                    <Checkbox
                      aria-label="选择全部可提交的线索"
                      disabled={actionsDisabled || !selectableIds.length}
                      checked={
                        !!selectableIds.length &&
                        selectedRows.length === selectableIds.length
                      }
                      indeterminate={
                        selectedRows.length > 0 &&
                        selectedRows.length < selectableIds.length
                      }
                      onChange={(e) =>
                        setSelectedKeys(e.target.checked ? selectableIds : [])
                      }
                    >
                      全选
                    </Checkbox>
                    {selectedRows.length > 0 && (
                      <Button
                        size="small"
                        disabled={actionsDisabled}
                        onClick={() => setBatchOpen(true)}
                      >
                        批量提交 ({selectedRows.length})
                      </Button>
                    )}
                  </div>
                )}
                <div className="lead-people-scroll">
                  {visibleRows.map((row) => (
                    <div
                      className="lead-person"
                      key={row.id}
                      data-current={active?.id === row.id}
                    >
                      {batchSelect && (
                        <Checkbox
                          aria-label={`批量选择 ${row.commenterName || "匿名用户"}`}
                          disabled={actionsDisabled || !selectableRow(row)}
                          checked={checkedIds.has(row.id)}
                          onChange={(e) =>
                            setSelectedKeys((keys) =>
                              e.target.checked
                                ? [...keys, row.id]
                                : keys.filter((id) => id !== row.id),
                            )
                          }
                        />
                      )}
                      <button
                        type="button"
                        className="lead-pick"
                        aria-label={`查看 ${row.commenterName || "匿名用户"} 的评论`}
                        aria-pressed={row.id === active?.id}
                        onClick={() => update({ activeId: row.id })}
                      >
                        <span className="lead-person-top">
                          <strong>{row.commenterName || "匿名用户"}</strong>
                          <span>{reviewState(row)}</span>
                        </span>
                        <span className="lead-excerpt">
                          {row.commentText || "无评论正文"}
                        </span>
                      </button>
                    </div>
                  ))}
                </div>
              </section>
              <section className="lead-reader" aria-label="线索详情">
                {active ? (
                  <>
                    <div className="lead-reader-head">
                      <h3>{active.commenterName || "匿名用户"}</h3>
                      {active.intent && (
                        <Tag color={intentColors[active.intent]}>
                          {intentLabels[active.intent]}
                        </Tag>
                      )}
                    </div>
                    <div className="lead-comment-meta">
                      平台原评论
                      {active.commentTime &&
                        ` · ${new Date(active.commentTime).toLocaleString()}`}
                      {active.likeCount != null && ` · ${active.likeCount} 赞`}
                    </div>
                    <blockquote>
                      {commentWithEvidence(active) || "无评论正文"}
                    </blockquote>
                    {active.qualified && !active.reason && (
                      <p className="lead-reason">
                        旧版已判为达标，未保存判断理由，请核对原评论。
                      </p>
                    )}
                    {active.reason && (
                      <p className="lead-reason">
                        <strong>AI 判断</strong> {active.reason}
                      </p>
                    )}
                    {active.qualified && !canContact && (
                      <Typography.Paragraph type="secondary">
                        已保留这条线索，当前来源未授权人工联系。
                      </Typography.Paragraph>
                    )}
                    {((active.qualified && canContact) || activeTask) && (
                      <div className="lead-compose">
                        <label htmlFor="lead-draft">
                          {editable ? "编辑私信" : "私信内容"}
                        </label>
                        {active.draftError && !activeTask && canContact && (
                          <Alert
                            showIcon
                            type="warning"
                            title="已识别为线索，AI 草稿尚未生成"
                            description={
                              retryDraft.isError &&
                              retryDraft.variables === active.id
                                ? retryDraft.error.message
                                : active.draftError
                            }
                            action={
                              <Button
                                size="small"
                                disabled={
                                  actionsDisabled || retryDraft.isPending
                                }
                                loading={
                                  retryDraft.isPending &&
                                  retryDraft.variables === active.id
                                }
                                onClick={() => {
                                  const current =
                                    useCommentLeadStore.getState();
                                  if (current.drafts[active.id] === "") {
                                    const next = { ...current.drafts };
                                    delete next[active.id];
                                    current.update({ drafts: next });
                                  }
                                  retryDraft.mutate(active.id);
                                }}
                              >
                                重试 AI 草稿
                              </Button>
                            }
                          />
                        )}
                        <Input.TextArea
                          placeholder="写一条回应这位评论者的私信"
                          id="lead-draft"
                          aria-label={`私信草稿-${active.commenterName}`}
                          value={activeDraft}
                          readOnly={!editable || batchRunning}
                          maxLength={320}
                          showCount
                          autoSize={{ minRows: 3, maxRows: 8 }}
                          onChange={(e) => {
                            const current = useCommentLeadStore.getState();
                            current.update({
                              drafts: {
                                ...current.drafts,
                                [active.id]: e.target.value,
                              },
                            });
                          }}
                        />
                        <p className="lead-queue-note">{rateLimitNote}</p>
                      </div>
                    )}
                    <div className="lead-reader-actions">
                      {renderActions(active)}
                      {active.qualified && !activeTask && !actionsDisabled && (
                        <Button
                          type="text"
                          disabled={submit.isPending}
                          onClick={() => {
                            const deferred = lead.deferredIds.includes(
                              active.id,
                            );
                            const next = visibleRows.find(
                              (row) =>
                                row.id !== active.id &&
                                reviewState(row) === "待审核",
                            );
                            setSelectedKeys((keys) =>
                              keys.filter((id) => id !== active.id),
                            );
                            update({
                              deferredIds: deferred
                                ? lead.deferredIds.filter(
                                    (id) => id !== active.id,
                                  )
                                : [...lead.deferredIds, active.id],
                              activeId: !deferred && next ? next.id : active.id,
                            });
                          }}
                        >
                          {lead.deferredIds.includes(active.id)
                            ? "恢复审核"
                            : "暂不联系"}
                        </Button>
                      )}
                    </div>
                  </>
                ) : (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description={
                      reviewFilter !== "all"
                        ? "当前状态下暂无线索"
                        : showAll
                          ? "没有可查看的分析结果"
                          : "这次没有找到符合条件的客户"
                    }
                  >
                    <Button
                      onClick={() =>
                        reviewFilter !== "all"
                          ? switchFilter("all")
                          : update({ step: 1, jobId: "", analyzeKey: "" })
                      }
                    >
                      {reviewFilter !== "all" ? "查看全部状态" : "调整筛选条件"}
                    </Button>
                  </Empty>
                )}
              </section>
            </div>
          )}
          <Modal
            centered
            className="lead-form-modal"
            open={batchOpen}
            title="批量提交私信"
            okText="确认提交"
            cancelText="取消"
            confirmLoading={batchRunning}
            okButtonProps={{
              disabled: actionsDisabled || !selectedRows.length,
            }}
            cancelButtonProps={{ disabled: batchRunning }}
            closable={!batchRunning}
            mask={{ closable: !batchRunning }}
            onOk={() => void runBatchSubmit()}
            onCancel={() => {
              if (!batchRunning) setBatchOpen(false);
            }}
          >
            <Space
              orientation="vertical"
              size="middle"
              style={{ width: "100%" }}
            >
              <Typography.Text>
                将为 {selectedRows.length} 位评论者加入私信发送队列：
              </Typography.Text>
              <div>
                {selectedRows.map((row) => {
                  const task = tasksByAnalysis.get(row.id);
                  const draft = (
                    drafts[row.id] ??
                    task?.draft ??
                    row.draft
                  ).trim();
                  return (
                    <div key={row.id}>
                      <Typography.Text strong>
                        {row.commenterName}
                      </Typography.Text>
                      <Typography.Text type="secondary">
                        ：{draft}
                      </Typography.Text>
                    </div>
                  );
                })}
              </div>
              <Alert type="info" showIcon title={rateLimitNote} />
              {batchRunning && (
                <Typography.Text type="secondary">
                  {batchProgress}
                </Typography.Text>
              )}
            </Space>
          </Modal>
        </section>
      )}
      {monitorsOpen && (
        <WorkMonitors
          open
          accounts={accounts}
          initialWork={started}
          onClose={() => setMonitorsOpen(false)}
          onAnalyze={(row) => {
            resetLead();
            update({
              step: 1,
              started: {
                workId: row.workId,
                accountId: row.accountId,
                observedAt: row.lastScan ?? "",
                result: {
                  awemeId: row.workId,
                  accountId: row.accountId,
                  readCount: row.readCount,
                  addedCount: row.addedCount,
                  updatedCount: 0,
                  coverage: "partial",
                },
              },
            });
            setMonitorsOpen(false);
          }}
        />
      )}
    </div>
  );
}
