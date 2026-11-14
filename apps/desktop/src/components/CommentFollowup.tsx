import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Input, Space } from "antd";
import { collectionApi } from "@keagent/api-client";
import type { CommentDetail } from "@keagent/shared-types";

const intents = {
  buy: "买房",
  rent: "租房",
  sell: "卖房",
  let: "出租",
  viewing: "看房",
  question: "咨询",
  unrelated: "与房产无关",
  unclear: "意图未明确",
};

export function CommentFollowup({
  workId,
  accountId,
  comment,
  canAnalyze,
  canContact,
  onOpenProfile,
}: {
  workId: string;
  accountId: string;
  comment: CommentDetail;
  canAnalyze: boolean;
  canContact: boolean;
  onOpenProfile: () => void;
}) {
  const { message } = App.useApp();
  const client = useQueryClient();
  const [draft, setDraft] = useState("");
  const ref = { workId, accountId, id: comment.id };
  const analysis = useMutation({
    mutationFn: () => collectionApi.analyzeComment(ref),
    retry: false,
    gcTime: 0,
  });
  const contact = useMutation({
    mutationFn: () => collectionApi.commentContact(ref),
    retry: false,
    gcTime: 0,
  });
  const analysisBlock = !canAnalyze
    ? "来源未授权 AI 分析。"
    : comment.truncated
      ? "评论正文已截断，无法分析完整意图。"
      : !comment.comment_text?.trim()
        ? "缺少评论正文，无法分析。"
        : undefined;
  const contactBlock = !canContact
    ? "来源未授权人工联系。"
    : !comment.commenter_profile
      ? "该评论未提供公开主页。"
      : undefined;
  async function copyDraft() {
    try {
      await navigator.clipboard.writeText(draft);
      void message.success("已复制草稿");
    } catch {
      void message.error("未能复制，请选中草稿后手动复制。");
    }
  }
  const result = analysis.data;
  return (
    <Space orientation="vertical" style={{ width: "100%", marginTop: 12 }}>
      <Space wrap>
        <Button
          disabled={!!analysisBlock}
          loading={analysis.isPending}
          onClick={() =>
            analysis.mutate(undefined, {
              onSuccess: (value) => setDraft(value.draft),
            })
          }
        >
          AI 分析意图
        </Button>
        {analysisBlock && <span className="muted">{analysisBlock}</span>}
      </Space>
      {analysis.error && (
        <Alert type="error" showIcon title={analysis.error.message} />
      )}
      {result && !analysisBlock && (
        <>
          <strong>评论意图 · {intents[result.intent]}</strong>
          <div>
            {result.evidence
              ? "原文依据：" + result.evidence
              : "缺少明确的原文依据。"}
          </div>
          {canContact && result.evidence && result.draft && (
            <>
              <label htmlFor={"draft-" + comment.id}>私信草稿</label>
              <Input.TextArea
                id={"draft-" + comment.id}
                value={draft}
                autoSize={{ minRows: 2, maxRows: 8 }}
                onChange={(event) => setDraft(event.target.value)}
              />
              <Button disabled={!draft.trim()} onClick={() => void copyDraft()}>
                复制草稿
              </Button>
            </>
          )}
        </>
      )}
      <Space wrap>
        <Button
          disabled={!!contactBlock}
          loading={contact.isPending}
          onClick={() =>
            contact.mutate(undefined, {
              onSuccess: (state) => {
                client.setQueryData(["douyin", "desktop"], state);
                onOpenProfile();
              },
            })
          }
        >
          打开主页 · 人工私信
        </Button>
        <span className="muted">
          {contactBlock || "在抖音主页核对收件人，进入私信后由你确认发送。"}
        </span>
      </Space>
      {contact.error && (
        <Alert type="error" showIcon title={contact.error.message} />
      )}
    </Space>
  );
}
