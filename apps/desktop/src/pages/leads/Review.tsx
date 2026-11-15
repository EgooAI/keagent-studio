import { useState } from "react";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Empty,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Tabs,
  Tag,
} from "antd";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import {
  creatorHubApi,
  leadWorkspaceApi,
  ServiceRequestError,
} from "@keagent/api-client";
import type { OutreachStatus, WorkspaceLead } from "@keagent/shared-types";
import { useCommentLeadStore } from "../../lib/commentLeadStore";
import { PageHeader } from "../../components/common";
import ReviewJobs, { ReviewWorkFilter } from "./ReviewJobs";
import { leadUrl, localTime } from "./navigation";
import "../comment-lead.css";
import "./Review.css";

export interface ReviewScope {
  accountId: string;
  platform: "douyin" | "xhs";
  canOperate: boolean;
}

const intents: Record<string, string> = {
  buy: "求购",
  rent: "求租",
  sell: "出售",
  let: "出租",
  viewing: "约看房源",
  question: "房产咨询",
  unclear: "需求待确认",
  unrelated: "与房产无关",
};
const delivery: Record<OutreachStatus, string> = {
  approved: "待入队",
  submitted: "已入队",
  sending: "发送中",
  sent: "已有发送记录",
  uncertain: "待核实",
  failed: "发送失败",
  canceled: "已取消",
};
const filterOptions = [
  { value: "all", label: "全部状态" },
  { value: "pending", label: "待审核" },
  { value: "missingDraft", label: "待补草稿" },
  { value: "skipped", label: "暂不联系" },
  { value: "queued", label: "已有私信任务" },
] as const;
const definitive = new Set([
  "QUEUE_FULL",
  "ACCOUNT_UNAVAILABLE",
  "COMMENT_PROFILE_UNAVAILABLE",
  "COMMENT_PURPOSE_DENIED",
  "COMMENT_NOT_QUALIFIED",
  "COMMENT_CHANGED",
  "INVALID_INPUT",
  "FORBIDDEN",
  "OUTREACH_EXISTS",
]);

function stateLabel(row: WorkspaceLead) {
  if (row.reviewStatus === "skipped") return "暂不联系";
  if (
    row.outreach &&
    row.outreach.method !== "electron" &&
    ["sent", "submitted", "sending"].includes(row.outreach.status)
  )
    return "历史任务 · 待核实";
  if (row.outreachStatus) return delivery[row.outreachStatus];
  return (row.manualDraft ?? row.draft).trim() ? "待审核" : "待补草稿";
}

function submittedDraft(row: WorkspaceLead) {
  if (row.outreach && !["failed", "canceled"].includes(row.outreach.status))
    return row.outreach.draft;
  return row.manualDraft ?? row.outreach?.draft ?? row.draft;
}

function editable(row: WorkspaceLead) {
  return (
    row.canContact &&
    (!row.outreachStatus ||
      ["approved", "failed", "canceled"].includes(row.outreachStatus))
  );
}

function originalComment(row: WorkspaceLead) {
  const index = row.evidence ? row.commentText.indexOf(row.evidence) : -1;
  if (index < 0) return row.commentText || "原评论正文不可用";
  return (
    <>
      {row.commentText.slice(0, index)}
      <mark>{row.evidence}</mark>
      {row.commentText.slice(index + row.evidence.length)}
    </>
  );
}

function changeLocalDraft(id: string, text?: string) {
  const store = useCommentLeadStore.getState();
  const drafts = { ...store.drafts };
  if (text === undefined) delete drafts[id];
  else drafts[id] = text;
  store.update({ drafts });
}

