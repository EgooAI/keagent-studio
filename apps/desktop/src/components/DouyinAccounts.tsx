import { useState } from "react";
import { App, Alert, Button, Empty, Modal, Space, Tag } from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  douyinApi,
  douyinDesktop,
  desktopPublishingAvailable,
  publishingMessage,
  useDouyinDesktop,
} from "../lib/douyin";
import type { DouyinAccount } from "@keagent/shared-types";
const labels: Record<string, string> = {
  logged_in: "已登录",
  logged_out: "未登录",
  expired: "登录已过期",
  verification_required: "需要人工验证",
  risk_controlled: "平台风控",
  profile_unavailable: "本机登录资料不可用",
  unknown: "待检查",
};
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
  async function run(method: string, accountId = "") {
    setBusy(method + accountId);
    try {
      await douyinDesktop(method, { accountId });
      void client.invalidateQueries({ queryKey: ["douyin"] });
    } catch (error) {
      message.error(publishingMessage(error));
    } finally {
      setBusy("");
    }
  }
  return (
    <section className="douyin-accounts">
      <div className="section-heading">
        <div>
          <h2>抖音账号</h2>
          <p className="muted">
            登录资料按当前用户、设备和账号独立保存在本机，网络跟随系统配置。
          </p>
        </div>
        <Button
          type="primary"
          disabled={!desktopPublishingAvailable() || !!busy}
          onClick={() => void run("account.add")}
        >
          添加抖音账号
        </Button>
      </div>
      {!desktopPublishingAvailable() && (
        <Alert type="info" title="请在桌面客户端登录和管理抖音账号。" />
      )}
      {query.error && (
        <Alert
          type="error"
          title={publishingMessage(query.error)}
          action={<Button onClick={() => void query.refetch()}>重试</Button>}
        />
      )}
      {!query.isPending && !query.data?.items.length && (
        <Empty description="尚未保存抖音账号" />
      )}
      {query.data?.items.map((account) => {
        const local = desktop.data?.deviceId === account.deviceId;
        return (
          <div className="douyin-account-row" key={account.id}>
            <div>
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
                  ? `抖音号：${account.platformUserId} · `
                  : ""}
                最近检查：
                {new Date(account.lastCheckedAt).toLocaleString("zh-CN")}
              </p>
            </div>
            <Space>
              <Button
                disabled={!local || !!busy}
                onClick={() => void run("account.open", account.id)}
              >
                打开 / 重新登录
              </Button>
              <Button
                disabled={!local || !!busy}
                onClick={() => void run("account.check", account.id)}
              >
                检查
              </Button>
              <Button
                danger
                disabled={!local || !!busy}
                onClick={() => setRemoving(account)}
              >
                解绑
              </Button>
            </Space>
          </div>
        );
      })}
      <Modal
        title="解绑这个抖音账号？"
        open={!!removing}
        okText="解绑并清除本机登录资料"
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
