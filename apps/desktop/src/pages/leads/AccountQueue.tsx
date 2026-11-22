import LeadTable from "../../components/LeadTable";
import { useState } from "react";
import {
  Alert,
  App,
  Button,
  Descriptions,
  Drawer,
  Empty,
  Input,
  Space,
  Tag,
  Timeline,
} from "antd";
import { Link, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { creatorHubApi, douyinApi } from "@keagent/api-client";
import type { DouyinMessageStep } from "@keagent/shared-types";
import { leadUrl, localTime, type LeadScope } from "./navigation";
import { useAccountTasks, type AccountTask } from "./accountTasks";
import OpenCommenterButton from "./OpenCommenterButton";

const stages = [
  ["", "全部任务"],
  ["waiting", "待执行"],
  ["running", "执行中"],
  ["uncertain", "待核实"],
  ["done", "已完成"],
  ["failed", "失败"],
  ["canceled", "已取消"],
];
const color = {
  waiting: "default",
  running: "blue",
  uncertain: "warning",
  done: "green",
  failed: "red",
  canceled: "default",
};
const stoppedBeforeSend = new Set([
  "DM_RECIPIENT_UNVERIFIED",
  "DM_ENTRY_MISSING",
  "DM_CONVERSATION_MISSING",
  "DM_EDITOR_MISSING",
  "DM_DRAFT_UNCONFIRMED",
  "DM_CONTACT_RESTRICTED",
  "DM_NOT_DISPATCHED",
]);
const messageStepLabels: Record<DouyinMessageStep, string> = {
  check_account: "核对账号登录",
  open_conversation: "打开并核对收件人会话",
  fill_message: "填写并核对私信正文",
  trigger_send: "校验授权并触发发送",
  verify_conversation: "重开会话核实消息",
  recheck_conversation: "后台回查确认消息",
};
const stepResults = {
  started: { label: "执行中", color: "blue" },
  completed: { label: "完成", color: "green" },
  failed: { label: "失败", color: "red" },
};
const stepTime = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function messageEvidence(task: AccountTask, platform: LeadScope["platform"]) {
  const { local } = task;
  if (local?.resultSource === "manual") return "经纪人已人工核对平台会话。";
  if (local?.state === "accepted")
    return "AI来客已在收件人的会话记录中自动核实这条私信。";
  if (local?.state === "failed" && stoppedBeforeSend.has(local.errorCode ?? ""))
    return "在发送前停止，未点击发送。";
  if (
    local?.state === "unknown" &&
    platform === "douyin" &&
    local.sourceWorkId &&
    local.sourceCommentId
  )
    return "AI来客会重新读取收件人的抖音会话。核实后，这里会自动更新。";
  if (task.stage === "uncertain")
    return "尚无可以确认发送成功的会话记录。请在对应平台会话中核对。";
  return "暂无会话核对记录。";
}

export default function AccountQueue(
  props: LeadScope & { accountName: string },
) {
  const queue = useAccountTasks(props.accountId);
  const { modal, message } = App.useApp();
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [resuming, setResuming] = useState(false);
  const stage = params.get("filter") || "";
  const id = params.get("taskId") || params.get("outreachId");
  const task = queue.tasks.find((t) => t.id === id || t.receipt?.id === id);
  const messageSteps = task?.local?.messageSteps ?? [];
  const update = (key: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(key, v);
    else next.delete(key);
    if (key === "taskId") next.delete("outreachId");
    setParams(next, { replace: true });
    if (key !== "taskId") setPage(1);
  };
  const query = search.trim().toLowerCase();
  const candidates = queue.tasks.filter(
    (task) =>
      !query ||
      [task.title, task.detail, task.receipt?.draft].some((value) =>
        value?.toLowerCase().includes(query),
      ),
  );
  const rows = candidates.filter((t) => !stage || t.stage === stage);
  const hasUncertainMessage = queue.tasks.some(
    (row) => row.local && row.stage === "uncertain",
  );
  async function resumeMessages() {
    setResuming(true);
    try {
      await douyinApi.queue("resume-message");
      await client.invalidateQueries({ queryKey: ["douyin", "desktop"] });
    } catch (e) {
      void message.error((e as Error).message);
    } finally {
      setResuming(false);
    }
  }
  function act(
    row: AccountTask,
    action: "cancel" | "confirm-sent" | "confirm-failed",
  ) {
    if (!row.local) return;
    modal.confirm({
      title:
        action === "cancel"
          ? "取消这条排队任务？"
          : action === "confirm-sent"
            ? "已在平台会话看到这条私信？"
            : "已确认平台未发出这条私信？",
      okText: action === "cancel" ? "取消任务" : "保存人工核对结果",
      cancelText: "返回",
      onOk: async () => {
        try {
          if (row.receipt && row.receipt.method === "electron") {
            if (action === "cancel")
              await creatorHubApi.cancelOutreach(
                row.receipt.id,
                row.receipt.attempt,
              );
            else
              await creatorHubApi.confirmOutreach(
                row.receipt.id,
                row.receipt.attempt,
                action === "confirm-sent" ? "sent" : "failed",
              );
          } else await douyinApi.queue(action, row.id);
          await Promise.all([
            client.invalidateQueries({ queryKey: ["douyin", "desktop"] }),
            client.invalidateQueries({ queryKey: ["lead-workspace"] }),
          ]);
        } catch (e) {
          void message.error((e as Error).message);
          throw e;
        }
      },
    });
  }
  return (
    <>
      <div className="lead-title">
        <h1>账号队列</h1>
        <Button onClick={() => void queue.refresh()} loading={queue.loading}>
          刷新
        </Button>
      </div>
      {queue.error && (
        <Alert
          type="error"
          showIcon
          title="队列未完整加载"
          description={queue.error.message}
        />
      )}
      {queue.paused && (
        <Alert
          type="warning"
          showIcon
          title="本机私信队列已暂停"
          description={
            queue.messageResumeAvailable
              ? "恢复后将继续执行本机已排队的私信。"
              : undefined
          }
          action={
            queue.messageResumeAvailable ? (
              <Button loading={resuming} onClick={() => void resumeMessages()}>
                恢复私信队列
              </Button>
            ) : hasUncertainMessage ? (
              <Button onClick={() => update("filter", "uncertain")}>
                查看待核实私信
              </Button>
            ) : (
              <Link to="/publish">前往发布中心</Link>
            )
          }
        />
      )}
      <div className="lead-statuses">
        {stages.map(([value, label]) => (
          <Button
            key={value}
            aria-pressed={stage === value}
            type={stage === value ? "primary" : "default"}
            onClick={() => update("filter", value)}
          >
            {label}{" "}
            {queue.loading || queue.error
              ? "—"
              : candidates.filter((t) => !value || t.stage === value).length}
          </Button>
        ))}
      </div>
      <div className="lead-box">
        <div className="lead-tools">
          <Input.Search
            allowClear
            aria-label="搜索任务"
            placeholder="搜索收件人、作品或任务内容"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <LeadTable<AccountTask>
          size="middle"
          rowKey="id"
          loading={queue.loading}
          dataSource={rows}
          scroll={{ x: 660 }}
          pagination={{
            current: Math.min(page, Math.max(1, Math.ceil(rows.length / 20))),
            pageSize: 20,
            showSizeChanger: false,
            onChange: setPage,
            hideOnSinglePage: true,
          }}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="当前筛选下没有任务"
              />
            ),
          }}
          columns={[
            {
              title: "任务内容",
              render: (_, r) => (
                <div className="lead-queue-identity">
                  <button
                    className="lead-row-link"
                    onClick={() => update("taskId", r.id)}
                  >
                    {r.title}
                  </button>
                </div>
              ),
            },
            { title: "账号", render: () => props.accountName },
            { title: "创建时间", render: (_, r) => localTime(r.createdAt) },
            {
              title: "状态",
              render: (_, r) => <Tag color={color[r.stage]}>{r.label}</Tag>,
            },
            {
              title: "说明",
              render: (_, r) =>
                r.local?.eligibleAt
                  ? "最早 " + localTime(r.local.eligibleAt)
                  : r.detail || "—",
            },
            {
              title: "操作",
              render: (_, r) => (
                <Button type="link" onClick={() => update("taskId", r.id)}>
                  查看详情
                </Button>
              ),
            },
          ]}
        />
      </div>
      <Drawer
        rootClassName="lead-sheet"
        open={!!id}
        title="任务详情"
        onClose={() => update("taskId", "")}
        size="large"
      >
        {task ? (
          <>
            <h2>{task.title}</h2>
            <Tag color={color[task.stage]}>{task.label}</Tag>
            <Descriptions
              column={1}
              size="small"
              className="lead-details"
              items={[
                {
                  key: "account",
                  label: "执行账号",
                  children: props.accountName,
                },
                {
                  key: "time",
                  label: "创建时间",
                  children: localTime(task.createdAt),
                },
                ...(task.receipt
                  ? [
                      {
                        key: "body",
                        label: "提交正文",
                        children: task.receipt.draft,
                      },
                    ]
                  : []),
                ...(task.checkedAt
                  ? [
                      {
                        key: "checked",
                        label: "核对时间",
                        children: localTime(task.checkedAt),
                      },
                    ]
                  : []),
                ...(task.local?.eligibleAt
                  ? [
                      {
                        key: "ready",
                        label: "最早可执行",
                        children: localTime(task.local.eligibleAt),
                      },
                    ]
                  : []),
                ...(task.detail
                  ? [
                      {
                        key: "reason",
                        label: "处理记录",
                        children: task.detail,
                      },
                    ]
                  : []),
                {
                  key: "evidence",
                  label: "会话核对",
                  children: messageEvidence(task, props.platform),
                },
              ]}
            />
            <section aria-labelledby="message-steps-heading">
              <h3 id="message-steps-heading">执行步骤</h3>
              {messageSteps.length ? (
                <Timeline
                  items={messageSteps.map((step) => {
                    const result = stepResults[step.status];
                    return {
                      key: step.step,
                      color: result.color,
                      content: (
                        <>
                          <Space size="small" wrap>
                            <strong>{messageStepLabels[step.step]}</strong>
                            <Tag color={result.color}>{result.label}</Tag>
                            <small>
                              {stepTime.format(new Date(step.timestamp))}
                            </small>
                            {step.durationMs !== undefined && (
                              <small>{step.durationMs} ms</small>
                            )}
                          </Space>
                          {step.errorMessage && <div>{step.errorMessage}</div>}
                        </>
                      ),
                    };
                  })}
                />
              ) : (
                <p>暂无执行步骤记录</p>
              )}
            </section>
            <Space wrap>
              {task.local?.sourceWorkId && task.local.sourceCommentId && (
                <OpenCommenterButton
                  accountId={props.accountId}
                  workId={task.local.sourceWorkId}
                  commentId={task.local.sourceCommentId}
                  label="查看收件人"
                  onOpen={() => update("taskId", "")}
                />
              )}
              {task.receipt?.analysisId && (
                <Link
                  to={leadUrl("review", props, {
                    analysisId: task.receipt.analysisId,
                  })}
                >
                  查看来源线索
                </Link>
              )}
              {!task.receipt && task.local?.sourceWorkId && (
                <Link
                  to={leadUrl("works", props, {
                    tab: "comments",
                    workId: task.local.sourceWorkId,
                  })}
                >
                  查看作品评论
                </Link>
              )}
              {task.local?.state === "queued" && (
                <Button onClick={() => act(task, "cancel")}>取消排队</Button>
              )}
              {task.local && task.stage === "uncertain" && (
                <>
                  <Button onClick={() => act(task, "confirm-sent")}>
                    人工确认已发出
                  </Button>
                  <Button onClick={() => act(task, "confirm-failed")}>
                    人工确认未发出
                  </Button>
                </>
              )}
            </Space>
          </>
        ) : (
          <Empty
            description={
              queue.loading ? "正在读取任务" : "当前账号未找到此任务"
            }
          />
        )}
      </Drawer>
    </>
  );
}
