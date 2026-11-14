import { useEffect, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Input,
  InputNumber,
  Popconfirm,
  Select,
  Space,
  Spin,
  Steps,
  Table,
  Tag,
  Typography,
} from "antd";
import type { TableColumnsType } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  creatorHubApi,
  isLive,
  ServiceRequestError,
} from "@keagent/api-client";
import type {
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
  const [criteria, setCriteria] = useState("");
  const [maxComments, setMaxComments] = useState(200);
  const [started, setStarted] = useState<{
    workId: string;
    accountId: string;
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
        consent: { accepted },
      });
    },
    onSuccess: (result) => {
      startKey.current = "";
      setStarted({ workId: result.awemeId, accountId: result.accountId });
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
  const results = useQuery({
    queryKey: ["creatorhub", "analyses", jobId],
    queryFn: () =>
      creatorHubApi.analyses({ jobId, qualified: true, limit: 500 }),
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
  const tasksByAnalysis = new Map<string, OutreachTask>();
  for (const [analysisId, task] of Object.entries(submitted))
    tasksByAnalysis.set(analysisId, task);
  for (const task of outreach.data?.items ?? [])
    tasksByAnalysis.set(task.analysisId, task);
  const submit = useMutation({
    mutationFn: (input: { row: LeadAnalysisRow; draft: string }) => {
      submitKeys.current[input.row.id] ||= crypto.randomUUID();
      return creatorHubApi.submitOutreach({
        analysisId: input.row.id,
        draft: input.draft.trim(),
        requestKey: submitKeys.current[input.row.id]!,
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
        const task = tasksByAnalysis.get(row.id);
        if (task) {
          const draft = (drafts[row.id] ?? task.draft ?? row.draft).trim();
          return (
            <Space orientation="vertical" size={4}>
              <Tag color={outreachColors[task.status] ?? "default"}>
                {outreachLabels[task.status] ?? task.status}
              </Tag>
              {outreachRefreshable(task.status) && (
                <Button
                  size="small"
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
              {task.status === "approved" && (
                <Button
                  size="small"
                  type="primary"
                  loading={
                    submit.isPending && submit.variables?.row.id === row.id
                  }
                  disabled={!row.commenterProfile || !draft}
                  onClick={() => submit.mutate({ row, draft })}
                >
                  继续发送
                </Button>
              )}
              {(task.status === "failed" || task.status === "canceled") && (
                <Button
                  size="small"
                  type="primary"
                  loading={
                    submit.isPending && submit.variables?.row.id === row.id
                  }
                  disabled={!row.commenterProfile || !draft}
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
              disabled={noProfile || !draft}
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
          <Space orientation="vertical" style={{ width: "100%" }}>
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
            <Button onClick={() => setCriteria(settings.data?.criteria ?? "")}>
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
            <Button
              type="primary"
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
              <Button loading={retry.isPending} onClick={() => retry.mutate()}>
                重试分析
              </Button>
            )}
            {retry.error && (
              <Alert type="error" showIcon title={retry.error.message} />
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
            <Alert
              type="info"
              showIcon
              title="CreatorHub 私信默认限速：2 次/小时、8 次/天、最短 900 秒；发送可能持续多天。"
            />
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
            {results.data && (
              <>
                <Typography.Text>
                  已加载 {results.data.items.length} 条达标评论。
                </Typography.Text>
                <Table<LeadAnalysisRow>
                  rowKey="id"
                  columns={columns}
                  dataSource={results.data.items}
                  pagination={{ pageSize: 50 }}
                  scroll={{ x: 1200 }}
                />
              </>
            )}
          </Space>
        </Card>
      )}
    </>
  );
}
