import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Alert,
  App,
  Button,
  Drawer,
  Empty,
  Input,
  Modal,
  Segmented,
  Select,
  Space,
  Table,
  Tag,
} from "antd";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { ListChecks, Pause, Play, RefreshCw, Search, X } from "lucide-react";
import { Link, useBlocker } from "react-router-dom";
import { artifactExchange } from "@keagent/api-client";
import {
  douyinStateLabels,
  validateDouyinInput,
  type ArtifactReviewState,
  type DouyinAccount,
  type DouyinBatchInput,
  type DouyinQueue,
  type DouyinQueueRow,
  type DouyinWorkspaceRow,
  type DouyinWorkspaceStatus,
} from "@keagent/shared-types";
import {
  douyinApi,
  publishingFailureText,
  publishingMessage,
  useDouyinDesktop,
} from "../lib/douyin";
import { PageHeader, formatDate } from "./common";
import "./publish-workbench.css";

export const reviewLabels: Record<ArtifactReviewState, string> = {
  pending: "待验收",
  approved: "验收通过",
  rejected: "验收未通过",
};
const statusLabels: Record<DouyinWorkspaceStatus, string> = {
  unpublished: "未发布",
  running: "执行中",
  accepted: "已提交",
  unknown: "待核对",
  failed: "失败或取消",
};
const colors: Record<string, string> = {
  running: "processing",
  submitting: "processing",
  accepted: "success",
  failed: "error",
  unknown: "warning",
  interrupted: "warning",
};
const emptyQueue: DouyinQueue = { paused: false, rows: [] };
const pending = (row: DouyinQueueRow) =>
  ["queued", "running", "submitting"].includes(row.state);
const selectable = (row: DouyinWorkspaceRow) =>
  row.review.state === "approved" &&
  row.deviceReady &&
  (row.status === "unpublished" || row.status === "failed");
const queueStatus = (row: DouyinQueueRow) =>
  row.state === "queued"
    ? "排队中"
    : row.state === "interrupted"
      ? "已中断"
      : douyinStateLabels[row.state];

