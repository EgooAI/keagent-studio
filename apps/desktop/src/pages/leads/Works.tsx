import LeadTable from "../../components/LeadTable";
import { useDeferredValue, useState } from "react";
import {
  Alert,
  App,
  Button,
  Drawer,
  Empty,
  Input,
  Popconfirm,
  Select,
  Space,
  Tabs,
  Tag,
} from "antd";
import { Plus, Search } from "lucide-react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { creatorHubApi, leadWorkspaceApi } from "@keagent/api-client";
import type {
  WorkspaceComment,
  WorkspaceWork,
  WorkMonitorSummary,
} from "@keagent/shared-types";
import { formatDate, PageHeader } from "../../components/common";
import { WorkAdd, WorkAnalyze, WorkReply } from "./WorkForms";
import OpenCommenterButton from "./OpenCommenterButton";
import { leadUrl } from "./navigation";
import "./Works.css";

type Props = {
  accountId: string;
  accountName?: string;
  platform: "douyin" | "xhs";
  canOperate: boolean;
};
type Work = {
  workId: string;
  cloud?: WorkspaceWork;
  local?: WorkMonitorSummary;
};
const modes = {
  monitor: "持续监控",
  once: "读取一次",
  stopped: "已停止",
  history: "历史采集",
};
const grants = {
  active: "有效",
  expired: "已过期",
  revoked: "已撤销",
  unconfigured: "未配置",
};
function workTitle(work: Work) {
  return work.cloud?.title || "作品 " + work.workId.replace(/^xhs-/, "");
}
function workMode(work: Work) {
  return work.local ? (work.local.mode ?? "monitor") : "history";
}
function workUrl(workId: string) {
  return workId.startsWith("xhs-")
    ? "https://www.xiaohongshu.com/explore/" + workId.slice(4)
    : "https://www.douyin.com/video/" + workId;
}

