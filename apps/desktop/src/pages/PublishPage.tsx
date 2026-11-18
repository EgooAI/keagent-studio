import { useEffect, useRef, useState } from "react";
import { Link, useBlocker, useParams } from "react-router-dom";
import {
  Alert,
  App,
  Button,
  Dropdown,
  Empty,
  Form,
  Input,
  Modal,
  Pagination,
  Progress,
  Radio,
  Segmented,
  Select,
  Space,
  Tag,
  type MenuProps,
} from "antd";
import { ArrowLeft, ChevronDown, Film, RotateCcw, Send } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { artifactExchange, isLive } from "@keagent/api-client";
import {
  douyinRecordLabel,
  formatDouyinSchedule,
  validateDouyinInput,
  validateDouyinSchedule,
  type ArtifactReviewState,
  type DouyinPublishRecord,
} from "@keagent/shared-types";
import { PageHeader } from "../components/common";
import PublishExecutionSteps from "../components/PublishExecutionSteps";
import {
  PublishWorkbench,
  reviewLabels,
  type PublishDetailSurface,
} from "../components/PublishWorkbench";
import { artifactMedia } from "../lib/artifactMedia";
import {
  douyinApi,
  douyinDesktop,
  desktopPublishingAvailable,
  publishingMessage,
  publishingFailureText,
  useDouyinDesktop,
} from "../lib/douyin";
import DemoPublishPage, {
  PublishDetailPage as DemoPublishDetail,
} from "./DemoPublishPage";