async function enqueue(row: WorkspaceLead, draft: string) {
  const store = useCommentLeadStore.getState();
  const key =
    row.outreachStatus === "approved"
      ? row.outreach?.requestKey
      : store.submitKeys[row.id] || crypto.randomUUID();
  if (!key) throw new Error("缺少原任务的请求标识，请在账号队列核实。");
  store.update({ submitKeys: { ...store.submitKeys, [row.id]: key } });
  let retireKey = false;
  try {
    const task = await creatorHubApi.submitOutreach({
      analysisId: row.id,
      draft: draft.trim(),
      requestKey: key,
    });
    retireKey = task.status !== "uncertain" && task.status !== "approved";
    return task;
  } catch (error) {
    retireKey =
      error instanceof ServiceRequestError &&
      (definitive.has(error.code ?? "") ||
        (error.code === "CREATORHUB_REJECTED" &&
          [400, 403, 404, 422].includes(error.status)));
    throw error;
  } finally {
    if (retireKey) {
      const latest = useCommentLeadStore.getState();
      const submitKeys = { ...latest.submitKeys };
      delete submitKeys[row.id];
      latest.update({ submitKeys });
    }
  }
}

export default function Review(scope: ReviewScope) {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "jobs" ? "jobs" : "leads";
  const set = (changes: Record<string, string | null>) => {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      for (const [key, value] of Object.entries(changes)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      return next;
    });
  };
  const workId = params.get("workId") || undefined;
  const jobId = params.get("jobId") || undefined;
  return (
    <>
      <PageHeader title="线索审核" />
      <Tabs
        activeKey={tab}
        onChange={(key) =>
          set({
            tab: key === "jobs" ? key : null,
            jobId: null,
            analysisId: null,
            filter: null,
            search: null,
          })
        }
        items={[
          { key: "leads", label: "AI 识别结果" },
          { key: "jobs", label: "分析任务" },
        ]}
      />
      {tab === "jobs" ? (
        <ReviewJobs
          accountId={scope.accountId}
          jobId={jobId}
          workId={workId}
          clearScope={() => set({ jobId: null, workId: null })}
          setWork={(id) => set({ workId: id || null, jobId: null })}
          showResults={(id) =>
            set({
              tab: null,
              jobId: id,
              analysisId: null,
              filter: null,
              search: null,
            })
          }
        />
      ) : (
        <LeadList
          key={scope.accountId}
          {...scope}
          workId={workId}
          jobId={jobId}
          params={params}
          set={set}
        />
      )}
    </>
  );
}

