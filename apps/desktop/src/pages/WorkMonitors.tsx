import { useState } from "react";
import {
  Alert,
  Button,
  Input,
  Modal,
  Drawer,
  Empty,
  List,
  Space,
  Spin,
  Tag,
} from "antd";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { creatorHubApi } from "@keagent/api-client";
import type { WorkMonitorSummary } from "@keagent/shared-types";

export function WorkMonitors({
  open,
  onClose,
  onAnalyze,
  accounts,
  initialWork,
}: {
  open: boolean;
  onClose: () => void;
  onAnalyze: (work: WorkMonitorSummary) => void;
  accounts: { id: string; nickname: string }[];
  initialWork?: { workId: string; accountId: string };
}) {
  const client = useQueryClient();
  const [selected, setSelected] = useState<{
    accountId: string;
    workId: string;
  }>();
  const work = selected ?? initialWork;
  const list = useQuery({
    queryKey: ["work-monitors"],
    queryFn: creatorHubApi.monitors,
    enabled: open,
    refetchInterval: open ? 10000 : false,
  });
  const [reply, setReply] = useState<{
    accountId: string;
    workId: string;
    commentId: string;
    name: string;
    requestKey: string;
    text: string;
  }>();
  const [receipt, setReceipt] = useState("");
  const send = useMutation({
    mutationFn: async () => {
      if (!reply) throw new Error("请选择评论");
      return creatorHubApi.reply(reply);
    },
    onSuccess: (task) => {
      setReceipt("已加入账号队列，可在发布中心查看结果。任务 " + task.id);
      setReply(undefined);
    },
  });
  const comments = useInfiniteQuery({
    queryKey: ["monitor-comments", work?.accountId, work?.workId],
    initialPageParam: "",
    enabled: open && !!work,
    queryFn: ({ pageParam }) =>
      creatorHubApi.comments(
        work!.accountId,
        work!.workId,
        pageParam || undefined,
      ),
    getNextPageParam: (page) => page.nextCursor || undefined,
  });
  const action = useMutation({
    mutationFn: async ({
      row,
      remove,
    }: {
      row: WorkMonitorSummary;
      remove: boolean;
    }) => {
      if (remove) await creatorHubApi.remove(row.id);
      else await creatorHubApi.scan(row.id);
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ["work-monitors"] });
      void client.invalidateQueries({ queryKey: ["monitor-comments"] });
    },
  });
  const replyComment =
    reply &&
    comments.data?.pages
      .flatMap((page) => page.items)
      .find((comment) => comment.id === reply.commentId);
  return (
    <Drawer
      rootClassName="lead-monitor-sheet"
      title="作品评论监控"
      open={open}
      onClose={onClose}
      size="large"
    >
      <p className="monitor-cadence">
        AI来客运行期间，每 15 分钟用对应账号检查一次新评论。
      </p>
      {list.isPending && <Spin />}
      {list.error && <Alert type="error" title={list.error.message} />}
      {action.error && <Alert type="error" title={action.error.message} />}
      {list.data && (
        <List
          dataSource={list.data}
          locale={{ emptyText: "暂无持续监控的作品" }}
          renderItem={(row) => (
            <List.Item
              className={
                work?.workId === row.workId && work?.accountId === row.accountId
                  ? "monitor-selected"
                  : undefined
              }
            >
              <Space orientation="vertical">
                <strong>
                  {row.platform === "xhs" ? "小红书" : "抖音"} ·{" "}
                  {row.workId.replace(/^xhs-/, "")}
                </strong>
                <span className="monitor-metadata">
                  {accounts.find((a) => a.id === row.accountId)?.nickname ??
                    "账号未登录"}{" "}
                  ·{" "}
                  {row.lastScan
                    ? new Date(row.lastScan).toLocaleString()
                    : "等待首次读取"}{" "}
                  · 上次读取 {row.readCount} 条，新增 {row.addedCount} 条
                </span>
                {row.error && <Tag color="error">{row.error}</Tag>}
                <Space wrap>
                  <Button size="small" onClick={() => setSelected(row)}>
                    查看评论
                  </Button>
                  <Button
                    size="small"
                    disabled={action.isPending}
                    onClick={() => action.mutate({ row, remove: false })}
                  >
                    立即读取
                  </Button>
                  <Button size="small" onClick={() => onAnalyze(row)}>
                    筛选线索
                  </Button>
                  <Button
                    size="small"
                    disabled={action.isPending}
                    onClick={() => action.mutate({ row, remove: true })}
                  >
                    停止监控
                  </Button>
                </Space>
              </Space>
            </List.Item>
          )}
        />
      )}
      {work && (
        <>
          <h3>作品 {work.workId.replace(/^xhs-/, "")} 的评论</h3>
          {comments.isPending && <Spin />}
          {comments.error && (
            <Alert type="error" title={comments.error.message} />
          )}
          {comments.data?.pages[0].sourceState !== "active" &&
            comments.data && (
              <Alert type="warning" title="评论来源授权未生效" />
            )}
          {comments.data && (
            <List
              dataSource={comments.data.pages.flatMap((p) => p.items)}
              locale={{ emptyText: <Empty description="暂无已保存的评论" /> }}
              renderItem={(row) => (
                <List.Item>
                  <div>
                    <strong>{row.commenter_name || "匿名用户"}</strong>
                    <p>{row.comment_text || "无文字评论"}</p>
                    {row.commenter_profile &&
                      comments.data?.pages[0].canContact && (
                        <Button
                          size="small"
                          onClick={() => {
                            send.reset();
                            setReply({
                              accountId: work.accountId,
                              workId: work.workId,
                              commentId: row.id,
                              name: row.commenter_name || "评论者",
                              text: "",
                              requestKey: crypto.randomUUID(),
                            });
                          }}
                        >
                          写私信
                        </Button>
                      )}
                  </div>
                </List.Item>
              )}
            />
          )}
          {comments.hasNextPage && (
            <Button
              loading={comments.isFetchingNextPage}
              onClick={() => void comments.fetchNextPage()}
            >
              更多评论
            </Button>
          )}
        </>
      )}
      {receipt && <Alert type="info" title={receipt} />}
      <Modal
        centered
        className="lead-form-modal lead-monitor-reply"
        open={!!reply}
        title={"给 " + (reply?.name ?? "") + " 写私信"}
        okText="加入账号队列"
        cancelText="取消"
        confirmLoading={send.isPending}
        okButtonProps={{ disabled: !reply?.text.trim() }}
        onCancel={() => {
          if (!send.isPending) setReply(undefined);
        }}
        onOk={() => send.mutate()}
      >
        {replyComment?.comment_text && (
          <blockquote>{replyComment.comment_text}</blockquote>
        )}
        <Input.TextArea
          aria-label="私信内容"
          placeholder="请输入要发送的私信内容"
          autoSize={{ minRows: 4, maxRows: 8 }}
          maxLength={320}
          showCount
          value={reply?.text ?? ""}
          disabled={send.isPending}
          onChange={(e) =>
            reply && setReply({ ...reply, text: e.target.value })
          }
        />
        {send.error && <Alert type="error" title={send.error.message} />}
      </Modal>
    </Drawer>
  );
}