export function PublishWorkbench({
  detail,
}: {
  detail: (artifactId: string, onDirty: (dirty: boolean) => void) => ReactNode;
}) {
  const { message, modal } = App.useApp();
  const client = useQueryClient();
  const desktop = useDouyinDesktop();
  const accounts = useQuery({
    queryKey: ["douyin", "accounts"],
    queryFn: douyinApi.accounts,
  });
  const [mode, setMode] = useState<"artifacts" | "queue">("artifacts");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [review, setReview] = useState<ArtifactReviewState>();
  const [status, setStatus] = useState<DouyinWorkspaceStatus>();
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<DouyinWorkspaceRow[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [dirty, setDirty] = useState(false);
  const blocker = useBlocker(dirty);
  const [batchRows, setBatchRows] = useState<DouyinWorkspaceRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [wide, setWide] = useState(
    () => window.matchMedia("(min-width: 1400px)").matches,
  );
  const focus = useRef<HTMLElement>(null);
  const query = useQuery({
    queryKey: ["douyin", "workbench", search, review, status, page],
    queryFn: () =>
      douyinApi.workspace({
        search,
        review,
        status,
        limit: 50,
        offset: (page - 1) * 50,
      }),
    placeholderData: keepPreviousData,
    retry: false,
    refetchInterval: 10_000,
  });
  const queue = desktop.data?.queue || emptyQueue;
  const active = desktop.data?.activeRecord;
  const localAccounts = (accounts.data?.items || []).filter(
    (account) =>
      account.deviceId === desktop.data?.deviceId && !account.unboundAt,
  );
  const accountName = (id: string) =>
    localAccounts.find((account) => account.id === id)?.name || "原发布账号";
  const outstanding = new Map(
    queue.rows
      .filter(
        (row) => pending(row) || ["unknown", "interrupted"].includes(row.state),
      )
      .map((row) => [row.artifactId, row]),
  );
  const statusTotal = Object.values(query.data?.counts || {}).reduce(
    (sum, n) => sum + (n || 0),
    0,
  );
  const pendingCount = queue.rows.filter(pending).length;
  const current = new Map(query.data?.items.map((row) => [row.id, row]));
  const canQueue = (row: DouyinWorkspaceRow) =>
    selectable(row) && !outstanding.has(row.id);
  const selectedReady = selected
    .map((row) => current.get(row.id) || row)
    .filter(canQueue);
  const batchAvailable =
    !!desktop.data?.queue && !!desktop.data.resolverAvailable;
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    const dialog = modal.confirm({
      title: "本次发布文案尚未提交",
      content: "离开发布中心后会清除本次编辑。",
      okText: "放弃并离开",
      cancelText: "继续编辑",
      onOk: () => blocker.proceed(),
      onCancel: () => blocker.reset(),
    });
    return () => dialog.destroy();
  }, [blocker, modal]);

  function resetPage() {
    setPage(1);
    setSelected([]);
  }
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim());
      resetPage();
    }, 250);
    return () => clearTimeout(timer);
  }, [searchInput]);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1400px)");
    const update = () => setWide(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (wide && selectedId) focus.current?.focus({ preventScroll: true });
  }, [wide, selectedId]);

  function openDetail(id: string) {
    if (id === selectedId) return;
    const open = () => {
      setDirty(false);
      setSelectedId(id);
    };
    if (!dirty) {
      open();
      return;
    }
    modal.confirm({
      title: "本次发布文案尚未提交",
      content: "切换成片后会清除这里编辑的标题、正文、话题和封面。",
      okText: "放弃修改",
      cancelText: "继续编辑",
      onOk: open,
    });
  }
  async function queueAction(
    action: "pause" | "resume" | "cancel" | "clear-interrupted",
    id?: string,
  ) {
    if (busy) return;
    setBusy(true);
    try {
      const updated = await douyinApi.queue(action, id);
      client.setQueryData(["douyin", "desktop"], {
        ...desktop.data,
        queue: updated,
      });
    } catch (error) {
      void message.error(publishingMessage(error));
    } finally {
      setBusy(false);
    }
  }
  const content = selectedId ? detail(selectedId, setDirty) : null;
  const layout =
    wide && selectedId
      ? "publish-bench-split with-detail"
      : "publish-bench-split";
  return (
    <div className="publish-bench">
      <PageHeader
        title="发布中心"
        actions={
          <Space>
            <Link to="/settings/platforms">管理抖音账号</Link>
            <Button
              icon={<RefreshCw size={15} />}
              onClick={() => {
                void query.refetch();
                void desktop.refetch();
              }}
            >
              刷新
            </Button>
          </Space>
        }
      />
      <section className="panel publish-bench-controls" aria-label="发布工作区">
        <Segmented
          value={mode}
          options={[
            { value: "artifacts", label: "成片工作台" },
            {
              value: "queue",
              label: "本机队列" + (pendingCount ? " " + pendingCount : ""),
            },
          ]}
          onChange={setMode}
        />
        <Space wrap>
          {desktop.data?.queue && (
            <Button
              loading={busy}
              icon={queue.paused ? <Play size={15} /> : <Pause size={15} />}
              disabled={!queue.paused && !pendingCount}
              onClick={() =>
                void queueAction(queue.paused ? "resume" : "pause")
              }
            >
              {queue.paused ? "恢复发布队列" : "暂停发布队列"}
            </Button>
          )}
          <Link className="muted" to="/publish/demo">
            演示
          </Link>
        </Space>
      </section>
      {queue.rows.some((row) => row.state === "unknown") && (
        <Alert
          showIcon
          type="warning"
          title="发布结果待核对，队列已暂停"
          description="在对应成片的发布记录中核对结果，再恢复队列。"
        />
      )}
      {queue.rows.some((row) => row.state === "interrupted") && (
        <Alert
          showIcon
          type="info"
          title="上次退出时有任务中断"
          description="请打开成片记录核对中断任务。恢复队列只会执行还在排队的条目。"
        />
      )}
      {query.error && mode === "artifacts" && (
        <Alert
          showIcon
          type="error"
          title="成片加载失败"
          description={publishingMessage(query.error)}
        />
      )}
      {desktop.error && (
        <Alert showIcon type="error" title={publishingMessage(desktop.error)} />
      )}
      <section
        className="panel publish-bench-table"
        aria-label={mode === "artifacts" ? "成片列表" : "本机发布队列"}
      >
        {mode === "artifacts" && (
          <>
            <div className="publish-bench-status" aria-label="按发布状态筛选">
              {([["", "全部"], ...Object.entries(statusLabels)] as const).map(
                ([key, label]) => (
                  <button
                    key={key}
                    aria-pressed={(status || "") === key}
                    onClick={() => {
                      setStatus(
                        key ? (key as DouyinWorkspaceStatus) : undefined,
                      );
                      resetPage();
                    }}
                  >
                    {label}
                    <span>
                      {key
                        ? query.data?.counts[key as DouyinWorkspaceStatus] || 0
                        : statusTotal}
                    </span>
                  </button>
                ),
              )}
            </div>
            <div className="publish-bench-toolbar">
              <Space wrap>
                <Input
                  aria-label="搜索成片"
                  placeholder="搜索成片标题或房源"
                  allowClear
                  prefix={<Search size={15} />}
                  value={searchInput}
                  maxLength={120}
                  onChange={(event) => setSearchInput(event.target.value)}
                />
                <Select
                  aria-label="验收状态"
                  placeholder="全部验收状态"
                  allowClear
                  className="publish-review-filter"
                  value={review}
                  onChange={(value) => {
                    setReview(value);
                    resetPage();
                  }}
                  options={Object.entries(reviewLabels).map(
                    ([value, label]) => ({ value, label }),
                  )}
                />
              </Space>
              {batchAvailable && (
                <Space>
                  {!!selected.length && (
                    <Button
                      type="text"
                      size="small"
                      onClick={() => setSelected([])}
                    >
                      清空已选 {selected.length}
                    </Button>
                  )}
                  <Button
                    type="primary"
                    icon={<ListChecks size={15} />}
                    disabled={
                      !selectedReady.length ||
                      selectedReady.length > 20 ||
                      query.isPlaceholderData
                    }
                    onClick={() => setBatchRows(selectedReady)}
                  >
                    配置批量发布
                    {selectedReady.length
                      ? " " + selectedReady.length + " 条"
                      : ""}
                  </Button>
                </Space>
              )}
            </div>
            {selectedReady.length > 20 && (
              <Alert
                showIcon
                type="warning"
                title="每批最多发布 20 条，请减少选择。"
              />
            )}
          </>
        )}
        <div className={layout}>
          {mode === "artifacts" ? (
            <Table<DouyinWorkspaceRow>
              size="small"
              rowKey="id"
              loading={query.isPending}
              dataSource={query.data?.items}
              scroll={{ y: "max(260px, calc(100vh - 335px))" }}
              pagination={{
                current: page,
                pageSize: 50,
                total: query.data?.total || 0,
                showSizeChanger: false,
                onChange: setPage,
              }}
              rowClassName={(row) =>
                row.id === selectedId ? "publish-row-active" : ""
              }
              rowSelection={
                batchAvailable
                  ? {
                      preserveSelectedRowKeys: true,
                      selectedRowKeys: selected.map((row) => row.id),
                      onChange: (_, rows) => setSelected(rows),
                      getCheckboxProps: (row) => ({
                        disabled: !canQueue(row) || query.isPlaceholderData,
                        "aria-label": "选择 " + row.title,
                      }),
                    }
                  : undefined
              }
              locale={{
                emptyText: (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="暂无符合条件的成片"
                  />
                ),
              }}
              columns={[
                {
                  title: "成片",
                  ellipsis: true,
                  render: (_, row) => (
                    <div className="publish-title-cell">
                      <button
                        className="publish-row-title"
                        onClick={() => openDetail(row.id)}
                        title={row.title}
                      >
                        {row.title}
                      </button>
                      <small title={row.propertyTitle || undefined}>
                        {row.propertyTitle || "版本 " + row.sourceRevision}
                      </small>
                    </div>
                  ),
                },
                {
                  title: "验收",
                  width: 102,
                  render: (_, row) => (
                    <Tag
                      color={
                        row.review.state === "approved"
                          ? "success"
                          : row.review.state === "pending"
                            ? "warning"
                            : "error"
                      }
                    >
                      {reviewLabels[row.review.state]}
                    </Tag>
                  ),
                },
                {
                  title: "发布",
                  width: 122,
                  render: (_, row) => {
                    const task = outstanding.get(row.id);
                    return (
                      <Tag color={colors[task?.state || row.status]}>
                        {task
                          ? queueStatus(task)
                          : row.recordState
                            ? douyinStateLabels[row.recordState]
                            : "未发布"}
                      </Tag>
                    );
                  },
                },
                {
                  title: "文件",
                  width: 84,
                  render: (_, row) =>
                    row.deviceReady ? "本机就绪" : "需原设备",
                },
                {
                  title: "登记时间",
                  width: 114,
                  render: (_, row) => formatDate(row.createdAt),
                },
                {
                  title: "",
                  width: 66,
                  render: (_, row) => (
                    <Button
                      size="small"
                      type="link"
                      onClick={() => openDetail(row.id)}
                    >
                      {row.review.state === "pending" ? "验收" : "详情"}
                    </Button>
                  ),
                },
              ]}
            />
          ) : (
            <Table<DouyinQueueRow>
              size="small"
              rowKey="id"
              dataSource={queue.rows}
              scroll={{ y: "max(260px, calc(100vh - 280px))" }}
              pagination={{ pageSize: 30, showSizeChanger: false }}
              rowClassName={(row) =>
                row.artifactId === selectedId ? "publish-row-active" : ""
              }
              locale={{
                emptyText: (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="本机队列为空"
                  />
                ),
              }}
              columns={[
                {
                  title: "发布标题",
                  ellipsis: true,
                  render: (_, row) => (
                    <button
                      className="publish-row-title"
                      onClick={() => openDetail(row.artifactId)}
                      title={row.title}
                    >
                      {row.title}
                    </button>
                  ),
                },
                {
                  title: "账号",
                  width: 120,
                  ellipsis: true,
                  render: (_, row) => accountName(row.accountId),
                },
                {
                  title: "状态",
                  width: 120,
                  render: (_, row) => {
                    const record =
                      active?.requestKey === row.id ? active : undefined;
                    return (
                      <Tag color={colors[record?.state || row.state]}>
                        {record &&
                        ["running", "submitting"].includes(record.state)
                          ? douyinStateLabels[record.state] +
                            " " +
                            record.progress +
                            "%"
                          : queueStatus(row)}
                      </Tag>
                    );
                  },
                },
                {
                  title: "处理结果",
                  width: 162,
                  ellipsis: true,
                  render: (_, row) =>
                    row.errorCode ? (
                      <span title={publishingFailureText(row.errorCode)}>
                        {publishingFailureText(row.errorCode)}
                      </span>
                    ) : (
                      "—"
                    ),
                },
                {
                  title: "",
                  width: 120,
                  render: (_, row) => (
                    <Space size={4}>
                      <Button
                        size="small"
                        type="link"
                        onClick={() => openDetail(row.artifactId)}
                      >
                        详情
                      </Button>
                      {row.state === "queued" && (
                        <Button
                          size="small"
                          type="link"
                          danger
                          disabled={busy}
                          onClick={() => void queueAction("cancel", row.id)}
                        >
                          取消
                        </Button>
                      )}
                      {row.state === "interrupted" && (
                        <Button
                          size="small"
                          type="link"
                          disabled={busy}
                          onClick={() =>
                            modal.confirm({
                              title: "清除这条中断记录？",
                              content:
                                "清除本机队列标记，抖音发布记录仍可在成片详情核对。",
                              onOk: () =>
                                queueAction("clear-interrupted", row.id),
                            })
                          }
                        >
                          清除
                        </Button>
                      )}
                    </Space>
                  ),
                },
              ]}
            />
          )}
          {wide && selectedId && (
            <aside
              ref={focus}
              tabIndex={-1}
              className="publish-bench-detail"
              aria-label="成片详情"
            >
              <Button
                className="publish-close"
                type="text"
                size="small"
                aria-label="关闭成片详情"
                icon={<X size={16} />}
                onClick={() => openDetail("")}
              />
              {content}
            </aside>
          )}
        </div>
      </section>
      {!wide && (
        <Drawer
          title="成片详情"
          size={520}
          open={!!selectedId}
          destroyOnHidden
          onClose={() => openDetail("")}
        >
          {content}
        </Drawer>
      )}
      {!!batchRows.length && (
        <PublishBatch
          rows={batchRows}
          accounts={localAccounts}
          onClose={() => setBatchRows([])}
          onQueued={(updated) => {
            client.setQueryData(["douyin", "desktop"], {
              ...desktop.data,
              queue: updated,
            });
            setBatchRows([]);
            setSelected([]);
            setMode("queue");
            void client.invalidateQueries({ queryKey: ["douyin"] });
          }}
        />
      )}
    </div>
  );
}

