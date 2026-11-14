import { useEffect, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Steps,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { TableColumnsType, TableProps } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  creatorHubApi,
  isLive,
  ServiceRequestError,
} from "@keagent/api-client";
import type {
  CreatorHubConsent,
  CreatorHubStartResult,
  LeadAnalysisRow,
  OutreachStatus,
  OutreachTask,
} from "@keagent/shared-types";
import { PageHeader } from "../components/common";
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
  submitted: "已提交",
  sending: "发送中",
  sent: "已发送",
  uncertain: "结果待确认",
  failed: "失败",
  canceled: "已取消",
};
const outreachColors: Record<OutreachStatus, string> = {
  approved: "blue",
  submitted: "processing",
  sending: "processing",
  sent: "success",
  uncertain: "warning",
  failed: "error",
  canceled: "default",
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
  "CREATORHUB_ACCOUNT_UNAVAILABLE",
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
  return status === "submitted" || status === "sending";
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
const rateLimitNote =
  "CreatorHub 私信默认限速：2 次/小时、8 次/天、最短 900 秒；发送可能持续多天。";

export default function CommentLeadPage() {
  if (!isLive || !desktopPublishingAvailable()) {
    return (
      <>
        <PageHeader
          title="评论获客"
          description="从抖音视频抓取评论，分析后人工审核私信草稿。"
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
  const [step, setStep] = useState(0);
  const [url, setUrl] = useState("");
  const [accountId, setAccountId] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [retentionDays, setRetentionDays] = useState(7);
  const [consentDays, setConsentDays] = useState(30);
  const [criteria, setCriteria] = useState("");
  const [maxComments, setMaxComments] = useState(200);
  const [showAll, setShowAll] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchProgress, setBatchProgress] = useState("");
  const [started, setStarted] = useState<{
    workId: string;
    accountId: string;
    result: CreatorHubStartResult;
    observedAt: string;
  }>();
  const [jobId, setJobId] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState<Record<string, OutreachTask>>({});
  const settingsHydrated = useRef(false);
  const startKey = useRef("");
  const analyzeKey = useRef("");
  const submitKeys = useRef<Record<string, string>>({});
  const login = useMutation({
    mutationFn: creatorHubApi.login,
    onSuccess: (result) =>
      queryClient.setQueryData(["creatorhub", "status"], result),
    retry: false,
  });
  const start = useMutation({
    mutationFn: () => {
      startKey.current ||= crypto.randomUUID();
      return creatorHubApi.start({
        url,
        accountId,
        requestKey: startKey.current,
        consent: {
          accepted,
          retentionDays,
          expiresAt: new Date(
            Date.now() + consentDays * 86400000,
          ).toISOString(),
        },
      });
    },
    onSuccess: (result) => {
      startKey.current = "";
      setStarted({
        workId: result.awemeId,
        accountId: result.accountId,
        result,
        observedAt: new Date().toISOString(),
      });
      setStep(1);
      void message.success(`已导入 ${result.addedCount} 条评论`);
      if (result.warning) void message.warning(result.warning);
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
    if (!settings.data || settingsHydrated.current) return;
    settingsHydrated.current = true;
    setCriteria(settings.data.criteria);
    setMaxComments(settings.data.maxComments);
  }, [settings.data]);
  const accounts = status.data?.accounts ?? [];
  useEffect(() => {
    if (accountId) return;
    const preferred = status.data?.selectedAccountId;
    if (preferred && accounts.some((account) => account.id === preferred)) {
      setAccountId(preferred);
      return;
    }
    if (accounts.length === 1) setAccountId(accounts[0].id);
  }, [status.data, accounts, accountId]);
  useEffect(() => {
    if (!status.data || !accountId) return;
    if (!accounts.some((account) => account.id === accountId)) setAccountId("");
  }, [accounts, accountId, status.data]);
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
      void queryClient.invalidateQueries({ queryKey: consentKey });
      void message.warning("已撤销来源授权");
    },
    retry: false,
  });
  const consentActive = consent.data?.state === "active";
  const analyze = useMutation({
    mutationFn: () => {
      analyzeKey.current ||= crypto.randomUUID();
      return creatorHubApi.analyze({
        accountId: started!.accountId,
        workId: started!.workId,
        criteria,
        maxComments,
        requestKey: analyzeKey.current,
      });
    },
    onSuccess: (job) => {
      analyzeKey.current = "";
      setJobId(job.id);
      setStep(2);
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
    enabled: !!jobId && ["done", "partial"].includes(job.data?.status || ""),
  });
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
      delete submitKeys.current[task.analysisId];
      setSubmitted((current) => ({
        ...current,
        [task.analysisId]: task,
      }));
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
      setSubmitted((current) => ({
        ...current,
        [task.analysisId || previous.analysisId]: task,
      }));
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
      setSubmitted((current) => ({
        ...current,
        [task.analysisId]: task,
      }));
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
    if (row.status === "failed") return false;
    const task = tasksByAnalysis.get(row.id);
    if (task && task.status !== "failed" && task.status !== "canceled")
      return false;
    const draft = (drafts[row.id] ?? task?.draft ?? row.draft).trim();
    return !!draft && !!row.commenterProfile;
  };
  const rowsById = new Map(
    (results.data?.items ?? []).map((row) => [row.id, row]),
  );
  const selectedRows = selectedKeys
    .map((key) => rowsById.get(key))
    .filter((row): row is LeadAnalysisRow => !!row && selectableRow(row));
  const rowSelection: TableProps<LeadAnalysisRow>["rowSelection"] = {
    selectedRowKeys: selectedKeys,
    onChange: (keys) => setSelectedKeys(keys.map(String)),
    getCheckboxProps: (row) => ({ disabled: !selectableRow(row) }),
  };
  const runBatchSubmit = async () => {
    const rows = selectedRows;
    if (rows.length === 0 || batchRunning) return;
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
        const requestKey = (submitKeys.current[row.id] ||= crypto.randomUUID());
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
            delete submitKeys.current[row.id];
            nextSubmitted[row.id] = result;
            success++;
          } else if (result.status === "uncertain") {
            // Keep the key: the same key must not trigger a new send.
            nextSubmitted[row.id] = result;
            uncertain++;
          } else {
            delete submitKeys.current[row.id];
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
            if (definitiveSubmitError(error)) delete submitKeys.current[row.id];
            if (isOutreachExists(error)) skipped++;
            else failed++;
          }
        }
      }
      setSubmitted((current) => ({ ...current, ...nextSubmitted }));
    } finally {
      setBatchRunning(false);
      setBatchProgress("");
      setBatchOpen(false);
      setSelectedKeys((current) =>
        current.filter((key) => !processed.includes(key)),
      );
      void queryClient.invalidateQueries({ queryKey: outreachKey });
    }
    const parts = [`成功 ${success}`, `待确认 ${uncertain}`, `失败 ${failed}`];
    if (skipped) parts.push(`跳过 ${skipped}`);
    void message.info(`批量提交：${parts.join("，")}`);
  };
  const submit = useMutation({
    mutationFn: (input: {
      row: LeadAnalysisRow;
      draft: string;
      requestKey?: string;
    }) => {
      const requestKey =
        input.requestKey ||
        (submitKeys.current[input.row.id] ||= crypto.randomUUID());
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
        delete submitKeys.current[row.id];
        setSubmitted((current) => ({ ...current, [row.id]: task }));
        void message.success("已提交 CreatorHub 私信队列");
      } else if (task.status === "uncertain") {
        // Keep the key: the same key must not trigger a new send.
        setSubmitted((current) => ({ ...current, [row.id]: task }));
        void message.warning(
          "结果待确认，请到 CreatorHub 任务队列核对后再确认",
        );
      } else {
        // failed/canceled (or an unexpected non-approved status)
        delete submitKeys.current[row.id];
        void message.error("上次提交未完成，请重试");
      }
      void queryClient.invalidateQueries({ queryKey: outreachKey });
    },
    onError: (error, { row }) => {
      // Definitive failures leave Go in `failed`; a new attempt needs a new key.
      if (definitiveSubmitError(error)) {
        delete submitKeys.current[row.id];
        void queryClient.invalidateQueries({ queryKey: outreachKey });
      }
      if (isOutreachExists(error)) {
        void message.info("该评论已有私信任务，已刷新状态");
      }
    },
    retry: false,
  });
  const actionsDisabled = !consentActive;
  const columns: TableColumnsType<LeadAnalysisRow> = [
    { title: "评论", dataIndex: "commentText", width: 220, ellipsis: true },
    { title: "用户", dataIndex: "commenterName", width: 120 },
    {
      title: "意图",
      dataIndex: "intent",
      width: 90,
      render: (intent: LeadAnalysisRow["intent"]) =>
        intent ? (
          <Tag color={intentColors[intent]}>{intentLabels[intent]}</Tag>
        ) : (
          <Tag>未识别</Tag>
        ),
    },
    {
      title: "点赞数",
      dataIndex: "likeCount",
      width: 90,
      render: (value: LeadAnalysisRow["likeCount"]) => value ?? "-",
    },
    {
      title: "评论时间",
      dataIndex: "commentTime",
      width: 170,
      render: (value: LeadAnalysisRow["commentTime"]) =>
        value ? new Date(value).toLocaleString() : "-",
    },
    { title: "依据", dataIndex: "evidence", width: 180, ellipsis: true },
    { title: "原因", dataIndex: "reason", width: 160, ellipsis: true },
    {
      title: "私信草稿",
      dataIndex: "draft",
      width: 260,
      render: (_: string, row) => {
        const task = tasksByAnalysis.get(row.id);
        return (
          <Input.TextArea
            aria-label={`私信草稿-${row.commenterName}`}
            value={drafts[row.id] ?? task?.draft ?? row.draft}
            readOnly={!!task && !outreachDraftEditable(task)}
            maxLength={320}
            showCount
            onChange={(event) =>
              setDrafts((current) => ({
                ...current,
                [row.id]: event.target.value,
              }))
            }
            autoSize={{ minRows: 2, maxRows: 6 }}
          />
        );
      },
    },
    {
      title: "操作",
      key: "action",
      width: 170,
      render: (_: unknown, row) => {
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
              <Tag color={outreachColors[task.status] ?? "default"}>
                {outreachLabels[task.status] ?? task.status}
              </Tag>
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
                    description="CreatorHub 将取消该排队中的私信任务，取消后可在本页重新提交。"
                    okText="确认"
                    cancelText="取消"
                    onConfirm={() => cancelTask.mutate(task)}
                  >
                    <Button
                      size="small"
                      danger
                      disabled={actionsDisabled}
                      loading={
                        cancelTask.isPending &&
                        cancelTask.variables?.id === task.id
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
                    refreshTask.isPending &&
                    refreshTask.variables?.id === task.id
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
                        confirm.isPending &&
                        confirm.variables?.task.id === task.id
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
                        confirm.isPending &&
                        confirm.variables?.task.id === task.id
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
                  loading={
                    submit.isPending && submit.variables?.row.id === row.id
                  }
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
                  loading={
                    submit.isPending && submit.variables?.row.id === row.id
                  }
                  disabled={actionsDisabled || !row.commenterProfile || !draft}
                  onClick={() => submit.mutate({ row, draft })}
                >
                  重新提交
                </Button>
              )}
            </Space>
          );
        }
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
              确认发送
            </Button>
            {noProfile && (
              <Typography.Text type="danger">
                缺少抖音主页，无法私信
              </Typography.Text>
            )}
          </Space>
        );
      },
    },
  ];
  return (
    <>
      <PageHeader
        title="评论获客"
        description="从抖音视频抓取评论，分析后人工审核私信草稿。"
      />
      <Steps
        current={step}
        items={[
          { title: "抓取" },
          { title: "分析设置" },
          { title: "分析进度" },
          { title: "审核与提交" },
        ]}
        style={{ marginBottom: 24 }}
      />
      {status.isPending && (
        <Typography.Paragraph type="secondary">
          <Spin size="small" /> 正在连接 CreatorHub…
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
      {step === 0 && (
        <Card title="抓取评论">
          <Space orientation="vertical" style={{ width: "100%" }}>
            <label htmlFor="lead-url">视频链接</label>
            <Input
              id="lead-url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://v.douyin.com/..."
            />
            <label htmlFor="lead-account">CreatorHub 账号</label>
            <Select
              id="lead-account"
              value={accountId || undefined}
              onChange={setAccountId}
              options={accounts.map((account) => ({
                value: account.id,
                label: account.nickname,
              }))}
            />
            <Checkbox
              aria-label="来源授权"
              checked={accepted}
              onChange={(event) => setAccepted(event.target.checked)}
            >
              我确认已获得读取和使用这些评论的授权（来源授权）
            </Checkbox>
            <Space size="large" wrap>
              <Space orientation="vertical" size={2}>
                <label htmlFor="lead-retention">默认留存天数</label>
                <InputNumber
                  id="lead-retention"
                  min={1}
                  max={90}
                  value={retentionDays}
                  onChange={(value) => setRetentionDays(value || 7)}
                />
                <Typography.Text type="secondary">
                  评论与来源数据的默认留存时间（1–90 天）。
                </Typography.Text>
              </Space>
              <Space orientation="vertical" size={2}>
                <label htmlFor="lead-consent-days">授权有效期（天）</label>
                <InputNumber
                  id="lead-consent-days"
                  min={1}
                  max={365}
                  value={consentDays}
                  onChange={(value) => setConsentDays(value || 30)}
                />
                <Typography.Text type="secondary">
                  来源授权到期后需重新确认（1–365 天）。
                </Typography.Text>
              </Space>
            </Space>
            {status.data?.health === "offline" && (
              <Alert
                type="warning"
                showIcon
                title="CreatorHub 未启动或未登录"
                action={
                  <Button onClick={() => void status.refetch()}>
                    刷新状态
                  </Button>
                }
              />
            )}
            {status.data?.health === "ready" && accounts.length === 0 && (
              <Button loading={login.isPending} onClick={() => login.mutate()}>
                登录抖音
              </Button>
            )}
            {login.error && (
              <Alert type="error" showIcon title={login.error.message} />
            )}
            {start.isPending && status.data?.progress && (
              <Typography.Text type="secondary">
                抓取进度：{status.data.progress}
              </Typography.Text>
            )}
            <Button
              type="primary"
              disabled={!url || !accountId || !accepted}
              loading={start.isPending}
              onClick={() => start.mutate()}
            >
              开始抓取
            </Button>
            {start.error && (
              <Alert type="error" showIcon title={start.error.message} />
            )}
          </Space>
        </Card>
      )}
      {step === 1 && (
        <Card title="分析设置">
          <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
            {started && (
              <Card size="small" title="抓取结果">
                <Space orientation="vertical" size={4}>
                  <Typography.Text>
                    作品 ID：
                    <Typography.Link
                      href={`https://www.douyin.com/video/${started.workId}`}
                      target="_blank"
                    >
                      {started.workId}
                    </Typography.Link>
                  </Typography.Text>
                  <Typography.Text>
                    抓取时间：
                    {new Date(started.observedAt).toLocaleString()}
                  </Typography.Text>
                  <Typography.Text>
                    读取评论：{started.result.readCount} 条
                  </Typography.Text>
                  <Typography.Text>
                    新增：{started.result.addedCount} 条
                  </Typography.Text>
                  <Typography.Text>
                    已存在：{started.result.updatedCount} 条
                  </Typography.Text>
                  <Typography.Text>
                    覆盖范围：
                    {coverageLabels[started.result.coverage] ??
                      started.result.coverage}
                  </Typography.Text>
                  {started.result.warning && (
                    <Alert
                      type="warning"
                      showIcon
                      title={started.result.warning}
                    />
                  )}
                </Space>
              </Card>
            )}
            <Card size="small" title="来源授权">
              <Space orientation="vertical" size={4}>
                {consent.isPending && (
                  <Typography.Text type="secondary">
                    <Spin size="small" /> 正在加载授权状态…
                  </Typography.Text>
                )}
                {consent.error && (
                  <Alert
                    type="error"
                    showIcon
                    title={consent.error.message}
                    action={
                      <Button onClick={() => void consent.refetch()}>
                        重试
                      </Button>
                    }
                  />
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
                          description="撤销后无法继续分析或提交私信，已保存的评论不会被删除。"
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
            </Card>
            {settings.isPending && (
              <Typography.Text type="secondary">
                <Spin size="small" /> 正在加载分析设置…
              </Typography.Text>
            )}
            <label htmlFor="lead-criteria">筛选提示词</label>
            {settings.data && (
              <Typography.Text type="secondary">
                已保存的提示词版本：
                {settings.data.criteriaHash.slice(0, 8) || "默认"}
              </Typography.Text>
            )}
            <Input.TextArea
              id="lead-criteria"
              value={criteria}
              onChange={(event) => setCriteria(event.target.value)}
              autoSize={{ minRows: 3, maxRows: 8 }}
            />
            <Button
              onClick={() =>
                setCriteria(
                  settings.data?.defaultCriteria ??
                    settings.data?.criteria ??
                    "",
                )
              }
            >
              恢复默认
            </Button>
            <label htmlFor="lead-max">最多分析条数</label>
            <InputNumber
              id="lead-max"
              min={1}
              max={500}
              value={maxComments}
              onChange={(value) => setMaxComments(value || 200)}
            />
            <Typography.Text type="secondary">
              最多分析 {maxComments} 条评论
            </Typography.Text>
            <Typography.Text type="secondary">
              预计调用 {Math.min(started?.result.readCount ?? 0, maxComments)}{" "}
              条
            </Typography.Text>
            <Button
              type="primary"
              disabled={!consentActive}
              loading={analyze.isPending}
              onClick={() => analyze.mutate()}
            >
              开始分析
            </Button>
            {analyze.error && (
              <Alert type="error" showIcon title={analyze.error.message} />
            )}
          </Space>
        </Card>
      )}
      {step === 2 && (
        <Card title="分析进度">
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
            {job.data?.criteriaHash && (
              <Typography.Text type="secondary">
                当前提示词哈希：{job.data.criteriaHash.slice(0, 8)}
              </Typography.Text>
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
            {failedItems.data && failedItems.data.items.length > 0 && (
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
              <Button type="primary" onClick={() => setStep(3)}>
                查看达标评论
              </Button>
            )}
            {job.data &&
              ["done", "partial", "failed", "canceled"].includes(
                job.data.status,
              ) && (
                <Button
                  onClick={() => {
                    setStep(1);
                    setJobId("");
                  }}
                >
                  重新分析
                </Button>
              )}
          </Space>
        </Card>
      )}
      {step === 3 && (
        <Card title="审核与提交">
          <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
            <Alert type="info" showIcon title={rateLimitNote} />
            <Space>
              <Checkbox
                checked={showAll}
                onChange={(event) => setShowAll(event.target.checked)}
              >
                显示全部
              </Checkbox>
              <Typography.Text type="secondary">
                包含未达标与失败的评论
              </Typography.Text>
            </Space>
            <Space>
              <Button
                type="primary"
                disabled={
                  actionsDisabled || selectedKeys.length === 0 || batchRunning
                }
                loading={batchRunning}
                onClick={() => setBatchOpen(true)}
              >
                {batchRunning
                  ? batchProgress || "批量提交中…"
                  : `批量提交 (${selectedKeys.length})`}
              </Button>
            </Space>
            {results.isPending && <Spin />}
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
            {results.data && (
              <>
                <Typography.Text>
                  已加载 {results.data.items.length} 条
                  {showAll ? "全部" : "达标"}评论。
                </Typography.Text>
                <Table<LeadAnalysisRow>
                  rowKey="id"
                  rowSelection={rowSelection}
                  columns={columns}
                  dataSource={results.data.items}
                  pagination={{ pageSize: 50 }}
                  scroll={{ x: 1200 }}
                />
              </>
            )}
            <Modal
              open={batchOpen}
              title="批量提交私信"
              okText="确认提交"
              cancelText="取消"
              confirmLoading={batchRunning}
              okButtonProps={{ disabled: batchRunning }}
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
                  将向 {selectedRows.length} 位评论者发送私信：
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
                          ：{draft.slice(0, 60)}
                          {draft.length > 60 ? "…" : ""}
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
          </Space>
        </Card>
      )}
    </>
  );
}
