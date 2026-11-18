import { useRef, useState, type ReactNode } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Drawer,
  Form,
  Input,
  InputNumber,
  Radio,
  Select,
  Space,
} from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { creatorHubApi } from "@keagent/api-client";
import type {
  CreatorHubStartResult,
  WorkspaceComment,
} from "@keagent/shared-types";
import { LeadTrialNotice, leadTrialQuery } from "./leadTrial";

// An ambiguous response must retry the same request rather than enqueue it twice.
function useRequestKey() {
  const last = useRef({ body: "", key: "" });
  return (value: unknown) => {
    const body = JSON.stringify(value);
    if (last.current.body !== body)
      last.current = { body, key: crypto.randomUUID() };
    return last.current.key;
  };
}

type FormAccount = {
  accountId: string;
  accountLabel: string;
  onClose: () => void;
};

export function WorkAdd({
  accountId,
  accountLabel,
  url = "",
  monitor = false,
  onClose,
  onDone,
}: FormAccount & {
  url?: string;
  monitor?: boolean;
  onDone: (result: CreatorHubStartResult) => void;
}) {
  const client = useQueryClient();
  const requestKey = useRequestKey();
  const [form] = Form.useForm();
  const accepted: boolean = Form.useWatch("accepted", form);
  const start = useMutation({
    mutationFn: (values: {
      url: string;
      monitor: boolean;
      accepted: boolean;
      retention: number;
      days: number;
    }) => {
      const body = {
        accountId,
        url: values.url.trim(),
        monitor: values.monitor,
      };
      return creatorHubApi.start({
        ...body,
        requestKey: requestKey({
          ...body,
          days: values.days,
          retention: values.retention,
        }),
        consent: {
          accepted: values.accepted,
          retentionDays: values.retention,
          expiresAt: new Date(
            Date.now() + values.days * 86400000,
          ).toISOString(),
        },
      });
    },
    onSettled: () =>
      void client.invalidateQueries({ queryKey: ["lead-workspace"] }),
  });
  return (
    <Drawer
      rootClassName="lead-sheet"
      open
      size={464}
      title="添加作品"
      onClose={() => {
        if (!start.isPending) onClose();
      }}
      closable={!start.isPending}
      footer={
        <Button
          type="primary"
          onClick={() => form.submit()}
          loading={start.isPending}
          disabled={!accepted}
        >
          读取评论
        </Button>
      }
    >
      <p className="work-account">读取账号 · {accountLabel}</p>
      <Form
        form={form}
        layout="vertical"
        disabled={start.isPending}
        initialValues={{
          url,
          monitor,
          retention: 7,
          days: 30,
          accepted: false,
        }}
        onFinish={(values) => start.mutate(values, { onSuccess: onDone })}
      >
        <Form.Item
          label="作品链接"
          name="url"
          rules={[
            { required: true, whitespace: true, message: "请粘贴作品链接" },
          ]}
        >
          <Input.TextArea
            autoSize={{ minRows: 2, maxRows: 4 }}
            placeholder="粘贴作品详情页或分享链接"
          />
        </Form.Item>
        <Form.Item label="读取方式" name="monitor">
          <Radio.Group
            options={[
              { label: "读取一次", value: false },
              { label: "持续监控", value: true },
            ]}
          />
        </Form.Item>
        <p className="work-note">
          KeAgent 运行时，每 15 分钟检查一次持续监控的作品。
        </p>
        <Form.Item name="accepted" valuePropName="checked">
          <Checkbox>
            我已获准读取作品评论、使用 AI 筛选，并在人工审核后联系评论者。
          </Checkbox>
        </Form.Item>
        <details className="work-options">
          <summary>留存与授权期限</summary>
          <Space wrap>
            <Form.Item
              label="评论留存（天）"
              name="retention"
              rules={[{ required: true }]}
            >
              <InputNumber min={1} max={90} precision={0} />
            </Form.Item>
            <Form.Item
              label="授权有效（天）"
              name="days"
              rules={[{ required: true }]}
            >
              <InputNumber min={1} max={365} precision={0} />
            </Form.Item>
          </Space>
        </details>
      </Form>
      {start.error && (
        <Alert type="error" showIcon title={start.error.message} />
      )}
    </Drawer>
  );
}