export default function PublishPage() {
  return isLive ? (
    <PublishWorkbench
      detail={(id, surface) => (
        <ArtifactPublishDetail key={id} artifactId={id} surface={surface} />
      )}
    />
  ) : (
    <DemoPublishPage />
  );
}
export function PublishDetailPage() {
  const { productionTaskId: artifactId = "" } = useParams();
  return isLive ? (
    <ArtifactPublishDetail key={artifactId} artifactId={artifactId} />
  ) : (
    <DemoPublishDetail />
  );
}
interface EditValues {
  title: string;
  description: string;
  hashtags: string[];
  accountId: string;
  timing: "immediate" | "scheduled";
  scheduleTime?: string;
}
const beijingSeconds = (value: string) => Date.parse(value + "+08:00") / 1000;
function ArtifactPublishDetail({
  artifactId,
  surface,
}: {
  artifactId: string;
  surface?: PublishDetailSurface;
}) {
  const embedded = !!surface;
  const client = useQueryClient();
  const { message, modal } = App.useApp();
  const desktop = useDouyinDesktop(!embedded);
  const artifactKey = ["douyin", "artifact", artifactId];
  const artifact = useQuery({
    queryKey: artifactKey,
    queryFn: () => artifactExchange.getArtifact(artifactId),
  });
  const accounts = useQuery({
    queryKey: ["douyin", "accounts"],
    queryFn: douyinApi.accounts,
  });
  const [recordOffset, setRecordOffset] = useState(0);
  const [detailTab, setDetailTab] = useState<"preview" | "records">("preview");
  const records = useQuery({
    queryKey: ["douyin", "records", artifactId, recordOffset],
    queryFn: () => douyinApi.records(artifactId, recordOffset),
    refetchInterval: 5000,
  });
  const assets = useQuery({
    queryKey: ["douyin", "assets", artifactId, artifact.data?.id],
    enabled: !!artifact.data,
    queryFn: () =>
      Promise.all(
        Object.values(artifact.data!.assets)
          .filter(Boolean)
          .map((id) => artifactExchange.getAsset(id)),
      ),
  });
  const [form] = Form.useForm<EditValues>();
  const values = Form.useWatch([], form) as EditValues | undefined;
  const [configurationRevision, setConfigurationRevision] = useState<number>();
  const configuring = configurationRevision !== undefined;
  const [dirty, setDirty] = useState(false);
  const blocker = useBlocker(dirty);
  const returnFocus = useRef<HTMLButtonElement>(null);
  const resultFocus = useRef<HTMLElement>(null);
  const inFlight = useRef(false);
  const [unplayableAt, setUnplayableAt] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reconciling, setReconciling] = useState<DouyinPublishRecord>();
  const [resultUrl, setResultUrl] = useState("");
  const [confirmAbsent, setConfirmAbsent] = useState(false);
  const publishKey = useRef(crypto.randomUUID());
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    const dialog = modal.confirm({
      className: "publish-dialog publish-confirm-dialog",
      centered: true,
      title: "本次发布文案尚未提交",
      okText: "放弃并离开",
      cancelText: "继续编辑",
      onOk: () => blocker.proceed(),
      onCancel: () => blocker.reset(),
    });
    return () => dialog.destroy();
  }, [blocker, modal]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function closeConfiguration() {
    if (inFlight.current) return;
    if (dirty)
      modal.confirm({
        className: "publish-dialog publish-confirm-dialog",
        centered: true,
        title: "放弃本次发布修改？",
        okText: "放弃修改",
        cancelText: "继续编辑",
        onOk: () => {
          publishKey.current = crypto.randomUUID();
          resetConfiguration();
        },
      });
    else resetConfiguration();
  }

  function resetConfiguration() {
    setDirty(false);
    setConfigurationRevision(undefined);
    setError("");
  }
  useEffect(() => {
    setRecordOffset(0);
  }, [artifactId]);
  useEffect(() => {
    publishKey.current = crypto.randomUUID();
  }, [artifactId, artifact.data?.review.revision]);
  const current = artifact.data;
  const localRecord = desktop.data?.activeRecord;
  const active = localRecord?.scheduledAt
    ? (records.data?.items.find(
        (record) =>
          record.id === localRecord.id && record.resultSource === "manual",
      ) ?? localRecord)
    : localRecord;
  const running =
    (!!active && ["running", "submitting"].includes(active.state)) ||
    !!desktop.data?.queue?.rows.some((row) =>
      ["running", "submitting"].includes(row.state),
    );
  const invalid = values
    ? validateDouyinInput({
        title: values.title || "",
        description: values.description || "",
        hashtags: values.hashtags || [],
      })
    : undefined;
  const scheduled = values?.timing === "scheduled";
  const scheduledAt = values?.scheduleTime
    ? beijingSeconds(values.scheduleTime)
    : undefined;
  const scheduleIssue =
    scheduled && scheduledAt !== undefined
      ? validateDouyinSchedule(scheduledAt)
      : undefined;
  const publishAction = scheduled
    ? scheduledAt && !scheduleIssue
      ? `预约 ${formatDouyinSchedule(scheduledAt).slice(5)} 发布`
      : "确认定时发布"
    : "立即发布到抖音";
  const deviceId = desktop.data?.deviceId;
  const local =
    !!deviceId &&
    assets.data?.every(
      (asset) =>
        asset.location.deviceId === deviceId &&
        asset.availability.state === "available",
    );
  const canPreview = !!desktop.data?.resolverAvailable && !!local;
  const previewKey = ["douyin-preview", artifactId, deviceId];
  const preview = useQuery({
    queryKey: previewKey,
    queryFn: () =>
      douyinDesktop<{ video: string; cover: string }>("preview", {
        artifactId,
      }),
    enabled: detailTab === "preview" && canPreview,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
  const playbackFailed = unplayableAt === preview.dataUpdatedAt;
  const previewError = preview.isError
    ? publishingMessage(preview.error)
    : playbackFailed
      ? "视频暂时无法播放"
      : undefined;
  const previewSource =
    canPreview && !playbackFailed && !preview.isError
      ? preview.data
      : undefined;
  const approved = current?.review.state === "approved";
  const reviewRevision = current?.review.revision;
  const handoffQuery = useQuery({
    queryKey: ["douyin-handoff", artifactId, deviceId, reviewRevision],
    queryFn: () =>
      artifactExchange.createHandoff({
        requestKey: `review-${artifactId}-${reviewRevision}`,
        artifactId,
        expectedReviewRevision: reviewRevision!,
      }),
    enabled: detailTab === "preview" && !!previewSource && approved,
    staleTime: Infinity,
    retry: false,
  });
  const handoff = handoffQuery.data;
  async function act(action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (error) {
      setError(publishingMessage(error));
    } finally {
      void client.invalidateQueries({ queryKey: ["douyin"] });
      inFlight.current = false;
      setBusy(false);
    }
  }
  function review(state: ArtifactReviewState) {
    modal.confirm({
      className: "publish-dialog publish-confirm-dialog",
      centered: true,
      title: state === "approved" ? "确认成片验收通过？" : "撤回成片验收？",
      content:
        state === "approved"
          ? "请确认已检查视频、封面与最终文案。通过后即可配置发布。"
          : "撤回后，尚未最终提交的发布操作会重新检查并停止。",
      okText: state === "approved" ? "验收通过" : "撤回验收",
      cancelText: "取消",
      onOk: () =>
        act(async () => {
          const updated = await artifactExchange.reviewArtifact({
            id: current!.id,
            expectedRevision: current!.review.revision,
            state,
          });
          client.setQueryData(artifactKey, updated);
        }),
    });
  }
  async function start(edit: EditValues) {
    if (!handoff) return;
    const scheduledAt =
      edit.timing === "scheduled"
        ? beijingSeconds(edit.scheduleTime || "")
        : undefined;
    if (scheduledAt !== undefined) {
      const invalid = validateDouyinSchedule(scheduledAt);
      if (invalid) throw new Error(invalid);
    }
    const record = await douyinApi.start({
      requestKey: publishKey.current,
      handoffId: handoff.id,
      accountId: edit.accountId,
      title: edit.title,
      description: edit.description || "",
      hashtags: edit.hashtags || [],
      scheduledAt,
    });
    if (!["running", "submitting"].includes(record.state))
      publishKey.current = crypto.randomUUID();
    resetConfiguration();
    setDetailTab("records");
    message.info(douyinRecordLabel(record));
  }
  async function openCreatorManage(record: DouyinPublishRecord) {
    await douyinDesktop("account.open", { accountId: record.accountId });
    await douyinDesktop("browser.action", {
      accountId: record.accountId,
      action: "manage",
    });
  }
  useEffect(() => {
    if (
      active?.artifactId === artifactId &&
      !["running", "submitting"].includes(active.state)
    )
      publishKey.current = crypto.randomUUID();
  }, [active?.id, active?.state, artifactId]);
  if (!current) {
    const status = (
      <>
        {!embedded && <PageHeader title="成片与抖音发布" />}
        {artifact.error ? (
          <Alert type="error" title={publishingMessage(artifact.error)} />
        ) : (
          <p>正在读取成片…</p>
        )}
      </>
    );
    return surface ? surface(status, false) : status;
  }
  const canConfigure = !!handoff && !!previewSource && approved;
  // A configuration that was opened for a different review must be closed and reopened.
  const canSubmit = canConfigure && configurationRevision === reviewRevision;
  let previewStatus = "正在加载视频预览…";
  if (previewError) previewStatus = previewError;
  else if (
    !desktopPublishingAvailable() ||
    desktop.data?.resolverAvailable === false ||
    desktop.isError ||
    assets.isError
  )
    previewStatus = "暂时无法预览成片";
  else if (assets.data && deviceId && !local)
    previewStatus = "请在原设备通过「更多」恢复文件";
  const restoreLabels = {
    video: "恢复视频文件",
    cover: "恢复封面文件",
    subtitle: "恢复字幕文件",
  };
  const recoveryItems = window.desktop?.artifactMedia
    ? (assets.data ?? []).map((asset) => ({
        key: asset.id,
        label: restoreLabels[asset.kind],
        disabled: busy || running || asset.location.deviceId !== deviceId,
        onClick: () =>
          void act(async () => {
            await artifactMedia.restore(asset.id);
            await client.resetQueries({ queryKey: previewKey, exact: true });
            message.success("文件已验证并恢复登记");
          }),
      }))
    : [];
  const moreItems: MenuProps["items"] = [
    ...(approved
      ? [
          {
            key: "withdraw",
            label: "撤回验收",
            icon: <RotateCcw size={15} aria-hidden="true" />,
            disabled: busy || running,
            onClick: () => review("pending"),
          },
        ]
      : []),
    ...(approved && recoveryItems.length ? [{ type: "divider" as const }] : []),
    ...recoveryItems,
  ];
  const content = (
    <div
      className={embedded ? "publish-artifact is-embedded" : "publish-artifact"}
    >
      {embedded ? (
        <div className="publish-detail-heading">
          <h2>{current.content.title}</h2>
        </div>
      ) : (
        <>
          <Link className="back-link" to="/publish">
            <ArrowLeft size={16} aria-hidden="true" /> 返回成片列表
          </Link>
          <PageHeader title={current.content.title} />
        </>
      )}
      {!desktopPublishingAvailable() && (
        <Alert
          type="info"
          title="请使用桌面客户端接收文件、管理账号并发布。网页版可以查看成片与记录。"
        />
      )}
      {desktopPublishingAvailable() && !desktop.data?.resolverAvailable && (
        <Alert
          type="info"
          title="等待制作侧文件解析器"
          description="成片信息与交接可正常查看；解析器接入后才启用真实预览和发布。"
        />
      )}
      {error && !configuring && !reconciling && (
        <Alert
          type="error"
          title="操作未完成"
          description={error}
          closable
          onClose={() => setError("")}
        />
      )}
      {assets.error && (
        <Alert type="error" title={publishingMessage(assets.error)} />
      )}
      <Segmented
        className="publish-detail-tabs"
        value={detailTab}
        onChange={setDetailTab}
        options={[
          { value: "preview", label: "预览验收" },
          { value: "records", label: "发布记录" },
        ]}
      />
      <div className="douyin-publish-layout" hidden={detailTab === "records"}>
        <section
          className="panel publish-preview-card"
          hidden={detailTab !== "preview"}
        >
          <div className="douyin-video-preview">
            {previewSource ? (
              <video
                key={preview.dataUpdatedAt}
                aria-label="成片预览"
                src={previewSource.video}
                poster={previewSource.cover}
                onError={() => setUnplayableAt(preview.dataUpdatedAt)}
                controls
              />
            ) : (
              <div className="publish-preview-placeholder">
                <div role="status">
                  <Film size={34} aria-hidden="true" />
                  <span>{previewStatus}</span>
                </div>
                {canPreview && previewError && (
                  <Button
                    size="small"
                    loading={preview.isFetching}
                    onClick={() => void preview.refetch()}
                  >
                    重新加载预览
                  </Button>
                )}
              </div>
            )}
          </div>
          <div className="publish-preview-actions">
            <Tag color={approved ? "green" : "gold"}>
              {reviewLabels[current.review.state]}
            </Tag>
            <div className="publish-review-actions">
              {approved ? (
                <Button
                  key="configure"
                  ref={returnFocus}
                  type="primary"
                  aria-label="配置发布"
                  aria-busy={handoffQuery.isFetching}
                  loading={handoffQuery.isFetching}
                  disabled={!canConfigure || busy || running}
                  onClick={() => {
                    form.resetFields();
                    form.setFieldsValue({
                      title: current.content.title,
                      description: current.content.script,
                      hashtags: [],
                    });
                    setError("");
                    setConfigurationRevision(current.review.revision);
                  }}
                >
                  配置发布
                </Button>
              ) : (
                <Button
                  key="approve"
                  type="primary"
                  disabled={!previewSource || busy || running}
                  onClick={() => review("approved")}
                >
                  验收通过
                </Button>
              )}
              {!!moreItems.length && (
                <Dropdown trigger={["click"]} menu={{ items: moreItems }}>
                  <Button
                    icon={<ChevronDown size={14} aria-hidden="true" />}
                    iconPlacement="end"
                    autoInsertSpace={false}
                    aria-haspopup="menu"
                    disabled={busy}
                  >
                    更多
                  </Button>
                </Dropdown>
              )}
            </div>
          </div>
          {approved && previewSource && handoffQuery.isError && (
            <Alert
              type="warning"
              showIcon
              title="暂时无法准备发布"
              description={publishingMessage(handoffQuery.error)}
              action={
                <Button
                  size="small"
                  onClick={() => void handoffQuery.refetch()}
                >
                  重试准备
                </Button>
              }
            />
          )}
        </section>
      </div>
      {active?.artifactId === artifactId && (
        <section
          className="panel douyin-result"
          hidden={detailTab !== "records"}
        >
          <h3>{douyinRecordLabel(active)}</h3>
          <Progress
            percent={active.progress}
            status={active.state === "failed" ? "exception" : undefined}
          />
          {running && (
            <Button
              onClick={() =>
                void act(async () => {
                  await douyinDesktop("account.open", {
                    accountId: active.accountId,
                  });
                })
              }
            >
              查看账号浏览器
            </Button>
          )}
        </section>
      )}
      <section
        ref={resultFocus}
        tabIndex={-1}
        className="panel douyin-result publish-record-panel"
        hidden={detailTab !== "records"}
      >
        <h2>这份成片的发布记录</h2>
        {records.error && (
          <Alert type="error" title={publishingMessage(records.error)} />
        )}
        <p className="muted">
          “已提交抖音”表示获得提交回执，不代表作品已通过审核或在线状态已核验。
        </p>
        {!records.data?.items.length && <Empty description="暂无发布记录" />}
        {records.data?.items.map((record) => (
          <article className="douyin-record" key={record.id}>
            <Space wrap className="publish-record-heading">
              <Tag
                color={
                  record.state === "accepted"
                    ? "green"
                    : record.state === "unknown"
                      ? "orange"
                      : "default"
                }
              >
                {douyinRecordLabel(record)}
              </Tag>
              <span>{record.title}</span>
              <small>
                {new Date(record.createdAt).toLocaleString("zh-CN")}
              </small>
              {record.resultSource === "manual" && <Tag>用户人工核对</Tag>}
            </Space>
            {record.scheduledAt && (
              <p>
                预约时间 {formatDouyinSchedule(record.scheduledAt)}（北京时间）
              </p>
            )}
            {record.url && douyinRecordLabel(record) !== "已排期" && (
              <p>
                <a
                  href={record.url}
                  onClick={(event) => {
                    if (desktopPublishingAvailable()) {
                      event.preventDefault();
                      void act(async () => {
                        await douyinDesktop("account.open", {
                          accountId: record.accountId,
                        });
                        await douyinDesktop("browser.action", {
                          accountId: record.accountId,
                          action: "post",
                          recordId: record.id,
                        });
                      });
                    }
                  }}
                  target="_blank"
                  rel="noreferrer"
                >
                  {record.url}
                </a>
              </p>
            )}
            {record.errorCode && (
              <p className="error-text">
                {publishingFailureText(record.errorCode)}
              </p>
            )}
            {(record.state === "unknown" ||
              douyinRecordLabel(record) === "已排期") && (
              <Space>
                <Button
                  disabled={!desktopPublishingAvailable()}
                  onClick={() => void act(() => openCreatorManage(record))}
                >
                  {record.state === "unknown"
                    ? "打开创作者中心核对"
                    : "去抖音管理"}
                </Button>
                <Button
                  disabled={record.deviceId !== desktop.data?.deviceId}
                  onClick={() => {
                    setReconciling(record);
                    setResultUrl(
                      record.state === "accepted" ? record.url || "" : "",
                    );
                    setConfirmAbsent(false);
                  }}
                >
                  记录核对结果
                </Button>
              </Space>
            )}
            <PublishExecutionSteps record={record} />
          </article>
        ))}
        {(records.data?.total || 0) > 20 && (
          <Pagination
            current={recordOffset / 20 + 1}
            pageSize={20}
            showSizeChanger={false}
            total={records.data?.total}
            onChange={(page) => setRecordOffset((page - 1) * 20)}
          />
        )}
      </section>
    </div>
  );
  return (
    <>
      {surface ? surface(content, configuring || !!reconciling) : content}
      <Modal
        centered
        forceRender
        width={880}
        classNames={{ body: "workbench-form-body" }}
        className="publish-dialog"
        title="配置发布"
        open={configuring}
        closable={!busy}
        keyboard={!busy}
        mask={{ closable: false }}
        onCancel={closeConfiguration}
        cancelText="取消"
        okText={publishAction}
        confirmLoading={busy}
        okButtonProps={{
          "aria-label": publishAction,
          disabled:
            busy ||
            !canSubmit ||
            running ||
            !!invalid ||
            (scheduled && (!scheduledAt || !!scheduleIssue)),
        }}
        onOk={() => form.submit()}
        afterOpenChange={(open) => {
          if (!open) {
            const target =
              detailTab === "records"
                ? resultFocus.current
                : returnFocus.current;
            target?.focus({ preventScroll: embedded });
          }
        }}
      >
        <p className="muted publish-config-notice">
          <Send size={17} aria-hidden="true" />
          <span>
            {scheduled
              ? "由抖音按排期公开，关闭下载，不同步头条。"
              : "立即公开发布，关闭下载，不同步头条。"}
            成片封面将上传为抖音竖封面。
          </span>
        </p>
        <Form
          className="publish-config-fields"
          form={form}
          layout="vertical"
          disabled={busy}
          onFinish={(edit) => {
            if (canSubmit && !running && !invalid) void act(() => start(edit));
          }}
          initialValues={{ hashtags: [], description: "", timing: "immediate" }}
          onValuesChange={() => {
            setDirty(true);
            publishKey.current = crypto.randomUUID();
          }}
        >
          <div>
            <Form.Item
              name="title"
              label="标题"
              rules={[{ required: true, message: "请输入标题" }]}
            >
              <Input showCount />
            </Form.Item>
            <Form.Item name="description" label="正文">
              <Input.TextArea rows={5} showCount />
            </Form.Item>
            <Form.Item name="hashtags" label="话题">
              <Select
                mode="tags"
                tokenSeparators={[" ", ","]}
                placeholder="输入话题后按回车"
              />
            </Form.Item>
          </div>
          <div>
            <Form.Item
              name="accountId"
              label="发布账号"
              rules={[{ required: true, message: "请选择抖音账号" }]}
            >
              <Select
                placeholder="选择当前设备的抖音账号"
                options={accounts.data?.items
                  .filter(
                    (account) =>
                      account.platform !== "xhs" &&
                      account.deviceId === desktop.data?.deviceId,
                  )
                  .map((account) => ({
                    value: account.id,
                    label: `${account.name}${account.loginStatus !== "logged_in" ? "（需登录）" : ""}`,
                  }))}
              />
            </Form.Item>
            <p className="publish-config-account-link">
              <Link to="/settings/platforms">添加或重新登录抖音账号</Link>
            </p>
            <Form.Item name="timing" label="发布时间">
              <Radio.Group
                options={[
                  { value: "immediate", label: "立即发布" },
                  { value: "scheduled", label: "定时发布" },
                ]}
              />
            </Form.Item>
            {scheduled && (
              <>
                <Form.Item
                  name="scheduleTime"
                  label="预约时间（北京时间）"
                  preserve={false}
                  extra="请选择 2 小时后至 14 天内的时间。"
                  rules={[{ required: true, message: "请选择预约时间" }]}
                >
                  <Input type="datetime-local" />
                </Form.Item>
                {previewSource?.cover && (
                  <img
                    className="douyin-cover-thumbnail"
                    src={previewSource.cover}
                    alt="预约发布封面"
                  />
                )}
              </>
            )}
          </div>
          {invalid && <Alert type="warning" title={invalid} />}
          {scheduleIssue && <Alert type="warning" title={scheduleIssue} />}
          {configuring && error && (
            <Alert type="error" showIcon title={error} />
          )}
          {configuring && !canSubmit && (
            <Alert
              type="warning"
              showIcon
              title="发布条件已变化，请返回详情检查验收和本机文件。"
            />
          )}
        </Form>
      </Modal>
      <Modal
        className="publish-dialog publish-reconcile-dialog"
        centered
        title={confirmAbsent ? "核对后允许重新安排发布" : "记录人工核对结果"}
        open={!!reconciling}
        onCancel={() => setReconciling(undefined)}
        footer={
          <Space>
            <Button onClick={() => setReconciling(undefined)}>取消</Button>
            <Button
              danger
              onClick={() => {
                if (!confirmAbsent) {
                  setConfirmAbsent(true);
                  return;
                }
                void act(async () => {
                  await douyinApi.reconcile(reconciling!.id, false);
                  setReconciling(undefined);
                });
              }}
            >
              {reconciling?.state === "accepted"
                ? confirmAbsent
                  ? "我已核对，预约已取消"
                  : "确认预约已取消"
                : confirmAbsent
                  ? "我已核对，确认未发布"
                  : "确认未发布"}
            </Button>
            <Button
              type="primary"
              disabled={!resultUrl || busy}
              onClick={() =>
                void act(async () => {
                  await douyinApi.reconcile(reconciling!.id, true, resultUrl);
                  setReconciling(undefined);
                })
              }
            >
              {reconciling?.scheduledAt ? "确认作品已公开" : "确认已有作品"}
            </Button>
          </Space>
        }
      >
        {error && <Alert type="error" title={error} />}
        <p>
          {reconciling?.scheduledAt
            ? "请先在抖音创作者中心核对该作品的排期和公开状态。排期仍在时请保留原记录。"
            : "请先在创作者中心核对。仅凭网络错误不能判断未发布，错误判断后再次操作可能产生重复作品。"}
        </p>
        <label className="publish-reconcile-field">
          已发布的抖音作品链接
          <Input
            aria-label="已发布的抖音作品链接"
            placeholder="https://www.douyin.com/video/作品ID"
            value={resultUrl}
            onChange={(event) => setResultUrl(event.target.value)}
          />
        </label>
      </Modal>
    </>
  );
}
