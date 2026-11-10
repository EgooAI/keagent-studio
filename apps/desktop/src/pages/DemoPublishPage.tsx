import { useEffect, useRef, useState } from "react";
import { Link, useBlocker, useParams, useSearchParams } from "react-router-dom";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Empty,
  Form,
  Input,
  Modal,
  Select,
  Tabs,
  Tag,
} from "antd";
import {
  ArrowLeft,
  ArrowUpRight,
  Download,
  Film,
  Search,
  Send,
  Video,
} from "lucide-react";
import { demoApi, isLive } from "@keagent/api-client";
import {
  platformLabels,
  type Platform,
  type ProductionTask,
  type PublishInput,
  type Workspace,
} from "@keagent/shared-types";
import { PageHeader, StatusTag, formatDate } from "../components/common";
import { useWorkspace } from "../lib/workspace";
import { productionResults } from "../lib/productionResults";

export default function PublishPage() {
  const { data } = useWorkspace();
  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");
  if (!data) return null;
  const completed = data.tasks.flatMap(productionResults);
  const tasks = completed.filter((task) => {
    const publishes = data.publishTasks.filter(
      (p) =>
        p.productionTaskId === task.id &&
        p.productionRevision === task.productionRevision,
    );
    const matches =
      status === "all" ||
      (status === "pending"
        ? !publishes.length
        : status === "failed"
          ? publishes.some((p) => ["failed", "unknown"].includes(p.status))
          : publishes.some((p) => p.status === status));
    return (
      matches &&
      `${task.propertySnapshot.community}${task.propertySnapshot.title}`.includes(
        search,
      )
    );
  });
  return (
    <>
      <PageHeader
        title="发布中心"
        description="检查每一份成片，再把合适的内容带到合适的平台。"
      />
      <div className="property-toolbar">
        <Tabs
          activeKey={status}
          onChange={setStatus}
          items={[
            ["all", "全部成果"],
            ["pending", "待发布"],
            ["running", "上传中"],
            ["draft_saved", "平台草稿"],
            ["published", "已发布"],
            ["failed", "失败 / 待确认"],
          ].map(([key, label]) => ({ key, label }))}
        />
        <Input
          className="publish-search"
          placeholder="搜索房源或视频"
          aria-label="搜索成片"
          prefix={<Search size={16} />}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          allowClear
        />
      </div>
      <div className="list-caption">
        <span>{tasks.length} 份视频成果</span>
        <span>平台草稿与正式发布分别记录 · 当前为模拟环境</span>
      </div>
      {tasks.length ? (
        <div className="publish-grid">
          {tasks.map((task) => (
            <article
              className="publish-card"
              key={`${task.id}-${task.productionRevision}`}
            >
              <Link
                className="publish-cover"
                to={`${isLive ? "/publish/demo" : "/publish"}/${task.id}?revision=${task.productionRevision}`}
              >
                <img
                  src={task.coverUrl ?? task.propertySnapshot.image}
                  alt={`${task.propertySnapshot.community}视频封面`}
                />
                <span className="video-cover-copy">
                  <small>
                    {task.configSnapshot.videoMode === "avatar"
                      ? "经纪人露脸"
                      : "纯口播"}
                  </small>
                  <strong>{task.propertySnapshot.community}</strong>
                  <span>
                    {task.propertySnapshot.layout} ·{" "}
                    {task.propertySnapshot.areaSqm}m²
                  </span>
                </span>
                <span className="video-play">
                  <Video size={24} />
                </span>
                <span className="sample-stamp">演示成片</span>
              </Link>
              <div className="publish-card-content">
                <h2>
                  <Link
                    to={`${isLive ? "/publish/demo" : "/publish"}/${task.id}?revision=${task.productionRevision}`}
                  >
                    {task.propertySnapshot.community}
                  </Link>
                </h2>
                <p className="muted">
                  成果修订 {task.productionRevision} ·{" "}
                  {formatDate(task.createdAt)} ·{" "}
                  {task.configSnapshot.outputResolution} ·{" "}
                  {task.configSnapshot.aspectRatio}
                </p>
                <div className="platform-statuses">
                  {data.publishTasks.filter(
                    (p) =>
                      p.productionTaskId === task.id &&
                      p.productionRevision === task.productionRevision,
                  ).length ? (
                    data.publishTasks
                      .filter(
                        (p) =>
                          p.productionTaskId === task.id &&
                          p.productionRevision === task.productionRevision,
                      )
                      .map((p) => (
                        <span key={p.id}>
                          {platformLabels[p.platform]}{" "}
                          <StatusTag status={p.status} />
                        </span>
                      ))
                  ) : (
                    <Tag>待发布</Tag>
                  )}
                </div>
                <Link
                  to={`${isLive ? "/publish/demo" : "/publish"}/${task.id}?revision=${task.productionRevision}`}
                  className="text-link"
                >
                  查看成果与发布 <ArrowUpRight size={15} />
                </Link>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <section className="panel empty-panel">
          <Empty description="这里还没有匹配的成片">
            <Link to="/studio">
              <Button type="primary">前往视频工厂</Button>
            </Link>
          </Empty>
        </section>
      )}
    </>
  );
}

export function PublishDetailPage() {
  const { productionTaskId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { modal } = App.useApp();
  const [dirty, setDirty] = useState(false);
  const blocker = useBlocker(dirty);
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    const dialog = modal.confirm({
      title: "放弃未提交的模拟发布配置？",
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
  const { data } = useWorkspace();
  if (!data) return null;
  const original = data.tasks.find((t) => t.id === productionTaskId);
  if (!original)
    return (
      <Empty description="成果不存在">
        <Link to="/publish">返回发布中心</Link>
      </Empty>
    );
  const revisions = productionResults(original);
  const requestedRevision = searchParams.get("revision");
  const task = requestedRevision
    ? revisions.find(
        (item) => item.productionRevision === Number(requestedRevision),
      )
    : revisions[0];
  if (!task)
    return (
      <Empty description="当前修订还未完成生产">
        <Link to={`/studio/tasks/${original.id}`}>查看生产任务</Link>
      </Empty>
    );
  const canPublish =
    original.status === "succeeded" &&
    original.productionRevision === task.productionRevision;
  const resolve = (id: string) =>
    data.resources.find((r) => r.id === id)?.name ?? id;
  const snapshots = [
    [
      "视频模式",
      task.configSnapshot.videoMode === "avatar" ? "经纪人露脸" : "纯口播",
    ],
    [
      "视频模板",
      `${resolve(task.configSnapshot.videoTemplate.id)} / v${task.configSnapshot.videoTemplate.version}`,
    ],
    [
      "风格模板",
      `${resolve(task.configSnapshot.styleTemplate.id)} / v${task.configSnapshot.styleTemplate.version}`,
    ],
    ["封面模板", resolve(task.configSnapshot.coverTemplate.id)],
    ["提示词模板", resolve(task.configSnapshot.promptTemplate.id)],
    [
      "声音",
      data.voices.find((v) => v.id === task.configSnapshot.voiceId)?.name ??
        "历史音色",
    ],
    ["文案修订", `第 ${task.scriptRevision} 版`],
    ["成果修订", `第 ${task.productionRevision} 版`],
  ];
  return (
    <>
      <Link className="back-link" to="/publish">
        <ArrowLeft size={16} /> 发布中心
      </Link>
      <PageHeader
        title={task.propertySnapshot.community}
        description="检查内容和来源信息，为不同平台分别设置发布文案。"
        actions={
          <>
            <Select
              aria-label="查看成果版本"
              value={task.productionRevision}
              onChange={(revision) =>
                setSearchParams({ revision: String(revision) })
              }
              options={revisions.map((result) => ({
                value: result.productionRevision,
                label: `成果修订 ${result.productionRevision}${result.productionRevision === original.productionRevision ? "（当前）" : "（历史）"}`,
              }))}
            />
            <a href={task.videoUrl} download="演示素材.mp4">
              <Button icon={<Download size={16} />}>下载示例视频</Button>
            </a>
          </>
        }
      />
      <div className="publish-detail-grid">
        <aside className="panel provenance-panel">
          <h2>制作信息</h2>
          <img
            src={task.propertySnapshot.image}
            className="provenance-photo"
            alt="房源来源照片"
          />
          <h3>{task.propertySnapshot.community}</h3>
          <p className="muted">
            {task.propertySnapshot.layout} · {task.propertySnapshot.areaSqm}m²
          </p>
          <p className="muted">编号 {task.propertySnapshot.propertyNumber}</p>
          <dl className="snapshot-list">
            {snapshots.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <Link to={`/studio/tasks/${task.id}`} className="text-link">
            查看生产记录 <ArrowUpRight size={14} />
          </Link>
        </aside>
        <section className="panel content-preview-panel">
          <div className="section-heading">
            <h2>视频成果</h2>
            <Tag variant="filled">本地演示素材</Tag>
          </div>
          <video
            controls
            preload="metadata"
            poster={task.coverUrl}
            src={task.videoUrl}
            className="result-video"
          />
          <p className="preview-disclaimer">
            静音示例视频，用于验证播放交互，未实际执行配音或剪辑。
          </p>
          <h3>口播文案</h3>
          <div className="script-content">{task.script}</div>
          <h3>封面预览</h3>
          <div className="cover-preview">
            <img
              src={task.coverUrl ?? task.propertySnapshot.image}
              alt="示例封面"
            />
            <strong>
              {task.propertySnapshot.community}
              <small>
                {task.propertySnapshot.layout} · {task.propertySnapshot.areaSqm}
                m²
              </small>
            </strong>
          </div>
        </section>
        <aside className="panel platform-config-panel">
          <h2>发布记录</h2>
          <p className="muted">不同平台的标题、账号和状态各自独立。</p>
          {!canPublish && (
            <p className="muted">
              正在查看历史成果，仅可查看并核对对应修订的发布记录。
            </p>
          )}
          <Tabs
            items={(["douyin", "xiaohongshu"] as Platform[]).map(
              (platform) => ({
                key: platform,
                label: platformLabels[platform],
                children: (
                  <PlatformPublishForm
                    key={`${task.id}-${task.productionRevision}-${platform}`}
                    task={task}
                    platform={platform}
                    data={data}
                    canPublish={canPublish}
                    dirty={dirty}
                    onDirty={setDirty}
                  />
                ),
              }),
            )}
          />
        </aside>
      </div>
    </>
  );
}

function PlatformPublishForm({
  task,
  platform,
  data,
  canPublish,
  dirty,
  onDirty,
}: {
  task: ProductionTask;
  platform: Platform;
  data: Workspace;
  canPublish: boolean;
  dirty: boolean;
  onDirty: (dirty: boolean) => void;
}) {
  const { message, modal } = App.useApp();
  const [form] = Form.useForm<PublishInput>();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const request = useRef({ fingerprint: "", key: "" });
  const accounts = data.accounts.filter(
    (account) => account.platform === platform && account.connected,
  );
  const records = data.publishTasks.filter(
    (p) =>
      p.productionTaskId === task.id &&
      p.platform === platform &&
      p.productionRevision === task.productionRevision,
  );
  function reset() {
    onDirty(false);
    setError("");
    setOpen(false);
  }
  function cancel() {
    if (inFlight.current) return;
    if (dirty)
      modal.confirm({
        title: "放弃未提交的模拟发布配置？",
        okText: "放弃修改",
        cancelText: "继续编辑",
        onOk: reset,
      });
    else reset();
  }
  async function submit(values: PublishInput) {
    if (inFlight.current || !canPublish || !accounts.length) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const payload = { ...values, hashtags: values.hashtags ?? [] };
      const fingerprint = JSON.stringify(payload);
      if (request.current.fingerprint !== fingerprint)
        request.current = { fingerprint, key: crypto.randomUUID() };
      await demoApi.createPublish(
        task.id,
        platform,
        payload,
        request.current.key,
      );
      reset();
      message.success("已创建模拟上传任务，可在下方查看进度");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "模拟提交失败，请重试");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      {canPublish && (
        <Button
          type="primary"
          onClick={() => {
            form.resetFields();
            setOpen(true);
          }}
        >
          配置发布
        </Button>
      )}
      <Modal
        centered
        width={640}
        classNames={{ body: "workbench-form-body" }}
        title={`配置模拟发布 · ${platformLabels[platform]}`}
        open={open}
        forceRender
        closable={!busy}
        keyboard={!busy}
        mask={{ closable: false }}
        onCancel={cancel}
        cancelText="取消"
        okText={`模拟提交到${platformLabels[platform]}草稿`}
        okButtonProps={{
          disabled: busy || !accounts.length || !canPublish,
          icon: <Send size={15} />,
        }}
        confirmLoading={busy}
        onOk={() => form.submit()}
      >
        <Form
          name={`publish-${task.id}-${task.productionRevision}-${platform}`}
          form={form}
          layout="vertical"
          disabled={!canPublish || busy}
          onValuesChange={() => onDirty(true)}
          onFinish={(values) => void submit(values)}
          initialValues={{
            accountId: accounts[0]?.id,
            title: `${task.propertySnapshot.community}｜${task.propertySnapshot.title}`,
            description: "房源与价格为示例内容，信息以实际核验为准。",
            hashtags: ["上海房产", "房源介绍"],
          }}
        >
          <Form.Item
            label="平台账号"
            name="accountId"
            rules={[{ required: true, message: "请选择已连接账号" }]}
          >
            <Select
              placeholder="选择已连接账号"
              options={accounts.map((a) => ({ value: a.id, label: a.name }))}
            />
          </Form.Item>
          {!accounts.length && (
            <Link to="/settings/platforms">前往设置连接演示账号</Link>
          )}
          <Form.Item
            label="发布标题"
            name="title"
            rules={[
              { required: true, message: "请填写发布标题" },
              { max: 100, message: "标题不能超过100字" },
            ]}
          >
            <Input.TextArea rows={2} maxLength={100} showCount />
          </Form.Item>
          <Form.Item label="发布描述" name="description">
            <Input.TextArea rows={4} />
          </Form.Item>
          <Form.Item label="话题标签" name="hashtags">
            <Select mode="tags" tokenSeparators={[",", "，"]} />
          </Form.Item>
          <Form.Item name="simulateFailure" valuePropName="checked">
            <Checkbox>模拟提交结果未知</Checkbox>
          </Form.Item>
        </Form>
        {open && error && <Alert type="error" showIcon title={error} />}
        <p className="preview-disclaimer">模拟发布仅在演示工作区生成记录。</p>
      </Modal>
      <div className="publish-records">
        <h3>该平台记录</h3>
        {records.length ? (
          records.map((record) => (
            <div className="publish-record" key={record.id}>
              <div>
                <StatusTag status={record.status} />
                <small>{formatDate(record.createdAt)}</small>
              </div>
              <p>{record.title}</p>
              {record.error && <p className="error-text">{record.error}</p>}
              {record.status === "unknown" && (
                <Button
                  size="small"
                  onClick={async () => {
                    try {
                      await demoApi.reconcilePublish(record.id);
                      message.success("已模拟核对结果，未重复提交");
                    } catch (error) {
                      message.error((error as Error).message);
                    }
                  }}
                >
                  核对模拟结果
                </Button>
              )}
            </div>
          ))
        ) : (
          <p className="muted">还没有该平台的发布任务</p>
        )}
      </div>
    </>
  );
}
