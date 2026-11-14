import { useRef } from "react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Descriptions,
  Drawer,
  Empty,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from "antd";
import { collectionApi } from "@keagent/api-client";
import type {
  CommentDetail,
  DouyinAccount,
  MonitoredVideo,
} from "@keagent/shared-types";
import { formatDate } from "./common";
import { CommentFollowup } from "./CommentFollowup";
import { panelLabels } from "../lib/douyin";

const unavailable = {
  unconfigured: "该账号尚未接入这条作品的获准评论来源。",
  expired: "这条作品的评论授权已过期。",
  revoked: "这条作品的评论授权已撤回。",
};
const coverageLabels = {
  unknown: "最近同步覆盖范围未知",
  partial: "最近同步仅覆盖部分评论",
  complete: "最近同步覆盖完整",
};

export function VideoComments({
  workId,
  accountId,
  accounts,
  video,
  onSelectAccount,
  onClose,
}: {
  workId: string;
  accountId: string;
  accounts: DouyinAccount[];
  video?: MonitoredVideo;
  onSelectAccount: (id: string) => void;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const work = useQuery({
    queryKey: ["douyin", "collection", "video", workId],
    queryFn: () => collectionApi.video(workId),
    enabled: !video,
    retry: false,
  });
  const selected = video ?? work.data;
  const comments = useInfiniteQuery({
    queryKey: ["douyin", "work-comments", workId, accountId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      collectionApi.comments({
        workId,
        accountId,
        cursor: pageParam,
        limit: 20,
      }),
    getNextPageParam: (page) => page.nextCursor || undefined,
    gcTime: 0,
    retry: false,
  });
  const pages = comments.data?.pages ?? [];
  const source = pages.find((p) => p.sourceState !== "active") ?? pages[0];
  const rows = pages.flatMap((p) => p.items);
  const byId = new Map(
    rows.filter((c) => c.comment_id).map((c) => [c.comment_id, c]),
  );
  const requestKey = useRef("");
  const sync = useMutation({
    mutationFn: () => {
      requestKey.current ||= crypto.randomUUID();
      return collectionApi.syncComments({
        workId,
        accountId,
        requestKey: requestKey.current,
      });
    },
    onSuccess: (result) => {
      requestKey.current = "";
      void message.success(
        `已读取 ${result.readCount} 条，新增 ${result.addedCount} 条，更新 ${result.updatedCount} 条。`,
      );
    },
    onSettled: () => comments.refetch(),
    retry: false,
  });

  return (
    <Drawer title="评论明细" open size="min(860px, 100vw)" onClose={onClose}>
      <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
        <div>
          <strong>{selected?.title || "抖音作品"}</strong>
          <div className="muted">
            作品 ID {workId}
            {selected && " · " + selected.author.name}
          </div>
        </div>
        <Space wrap>
          <span>读取账号</span>
          <Select
            aria-label="读取账号"
            style={{ minWidth: 150 }}
            value={accountId}
            options={accounts.map((account) => ({
              value: account.id,
              label: account.name,
            }))}
            onChange={onSelectAccount}
          />
          {selected?.accountId === accountId && (
            <Tag>上次观察评论区：{panelLabels[selected.panelStatus]}</Tag>
          )}
          <Button
            loading={comments.isFetching && !comments.isFetchingNextPage}
            disabled={sync.isPending}
            onClick={() => {
              sync.reset();
              void comments.refetch();
            }}
          >
            刷新记录
          </Button>
        </Space>
        {comments.isPending ? (
          <Spin aria-label="正在读取评论记录" />
        ) : comments.isError ? (
          <Alert type="error" showIcon title={comments.error.message} />
        ) : (
          source &&
          (source.sourceState !== "active" ? (
            <Alert
              type="info"
              showIcon
              title={unavailable[source.sourceState]}
              description={
                source.sourceState === "unconfigured"
                  ? "请为当前账号和作品配置已获准的评论导出或抖音开放平台来源。"
                  : "请核对该作品的现行授权后再同步。"
              }
            />
          ) : (
            <>
              <Space wrap>
                <span>来源：{source.sourceLabel || "已授权来源"}</span>
                {source.lastSyncedAt && (
                  <>
                    <Tag>{coverageLabels[source.coverage]}</Tag>
                    <span className="muted">
                      最近同步 {formatDate(source.lastSyncedAt)}
                    </span>
                  </>
                )}
                <Button
                  type="primary"
                  loading={sync.isPending}
                  disabled={comments.isFetching}
                  onClick={() => sync.mutate()}
                >
                  同步评论
                </Button>
              </Space>
              {sync.error && (
                <Alert type="error" showIcon title={sync.error.message} />
              )}
              <Table<CommentDetail>
                size="small"
                pagination={false}
                rowKey="id"
                scroll={{ x: 560 }}
                dataSource={rows}
                locale={{
                  emptyText: (
                    <Empty
                      description={
                        !source.lastSyncedAt
                          ? "尚未同步评论。"
                          : source.coverage === "complete"
                            ? "来源在最近一次完整同步中返回 0 条评论。"
                            : "当前来源尚无可展示的评论记录。"
                      }
                    />
                  ),
                }}
                columns={[
                  {
                    title: "评论者",
                    width: 110,
                    render: (_, c) => c.commenter_name ?? "昵称未提供",
                  },
                  {
                    title: "评论正文",
                    render: (_, c) => {
                      const parent = c.parent_comment_id
                        ? byId.get(c.parent_comment_id)
                        : undefined;
                      return (
                        <>
                          {c.parent_comment_id && (
                            <div className="muted">
                              回复 {parent?.commenter_name ?? "父评论"} ·{" "}
                              {c.parent_comment_id}
                            </div>
                          )}
                          <span
                            style={{
                              whiteSpace: "pre-wrap",
                              overflowWrap: "anywhere",
                            }}
                          >
                            {c.comment_text ?? "正文未提供"}
                          </span>
                          {c.truncated && <Tag>正文已截断</Tag>}
                        </>
                      );
                    },
                  },
                  {
                    title: "评论时间",
                    width: 104,
                    render: (_, c) => formatDate(c.comment_time),
                  },
                  {
                    title: "点赞",
                    width: 64,
                    render: (_, c) => c.like_count ?? "未知",
                  },
                  {
                    title: "回复数",
                    width: 64,
                    render: (_, c) => c.reply_count ?? "未知",
                  },
                ]}
                expandable={{
                  expandedRowRender: (c) => (
                    <>
                      <Descriptions
                        size="small"
                        column={{ xs: 1, sm: 2 }}
                        bordered
                        items={[
                          {
                            key: "id",
                            label: "评论 ID",
                            children: c.comment_id ?? "来源未提供",
                          },
                          {
                            key: "parent",
                            label: "父评论 ID",
                            children: c.parent_comment_id ?? "来源未提供",
                          },
                          {
                            key: "profile",
                            label: "公开主页",
                            span: "filled",
                            children: c.commenter_profile ? (
                              <Typography.Text
                                copyable
                                style={{ overflowWrap: "anywhere" }}
                              >
                                {c.commenter_profile}
                              </Typography.Text>
                            ) : (
                              "来源未提供"
                            ),
                          },
                          {
                            key: "first",
                            label: "首次观察",
                            children: formatDate(c.firstSeenAt),
                          },
                          {
                            key: "last",
                            label: "最近观察",
                            children: formatDate(c.lastSeenAt),
                          },
                          {
                            key: "changed",
                            label: "最近变更",
                            span: "filled",
                            children: formatDate(c.updatedAt),
                          },
                        ]}
                      />
                      <CommentFollowup
                        key={JSON.stringify([
                          c.updatedAt,
                          source.canAnalyze,
                          source.canContact,
                        ])}
                        workId={workId}
                        accountId={accountId}
                        comment={c}
                        canAnalyze={source.canAnalyze}
                        canContact={source.canContact}
                        onOpenProfile={onClose}
                      />
                    </>
                  ),
                }}
              />
              {comments.hasNextPage && (
                <Button
                  loading={comments.isFetchingNextPage}
                  onClick={() => void comments.fetchNextPage()}
                >
                  加载更多评论
                </Button>
              )}
            </>
          ))
        )}
      </Space>
    </Drawer>
  );
}
