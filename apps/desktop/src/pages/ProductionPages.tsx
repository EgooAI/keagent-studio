import { useEffect, useState } from "react";
import {
  Alert,
  App,
  Button,
  Descriptions,
  Empty,
  Input,
  Progress,
  Skeleton,
  Steps,
  Table,
  Tag,
} from "antd";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  FileCheck,
  RefreshCw,
  Save,
  Square,
} from "lucide-react";
import { Link, useBlocker, useNavigate, useParams } from "react-router-dom";
import { demoApi } from "@keagent/api-client";
import {
  stageLabels,
  type ProductionTask,
  type Stage,
} from "@keagent/shared-types";
import { useWorkspace } from "../lib/workspace";
import { ScriptHistory } from "../components/ScriptHistory";
import {
  PageHeader,
  StatusTag,
  formatDate,
  formatPrice,
} from "../components/common";

export function BatchDetailPage() {
  const { batchId } = useParams();
  const { data } = useWorkspace();
  const { message } = App.useApp();
  const navigate = useNavigate();
  if (!data) return <Skeleton active />;
  const batch = data.batches.find((item) => item.id === batchId);
  if (!batch)
    return (
      <Empty description="未找到这个生成批次">
        <Button onClick={() => navigate("/studio")}>返回视频工厂</Button>
      </Empty>
    );
  const tasks = data.tasks.filter((task) => task.batchId === batch.id);
  const counts = {
    done: tasks.filter((task) => task.status === "succeeded").length,
    review: tasks.filter((task) => task.status === "awaiting_review").length,
    running: tasks.filter(
      (task) => task.status === "running" || task.status === "queued",
    ).length,
    failed: tasks.filter((task) => task.status === "failed").length,
  };
  const retry = async (id: string) => {
    try {
      await demoApi.retryTask(id);
      void message.success("已将失败任务重新加入队列");
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "重试失败");
    }
  };

  return (
    <>
      <Button
        type="text"
        className="back-link"
        icon={<ArrowLeft size={16} />}
        onClick={() => navigate("/studio")}
      >
        返回视频工厂
      </Button>
      <PageHeader
        title="批次生成进度"
        description={`${batch.id} · ${formatDate(batch.createdAt)}创建 · ${tasks.length} 套房源独立生成`}
        actions={
          <Button onClick={() => navigate("/studio/create")}>继续创作</Button>
        }
      />
      <section className="panel batch-overview">
        <dl>
          <div>
            <dt>全部任务</dt>
            <dd>
              {tasks.length}
              <small> 个</small>
            </dd>
          </div>
          <div>
            <dt>已完成</dt>
            <dd>
              {counts.done}
              <small> 个</small>
            </dd>
          </div>
          <div>
            <dt>执行中</dt>
            <dd>
              {counts.running}
              <small> 个</small>
            </dd>
          </div>
          <div>
            <dt>待文案审核</dt>
            <dd>
              {counts.review}
              <small> 个</small>
            </dd>
          </div>
          <div>
            <dt>失败</dt>
            <dd>
              {counts.failed}
              <small> 个</small>
            </dd>
          </div>
        </dl>
      </section>
      {counts.review > 0 && (
        <Alert
          type="info"
          showIcon
          title={`${counts.review} 条文案等待你确认`}
          description="审核通过的任务会继续模拟配音与视频合成，其他任务互不影响。"
          style={{ marginBottom: 20 }}
        />
      )}
      <section className="panel">
        <div className="section-heading">
          <h2>房源视频任务</h2>
          <Tag>
            {batch.configSnapshot.videoMode === "avatar"
              ? "经纪人露脸"
              : "纯口播"}
          </Tag>
        </div>
        <Table<ProductionTask>
          rowKey="id"
          dataSource={tasks}
          pagination={false}
          scroll={{ x: 760 }}
          className="task-list"
          columns={[
            {
              title: "房源",
              key: "property",
              render: (_, task) => (
                <div className="table-property">
                  <img src={task.propertySnapshot.image} alt="" />
                  <span>
                    <strong>{task.propertySnapshot.community}</strong>
                    <small>
                      {task.propertySnapshot.layout} ·{" "}
                      {task.propertySnapshot.areaSqm} ㎡
                    </small>
                  </span>
                </div>
              ),
            },
            {
              title: "当前阶段",
              key: "stage",
              render: (_, task) => (
                <span>
                  {stageLabels[task.stage]}
                  {task.status === "running" && (
                    <small className="muted block">模拟执行中</small>
                  )}
                </span>
              ),
            },
            {
              title: "状态",
              key: "status",
              render: (_, task) => <StatusTag status={task.status} />,
            },
            {
              title: "进度",
              key: "progress",
              width: 160,
              render: (_, task) => (
                <Progress
                  size="small"
                  percent={task.progress}
                  status={
                    task.status === "failed"
                      ? "exception"
                      : task.status === "succeeded"
                        ? "success"
                        : "normal"
                  }
                />
              ),
            },
            {
              title: "操作",
              key: "action",
              render: (_, task) => (
                <div className="button-row">
                  <Button
                    type="link"
                    onClick={() =>
                      navigate(
                        task.status === "awaiting_review"
                          ? `/studio/tasks/${task.id}/review`
                          : `/studio/tasks/${task.id}`,
                      )
                    }
                  >
                    {task.status === "awaiting_review"
                      ? "审核文案"
                      : "查看详情"}
                  </Button>
                  {task.status === "failed" && (
                    <Button size="small" onClick={() => void retry(task.id)}>
                      重试
                    </Button>
                  )}
                  {task.status === "succeeded" && (
                    <Button
                      type="link"
                      onClick={() => navigate(`/publish/${task.id}`)}
                    >
                      查看成果
                    </Button>
                  )}
                </div>
              ),
            },
          ]}
        />
      </section>
      <p className="form-hint">
        本页进度与任务结果均为本地模拟，不会调用真实 AI 或第三方平台。
      </p>
    </>
  );
}

