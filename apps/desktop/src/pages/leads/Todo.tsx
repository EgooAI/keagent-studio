import { Alert, Button, Empty, Skeleton } from "antd";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Plus } from "lucide-react";
import { Link } from "react-router-dom";
import { leadWorkspaceApi } from "@keagent/api-client";
import { leadUrl, type LeadScope } from "./navigation";
import { useAccountTasks } from "./accountTasks";

export default function Todo(
  props: LeadScope & {
    canOperate: boolean;
  },
) {
  const { accountId, canOperate } = props;
  const input = { accountId };
  const counts = useQuery({
    queryKey: ["lead-workspace", "overview", accountId],
    queryFn: () => leadWorkspaceApi.overview(input),
    refetchInterval: 15000,
  });
  const recent = useQuery({
    queryKey: ["lead-workspace", "recent-works", accountId],
    queryFn: () => leadWorkspaceApi.works({ ...input, limit: 5 }),
  });
  const pending = useQuery({
    queryKey: ["lead-workspace", "todo-pending", accountId],
    queryFn: () =>
      leadWorkspaceApi.leads({ ...input, status: "pending", limit: 5 }),
  });
  const missing = useQuery({
    queryKey: ["lead-workspace", "todo-missing", accountId],
    queryFn: () =>
      leadWorkspaceApi.leads({ ...input, status: "missingDraft", limit: 3 }),
  });
  const queue = useAccountTasks(accountId);
  const unverified = queue.tasks.filter(
    (t) => t.kind === "message" && t.stage === "uncertain",
  );
  const metrics = [
    {
      label: "待审核线索",
      n: counts.data?.pending,
      link: leadUrl("review", props, { filter: "pending" }),
    },
    {
      label: "待补私信草稿",
      n: counts.data?.missingDraft,
      link: leadUrl("review", props, { filter: "missingDraft" }),
    },
    {
      label: "私信待核实",
      n: queue.loading || queue.error ? undefined : unverified.length,
      link: leadUrl("queue", props, { filter: "uncertain", kind: "message" }),
    },
  ];
  const items = [
    ...unverified.slice(0, 3).map((t) => ({
      key: t.id,
      title: t.title,
      detail: t.detail || "待核实发送结果",
      action: "查看记录",
      url: leadUrl("queue", props, { taskId: t.id }),
    })),
    ...(missing.data?.items ?? []).map((l) => ({
      key: l.id,
      title: "为" + (l.commenterName || "评论者") + "补私信草稿",
      detail: l.commentText,
      action: "写草稿",
      url: leadUrl("review", props, { analysisId: l.id }),
    })),
    ...(pending.data?.items ?? [])
      .filter((l) => !missing.data?.items.some((s) => s.id === l.id))
      .map((l) => ({
        key: l.id,
        title: "审核" + (l.commenterName || "评论者") + "的需求",
        detail: l.commentText,
        action: "看原评论",
        url: leadUrl("review", props, { analysisId: l.id }),
      })),
  ].slice(0, 8);
  const error =
    counts.error ??
    recent.error ??
    pending.error ??
    missing.error ??
    queue.error;
  return (
    <>
      <div className="lead-title">
        <h1>我的待办</h1>
        {canOperate && (
          <Link
            className="lead-primary"
            to={leadUrl("works", props, { add: "1" })}
          >
            <Plus size={15} />
            添加作品
          </Link>
        )}
      </div>
      {error && (
        <Alert
          showIcon
          type="error"
          title="部分待办数据未能读取"
          description={error.message}
          action={
            <Button
              onClick={() =>
                void Promise.all([
                  counts.refetch(),
                  recent.refetch(),
                  pending.refetch(),
                  missing.refetch(),
                  queue.refresh(),
                ])
              }
            >
              重试
            </Button>
          }
        />
      )}
      <div className="lead-metrics">
        {metrics.map((m) => (
          <Link key={m.label} to={m.link}>
            <span>
              {m.label}
              <ArrowRight size={15} />
            </span>
            <strong>{m.n ?? "—"}</strong>
          </Link>
        ))}
      </div>
      <div className="lead-dashboard">
        <section className="lead-box">
          <header>
            <h2>待处理事项</h2>
          </header>
          {pending.isPending || missing.isPending || queue.loading ? (
            <Skeleton active />
          ) : items.length ? (
            items.map((i) => (
              <Link className="lead-todo-row" key={i.key} to={i.url}>
                <span>
                  <strong>{i.title}</strong>
                  <small>{i.detail}</small>
                </span>
                <b>{i.action} →</b>
              </Link>
            ))
          ) : (
            !error && (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="当前账号暂无待办"
              >
                <Link to={leadUrl("review", props)}>查看全部已识别线索</Link>
              </Empty>
            )
          )}
        </section>
        <section className="lead-box">
          <header>
            <h2>近期作品</h2>
            <Link to={leadUrl("works", props)}>全部作品 →</Link>
          </header>
          {recent.isPending ? (
            <Skeleton active />
          ) : recent.data?.items.length ? (
            recent.data.items.map((w) => (
              <Link
                className="lead-todo-row"
                key={w.workId}
                to={leadUrl("works", props, {
                  tab: "comments",
                  workId: w.workId,
                })}
              >
                <span>
                  <strong>{w.title || "作品 " + w.workId}</strong>
                  <small>已保存 {w.commentCount} 条评论</small>
                </span>
              </Link>
            ))
          ) : (
            !recent.error && (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="暂无已保存的作品"
              />
            )
          )}
        </section>
      </div>
    </>
  );
}
