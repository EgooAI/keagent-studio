import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Descriptions,
  Empty,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from "antd";
import { collectionApi, douyinApi, isLive } from "@keagent/api-client";
import type {
  CollectionRun,
  CollectionRunState,
  CollectionTarget,
  CollectionTargetInput,
  CollectionTargetKind,
  MonitoredVideo,
} from "@keagent/shared-types";
import { formatDate, PageHeader } from "../components/common";
import {
  desktopPublishingAvailable,
  panelLabels,
  useDouyinDesktop,
} from "../lib/douyin";

const kinds: Record<CollectionTargetKind, string> = {
  video: "单条视频",
  creator: "博主主页",
  keyword: "关键词",
};
const runStates: Record<CollectionRunState, string> = {
  queued: "等待执行",
  running: "观察中",
  succeeded: "已完成",
  partial: "部分完成",
  failed: "失败",
  blocked: "已阻止",
  canceled: "已取消",
  interrupted: "已中断",
};
const sourceLabels = {
  video: "作品链接",
  creator: "主页链接",
  keyword: "关键词",
};
const sources = {
  video: "https://www.douyin.com/video/作品ID",
  creator: "https://www.douyin.com/user/博主标识",
  keyword: "输入要保存的关键词",
};
const listKey = ["douyin", "collection"] as const;
const paging = {
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (last: { nextCursor?: string }) =>
    last.nextCursor || undefined,
  retry: false,
};
function activeRun(run: CollectionRun) {
  return run.state === "queued" || run.state === "running";
}
function errorText(error: unknown) {
  return error instanceof Error ? error.message : "操作失败，请重试";
}

export default function CollectionPage() {
  const navigate = useNavigate();
  return (
    <>
      <PageHeader
        title="AI 获客"
        description="管理抖音目标，使用本机账号手动核验作品并查看评论区状态。"
        actions={
          <Button onClick={() => navigate("/leads/comment-observation")}>
            评论观察
          </Button>
        }
      />
      {isLive && desktopPublishingAvailable() ? (
        <CollectionWorkspace />
      ) : (
        <Alert
          showIcon
          type="info"
          title={
            isLive
              ? "请在桌面客户端打开目标管理"
              : "Mock 演示模式 · 未连接真实目标和观察记录"
          }
          description="目标管理与手动观察需要已登录的桌面客户端。"
        />
      )}
    </>
  );
}