export default function Works(props: Props) {
  return <WorksView key={props.platform + props.accountId} {...props} />;
}
function WorksView({ accountId, accountName, platform, canOperate }: Props) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const client = useQueryClient();
  const tab = params.get("tab") === "comments" ? "comments" : "works";
  const workId = params.get("workId") || "";
  const [workSearch, setWorkSearch] = useState("");
  const [mode, setMode] = useState("");
  const [pickerSearch, setPickerSearch] = useState("");
  const search = params.get("search") || "";
  const commentSearch = useDeferredValue(search.trim());
  const workQuery = useDeferredValue(
    (tab === "works" ? workSearch : pickerSearch).trim(),
  );
  const [detailId, setDetailId] = useState("");
  const [analysis, setAnalysis] = useState<Work>();
  const [reply, setReply] = useState<WorkspaceComment>();
  const [startWith, setStartWith] = useState<{
    url: string;
    monitor: boolean;
  }>();
  const accountLabel =
    (platform === "xhs" ? "小红书" : "抖音") +
    " · " +
    (accountName || accountId);
  function setView(tab: string, id = "") {
    const next = new URLSearchParams(params);
    next.set("tab", tab);
    next.delete("add");
    next.delete("search");
    if (id) next.set("workId", id);
    else next.delete("workId");
    setParams(next);
  }
  function updateParam(key: string, value: string, replace = false) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace });
  }
  function openAdd(
    work?: Work,
    monitor = work ? workMode(work) === "monitor" : false,
  ) {
    setStartWith(work ? { url: workUrl(work.workId), monitor } : undefined);
    setDetailId("");
    updateParam("add", "1");
  }
  const works = useInfiniteQuery({
    queryKey: ["lead-workspace", "works", accountId, workQuery],
    initialPageParam: "",
    queryFn: ({ pageParam }) =>
      leadWorkspaceApi.works({
        accountId,
        search: workQuery || undefined,
        cursor: pageParam || undefined,
        limit: 60,
      }),
    getNextPageParam: (p) => p.nextCursor || undefined,
    enabled: !!accountId,
    refetchInterval: 15000,
  });
  const local = useQuery({
    queryKey: ["lead-workspace", "work-history", accountId],
    queryFn: creatorHubApi.workHistory,
    enabled: !!accountId,
    refetchInterval: 15000,
  });
  const records = new Map<string, Work>();
  for (const page of works.data?.pages ?? [])
    for (const row of page.items)
      records.set(row.workId, { workId: row.workId, cloud: row });
  for (const row of local.data ?? []) {
    if (row.platform !== platform || row.accountId !== accountId) continue;
    const entry = records.get(row.workId);
    if (entry) entry.local = row;
    else if (row.workId.includes(workQuery))
      records.set(row.workId, { workId: row.workId, local: row });
  }
  const pickedId = detailId || workId;
  const selectedQuery = useQuery({
    queryKey: ["lead-workspace", "work", accountId, pickedId],
    queryFn: () =>
      leadWorkspaceApi.works({ accountId, workId: pickedId, limit: 1 }),
    enabled: !!accountId && !!pickedId && !records.get(pickedId)?.cloud,
  });
  const selectedCloud = selectedQuery.data?.items.find(
    (w) => w.workId === pickedId,
  );
  const selected = pickedId
    ? {
        workId: pickedId,
        local: local.data?.find(
          (w) => w.accountId === accountId && w.workId === pickedId,
        ),
        cloud: records.get(pickedId)?.cloud ?? selectedCloud,
      }
    : undefined;
  const comments = useInfiniteQuery({
    queryKey: ["lead-workspace", "comments", accountId, workId, commentSearch],
    initialPageParam: "",
    queryFn: ({ pageParam }) =>
      leadWorkspaceApi.comments({
        accountId,
        workId: workId || undefined,
        search: commentSearch || undefined,
        cursor: pageParam || undefined,
        limit: 50,
      }),
    getNextPageParam: (p) => p.nextCursor || undefined,
    enabled: !!accountId && tab === "comments",
    refetchInterval: 15000,
  });
  const consent = useQuery({
    queryKey: ["lead-workspace", "work-consent", accountId, detailId],
    queryFn: () => creatorHubApi.consent(accountId, detailId),
    enabled: !!accountId && !!detailId,
  });
  const action = useMutation({
    mutationFn: async (request: {
      type: "scan" | "stop" | "revoke";
      work: Work;
    }) => {
      if (request.type === "revoke") {
        await creatorHubApi.revokeConsent(accountId, request.work.workId);
        return "已撤销来源授权";
      }
      if (!request.work.local) throw new Error("找不到本机读取记录");
      if (request.type === "stop") {
        await creatorHubApi.remove(request.work.local.id);
        return "已停止持续监控";
      }
      const result = await creatorHubApi.scan(request.work.local.id);
      return (
        "已读取 " +
        result.readCount +
        " 条评论，新增 " +
        result.addedCount +
        " 条"
      );
    },
    onSuccess: (note) => void message.success(note),
    onSettled: () =>
      void client.invalidateQueries({ queryKey: ["lead-workspace"] }),
  });
  const choices = [...records.values()];
  const workOptions = choices.map((w) => ({
    label: workTitle(w),
    value: w.workId,
  }));
  if (workId && !records.has(workId))
    workOptions.unshift({
      label:
        selected && selected.workId === workId ? workTitle(selected) : workId,
      value: workId,
    });
  const errors = [
    works.error,
    local.error,
    selectedQuery.error,
    tab === "comments" ? comments.error : null,
  ].filter(Boolean);
  return (
    <div className="work-page">
      <PageHeader
        title="作品与评论"
        actions={
          <Button
            type="primary"
            icon={<Plus size={16} />}
            disabled={!canOperate}
            onClick={() => openAdd()}
          >
            添加作品
          </Button>
        }
      />
      <Tabs
        activeKey={tab}
        onChange={(value) => setView(value)}
        items={[
          { key: "works", label: "作品列表" },
          { key: "comments", label: "评论记录" },
        ]}
      />
      {errors.map((err, i) => (
        <Alert
          key={i}
          showIcon
          type="error"
          title={err?.message}
          action={
            <Button
              size="small"
              onClick={() =>
                void client.invalidateQueries({ queryKey: ["lead-workspace"] })
              }
            >
              刷新
            </Button>
          }
        />
      ))}
      {tab === "works" ? (
        <>
          <section className="work-table-panel">
            <div className="work-toolbar">
              <Input
                allowClear
                prefix={<Search size={15} />}
                placeholder="搜索作品名称或编号"
                maxLength={200}
                aria-label="搜索作品名称或编号"
                value={workSearch}
                onChange={(e) => setWorkSearch(e.target.value)}
              />
              <Select
                aria-label="读取方式"
                value={mode}
                onChange={setMode}
                options={[
                  { label: "全部读取方式", value: "" },
                  ...Object.entries(modes).map(([value, label]) => ({
                    value,
                    label,
                  })),
                ]}
              />
            </div>
            <LeadTable<Work>
              rowKey="workId"
              pagination={false}
              loading={works.isLoading}
              scroll={{ x: 690 }}
              dataSource={choices.filter((w) => !mode || mode === workMode(w))}
              locale={{
                emptyText: (
                  <Empty
                    description={
                      mode || workQuery
                        ? "没有符合条件的作品"
                        : "当前账号暂无采集记录"
                    }
                  />
                ),
              }}
              columns={[
                {
                  title: "作品",
                  key: "title",
                  render: (_, w) => (
                    <div className="work-identity">
                      <Button
                        className="work-title-link"
                        type="link"
                        onClick={() => {
                          action.reset();
                          setDetailId(w.workId);
                        }}
                      >
                        {workTitle(w)}
                      </Button>
                      <small>{w.workId}</small>
                    </div>
                  ),
                },
                {
                  title: "读取方式",
                  key: "mode",
                  width: 94,
                  render: (_, w) => (
                    <Tag
                      color={workMode(w) === "monitor" ? "success" : undefined}
                    >
                      {modes[workMode(w)]}
                    </Tag>
                  ),
                },
                {
                  title: "上次读取",
                  key: "date",
                  width: 130,
                  render: (_, w) =>
                    w.local?.lastScan || w.cloud?.lastSyncedAt
                      ? formatDate(w.local?.lastScan || w.cloud?.lastSyncedAt)
                      : "等待首次读取",
                },
                {
                  title: "读到 / 新增",
                  key: "counts",
                  width: 110,
                  render: (_, w) =>
                    w.cloud?.lastSyncedAt || w.local?.lastScan
                      ? (w.local?.readCount ?? w.cloud?.readCount ?? "—") +
                        " / +" +
                        (w.local?.addedCount ?? w.cloud?.addedCount ?? "—")
                      : "—",
                },
                {
                  title: "来源授权",
                  key: "grant",
                  width: 95,
                  render: (_, w) =>
                    w.cloud ? (
                      <Tag
                        color={
                          w.cloud.sourceState === "active"
                            ? "purple"
                            : "warning"
                        }
                      >
                        {grants[w.cloud.sourceState]}
                      </Tag>
                    ) : (
                      "待查询"
                    ),
                },
                {
                  title: "操作",
                  key: "act",
                  width: 96,
                  render: (_, w) => (
                    <Button
                      type="link"
                      onClick={() => setView("comments", w.workId)}
                    >
                      查看评论
                    </Button>
                  ),
                },
              ]}
            />
            {works.hasNextPage && (
              <div className="work-more">
                <Button
                  loading={works.isFetchingNextPage}
                  onClick={() => void works.fetchNextPage()}
                >
                  加载更多作品
                </Button>
              </div>
            )}
          </section>
          <p className="work-note">
            KeAgent 运行期间，每 15 分钟检查一次持续监控的作品。
          </p>
        </>
      ) : (
        <section className="work-table-panel">
          <div className="work-toolbar">
            <Input
              allowClear
              prefix={<Search size={15} />}
              placeholder="搜索昵称或评论原文"
              maxLength={200}
              aria-label="搜索昵称或评论原文"
              value={search}
              onChange={(e) => updateParam("search", e.target.value, true)}
            />
            <Select
              aria-label="按作品筛选评论"
              allowClear
              showSearch={{ filterOption: false, onSearch: setPickerSearch }}
              placeholder="全部作品"
              value={workId || undefined}
              onClear={() => setPickerSearch("")}
              onChange={(value) => {
                setPickerSearch("");
                setView("comments", value);
              }}
              options={workOptions}
              onPopupScroll={(e) => {
                const el = e.currentTarget;
                if (
                  works.hasNextPage &&
                  !works.isFetchingNextPage &&
                  el.scrollTop + el.clientHeight >= el.scrollHeight - 20
                )
                  void works.fetchNextPage();
              }}
            />
            <Button
              disabled={!!selected && !selected.cloud?.canAnalyze}
              onClick={() => setAnalysis(selected ?? { workId: "" })}
            >
              AI 筛选线索
            </Button>
            {workId && (
              <Link to={leadUrl("review", { accountId, platform }, { workId })}>
                查看已有线索
              </Link>
            )}
          </div>
          {selected?.cloud && selected.cloud.sourceState !== "active" && (
            <Alert
              type="warning"
              showIcon
              title={
                "该作品的评论来源授权" + grants[selected.cloud.sourceState]
              }
            />
          )}
          <LeadTable<WorkspaceComment>
            rowKey="id"
            pagination={false}
            scroll={{ x: 700 }}
            loading={comments.isLoading}
            dataSource={comments.data?.pages.flatMap((p) => p.items) ?? []}
            locale={{
              emptyText: (
                <Empty
                  description={
                    commentSearch ? "未找到匹配的评论" : "暂无可查看的评论"
                  }
                />
              ),
            }}
            columns={[
              {
                title: "评论者",
                dataIndex: "commenter_name",
                width: 140,
                render: (v: string | null) => (
                  <span className="work-commenter">
                    <span aria-hidden="true">{Array.from(v || "匿")[0]}</span>
                    {v || "匿名用户"}
                  </span>
                ),
              },
              {
                title: "评论原文",
                key: "text",
                render: (_, c) => (
                  <div className="work-comment">
                    {c.comment_text || "无文字评论"}
                  </div>
                ),
              },
              {
                title: "来源作品",
                key: "work",
                width: "22%",
                render: (_, c) => (
                  <Button
                    type="link"
                    className="work-title-link"
                    onClick={() => setView("comments", c.workId)}
                  >
                    {c.title || c.workId}
                  </Button>
                ),
              },
              {
                title: "评论时间",
                key: "time",
                width: 120,
                render: (_, c) =>
                  c.comment_time ? formatDate(c.comment_time) : "未提供",
              },
              {
                title: "操作",
                key: "reply",
                width: 200,
                render: (_, c) =>
                  !canOperate ? (
                    <span className="work-note">本机账号未登录</span>
                  ) : !c.canContact ? (
                    <span className="work-note">未授权联系</span>
                  ) : !c.commenter_profile ? (
                    <span className="work-note">缺少用户主页</span>
                  ) : (
                    <Space size={0} wrap>
                      <OpenCommenterButton
                        accountId={accountId}
                        workId={c.workId}
                        commentId={c.id}
                        label="打开平台主页"
                      />
                      <Button type="link" onClick={() => setReply(c)}>
                        写私信
                      </Button>
                    </Space>
                  ),
              },
            ]}
          />
          {comments.hasNextPage && (
            <div className="work-more">
              <Button
                loading={comments.isFetchingNextPage}
                onClick={() => void comments.fetchNextPage()}
              >
                加载更多评论
              </Button>
            </div>
          )}
        </section>
      )}
      {detailId && selected && (
        <Drawer
          rootClassName="lead-sheet"
          open
          title="作品详情"
          size={464}
          onClose={() => setDetailId("")}
        >
          <h3>{workTitle(selected)}</h3>
          <a href={workUrl(selected.workId)} target="_blank" rel="noreferrer">
            查看原作品
          </a>
          <dl className="work-details">
            <dt>读取账号</dt>
            <dd>{accountLabel}</dd>
            <dt>读取方式</dt>
            <dd>{modes[workMode(selected)]}</dd>
            <dt>已保存评论</dt>
            <dd>{selected.cloud?.commentCount ?? "—"}</dd>
            <dt>最近读取</dt>
            <dd>
              {formatDate(
                selected.local?.lastScan || selected.cloud?.lastSyncedAt,
              )}
            </dd>
            {selected.local?.mode === "monitor" && (
              <>
                <dt>下次检查</dt>
                <dd>
                  {formatDate(new Date(selected.local.nextScan).toISOString())}
                </dd>
              </>
            )}
            <dt>来源授权</dt>
            <dd>
              {consent.data
                ? grants[consent.data.state]
                : consent.error
                  ? "读取失败"
                  : "正在查询"}
            </dd>
            {consent.data?.state === "active" && (
              <>
                <dt>允许的用途</dt>
                <dd>
                  {[
                    consent.data.purposes?.analyzeWithAI && "AI 分析",
                    consent.data.purposes?.manualContact && "人工联系",
                  ]
                    .filter(Boolean)
                    .join("、") || "无"}
                </dd>
              </>
            )}
            {consent.data?.expiresAt && (
              <>
                <dt>授权到期</dt>
                <dd>{formatDate(consent.data.expiresAt)}</dd>
              </>
            )}
          </dl>
          {selected.local?.error && (
            <Alert showIcon type="warning" title={selected.local.error} />
          )}
          {(action.error || consent.error) && (
            <Alert
              showIcon
              type="error"
              title={(action.error || consent.error)?.message}
            />
          )}
          <Space wrap className="work-actions">
            <Button
              type="primary"
              onClick={() => {
                setDetailId("");
                setView("comments", selected.workId);
              }}
            >
              查看评论
            </Button>
            <Link
              to={leadUrl(
                "review",
                { accountId, platform },
                { workId: selected.workId },
              )}
            >
              查看已有线索
            </Link>
            <Button
              disabled={!selected.cloud?.canAnalyze}
              onClick={() => {
                setDetailId("");
                setAnalysis(selected);
              }}
            >
              AI 筛选线索
            </Button>
            {canOperate && (
              <Button
                loading={action.isPending && action.variables?.type === "scan"}
                disabled={action.isPending}
                onClick={() =>
                  selected.local && consent.data?.state === "active"
                    ? action.mutate({ type: "scan", work: selected })
                    : openAdd(selected)
                }
              >
                立即读取
              </Button>
            )}
            {workMode(selected) === "monitor" && (
              <Popconfirm
                title="停止持续监控这部作品？"
                description="已保存的评论和线索仍可在工作区查看。"
                onConfirm={() =>
                  action.mutate({ type: "stop", work: selected })
                }
              >
                <Button disabled={action.isPending}>停止监控</Button>
              </Popconfirm>
            )}
            {canOperate && workMode(selected) !== "monitor" && (
              <Button onClick={() => openAdd(selected, true)}>开启监控</Button>
            )}
            {consent.data?.state === "active" && (
              <Popconfirm
                title="撤销这部作品的来源授权？"
                description="撤销后将停止提供原评论、分析和联系操作。"
                onConfirm={() =>
                  action.mutate({ type: "revoke", work: selected })
                }
              >
                <Button disabled={action.isPending} danger>
                  撤销授权
                </Button>
              </Popconfirm>
            )}
          </Space>
        </Drawer>
      )}
      {params.get("add") === "1" && canOperate && (
        <WorkAdd
          accountId={accountId}
          accountLabel={accountLabel}
          {...startWith}
          onClose={() => updateParam("add", "")}
          onDone={(result) => {
            void message.success(
              "已读取 " +
                result.readCount +
                " 条评论，新增 " +
                result.addedCount +
                " 条",
            );
            if (result.warning) void message.warning(result.warning);
            setView("comments", result.awemeId);
          }}
        />
      )}
      {analysis && (
        <WorkAnalyze
          accountId={accountId}
          workId={analysis.workId}
          title={workTitle(analysis)}
          workSelector={
            !workId && !detailId ? (
              <Select
                aria-label="要分析的作品"
                showSearch={{ filterOption: false, onSearch: setPickerSearch }}
                placeholder="请选择作品"
                value={analysis.workId || undefined}
                onChange={(id) => {
                  setPickerSearch("");
                  setAnalysis(records.get(id));
                }}
                options={workOptions.map((option) => ({
                  ...option,
                  disabled: !records.get(option.value)?.cloud?.canAnalyze,
                }))}
                onPopupScroll={(event) => {
                  const el = event.currentTarget;
                  if (
                    works.hasNextPage &&
                    !works.isFetchingNextPage &&
                    el.scrollTop + el.clientHeight >= el.scrollHeight - 20
                  )
                    void works.fetchNextPage();
                }}
              />
            ) : undefined
          }
          onClose={() => setAnalysis(undefined)}
          onDone={(jobId) => {
            navigate(
              leadUrl(
                "review",
                { accountId, platform },
                { tab: "jobs", jobId },
              ),
            );
          }}
        />
      )}
      {reply && canOperate && (
        <WorkReply
          accountId={accountId}
          accountLabel={accountLabel}
          comment={reply}
          onClose={() => setReply(undefined)}
          onDone={(taskId) => {
            void message.success("已加入私信队列");
            setReply(undefined);
            navigate(leadUrl("queue", { accountId, platform }, { taskId }));
          }}
        />
      )}
    </div>
  );
}