export function ProductionTaskPage() {
  const { taskId } = useParams();
  const { data } = useWorkspace();
  const { message, modal } = App.useApp();
  const navigate = useNavigate();
  const [script, setScript] = useState("");
  const [baseScript, setBaseScript] = useState("");
  const [baseRevision, setBaseRevision] = useState(0);
  const [loadedTaskId, setLoadedTaskId] = useState("");
  const [busy, setBusy] = useState(false);
  const task = data?.tasks.find((item) => item.id === taskId);
  const dirty = script !== baseScript;
  const blocker = useBlocker(dirty);

  useEffect(() => {
    if (
      task &&
      (loadedTaskId !== task.id ||
        (!dirty &&
          task.scriptRevision >= baseRevision &&
          (task.scriptRevision !== baseRevision || task.script !== baseScript)))
    ) {
      setScript(task.script);
      setBaseScript(task.script);
      setBaseRevision(task.scriptRevision);
      setLoadedTaskId(task.id);
    }
  }, [task, loadedTaskId, dirty, baseRevision, baseScript]);

  useEffect(() => {
    if (blocker.state !== "blocked") return;
    const dialog = modal.confirm({
      title: "文案修改尚未保存",
      content: "离开页面将丢弃本次未保存的编辑。",
      okText: "放弃编辑并离开",
      cancelText: "继续编辑",
      onOk: () => blocker.proceed(),
      onCancel: () => blocker.reset(),
    });
    return () => dialog.destroy();
  }, [blocker, modal]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  if (!data) return <Skeleton active />;
  if (!task)
    return (
      <Empty description="未找到这个生成任务">
        <Button onClick={() => navigate("/studio")}>返回视频工厂</Button>
      </Empty>
    );
  const property = task.propertySnapshot;
  const conflicted = task.scriptRevision > baseRevision;
  const stages: Stage[] =
    task.configSnapshot.videoMode === "avatar"
      ? ["prepare", "script", "tts", "avatar", "render", "cover"]
      : ["prepare", "script", "tts", "render", "cover"];
  const current =
    task.status === "succeeded"
      ? stages.length
      : Math.max(0, stages.indexOf(task.stage));
  const resourceName = (id: string) =>
    data.resources.find((item) => item.id === id)?.name ?? id;

  const run = async (command: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try {
      await command();
      void message.success(success);
    } catch (error) {
      void message.error(
        error instanceof Error ? error.message : "操作失败，请重试",
      );
    } finally {
      setBusy(false);
    }
  };
  const acceptScript = (updated: ProductionTask) => {
    setScript(updated.script);
    setBaseScript(updated.script);
    setBaseRevision(updated.scriptRevision);
  };
  const save = async () =>
    acceptScript(await demoApi.saveScript(task.id, script, baseRevision));
  const requestSave = () => {
    if (!script.trim()) {
      void message.warning("请先填写口播文案");
      return;
    }
    if (conflicted) {
      void message.warning("文案已有新修订，请先核对最新内容");
      return;
    }
    if (task.stage !== "prepare" && task.stage !== "script") {
      modal.confirm({
        title: "修改文案后需要重新生成",
        content:
          "当前配音、开场片段和视频将不再用于新修订。此前发布记录会保留，不会被覆盖。",
        okText: "保存并重新生成",
        cancelText: "继续编辑",
        onOk: () => run(save, "文案已保存，下游内容将使用新修订重新生成"),
      });
    } else void run(save, "文案修改已保存");
  };
  const approve = () => {
    if (!script.trim()) {
      void message.warning("口播文案不能为空");
      return;
    }
    if (conflicted) {
      void message.warning("文案已有新修订，请先核对最新内容");
      return;
    }
    void run(
      async () =>
        acceptScript(
          await demoApi.approveScript(task.id, script, baseRevision),
        ),
      "审核通过，继续模拟配音与剪辑",
    );
  };

  return (
    <>
      <Button
        type="text"
        className="back-link"
        icon={<ArrowLeft size={16} />}
        onClick={() => navigate(`/studio/batches/${task.batchId}`)}
      >
        返回批次
      </Button>
      <PageHeader
        title={
          task.status === "awaiting_review" ? "审核口播文案" : "视频任务详情"
        }
        description={`${property.community} · ${task.id} · ${formatDate(task.createdAt)}`}
        actions={<StatusTag status={task.status} />}
      />
      {task.status === "failed" && (
        <Alert
          type="error"
          showIcon
          title="当前阶段执行失败"
          description={task.error ?? "请检查任务配置后重试。"}
          action={
            <Button
              onClick={() =>
                void run(() => demoApi.retryTask(task.id), "任务已重新排队")
              }
              loading={busy}
            >
              重试当前阶段
            </Button>
          }
          style={{ marginBottom: 20 }}
        />
      )}
      <section className="panel production-progress">
        <div className="section-heading">
          <h2>生成流程</h2>
          <span className="muted">
            模拟任务 · 修订 {task.productionRevision}
          </span>
        </div>
        <Steps
          size="small"
          current={current}
          status={
            task.status === "failed"
              ? "error"
              : task.status === "canceled"
                ? "wait"
                : "process"
          }
          items={stages.map((stage) => ({
            title: stageLabels[stage],
            content:
              stage === "script" && task.status === "awaiting_review"
                ? "等待你的确认"
                : undefined,
          }))}
        />
      </section>
      <div className="task-detail-grid">
        <section className="panel script-panel">
          <div className="section-heading">
            <h2>
              <FileCheck size={19} /> 口播文案
            </h2>
            <Tag>文案修订 {task.scriptRevision}</Tag>
          </div>
          {task.status === "awaiting_review" && (
            <Alert
              type="info"
              showIcon
              title="文案审核通过后，才会继续配音和剪辑。"
              style={{ marginBottom: 18 }}
            />
          )}
          {conflicted && (
            <Alert
              type="warning"
              showIcon
              title="文案已有新修订，本地修改仍保留"
              description="请先复制需要保留的编辑，再载入最新版本进行合并。"
              action={
                <Button
                  size="small"
                  onClick={() => {
                    setScript(task.script);
                    setBaseScript(task.script);
                    setBaseRevision(task.scriptRevision);
                  }}
                >
                  载入最新文案
                </Button>
              }
              style={{ marginBottom: 18 }}
            />
          )}
          {task.script || script ? (
            <>
              <label className="form-label" htmlFor="script-editor">
                编辑口播内容
              </label>
              <Input.TextArea
                id="script-editor"
                aria-label="编辑口播内容"
                value={script}
                onChange={(event) => setScript(event.target.value)}
                autoSize={{ minRows: 12, maxRows: 22 }}
                disabled={task.status === "canceled"}
                maxLength={6000}
                showCount
              />
              <p className="form-hint">
                请核对价格、面积和卖点。修改已配音的文案会使下游产物失效。
              </p>
              <div className="script-actions">
                <div className="button-row">
                  <Button
                    icon={<RefreshCw size={15} />}
                    disabled={task.status === "canceled" || busy}
                    onClick={() =>
                      modal.confirm({
                        title: "重新生成口播文案？",
                        content:
                          "当前未保存的编辑将被新文案替换，下游产物需要重新生成。",
                        okText: "重新生成",
                        cancelText: "取消",
                        onOk: () =>
                          run(
                            async () =>
                              acceptScript(
                                await demoApi.regenerateScript(
                                  task.id,
                                  baseRevision,
                                ),
                              ),
                            "已重新开始模拟文案生成",
                          ),
                      })
                    }
                  >
                    重新生成
                  </Button>
                  <Button
                    icon={<Copy size={15} />}
                    onClick={() =>
                      void run(async () => {
                        await navigator.clipboard.writeText(script);
                      }, "文案已复制")
                    }
                  >
                    复制文案
                  </Button>
                </div>
                <div className="button-row">
                  <Button
                    icon={<Save size={15} />}
                    disabled={
                      !dirty || conflicted || task.status === "canceled"
                    }
                    loading={busy}
                    onClick={requestSave}
                  >
                    保存修改
                  </Button>
                  {task.status === "awaiting_review" && (
                    <Button
                      type="primary"
                      icon={<Check size={16} />}
                      loading={busy}
                      disabled={conflicted}
                      onClick={approve}
                    >
                      审核通过并继续
                    </Button>
                  )}
                </div>
              </div>
            </>
          ) : (
            <Empty
              description={
                task.status === "canceled"
                  ? "任务已取消"
                  : "文案正在准备，生成后会显示在这里"
              }
            />
          )}
          {!!task.history?.length && <ScriptHistory history={task.history} />}
          {task.status === "succeeded" && (
            <div className="task-result-action">
              <span>视频已生成，可前往发布中心预览与配置平台草稿。</span>
              <Button
                type="primary"
                onClick={() => navigate(`/publish/${task.id}`)}
              >
                查看生成成果 <ArrowRight size={15} />
              </Button>
            </div>
          )}
          {task.status !== "succeeded" && task.status !== "canceled" && (
            <Button
              danger
              type="text"
              icon={<Square size={14} />}
              onClick={() =>
                modal.confirm({
                  title: "取消这条视频任务？",
                  content:
                    "取消后不会继续生成，同一批次的其他任务不受影响。已取消的任务需要重新创建。",
                  okText: "取消任务",
                  cancelText: "继续保留",
                  okButtonProps: { danger: true },
                  onOk: () =>
                    run(() => demoApi.cancelTask(task.id), "任务已取消"),
                })
              }
            >
              取消任务
            </Button>
          )}
        </section>
        <aside className="task-context panel">
          <img
            className="task-property-image"
            src={property.image}
            alt={property.title}
          />
          <h2>{property.community}</h2>
          <p className="muted">
            {property.layout} · {property.areaSqm} ㎡ · {property.district}
          </p>
          <div className="property-price">
            {formatPrice(property.priceCents)}
          </div>
          <p>{property.description}</p>
          <Descriptions
            size="small"
            column={1}
            colon={false}
            items={[
              {
                key: "number",
                label: "房源号",
                children: property.propertyNumber,
              },
              {
                key: "mode",
                label: "视频模式",
                children:
                  task.configSnapshot.videoMode === "avatar"
                    ? "经纪人露脸"
                    : "纯口播",
              },
              {
                key: "prompt",
                label: "提示词",
                children: `${resourceName(task.configSnapshot.promptTemplate.id)} v${task.configSnapshot.promptTemplate.version}`,
              },
              {
                key: "template",
                label: "视频模板",
                children: `${resourceName(task.configSnapshot.videoTemplate.id)} v${task.configSnapshot.videoTemplate.version}`,
              },
              {
                key: "style",
                label: "风格模板",
                children: `${resourceName(task.configSnapshot.styleTemplate.id)} v${task.configSnapshot.styleTemplate.version}`,
              },
              {
                key: "voice",
                label: "声音",
                children:
                  data.voices.find(
                    (item) => item.id === task.configSnapshot.voiceId,
                  )?.name ?? task.configSnapshot.voiceId,
              },
              ...(task.configSnapshot.videoMode === "avatar"
                ? [
                    {
                      key: "avatar",
                      label: "人物形象",
                      children:
                        data.avatars.find(
                          (item) => item.id === task.configSnapshot.avatarId,
                        )?.name ?? "未选择",
                    },
                  ]
                : []),
              {
                key: "review",
                label: "审核方式",
                children: task.configSnapshot.requireScriptReview
                  ? "人工审核"
                  : "自动继续",
              },
            ]}
          />
          <p className="form-hint">
            以上为创建任务时的配置快照，不随默认设置变化。
          </p>
          <Link to={`/properties/${property.id}`}>
            查看当前房源资料 <ArrowRight size={13} />
          </Link>
        </aside>
      </div>
    </>
  );
}