function CollectionWorkspace() {
  const { message, modal } = App.useApp();
  const client = useQueryClient();
  const navigate = useNavigate();
  const desktop = useDouyinDesktop();
  const accounts = useQuery({
    queryKey: ["douyin", "accounts"],
    queryFn: douyinApi.accounts,
  });
  const localAccounts = (accounts.data?.items ?? []).filter(
    (a) => !a.unboundAt && a.deviceId === desktop.data?.deviceId,
  );
  const accountName = (id: string) =>
    accounts.data?.items.find((a) => a.id === id)?.name ?? id;
  const [tab, setTab] = useState("targets");
  const [filter, setFilter] = useState<Pick<CollectionTarget, "id" | "name">>();
  const [editor, setEditor] = useState<CollectionTarget | "new">();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [form] = Form.useForm<CollectionTargetInput>();
  const kind = Form.useWatch("kind", form) ?? "video";
  const createKey = useRef({ fingerprint: "", key: "" });
  const runKeys = useRef(new Map<string, string>());
  const inFlight = useRef(false);
  const targets = useInfiniteQuery({
    queryKey: [...listKey, "targets"],
    ...paging,
    queryFn: ({ pageParam }) =>
      collectionApi.targets({ cursor: pageParam, limit: 20 }),
    enabled: tab === "targets",
  });
  const runs = useInfiniteQuery({
    queryKey: [...listKey, "runs", filter?.id],
    ...paging,
    queryFn: ({ pageParam }) =>
      collectionApi.runs({
        targetId: filter?.id,
        cursor: pageParam,
        limit: 20,
      }),
    enabled: tab === "runs",
    refetchInterval: (q) =>
      q.state.data?.pages.some((p) => p.items.some(activeRun)) ? 1200 : false,
  });
  const videos = useInfiniteQuery({
    queryKey: [...listKey, "videos"],
    ...paging,
    queryFn: ({ pageParam }) =>
      collectionApi.videos({ cursor: pageParam, limit: 20 }),
    enabled: tab === "videos",
  });
  const shown = tab === "targets" ? targets : tab === "runs" ? runs : videos;
  const error =
    actionError ||
    (shown.error && errorText(shown.error)) ||
    (accounts.error && errorText(accounts.error)) ||
    (desktop.error && errorText(desktop.error));
  function showHistory(target?: Pick<CollectionTarget, "id" | "name">) {
    setFilter(target);
    setTab("runs");
  }
  function refresh() {
    setActionError("");
    void shown.refetch();
    if (accounts.isError) void accounts.refetch();
    if (desktop.isError) void desktop.refetch();
  }
  async function change(action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setActionError("");
    try {
      await action();
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      void client.invalidateQueries({ queryKey: listKey });
      inFlight.current = false;
      setBusy(false);
    }
  }
  function openEditor(target: CollectionTarget | "new") {
    setActionError("");
    createKey.current = { fingerprint: "", key: "" };
    setEditor(target);
    form.resetFields();
    form.setFieldsValue(
      target === "new"
        ? {
            name: "",
            value: "",
            kind: "video",
            accountId:
              localAccounts.length === 1 ? localAccounts[0].id : undefined,
          }
        : {
            name: target.name,
            value: target.value,
            kind: target.kind,
            accountId: target.accountId,
          },
    );
  }
  async function save(values: CollectionTargetInput) {
    if (!editor) return;
    await change(async () => {
      const fields = {
        ...values,
        name: values.name.trim(),
        value: values.value.trim(),
      };
      if (editor === "new") {
        const fingerprint = JSON.stringify(fields);
        if (fingerprint !== createKey.current.fingerprint) {
          createKey.current = { fingerprint, key: crypto.randomUUID() };
        }
        await collectionApi.createTarget({
          ...fields,
          requestKey: createKey.current.key,
        });
      } else {
        await collectionApi.updateTarget({
          ...fields,
          id: editor.id,
          expectedVersion: editor.version,
        });
      }
      setEditor(undefined);
      message.success("目标已保存");
    });
  }
  function start(target: CollectionTarget) {
    void change(async () => {
      const snapshot = target.id + ":" + target.version;
      const requestKey = runKeys.current.get(snapshot) ?? crypto.randomUUID();
      runKeys.current.set(snapshot, requestKey);
      await collectionApi.startRun(target.id, target.version, requestKey);
      runKeys.current.delete(snapshot);
      showHistory(target);
    });
  }
  function archive(target: CollectionTarget) {
    modal.confirm({
      title: "删除目标“" + target.name + "”？",
      content: "此目标的运行历史和已核验作品仍可查看。",
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: () =>
        change(async () => {
          await collectionApi.archiveTarget(target.id, target.version);
        }),
    });
  }
  return (
    <section className="panel collection-workspace">
      {error && !editor && <Alert showIcon type="error" title={error} />}
      <Tabs
        activeKey={tab}
        onChange={(key) => {
          setTab(key);
          setFilter(undefined);
          setActionError("");
        }}
        destroyOnHidden
        items={[
          {
            key: "targets",
            label: "目标管理",
            children: (
              <Table<CollectionTarget>
                rowKey="id"
                size="small"
                pagination={false}
                scroll={{ x: 800 }}
                loading={targets.isLoading}
                dataSource={targets.data?.pages.flatMap((p) => p.items) ?? []}
                locale={{ emptyText: <Empty description="尚未添加监控目标" /> }}
                columns={[
                  {
                    title: "目标",
                    render: (_, t) => (
                      <>
                        <strong>{t.name}</strong>
                        <div className="collection-source">{t.value}</div>
                      </>
                    ),
                  },
                  { title: "类型", render: (_, t) => kinds[t.kind] },
                  {
                    title: "执行账号",
                    render: (_, t) => accountName(t.accountId),
                  },
                  {
                    title: "状态",
                    render: (_, t) => (
                      <Tag>
                        {t.state === "active"
                          ? "已启用"
                          : t.state === "paused"
                            ? "已暂停"
                            : "已删除"}
                      </Tag>
                    ),
                  },
                  {
                    title: "操作",
                    render: (_, t) => {
                      const local = t.deviceId === desktop.data?.deviceId;
                      return (
                        <Space wrap size={[6, 4]}>
                          {t.kind === "video" ? (
                            <Button
                              size="small"
                              disabled={busy || !local || t.state !== "active"}
                              onClick={() => start(t)}
                            >
                              手动观察
                            </Button>
                          ) : (
                            <span className="muted">仅保存目标</span>
                          )}
                          <Button
                            type="link"
                            size="small"
                            onClick={() => showHistory(t)}
                          >
                            历史
                          </Button>
                          {local ? (
                            <>
                              <Button
                                type="link"
                                size="small"
                                disabled={busy}
                                onClick={() => openEditor(t)}
                              >
                                编辑
                              </Button>
                              <Button
                                type="link"
                                size="small"
                                disabled={busy}
                                onClick={() =>
                                  void change(async () => {
                                    if (t.state === "active")
                                      await collectionApi.pauseTarget(
                                        t.id,
                                        t.version,
                                      );
                                    else
                                      await collectionApi.resumeTarget(
                                        t.id,
                                        t.version,
                                      );
                                  })
                                }
                              >
                                {t.state === "active" ? "暂停" : "恢复"}
                              </Button>
                              <Button
                                type="link"
                                size="small"
                                danger
                                disabled={busy}
                                onClick={() => archive(t)}
                              >
                                删除
                              </Button>
                            </>
                          ) : (
                            <span className="muted">其他设备</span>
                          )}
                        </Space>
                      );
                    },
                  },
                ]}
              />
            ),
          },
          {
            key: "runs",
            label: "运行历史",
            children: (
              <>
                {filter && (
                  <p>
                    目标：{filter.name}{" "}
                    <Button
                      type="link"
                      size="small"
                      onClick={() => setFilter(undefined)}
                    >
                      查看全部历史
                    </Button>
                  </p>
                )}
                <Table<CollectionRun>
                  rowKey="id"
                  size="small"
                  pagination={false}
                  scroll={{ x: 750 }}
                  loading={runs.isLoading}
                  dataSource={runs.data?.pages.flatMap((p) => p.items) ?? []}
                  locale={{ emptyText: <Empty description="暂无运行记录" /> }}
                  expandable={{
                    expandedRowRender: (r) => (
                      <Descriptions
                        size="small"
                        bordered
                        column={{ xs: 1, sm: 2 }}
                        items={[
                          {
                            key: "url",
                            label: "目标链接",
                            children: r.targetUrl,
                          },
                          {
                            key: "device",
                            label: "设备",
                            children: r.deviceId,
                          },
                          {
                            key: "input",
                            label: "输入作品 ID",
                            children: r.inputWorkId,
                          },
                          {
                            key: "verified",
                            label: "核验作品 ID",
                            children: r.verifiedWorkId ?? "未核验",
                          },
                          {
                            key: "start",
                            label: "开始执行",
                            children: formatDate(r.startedAt),
                          },
                          {
                            key: "end",
                            label: "执行结束",
                            children: formatDate(r.endedAt),
                          },
                          {
                            key: "title",
                            label: "作品",
                            children: r.title ?? "—",
                          },
                          {
                            key: "author",
                            label: "作者",
                            children: r.author?.name ?? "未核验",
                          },
                          {
                            key: "reason",
                            label: "原因",
                            children:
                              [r.reason, r.errorCode]
                                .filter(Boolean)
                                .join(" · ") || "—",
                          },
                        ]}
                      />
                    ),
                  }}
                  columns={[
                    {
                      title: "目标",
                      render: (_, r) => (
                        <Space wrap>
                          {r.targetName}
                          {r.targetArchived && <Tag>目标已删除</Tag>}
                        </Space>
                      ),
                    },
                    {
                      title: "账号",
                      render: (_, r) => accountName(r.accountId),
                    },
                    {
                      title: "创建时间",
                      dataIndex: "createdAt",
                      render: formatDate,
                    },
                    {
                      title: "执行状态",
                      render: (_, r) => <Tag>{runStates[r.state]}</Tag>,
                    },
                    {
                      title: "评论区",
                      render: (_, r) => panelLabels[r.panelStatus],
                    },
                    {
                      title: "原因",
                      render: (_, r) => r.reason || r.errorCode || "—",
                    },
                    {
                      title: "操作",
                      render: (_, r) =>
                        activeRun(r) &&
                        r.deviceId === desktop.data?.deviceId ? (
                          <Button
                            size="small"
                            disabled={busy}
                            onClick={() =>
                              void change(async () => {
                                await collectionApi.cancelRun(r.id);
                              })
                            }
                          >
                            取消运行
                          </Button>
                        ) : (
                          "—"
                        ),
                    },
                  ]}
                />
              </>
            ),
          },
          {
            key: "videos",
            label: "已核验作品",
            children: (
              <Table<MonitoredVideo>
                rowKey="id"
                size="small"
                pagination={false}
                scroll={{ x: 720 }}
                loading={videos.isLoading}
                dataSource={videos.data?.pages.flatMap((p) => p.items) ?? []}
                locale={{ emptyText: <Empty description="暂无已核验作品" /> }}
                columns={[
                  {
                    title: "作品",
                    render: (_, v) => (
                      <>
                        <strong>{v.title || v.id}</strong>
                        <div className="collection-source">
                          <Typography.Text copyable={{ text: v.targetUrl }}>
                            {v.targetUrl}
                          </Typography.Text>
                        </div>
                      </>
                    ),
                  },
                  { title: "作者", render: (_, v) => v.author.name },
                  {
                    title: "最近观察账号",
                    render: (_, v) => accountName(v.accountId),
                  },
                  {
                    title: "评论区",
                    render: (_, v) => panelLabels[v.panelStatus],
                  },
                  {
                    title: "最近观察时间",
                    dataIndex: "lastObservedAt",
                    render: formatDate,
                  },
                ]}
              />
            ),
          },
        ]}
        tabBarExtraContent={
          <Space>
            <Button
              aria-label="刷新"
              loading={shown.isFetching}
              onClick={refresh}
            >
              刷新
            </Button>
            {tab === "targets" && (
              <Button
                type="primary"
                disabled={busy}
                onClick={() => openEditor("new")}
              >
                新建目标
              </Button>
            )}
          </Space>
        }
      />
      {shown.hasNextPage && (
        <Button
          className="collection-more"
          loading={shown.isFetchingNextPage}
          onClick={() => void shown.fetchNextPage()}
        >
          加载更多
        </Button>
      )}
      <Modal
        title={editor === "new" ? "新建目标" : "编辑目标"}
        open={!!editor}
        forceRender
        onCancel={() => {
          if (!busy) {
            setEditor(undefined);
            setActionError("");
          }
        }}
        onOk={() => form.submit()}
        confirmLoading={busy}
        okButtonProps={{ "aria-label": "保存" }}
        okText="保存"
        cancelText="取消"
      >
        <Form
          form={form}
          name="collection-target"
          layout="vertical"
          onFinish={save}
        >
          {editor && actionError && (
            <Alert showIcon type="error" title={actionError} />
          )}
          <Form.Item
            label="目标名称"
            name="name"
            rules={[
              { required: true, whitespace: true, message: "请输入目标名称" },
            ]}
          >
            <Input maxLength={80} />
          </Form.Item>
          <Form.Item label="目标类型" name="kind" rules={[{ required: true }]}>
            <Select
              options={Object.entries(kinds).map(([value, label]) => ({
                value,
                label,
              }))}
              onChange={() => form.setFieldValue("value", "")}
            />
          </Form.Item>
          <Form.Item
            label={sourceLabels[kind]}
            name="value"
            rules={[
              { required: true, whitespace: true, message: "请填写目标内容" },
            ]}
            extra={
              kind === "video"
                ? "支持标准作品链接，或作者主页中已打开作品的地址。"
                : "此类型仅保存配置，暂未开通自动发现。"
            }
          >
            <Input
              placeholder={sources[kind]}
              maxLength={kind === "keyword" ? 100 : 2048}
            />
          </Form.Item>
          <Form.Item
            label="本机执行账号"
            name="accountId"
            rules={[{ required: true, message: "请选择本机抖音账号" }]}
          >
            <Select
              placeholder="选择抖音账号"
              loading={accounts.isLoading || desktop.isLoading}
              options={localAccounts.map((a) => ({
                value: a.id,
                label: a.name,
              }))}
            />
          </Form.Item>
          {!accounts.isLoading &&
            !desktop.isLoading &&
            !localAccounts.length && (
              <Alert
                type="info"
                title="请先在发布中心添加本机抖音账号"
                action={
                  <Button type="link" onClick={() => navigate("/publish")}>
                    发布中心
                  </Button>
                }
              />
            )}
        </Form>
      </Modal>
    </section>
  );
}
