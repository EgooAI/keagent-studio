import LeadTable from "../../components/LeadTable";
import { useState } from "react";
import {
  Alert,
  App,
  Button,
  Drawer,
  Empty,
  Input,
  List,
  Popconfirm,
  Progress,
  Radio,
  Select,
  Space,
  Tag,
} from "antd";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { creatorHubApi, leadWorkspaceApi } from "@keagent/api-client";
import type { AnalysisJob, WorkspaceJob } from "@keagent/shared-types";
import { localTime } from "./navigation";
import { leadTrialQuery } from "./leadTrial";

const jobLabels: Record<AnalysisJob["status"], string> = {
  queued: "排队中",
  running: "分析中",
  done: "已完成",
  partial: "部分完成",
  failed: "失败",
  canceled: "已取消",
};
function isRunning(status: AnalysisJob["status"]) {
  return status === "queued" || status === "running";
}
function retryable(status: AnalysisJob["status"]) {
  return status === "partial" || status === "failed";
}

export function ReviewWorkFilter({
  accountId,
  value,
  onChange,
}: {
  accountId: string;
  value?: string;
  onChange: (id?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const work = useInfiniteQuery({
    queryKey: ["lead-workspace", "review-work-options", accountId, search],
    enabled: open || !!value,
    initialPageParam: "",
    queryFn: ({ pageParam }) =>
      leadWorkspaceApi.works({
        accountId,
        search: search || undefined,
        cursor: pageParam || undefined,
        limit: 40,
      }),
    getNextPageParam: (p) => p.nextCursor || undefined,
  });
  return (
    <Select
      aria-label="按作品筛选"
      placeholder="全部作品"
      allowClear
      showSearch={{ filterOption: false, onSearch: setSearch }}
      value={value}
      onChange={onChange}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setSearch("");
      }}
      loading={work.isFetching}
      notFoundContent={
        work.error
          ? "读取作品失败"
          : work.isFetching
            ? "正在读取作品"
            : "未找到作品"
      }
      options={work.data?.pages.flatMap((p) =>
        p.items.map((w) => ({ label: w.title || w.workId, value: w.workId })),
      )}
      onPopupScroll={(e) => {
        const el = e.currentTarget;
        if (
          el.scrollHeight - el.clientHeight - el.scrollTop < 30 &&
          work.hasNextPage &&
          !work.isFetchingNextPage
        )
          void work.fetchNextPage();
      }}
      style={{ minWidth: 130, maxWidth: 280 }}
    />
  );
}