function LeadList({
  accountId,
  platform,
  canOperate,
  workId,
  jobId,
  params,
  set,
}: ReviewScope & {
  workId?: string;
  jobId?: string;
  params: URLSearchParams;
  set: (changes: Record<string, string | null>) => void;
}) {
  const { message } = App.useApp();
  const client = useQueryClient();
  const drafts = useCommentLeadStore((s) => s.drafts);
  const [selected, select] = useState("");
  const [bulk, setBulk] = useState(false);
  const [checked, setChecked] = useState<string[]>([]);
  const [confirmRows, setConfirmRows] = useState<
    { row: WorkspaceLead; draft: string }[]
  >([]);
  const analysisId = params.get("analysisId") || undefined;
  const filter =
    filterOptions.find((o) => o.value === params.get("filter"))?.value ?? "all";
  const search = params.get("search") || undefined;
  const input = {
    accountId,
    workId,
    jobId,
    analysisId,
    status: filter,
    search,
  };
  const result = useInfiniteQuery({
    queryKey: ["lead-workspace", "leads", input],
    initialPageParam: "",
    queryFn: ({ pageParam }) =>
      leadWorkspaceApi.leads({
        ...input,
        cursor: pageParam || undefined,
        limit: 50,
      }),
    getNextPageParam: (page) => page.nextCursor || undefined,
    refetchInterval: (data) =>
      data.state.data?.pages.some((p) =>
        p.items.some(
          (r) =>
            r.outreach?.method === "electron" &&
            (r.outreachStatus === "sending" ||
              r.outreachStatus === "submitted"),
        ),
      )
        ? 8000
        : false,
  });
  const rows = result.data?.pages.flatMap((p) => p.items) ?? [];
  const active = rows.find((r) => r.id === selected) ?? rows[0];
  const textFor = (row: WorkspaceLead) =>
    (editable(row) ? drafts[row.id] : undefined) ?? submittedDraft(row);
  const sendable = (r: WorkspaceLead) =>
    canOperate &&
    editable(r) &&
    r.reviewStatus !== "skipped" &&
    !!r.commenterProfile &&
    !!textFor(r).trim() &&
    (r.outreachStatus !== "approved" || !!r.outreach?.requestKey);
  const refresh = () =>
    client.invalidateQueries({ queryKey: ["lead-workspace"] });
  const save = useMutation({
    mutationFn: leadWorkspaceApi.saveReview,
    onSuccess: (_, change) => {
      if (
        typeof change.draft === "string" &&
        useCommentLeadStore.getState().drafts[change.analysisId] ===
          change.draft
      ) {
        changeLocalDraft(change.analysisId);
      }
      void message.success(
        change.skipped === undefined
          ? "草稿已保存"
          : change.skipped
            ? "已标为暂不联系"
            : "已恢复待审核",
      );
    },
    onError: (e) => void message.error(e.message),
    onSettled: refresh,
    retry: false,
  });
  const regenerate = useMutation({
    mutationFn: creatorHubApi.retryDraft,
    onSuccess: (_, id) => {
      if (useCommentLeadStore.getState().drafts[id] === "")
        changeLocalDraft(id);
      void message.success("草稿已生成");
    },
    onError: (e) => void message.error(e.message),
    onSettled: refresh,
    retry: false,
  });
  const submit = useMutation({
    mutationFn: async (items: { row: WorkspaceLead; draft: string }[]) => {
      const messages: string[] = [];
      let queued = 0;
      for (const { row, draft } of items) {
        try {
          const task = await enqueue(row, draft);
          if (["submitted", "sending", "sent"].includes(task.status)) {
            queued++;
            changeLocalDraft(row.id);
          } else
            messages.push(
              (row.commenterName || "评论者") + "：" + delivery[task.status],
            );
        } catch (e) {
          messages.push(
            (row.commenterName || "评论者") +
              "：" +
              (e instanceof Error ? e.message : "提交结果待核实"),
          );
        }
      }
      return { queued, messages };
    },
    onSuccess: ({ queued, messages }) => {
      if (queued) void message.success("已受理 " + queued + " 条私信");
      if (messages.length) void message.warning(messages.join("；"), 8);
      setConfirmRows([]);
      setChecked([]);
      setBulk(false);
    },
    onSettled: refresh,
    retry: false,
  });
  const busy = save.isPending || regenerate.isPending || submit.isPending;
  const text = active ? textFor(active) : "";
  const checkedRows = rows.filter((r) => checked.includes(r.id) && sendable(r));
  const outbound = active?.outreach;
  const grantText = active?.canContact
    ? "允许人工联系"
    : active?.sourceState === "active"
      ? "未授权人工联系"
      : (
          {
            expired: "来源授权已过期",
            revoked: "来源授权已撤销",
            unconfigured: "尚无来源授权",
          } as Record<string, string>
        )[active?.sourceState ?? ""] || "来源无法联系";
  return (
    <div className="review-space">
      {(workId || jobId || analysisId) && (
        <div className="review-scope">
          <span>
            {analysisId
              ? "已定位指定线索"
              : jobId
                ? "当前分析任务的线索"
                : "当前作品的线索"}
          </span>
          <Button
            type="link"
            onClick={() => set({ workId: null, jobId: null, analysisId: null })}
          >
            查看全部线索
          </Button>
        </div>
      )}
      {result.error && (
        <Alert
          type="error"
          showIcon
          title={result.error.message}
          action={<Button onClick={() => void result.refetch()}>重试</Button>}
        />
      )}
      <section className="lead-review-layout">
        <section className="lead-people" aria-label="评论者列表">
          <div className="lead-list-tools">
            <h3>评论者</h3>
            <Button
              type="link"
              size="small"
              disabled={!rows.length || !canOperate || busy}
              onClick={() => {
                setBulk(!bulk);
                setChecked([]);
              }}
            >
              {bulk ? "退出批选" : "批量选择"}
            </Button>
          </div>
          <div className="review-filters">
            <Input.Search
              key={search ?? ""}
              aria-label="搜索评论者或原评论"
              allowClear
              defaultValue={search}
              placeholder="搜索昵称或原评论"
              onSearch={(q) => {
                setChecked([]);
                set({ search: q.trim(), analysisId: null });
              }}
            />
            <Select
              aria-label="线索状态"
              value={filter}
              options={[...filterOptions]}
              onChange={(v) => {
                setChecked([]);
                set({ filter: v, analysisId: null });
              }}
            />
            <ReviewWorkFilter
              accountId={accountId}
              value={workId}
              onChange={(value) => {
                setChecked([]);
                set({ workId: value || null, jobId: null, analysisId: null });
              }}
            />
          </div>
          {bulk && (
            <div className="lead-batch-tools">
              <Checkbox
                checked={
                  rows.some(sendable) &&
                  checkedRows.length === rows.filter(sendable).length
                }
                onChange={(e) =>
                  setChecked(
                    e.target.checked
                      ? rows.filter(sendable).map((r) => r.id)
                      : [],
                  )
                }
              >
                全选本页
              </Checkbox>
              <Button
                size="small"
                disabled={!checkedRows.length || busy}
                onClick={() =>
                  setConfirmRows(
                    checkedRows.map((row) => ({ row, draft: textFor(row) })),
                  )
                }
              >
                审核提交 ({checkedRows.length})
              </Button>
            </div>
          )}
          <div className="lead-people-scroll">
            {result.isPending && <Spin className="review-loading" />}
            {rows.map((r) => (
              <div
                key={r.id}
                className="lead-person"
                data-current={r.id === active?.id}
              >
                {bulk && (
                  <Checkbox
                    aria-label={"选择 " + (r.commenterName || "匿名用户")}
                    checked={checkedRows.some((x) => x.id === r.id)}
                    disabled={!sendable(r) || busy}
                    onChange={(e) =>
                      setChecked((prev) =>
                        e.target.checked
                          ? [...prev, r.id]
                          : prev.filter((id) => id !== r.id),
                      )
                    }
                  />
                )}
                <button
                  type="button"
                  className="lead-pick"
                  aria-pressed={r.id === active?.id}
                  aria-label={
                    "查看 " + (r.commenterName || "匿名用户") + " 的评论"
                  }
                  onClick={() => select(r.id)}
                >
                  <span className="lead-person-top">
                    <strong>{r.commenterName || "匿名用户"}</strong>
                    <span>{intents[r.intent] || "已识别"}</span>
                  </span>
                  <span className="lead-excerpt">{r.commentText}</span>
                  <small className="review-row-state">{stateLabel(r)}</small>
                </button>
              </div>
            ))}
            {result.hasNextPage && (
              <Button
                type="link"
                block
                loading={result.isFetchingNextPage}
                onClick={() => void result.fetchNextPage()}
              >
                更多线索
              </Button>
            )}
          </div>
        </section>
        {active ? (
          <article className="lead-reader" aria-label="线索详情">
            <div className="lead-reader-head">
              <h3>{active.commenterName || "匿名用户"}</h3>
              <Tag>{stateLabel(active)}</Tag>
            </div>
            <div className="review-source">
              来源作品　
              <Link
                to={leadUrl(
                  "works",
                  { platform, accountId },
                  {
                    tab: "comments",
                    workId: active.workId,
                    search: active.commentId || active.commenterName,
                  },
                )}
              >
                {active.title || active.workId}
              </Link>
            </div>
            <h4>原评论</h4>
            <blockquote>{originalComment(active)}</blockquote>
            <small className="review-meta">
              {[
                platform === "xhs" ? "小红书" : "抖音",
                active.commentTime && localTime(active.commentTime),
                active.likeCount != null && active.likeCount + " 赞",
              ]
                .filter(Boolean)
                .join(" · ")}
            </small>
            <p className="lead-reason">
              <strong>需求判断</strong>
              {active.reason || intents[active.intent] || "已识别为线索"}
            </p>
            <div className="lead-compose">
              <label htmlFor="review-draft">私信草稿</label>
              {!active.draft &&
                active.manualDraft == null &&
                active.draftError && (
                  <Alert
                    type="warning"
                    showIcon
                    title="已识别为线索，AI 草稿尚未生成"
                    description={active.draftError}
                    action={
                      active.canAnalyze &&
                      active.canContact &&
                      !outbound &&
                      !drafts[active.id]?.trim() ? (
                        <Button
                          size="small"
                          disabled={busy}
                          loading={
                            regenerate.isPending &&
                            regenerate.variables === active.id
                          }
                          onClick={() => regenerate.mutate(active.id)}
                        >
                          重试生成草稿
                        </Button>
                      ) : undefined
                    }
                  />
                )}
              <Input.TextArea
                id="review-draft"
                value={text}
                disabled={!editable(active) || busy}
                maxLength={320}
                showCount
                placeholder={
                  editable(active)
                    ? "根据原评论写一条私信"
                    : "暂无可编辑的私信草稿"
                }
                autoSize={{ minRows: 3, maxRows: 8 }}
                onChange={(e) => changeLocalDraft(active.id, e.target.value)}
              />
              <div className="review-meta">
                {grantText}
                {!canOperate ? " · 该账号当前无法在本机发送" : ""}
                {!active.commenterProfile ? " · 缺少评论者主页" : ""}
              </div>
              {outbound && (
                <p className="review-source">
                  私信记录　{stateLabel(active)} {outbound.error}{" "}
                  <Link
                    to={leadUrl(
                      "queue",
                      { platform, accountId },
                      {
                        outreachId: outbound.id,
                        ...(outbound.creatorhubTaskId
                          ? { taskId: outbound.creatorhubTaskId }
                          : {}),
                      },
                    )}
                  >
                    查看账号队列
                  </Link>
                </p>
              )}
            </div>
            <div className="review-actions">
              <Button
                disabled={
                  busy ||
                  active.reviewStatus === "queued" ||
                  active.sourceState !== "active"
                }
                onClick={() =>
                  save.mutate({
                    analysisId: active.id,
                    skipped: active.reviewStatus !== "skipped",
                  })
                }
              >
                {active.reviewStatus === "skipped" ? "恢复待审核" : "暂不联系"}
              </Button>
              <Space wrap>
                <Button
                  disabled={
                    !editable(active) ||
                    active.reviewStatus === "queued" ||
                    busy ||
                    drafts[active.id] === undefined
                  }
                  loading={
                    save.isPending && save.variables?.draft !== undefined
                  }
                  onClick={() =>
                    save.mutate({ analysisId: active.id, draft: text })
                  }
                >
                  保存草稿
                </Button>
                <Button
                  type="primary"
                  disabled={busy || !sendable(active)}
                  loading={submit.isPending && submit.variables?.length === 1}
                  onClick={() => submit.mutate([{ row: active, draft: text }])}
                >
                  {outbound?.status === "approved"
                    ? "继续加入私信队列"
                    : outbound?.status === "failed" ||
                        outbound?.status === "canceled"
                      ? "重新加入私信队列"
                      : "加入私信队列"}
                </Button>
              </Space>
            </div>
          </article>
        ) : (
          <Empty
            className="review-empty"
            description={
              result.isPending
                ? "正在读取线索"
                : result.error
                  ? "线索暂时无法读取"
                  : search || filter !== "all"
                    ? "没有符合当前条件的线索"
                    : "暂无已识别的线索"
            }
          />
        )}
      </section>
      <Modal
        title="批量提交私信"
        open={!!confirmRows.length}
        okText={"确认加入队列 (" + confirmRows.length + ")"}
        cancelText="取消"
        confirmLoading={submit.isPending}
        cancelButtonProps={{ disabled: submit.isPending }}
        onCancel={() => !submit.isPending && setConfirmRows([])}
        onOk={() => submit.mutate(confirmRows)}
      >
        <p>请核对每位评论者和私信正文，提交后将由同一账号队列依次执行。</p>
        <div className="review-confirm-list">
          {confirmRows.map(({ row, draft }) => (
            <p key={row.id}>
              <strong>{row.commenterName || "匿名用户"}</strong>
              <br />
              {draft}
            </p>
          ))}
        </div>
      </Modal>
    </div>
  );
}
