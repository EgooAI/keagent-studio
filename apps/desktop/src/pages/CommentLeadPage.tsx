import { useEffect, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Input,
  InputNumber,
  Select,
  Space,
  Steps,
  Tag,
  Table,
  Typography,
} from "antd";
import { useMutation, useQuery } from "@tanstack/react-query";
import { creatorHubApi } from "@keagent/api-client";
import type { LeadAnalysisRow } from "@keagent/shared-types";
import { PageHeader } from "../components/common";

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

export default function CommentLeadPage() {
  const { message } = App.useApp();
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
  const status = useQuery({
    queryKey: ["creatorhub", "status"],
    queryFn: creatorHubApi.status,
    retry: false,
  });
  const settings = useQuery({
    queryKey: ["creatorhub", "settings"],
    queryFn: creatorHubApi.settings,
    retry: false,
  });
  useEffect(() => {
    if (!settings.data) return;
    setCriteria((current) => current || settings.data.criteria);
    setMaxComments(settings.data.maxComments);
  }, [settings.data]);
  const accounts = status.data?.accounts ?? [];
  useEffect(() => {
    if (!accountId && accounts.length === 1) setAccountId(accounts[0].id);
  }, [accounts, accountId]);
  const start = useMutation({
    mutationFn: () =>
      creatorHubApi.start({
        url,
        accountId,
        requestKey: crypto.randomUUID(),
        consent: { accepted },
      }),
    onSuccess: (result) => {
      setStarted({ workId: result.awemeId, accountId: result.accountId });
      setStep(1);
      void message.success(
        `已导入 ${result.addedCount} 条评论${
          result.warning ? "；" + result.warning : ""
        }`,
      );
    },
    retry: false,
  });
  const analyze = useMutation({
    mutationFn: () =>
      creatorHubApi.analyze({
        accountId: started!.accountId,
        workId: started!.workId,
        criteria,
        maxComments,
        requestKey: crypto.randomUUID(),
      }),
    onSuccess: (job) => {
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
  const results = useQuery({
    queryKey: ["creatorhub", "analyses", jobId],
    queryFn: () =>
      creatorHubApi.analyses({ jobId, qualified: true, limit: 500 }),
    enabled: !!jobId && ["done", "partial"].includes(job.data?.status || ""),
  });
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
      {step === 0 && (
        <Card title="抓取评论">
          <Space direction="vertical" style={{ width: "100%" }}>
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
              />
            )}
            {status.data?.health === "ready" && accounts.length === 0 && (
              <Button onClick={() => void creatorHubApi.login()}>
                登录抖音
              </Button>
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
          <Space direction="vertical" style={{ width: "100%" }}>
            <label htmlFor="lead-criteria">筛选提示词</label>
            <Input.TextArea
              id="lead-criteria"
              value={criteria}
              onChange={(event) => setCriteria(event.target.value)}
              autoSize={{ minRows: 3, maxRows: 8 }}
            />
            <label htmlFor="lead-max">最多分析条数</label>
            <InputNumber
              id="lead-max"
              min={1}
              max={500}
              value={maxComments}
              onChange={(value) => setMaxComments(value || 200)}
            />
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
      {step === 2 && job.data && (
        <Card title="分析进度">
          <Space direction="vertical">
            <Typography.Text>
              已处理 {job.data.processed} / {job.data.total}，达标{" "}
              {job.data.qualified}，失败 {job.data.failed}
            </Typography.Text>
            {["queued", "running"].includes(job.data.status) && (
              <Button
                onClick={() => void creatorHubApi.cancelAnalysis(job.data!.id)}
              >
                取消分析
              </Button>
            )}
            {["done", "partial"].includes(job.data.status) && (
              <Button type="primary" onClick={() => setStep(3)}>
                查看达标评论
              </Button>
            )}
          </Space>
        </Card>
      )}
      {step === 3 && (
        <Card title="达标评论">
          <Typography.Text>
            已加载 {results.data?.items.length ?? 0} 条达标评论。
          </Typography.Text>
        </Card>
      )}
    </>
  );
}