export function WorkAnalyze({
  accountId,
  workId,
  title,
  workSelector,
  onClose,
  onDone,
}: {
  accountId: string;
  workId: string;
  title: string;
  workSelector?: ReactNode;
  onClose: () => void;
  onDone: (jobId: string) => void;
}) {
  const client = useQueryClient();
  const requestKey = useRequestKey();
  const settings = useQuery({
    queryKey: ["creatorhub", "settings"],
    queryFn: creatorHubApi.settings,
  });
  const trial = useQuery(leadTrialQuery);
  const remaining = trial.data?.analysis.remaining;
  const maxAllowed = Math.min(500, remaining ?? 500);
  const [criteria, setCriteria] = useState<string>();
  const [max, setMax] = useState<number>();
  const value = criteria ?? settings.data?.criteria ?? "";
  const requestedCount =
    max ?? Math.min(settings.data?.maxComments ?? 1, Math.max(1, maxAllowed));
  const analyze = useMutation({
    mutationFn: () => {
      setMax(requestedCount);
      const body = {
        accountId,
        workId,
        criteria: value.trim(),
        maxComments: requestedCount,
      };
      return creatorHubApi.analyze({ ...body, requestKey: requestKey(body) });
    },
    onSuccess: () =>
      void client.invalidateQueries({ queryKey: ["lead-workspace"] }),
    onSettled: () =>
      client.invalidateQueries({ queryKey: leadTrialQuery.queryKey }),
  });
  return (
    <Drawer
      rootClassName="lead-sheet"
      open
      size={464}
      title="筛选线索"
      closable={!analyze.isPending}
      onClose={() => {
        if (!analyze.isPending) onClose();
      }}
      footer={
        <Button
          type="primary"
          loading={analyze.isPending}
          disabled={
            !workId ||
            !settings.data ||
            !value.trim() ||
            remaining === 0 ||
            requestedCount < 1 ||
            requestedCount > maxAllowed
          }
          onClick={() =>
            analyze.mutate(undefined, { onSuccess: (job) => onDone(job.id) })
          }
        >
          开始分析
        </Button>
      }
    >
      {trial.data && (
        <p>
          <LeadTrialNotice trial={trial.data} />
        </p>
      )}
      {remaining === 0 && (
        <Alert
          showIcon
          type="warning"
          title="今日评论分析额度已用完，次日北京时间零点恢复。"
        />
      )}
      <Form layout="vertical" disabled={analyze.isPending || !settings.data}>
        {workSelector ? (
          <Form.Item label="来源作品">{workSelector}</Form.Item>
        ) : (
          <p className="work-account">{title}</p>
        )}
        <Form.Item
          label="筛选条件"
          extra="默认筛选房产需求，填写自定义条件后按该条件匹配评论。"
        >
          <Select
            aria-label="选择筛选条件"
            value={value || undefined}
            placeholder="选择常用条件"
            onChange={setCriteria}
            options={[
              ...new Set(
                [
                  settings.data?.defaultCriteria,
                  "希望预约看房的人",
                  "询问租金或售价的人",
                  value,
                ].filter((s): s is string => !!s),
              ),
            ].map((s) => ({ label: s, value: s }))}
          />
          <Input.TextArea
            aria-label="自定义筛选条件"
            maxLength={8000}
            autoSize={{ minRows: 3, maxRows: 8 }}
            value={value}
            onChange={(e) => setCriteria(e.target.value)}
          />
        </Form.Item>
        <Form.Item
          label="最多分析评论数"
          extra={
            requestedCount > maxAllowed && maxAllowed > 0
              ? `今日剩余 ${maxAllowed} 条，请减少分析条数。`
              : undefined
          }
        >
          <InputNumber
            aria-label="最多分析评论数"
            min={1}
            max={Math.max(1, maxAllowed)}
            precision={0}
            disabled={remaining === 0}
            value={remaining === 0 ? undefined : requestedCount}
            onChange={(v) => setMax(v ?? undefined)}
          />
        </Form.Item>
      </Form>
      {(settings.error || analyze.error) && (
        <Alert
          type="error"
          showIcon
          title={(settings.error || analyze.error)?.message}
        />
      )}
    </Drawer>
  );
}

export function WorkReply({
  accountId,
  accountLabel,
  comment,
  onClose,
  onDone,
}: FormAccount & {
  comment: WorkspaceComment;
  onDone: (taskId: string) => void;
}) {
  const [text, setText] = useState("");
  const requestKey = useRequestKey();
  const client = useQueryClient();
  const send = useMutation({
    mutationFn: () => {
      const body = {
        accountId,
        workId: comment.workId,
        commentId: comment.id,
        text: text.trim(),
      };
      return creatorHubApi.reply({ ...body, requestKey: requestKey(body) });
    },
    onSuccess: () =>
      void client.invalidateQueries({ queryKey: ["lead-workspace"] }),
  });
  return (
    <Drawer
      rootClassName="lead-sheet"
      open
      size={464}
      title={"给 " + (comment.commenter_name || "评论者") + " 写私信"}
      closable={!send.isPending}
      onClose={() => {
        if (!send.isPending) onClose();
      }}
      footer={
        <Button
          type="primary"
          loading={send.isPending}
          disabled={!text.trim()}
          onClick={() =>
            send.mutate(undefined, { onSuccess: (task) => onDone(task.id) })
          }
        >
          加入私信队列
        </Button>
      }
    >
      <p className="work-account">发送账号 · {accountLabel}</p>
      <blockquote className="work-quote">
        {comment.comment_text || "无文字评论"}
      </blockquote>
      <Form layout="vertical">
        <Form.Item label="私信内容" htmlFor="work-reply-text">
          <Input.TextArea
            id="work-reply-text"
            maxLength={320}
            showCount
            disabled={send.isPending}
            rows={5}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </Form.Item>
      </Form>
      {send.error && <Alert type="error" title={send.error.message} showIcon />}
    </Drawer>
  );
}