function PublishBatch({
  rows,
  accounts,
  onClose,
  onQueued,
}: {
  rows: DouyinWorkspaceRow[];
  accounts: DouyinAccount[];
  onClose: () => void;
  onQueued: (result: DouyinQueue) => void;
}) {
  const eligible = accounts.filter(
    (account) => account.loginStatus === "logged_in",
  );
  const [accountId, setAccount] = useState(
    eligible.length === 1 ? eligible[0].id : undefined,
  );
  const [edits, setEdits] = useState<
    Record<string, { title?: string; description?: string }>
  >({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const attempt = useRef<{ fingerprint: string; key: string } | undefined>(
    undefined,
  );
  const query = useQuery({
    queryKey: [
      "douyin",
      "batch-preview",
      rows.map((row) => [row.id, row.review.revision]),
    ],
    queryFn: () =>
      Promise.all(rows.map((row) => artifactExchange.getArtifact(row.id))),
    retry: false,
  });
  const entries =
    query.data?.map((artifact) => ({
      artifactId: artifact.id,
      expectedReviewRevision: artifact.review.revision,
      title: edits[artifact.id]?.title ?? artifact.content.title,
      description: edits[artifact.id]?.description ?? artifact.content.script,
    })) || [];
  const issues = entries.map((entry, i) =>
    query.data?.[i].review.state !== "approved" ||
    entry.expectedReviewRevision !== rows[i].review.revision
      ? "验收已变化，请关闭后重新选择"
      : validateDouyinInput({ ...entry, hashtags: [] }),
  );
  async function enqueue() {
    if (
      !accountId ||
      !entries.length ||
      issues.some(Boolean) ||
      submitting.current
    )
      return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const fingerprint = JSON.stringify([accountId, entries]);
      if (attempt.current?.fingerprint !== fingerprint)
        attempt.current = { fingerprint, key: crypto.randomUUID() };
      const input: DouyinBatchInput = {
        requestKey: attempt.current.key,
        accountId,
        entries,
      };
      onQueued(await douyinApi.batch(input));
    } catch (error) {
      setError(publishingMessage(error));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal
      title={"配置批量发布 · " + rows.length + " 条"}
      open
      width={760}
      onCancel={busy ? undefined : onClose}
      closable={!busy}
      mask={{ closable: false }}
      cancelText="返回"
      cancelButtonProps={{ disabled: busy }}
      okText={"确认公开发布 " + rows.length + " 条"}
      confirmLoading={busy}
      okButtonProps={{
        disabled:
          !eligible.some((account) => account.id === accountId) ||
          !entries.length ||
          issues.some(Boolean),
      }}
      onOk={() => void enqueue()}
      styles={{ body: { maxHeight: "63vh", overflowY: "auto" } }}
    >
      <Alert
        showIcon
        type="info"
        title="确认后按列表顺序公开发布到同一账号"
        description="每条使用成片原封面。标题和正文可逐条修改，成片验收版本会在执行时重新核对。"
      />
      <div className="publish-batch-account">
        <Select
          aria-label="批次发布账号"
          placeholder="选择已登录的本机抖音账号"
          value={accountId}
          disabled={busy}
          onChange={setAccount}
          options={eligible.map((account) => ({
            value: account.id,
            label: account.name,
          }))}
        />
        {!eligible.length && <Link to="/settings/platforms">登录抖音账号</Link>}
      </div>
      {(error || query.error) && (
        <Alert
          showIcon
          type="error"
          title={error || publishingMessage(query.error)}
          action={
            query.error && (
              <Button onClick={() => void query.refetch()}>重试</Button>
            )
          }
        />
      )}
      {query.isPending && <p role="status">正在读取已选成片…</p>}
      <ol className="publish-batch-entries">
        {entries.map((entry, index) => (
          <li key={entry.artifactId}>
            <strong>{rows[index].title}</strong>
            <label>
              发布标题
              <Input
                aria-label={"第 " + (index + 1) + " 条发布标题"}
                value={entry.title}
                disabled={busy}
                onChange={(e) => {
                  const title = e.target.value;
                  setEdits((old) => ({
                    ...old,
                    [entry.artifactId]: { ...old[entry.artifactId], title },
                  }));
                }}
              />
            </label>
            <label>
              发布正文
              <Input.TextArea
                aria-label={"第 " + (index + 1) + " 条发布正文"}
                value={entry.description}
                disabled={busy}
                autoSize={{ minRows: 2, maxRows: 4 }}
                onChange={(e) => {
                  const description = e.target.value;
                  setEdits((old) => ({
                    ...old,
                    [entry.artifactId]: {
                      ...old[entry.artifactId],
                      description,
                    },
                  }));
                }}
              />
            </label>
            {issues[index] && (
              <span className="error-text">{issues[index]}</span>
            )}
          </li>
        ))}
      </ol>
    </Modal>
  );
}