export default function ReviewJobs({
  accountId,
  workId,
  jobId,
  clearScope,
  setWork,
  showResults,
}: {
  accountId: string;
  workId?: string;
  jobId?: string;
  clearScope: () => void;
  setWork: (id?: string) => void;
  showResults: (id: string) => void;
}) {
  const { message } = App.useApp();
  const client = useQueryClient();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [detail, setDetail] = useState<{ job: WorkspaceJob; view: string }>();
  const input = {
    accountId,
    workId,
    jobId,
    status: status || undefined,
    search: search || undefined,
  };
  const jobs = useInfiniteQuery({
    queryKey: ["lead-workspace", "jobs", input],
    initialPageParam: "",
    queryFn: ({ pageParam }) =>
      leadWorkspaceApi.jobs({
        ...input,
        cursor: pageParam || undefined,
        limit: 30,
      }),
    getNextPageParam: (p) => p.nextCursor || undefined,
    refetchInterval: (q) =>
      q.state.data?.pages.some((p) => p.items.some((j) => isRunning(j.status)))
        ? 2500
        : false,
  });
  const rows = jobs.data?.pages.flatMap((p) => p.items) ?? [];
  const job = rows.find((j) => j.id === detail?.job.id) ?? detail?.job;
  const grant = useQuery({
    queryKey: ["lead-workspace", "analysis-permission", accountId, job?.workId],
    queryFn: () => creatorHubApi.consent(accountId, job!.workId),
    enabled: !!job,
  });
  const mayRead = grant.data?.state === "active" && !grant.error;
  const mayRetry = mayRead && grant.data?.purposes?.analyzeWithAI === true;
  const items = useInfiniteQuery({
    queryKey: ["lead-workspace", "job-items", job?.id, detail?.view],
    initialPageParam: "",
    enabled: !!job && mayRead,
    queryFn: ({ pageParam }) =>
      creatorHubApi.analyses({
        jobId: job!.id,
        ...(detail?.view === "failed"
          ? { status: "failed" }
          : detail?.view === "others"
            ? { qualified: false, status: "done" }
            : {}),
        cursor: pageParam || undefined,
        limit: 50,
      }),
    getNextPageParam: (p) => p.nextCursor || undefined,
    refetchInterval: job && isRunning(job.status) ? 2500 : false,
  });
  const action = useMutation({
    mutationFn: (input: {
      jobId: string;
      mode: "retry" | "cancel";
      item?: string;
    }) =>
      input.mode === "cancel"
        ? creatorHubApi.cancelAnalysis(input.jobId)
        : creatorHubApi.retryAnalysis(
            input.jobId,
            input.item ? [input.item] : undefined,
          ),
    onSuccess: (_, input) =>
      void message.success(
        input.mode === "cancel" ? "已取消分析" : "已将失败条目重新提交分析",
      ),
    onError: (e) => void message.error(e.message),
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: ["lead-workspace"] }),
        client.invalidateQueries({ queryKey: leadTrialQuery.queryKey }),
      ]),
    retry: false,
  });
  return (
    <div className="review-space">
      {(workId || jobId) && (
        <div className="review-scope">
          已筛选{jobId ? "指定分析任务" : "指定作品"}
          <Button type="link" onClick={clearScope}>
            全部任务
          </Button>
        </div>
      )}
      <section className="review-job-panel">
        <div className="review-job-tools">
          <ReviewWorkFilter
            accountId={accountId}
            value={workId}
            onChange={setWork}
          />
          <Select
            aria-label="任务状态"
            value={status}
            onChange={setStatus}
            options={[
              { value: "", label: "全部状态" },
              ...Object.entries(jobLabels).map(([value, label]) => ({
                value,
                label,
              })),
            ]}
          />
          <Input.Search
            aria-label="搜索分析任务"
            placeholder="搜索作品或筛选条件"
            allowClear
            onSearch={(t) => setSearch(t.trim())}
            style={{ width: 225 }}
          />
        </div>
        {jobs.error && (
          <Alert
            type="error"
            showIcon
            title={jobs.error.message}
            action={<Button onClick={() => void jobs.refetch()}>重试</Button>}
          />
        )}
        <LeadTable<WorkspaceJob>
          loading={jobs.isPending}
          rowKey="id"
          pagination={false}
          scroll={{ x: 740 }}
          dataSource={rows}
          locale={{ emptyText: "暂无符合条件的分析任务" }}
          columns={[
            {
              title: "作品 / 筛选条件",
              key: "work",
              render: (_, r) => (
                <div className="review-job-title">
                  <strong>{r.title || r.workId}</strong>
                  <small>{r.criteria || "未记录筛选条件"}</small>
                </div>
              ),
            },
            {
              title: "分析进度",
              key: "progress",
              width: 135,
              render: (_, r) => (
                <div>
                  {Math.min(r.processed, r.total)} / {r.total}
                  <Progress
                    size="small"
                    showInfo={false}
                    percent={
                      r.total
                        ? Math.min(
                            100,
                            Math.round((r.processed * 100) / r.total),
                          )
                        : 0
                    }
                  />
                </div>
              ),
            },
            {
              title: "已识别线索",
              dataIndex: "qualified",
              width: 105,
              render: (n: number) => n + " 人",
            },
            {
              title: "创建时间",
              key: "created",
              width: 126,
              render: (_, r) => localTime(r.createdAt),
            },
            {
              title: "状态",
              key: "status",
              width: 120,
              render: (_, r) => (
                <div>
                  <Tag
                    color={
                      r.status === "done"
                        ? "green"
                        : r.status === "failed"
                          ? "red"
                          : r.status === "partial"
                            ? "gold"
                            : undefined
                    }
                  >
                    {jobLabels[r.status]}
                  </Tag>
                  {r.failed > 0 && (
                    <small className="review-row-state">
                      {r.failed} 条失败
                    </small>
                  )}
                </div>
              ),
            },
            {
              title: "操作",
              key: "actions",
              width: 160,
              render: (_, r) => (
                <Space size={4} wrap>
                  <Button
                    type="link"
                    size="small"
                    onClick={() => showResults(r.id)}
                  >
                    看线索
                  </Button>
                  <Button
                    type="link"
                    size="small"
                    onClick={() =>
                      setDetail({
                        job: r,
                        view: r.failed > 0 ? "failed" : "all",
                      })
                    }
                  >
                    {r.failed > 0 ? "查看失败项" : "任务明细"}
                  </Button>
                </Space>
              ),
            },
          ]}
        />
        {jobs.hasNextPage && (
          <Button
            type="link"
            block
            loading={jobs.isFetchingNextPage}
            onClick={() => void jobs.fetchNextPage()}
          >
            更多任务
          </Button>
        )}
      </section>
      <Drawer
        rootClassName="lead-sheet"
        title="分析任务明细"
        size="large"
        open={!!detail}
        onClose={() => setDetail(undefined)}
      >
        {job && detail && (
          <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
            <div className="review-job-title">
              <h3>{job.title || job.workId}</h3>
              <p>{job.criteria}</p>
            </div>
            <Space wrap>
              <Tag>{jobLabels[job.status]}</Tag>
              <span>
                已处理 {Math.min(job.processed, job.total)} / {job.total} 条
              </span>
              {job.processed > job.total && (
                <span>含重试共处理 {job.processed} 次</span>
              )}
              <span>识别 {job.qualified} 人</span>
              {isRunning(job.status) && (
                <Popconfirm
                  title="取消本次分析？"
                  onConfirm={() =>
                    action.mutate({ jobId: job.id, mode: "cancel" })
                  }
                >
                  <Button danger size="small" disabled={action.isPending}>
                    取消分析
                  </Button>
                </Popconfirm>
              )}
              {retryable(job.status) && (
                <Button
                  disabled={!mayRetry || action.isPending}
                  onClick={() =>
                    action.mutate({ jobId: job.id, mode: "retry" })
                  }
                >
                  重试失败项
                </Button>
              )}
            </Space>
            {job.error && <Alert type="warning" showIcon title={job.error} />}
            {grant.error && (
              <Alert type="error" showIcon title={grant.error.message} />
            )}
            {grant.data && !mayRead && (
              <Alert type="warning" title="来源授权未生效，无法查看分析明细" />
            )}
            {mayRead && (
              <>
                <Radio.Group
                  value={detail.view}
                  optionType="button"
                  onChange={(e) =>
                    setDetail({ ...detail, view: e.target.value })
                  }
                  options={[
                    { value: "all", label: "全部条目" },
                    { value: "failed", label: "分析失败" },
                    { value: "others", label: "未达标" },
                  ]}
                />
                {items.error && (
                  <Alert
                    type="error"
                    title={items.error.message}
                    showIcon
                    action={
                      <Button onClick={() => void items.refetch()}>重试</Button>
                    }
                  />
                )}
                <List
                  loading={items.isPending}
                  dataSource={items.data?.pages.flatMap((p) => p.items) ?? []}
                  locale={{
                    emptyText: <Empty description="暂无符合条件的分析条目" />,
                  }}
                  renderItem={(r) => (
                    <List.Item
                      extra={
                        r.status === "failed" &&
                        retryable(job.status) && (
                          <Button
                            size="small"
                            disabled={action.isPending || !mayRetry}
                            onClick={() =>
                              action.mutate({
                                jobId: job.id,
                                mode: "retry",
                                item: r.id,
                              })
                            }
                          >
                            重试该条
                          </Button>
                        )
                      }
                    >
                      <List.Item.Meta
                        title={
                          <Space>
                            <strong>{r.commenterName || "匿名用户"}</strong>
                            <Tag>
                              {r.status === "failed"
                                ? "分析失败"
                                : r.status === "queued"
                                  ? "等待分析"
                                  : r.qualified
                                    ? "已识别"
                                    : "未达标"}
                            </Tag>
                          </Space>
                        }
                        description={
                          <>
                            <div>{r.commentText}</div>
                            {r.error || r.reason}
                          </>
                        }
                      />
                    </List.Item>
                  )}
                />
                {items.hasNextPage && (
                  <Button
                    onClick={() => void items.fetchNextPage()}
                    loading={items.isFetchingNextPage}
                  >
                    更多条目
                  </Button>
                )}
              </>
            )}
          </Space>
        )}
      </Drawer>
    </div>
  );
}
