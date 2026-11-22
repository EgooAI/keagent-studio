import { useState } from "react";
import { App, Alert, Button, Empty, Modal, Space, Tag } from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  socialPlatformLabel,
  douyinApi,
  douyinDesktop,
  desktopPublishingAvailable,
  publishingMessage,
  useDouyinDesktop,
} from "../lib/douyin";
import type { DouyinAccount, SocialPlatform } from "@keagent/shared-types";
const labels: Record<string, string> = {
  logged_in: "已登录",
  logged_out: "未登录",
  expired: "登录已过期",
  verification_required: "需要人工验证",
  risk_controlled: "平台风控",
  profile_unavailable: "本机登录资料不可用",
  unknown: "待检查",
};
const accountPlatforms: SocialPlatform[] = ["channels", "douyin", "xhs"];
export default function DouyinAccounts() {
  const query = useQuery({
    queryKey: ["douyin", "accounts"],
    queryFn: douyinApi.accounts,
  });
  const desktop = useDouyinDesktop();
  const client = useQueryClient();
  const { message } = App.useApp();
  const [busy, setBusy] = useState("");
  const [removing, setRemoving] = useState<DouyinAccount>();
  const loginIds = desktop.data?.channelsLoginAccountIds ?? [];
  const loginError = desktop.data?.channelsLoginError;
  async function run(
    method: string,
    accountId = "",
    platform?: SocialPlatform,
    action?: "close",
  ) {
    setBusy(method + accountId);
    try {
      const result = await douyinDesktop<{ loginStatus?: string } | null>(
        method,
        { accountId, platform, action },
      );
      if (method === "account.check" && platform === "channels") {
        if (result?.loginStatus === "logged_in")
          message.success("视频号已登录，账号已保存");
        else message.info("当前视频号未登录，请点击「扫码登录」。");
      }
      void client.invalidateQueries({ queryKey: ["douyin"] });
    } catch (error) {
      message.error(publishingMessage(error, platform));
    } finally {
      setBusy("");
    }
  }
  return (
    <section className="douyin-accounts">
      <div className="section-heading">
        <div>
          <h2>平台账号</h2>
          <p className="muted">
            登录资料按当前用户、设备和账号独立保存在本机，网络跟随系统配置。
          </p>
        </div>
        <Space wrap>
          {accountPlatforms.map((platform) => (
            <Button
              key={platform}
              type={platform === "channels" ? "primary" : "default"}
              disabled={
                !desktopPublishingAvailable() ||
                !!busy ||
                (platform === "channels" && !!loginIds.length)
              }
              onClick={() => void run("account.add", "", platform)}
            >
              添加{socialPlatformLabel(platform)}账号
            </Button>
          ))}
        </Space>
      </div>
      {!desktopPublishingAvailable() && (
        <Alert type="info" title="请在桌面客户端登录和管理平台账号。" />
      )}
      {query.error && (
        <Alert
          type="error"
          title={publishingMessage(query.error)}
          action={<Button onClick={() => void query.refetch()}>重试</Button>}
        />
      )}
      {loginIds.map((accountId) => (
        <Alert
          key={accountId}
          type="info"
          showIcon
          title="等待微信扫码登录"
          description="请用微信扫描视频号助手窗口中的二维码。登录成功后会自动保存账号并返回 AI来客。"
          action={
            <Button
              size="small"
              disabled={!!busy}
              onClick={() =>
                void run("browser.action", accountId, "channels", "close")
              }
            >
              取消登录
            </Button>
          }
        />
      ))}
      {loginError && (
        <Alert
          type="error"
          showIcon
          title="视频号登录未完成"
          description={loginError.message}
        />
      )}
      {!loginIds.length && !query.isPending && !query.data?.items.length && (
        <Empty description="尚未保存平台账号" />
      )}
      {query.data?.items
        .slice()
        .sort(
          (a, b) =>
            accountPlatforms.indexOf(a.platform ?? "douyin") -
            accountPlatforms.indexOf(b.platform ?? "douyin"),
        )
        .map((account) => {
          const local = desktop.data?.deviceId === account.deviceId;
          const unavailable = !local || !!busy || loginIds.includes(account.id);
          return (
            <div className="douyin-account-row" key={account.id}>
              <div>
                <Tag
                  className={`settings-platform-${account.platform ?? "douyin"}`}
                >
                  {socialPlatformLabel(account.platform)}
                </Tag>
                <strong>{account.name}</strong>{" "}
                <Tag
                  color={
                    account.loginStatus === "logged_in" ? "green" : "default"
                  }
                >
                  {labels[account.loginStatus] || "待检查"}
                </Tag>
                {!local && <Tag>其他设备</Tag>}
                <p className="muted">
                  {account.platformUserId
                    ? `${(account.platform ?? "douyin") === "douyin" ? "抖音号" : socialPlatformLabel(account.platform) + " ID"}：${account.platformUserId} · `
                    : ""}
                  最近检查：
                  {new Date(account.lastCheckedAt).toLocaleString("zh-CN")}
                </p>
              </div>
              <Space wrap>
                <Button
                  disabled={unavailable}
                  onClick={() =>
                    void run("account.open", account.id, account.platform)
                  }
                >
                  {account.platform === "channels"
                    ? "扫码登录"
                    : "打开 / 重新登录"}
                </Button>
                <Button
                  disabled={unavailable}
                  loading={busy === "account.check" + account.id}
                  onClick={() =>
                    void run("account.check", account.id, account.platform)
                  }
                >
                  {account.platform === "channels" ? "检查并保存" : "检查"}
                </Button>
                <Button
                  danger
                  disabled={unavailable}
                  onClick={() => setRemoving(account)}
                >
                  解绑
                </Button>
              </Space>
            </div>
          );
        })}
      <Modal
        className="settings-action-modal"
        centered
        width={500}
        title={`解绑这个${socialPlatformLabel(removing?.platform)}账号？`}
        open={!!removing}
        okText="解绑并清除本机登录资料"
        confirmLoading={!!busy}
        okButtonProps={{ danger: true }}
        onCancel={() => setRemoving(undefined)}
        onOk={async () => {
          if (removing) await run("account.unbind", removing.id);
          setRemoving(undefined);
        }}
      >
        <p>只清除该账号在当前设备的登录资料，历史发布记录保留。</p>
      </Modal>
    </section>
  );
}
