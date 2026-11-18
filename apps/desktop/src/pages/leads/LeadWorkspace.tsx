import { Alert, Button, Empty, Segmented, Skeleton, Space, Tag } from "antd";
import { useQuery } from "@tanstack/react-query";
import { UserRound } from "lucide-react";
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";
import { creatorHubApi } from "@keagent/api-client";
import { desktopPublishingAvailable } from "../../lib/douyin";
import { leadUrl } from "./navigation";
import type { SocialPlatform } from "@keagent/shared-types";
import Works from "./Works";
import Review from "./Review";
import Todo from "./Todo";
import AccountQueue from "./AccountQueue";
import { LeadTrialNotice, leadTrialQuery } from "./leadTrial";
import "./workspace.css";

export default function LeadWorkspace() {
  return desktopPublishingAvailable() ? (
    <AccountWorkspace />
  ) : (
    <Alert
      showIcon
      type="info"
      title="请在 KeAgent 桌面客户端打开 AI 获客"
      description="在桌面端可以查看已保存的作品、评论、线索和本机账号队列。"
    />
  );
}

function AccountWorkspace() {
  const { area = "todo" } = useParams();
  const [params, setParams] = useSearchParams();
  const platform: SocialPlatform =
    params.get("platform") === "xhs" ? "xhs" : "douyin";
  const logged = useQuery({
    queryKey: ["creatorhub", "status"],
    queryFn: creatorHubApi.status,
    enabled: platform === "douyin",
    retry: false,
    refetchInterval: 15000,
  });
  const account =
    platform === "douyin"
      ? logged.data?.accounts.find((a) => (a.platform || "douyin") === "douyin")
      : undefined;
  const trial = useQuery({
    ...leadTrialQuery,
    enabled: !!account && !logged.isError,
  });
  const requested = params.get("accountId");
  if (account && requested && requested !== account.id) {
    // Abandon actions and filters from links for a previous account.
    return (
      <Navigate
        replace
        to={leadUrl("todo", { platform, accountId: account.id })}
      />
    );
  }
  const canOperate = !!account && !logged.isError;
  const scope = { platform, accountId: account?.id ?? "" };
  const title =
    area === "works"
      ? "作品与评论"
      : area === "review"
        ? "线索审核"
        : area === "queue"
          ? "账号队列"
          : "我的待办";
  return (
    <section className="lead-workspace">
      <header className="lead-context">
        <strong>AI 获客</strong>
        <Segmented
          aria-label="获客平台"
          value={platform}
          options={[
            { label: "抖音", value: "douyin" },
            { label: "小红书", value: "xhs" },
          ]}
          onChange={(v) => setParams({ platform: v as SocialPlatform })}
        />
        {account && (
          <Space className="lead-account-field" wrap>
            <UserRound size={17} aria-hidden="true" />
            <strong>{account.nickname}</strong>
            <Tag color={canOperate ? "green" : "default"}>
              {canOperate ? "已登录" : "登录状态待确认"}
            </Tag>
          </Space>
        )}
        {trial.data && <LeadTrialNotice trial={trial.data} />}
      </header>
      {platform === "xhs" ? (
        <Empty
          className="lead-account-empty"
          description="小红书 AI 获客暂未开发"
        />
      ) : (
        <>
          <nav className="lead-mobile-nav" aria-label="AI 获客子页面">
            {(["todo", "works", "review", "queue"] as const).map((a, i) => (
              <Link
                key={a}
                aria-current={a === area ? "page" : undefined}
                to={leadUrl(a, scope)}
              >
                {["我的待办", "作品与评论", "线索审核", "账号队列"][i]}
              </Link>
            ))}
          </nav>
          {logged.error && (
            <Alert
              showIcon
              type="warning"
              title="读取本机登录状态失败"
              description={logged.error.message}
              action={<Button onClick={() => logged.refetch()}>重试</Button>}
            />
          )}
          {logged.isPending ? (
            <Skeleton active />
          ) : !account ? (
            <>
              <h1>{title}</h1>
              {!logged.isError && (
                <Empty
                  className="lead-account-empty"
                  description="当前平台暂无已登录的账号"
                >
                  <Link to="/settings/platforms">前往平台账号</Link>
                </Empty>
              )}
            </>
          ) : (
            <div key={platform + account.id}>
              {area === "works" ? (
                <Works
                  {...scope}
                  accountName={account.nickname}
                  canOperate={canOperate}
                />
              ) : area === "review" ? (
                <Review {...scope} canOperate={canOperate} />
              ) : area === "queue" ? (
                <AccountQueue {...scope} accountName={account.nickname} />
              ) : (
                <Todo {...scope} canOperate={canOperate} />
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
