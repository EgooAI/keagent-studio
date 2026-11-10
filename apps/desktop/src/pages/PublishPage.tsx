import { useEffect, useRef, useState } from "react";
import { Link, useBlocker, useParams } from "react-router-dom";
import {
  Alert,
  App,
  Button,
  Empty,
  Form,
  Input,
  Modal,
  Pagination,
  Progress,
  Segmented,
  Select,
  Space,
  Tag,
  Timeline,
} from "antd";
import { Film } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { artifactExchange, isLive } from "@keagent/api-client";
import {
  douyinStateLabels,
  validateDouyinInput,
  type ArtifactHandoff,
  type ArtifactReviewState,
  type DouyinPublishRecord,
} from "@keagent/shared-types";
import { PageHeader } from "../components/common";
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
}
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
  const artifact = useQuery({
    queryKey: ["douyin", "artifact", artifactId],
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
  const [configuring, setConfiguring] = useState(false);
  const [dirty, setDirty] = useState(false);
  const blocker = useBlocker(dirty);
  const returnFocus = useRef<HTMLButtonElement>(null);
  const resultFocus = useRef<HTMLElement>(null);
  const inFlight = useRef(false);
  const [handoff, setHandoff] = useState<ArtifactHandoff>();
  const [preview, setPreview] = useState<{ video: string; cover: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reconciling, setReconciling] = useState<DouyinPublishRecord>();
  const [resultUrl, setResultUrl] = useState("");
  const [confirmAbsent, setConfirmAbsent] = useState(false);
  const handoffKey = useRef(crypto.randomUUID());
  const publishKey = useRef(crypto.randomUUID());
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    const dialog = modal.confirm({
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
    setConfiguring(false);
    setError("");
  }
  useEffect(() => {
    setHandoff(undefined);
    setRecordOffset(0);
    setPreview(undefined);
    handoffKey.current = crypto.randomUUID();
    publishKey.current = crypto.randomUUID();
  }, [artifactId]);
  useEffect(() => {
    setHandoff(undefined);
    handoffKey.current = crypto.randomUUID();
    publishKey.current = crypto.randomUUID();
  }, [artifact.data?.review.revision]);
  const current = artifact.data;
  const active = desktop.data?.activeRecord;
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
  const local = assets.data?.every(
    (asset) =>
      asset.location.deviceId === desktop.data?.deviceId &&
      asset.availability.state === "available",
  );
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
  async function receive() {
    if (!current) return;
    const value = await artifactExchange.createHandoff({
      requestKey: handoffKey.current,
      artifactId: current.id,
      expectedReviewRevision: current.review.revision,
    });
    setHandoff(value);
    message.success("已固定成片交接版本");
  }
  function review(state: ArtifactReviewState) {
    modal.confirm({
      title: state === "approved" ? "确认成片验收通过？" : "撤回成片验收？",
      content:
        state === "approved"
          ? "请确认已检查视频、封面与最终文案。验收通过后才能接收并发布这份成片。"
          : "撤回后，尚未最终提交的发布操作会重新检查并停止。",
      okText: state === "approved" ? "验收通过" : "撤回验收",
      cancelText: "取消",
      onOk: () =>
        act(async () => {
          await artifactExchange.reviewArtifact({
            id: current!.id,
            expectedRevision: current!.review.revision,
            state,
          });
          setHandoff(undefined);
        }),
    });
  }
  async function start(edit: EditValues) {
    if (!handoff) return;
    const record = await douyinApi.start({
      requestKey: publishKey.current,
      handoffId: handoff.id,
      accountId: edit.accountId,
      title: edit.title,
      description: edit.description || "",
      hashtags: edit.hashtags || [],
    });
    if (!["running", "submitting"].includes(record.state))
      publishKey.current = crypto.randomUUID();
    resetConfiguration();
    setDetailTab("records");
    message.info(douyinStateLabels[record.state]);
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
  const canConfigure =
    !!handoff &&
    !!desktop.data?.resolverAvailable &&
    !!local &&
    current.review.state === "approved";
  const content = (
    <>
      {embedded ? (
        <div className="publish-detail-heading">
          <h2>{current.content.title}</h2>
          <p className="muted">
            成片版本 {current.source.revision} · 验收修订{" "}
            {current.review.revision}
          </p>
        </div>
      ) : (
        <>
          <Link to="/publish">← 返回成片列表</Link>
          <PageHeader
            title={current.content.title}
            description={`成片版本 ${current.source.revision} · 验收修订 ${current.review.revision}`}
          />
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
        <section className="panel" hidden={detailTab !== "preview"}>
          <div className="douyin-video-preview">
            {preview ? (
              <video src={preview.video} poster={preview.cover} controls />
            ) : (
              <Film size={64} />
            )}
          </div>
          <Space wrap>
            <Tag
              color={current.review.state === "approved" ? "green" : "default"}
            >
              {reviewLabels[current.review.state]}
            </Tag>
            <Tag>
              {assets.isPending
                ? "检查资产状态中"
                : local
                  ? "当前设备文件已登记"
                  : "需在原设备恢复文件"}
            </Tag>
            <Button
              disabled={!desktop.data?.resolverAvailable || !local || busy}
              onClick={() =>
                void act(async () =>
                  setPreview(await douyinDesktop("preview", { artifactId })),
                )
              }
            >
              验证文件并预览
            </Button>
          </Space>
          <p className="muted">发布前会重新检查验收状态和本机文件。</p>
          <Space wrap className="douyin-file-actions">
            {window.desktop?.artifactMedia &&
              assets.data?.map((asset) => (
                <Button
                  key={asset.id}
                  size="small"
                  disabled={
                    busy ||
                    running ||
                    asset.location.deviceId !== desktop.data?.deviceId
                  }
                  onClick={() =>
                    void act(async () => {
                      await artifactMedia.restore(asset.id);
                      setPreview(undefined);
                      message.success("文件已验证并恢复登记");
                    })
                  }
                >
                  {asset.kind === "video"
                    ? "恢复视频文件"
                    : asset.kind === "cover"
                      ? "恢复封面文件"
                      : "恢复字幕文件"}
                </Button>
              ))}
            {current.review.state !== "approved" && (
              <Button
                type="primary"
                disabled={!preview || busy || running}
                onClick={() => review("approved")}
              >
                验收通过
              </Button>
            )}
            {current.review.state === "approved" && (
              <Button
                disabled={busy || running}
                onClick={() => review("pending")}
              >
                撤回验收
              </Button>
            )}
          </Space>
          {current.review.state !== "approved" && (
            <p className="muted">先验证文件并预览，再确认成片验收。</p>
          )}

          <Button
            disabled={
              !desktopPublishingAvailable() ||
              busy ||
              current.review.state !== "approved" ||
              !local
            }
            onClick={() => void act(receive)}
          >
            {handoff ? "已接收该版本" : "接收这份成片"}
          </Button>
          {handoff && (
            <>
              <p className="muted">交接号：{handoff.id}</p>
              <Button
                ref={returnFocus}
                type="primary"
                disabled={!canConfigure || busy || running}
                onClick={() => {
                  form.resetFields();
                  form.setFieldsValue({
                    title: current.content.title,
                    description: current.content.script,
                    hashtags: [],
                  });
                  setError("");
                  setConfiguring(true);
                }}
              >
                配置发布
              </Button>
            </>
          )}
        </section>
      </div>
      {active?.artifactId === artifactId && (
        <section
          className="panel douyin-result"
          hidden={detailTab !== "records"}
        >
          <h3>{douyinStateLabels[active.state]}</h3>
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
        className="panel douyin-result"
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
            <Space wrap>
              <Tag
                color={
                  record.state === "accepted"
                    ? "green"
                    : record.state === "unknown"
                      ? "orange"
                      : "default"
                }
              >
                {douyinStateLabels[record.state]}
              </Tag>
              <span>{record.title}</span>
              <small>
                {new Date(record.createdAt).toLocaleString("zh-CN")}
              </small>
              {record.resultSource === "manual" && <Tag>用户人工核对</Tag>}
            </Space>
            {record.url && (
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
            {record.state === "unknown" && (
              <Space>
                <Button
                  disabled={!desktopPublishingAvailable()}
                  onClick={() =>
                    void act(async () => {
                      await douyinDesktop("account.open", {
                        accountId: record.accountId,
                      });
                      await douyinDesktop("browser.action", {
                        accountId: record.accountId,
                        action: "manage",
                      });
                    })
                  }
                >
                  打开创作者中心核对
                </Button>
                <Button
                  disabled={record.deviceId !== desktop.data?.deviceId}
                  onClick={() => {
                    setReconciling(record);
                    setResultUrl("");
                    setConfirmAbsent(false);
                  }}
                >
                  记录核对结果
                </Button>
              </Space>
            )}
            <details>
              <summary>执行步骤</summary>
              <Timeline
                items={record.logs.map((log, index) => ({
                  key: index,
                  children: `${log.step} · ${log.status}${log.durationMs === undefined ? "" : ` · ${log.durationMs}ms`}`,
                }))}
              />
            </details>
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
    </>
  );
  return (
    <>
      {surface ? surface(content, configuring || !!reconciling) : content}
      <Modal
        centered
        forceRender
        width={880}
        classNames={{ body: "workbench-form-body" }}
        title="配置发布"
        open={configuring}
        closable={!busy}
        keyboard={!busy}
        mask={{ closable: false }}
        onCancel={closeConfiguration}
        cancelText="取消"
        okText="立即发布到抖音"
        confirmLoading={busy}
        okButtonProps={{
          "aria-label": "立即发布到抖音",
          disabled: busy || !canConfigure || running || !!invalid,
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
          立即公开发布，关闭下载，不同步头条。封面由抖音页面处理。
        </p>
        <Form
          className="publish-config-fields"
          form={form}
          layout="vertical"
          disabled={busy}
          onFinish={(edit) => {
            if (canConfigure && !running && !invalid)
              void act(() => start(edit));
          }}
          initialValues={{ hashtags: [], description: "" }}
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
                    (account) => account.deviceId === desktop.data?.deviceId,
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
          </div>
          {invalid && <Alert type="warning" title={invalid} />}
          {configuring && error && (
            <Alert type="error" showIcon title={error} />
          )}
          {configuring && !canConfigure && (
            <Alert
              type="warning"
              showIcon
              title="发布条件已变化，请返回详情检查验收和本机文件。"
            />
          )}
        </Form>
      </Modal>
      <Modal
        title={confirmAbsent ? "确认未发布后允许重新操作" : "记录人工核对结果"}
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
              {confirmAbsent ? "我已核对，确认未发布" : "确认未发布"}
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
              确认已有作品
            </Button>
          </Space>
        }
      >
        {error && <Alert type="error" title={error} />}
        <p>
          请先在创作者中心核对。仅凭网络错误不能判断未发布，错误判断后再次操作可能产生重复作品。
        </p>
        <Input
          aria-label="已发布的抖音作品链接"
          placeholder="https://www.douyin.com/video/作品ID"
          value={resultUrl}
          onChange={(event) => setResultUrl(event.target.value)}
        />
      </Modal>
    </>
  );
}
