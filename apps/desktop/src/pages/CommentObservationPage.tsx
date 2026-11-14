import { useState } from "react";
import { Link } from "react-router-dom";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Descriptions,
  Empty,
  Form,
  Image,
  Input,
  Select,
  Space,
  Table,
  Tag,
} from "antd";
import { useQuery } from "@tanstack/react-query";
import { douyinApi, isLive } from "@keagent/api-client";
import type {
  CommentObservation,
  CommentPanelStatus,
} from "@keagent/shared-types";
import { PageHeader } from "../components/common";
import {
  desktopPublishingAvailable,
  publishingMessage,
  useDouyinDesktop,
} from "../lib/douyin";

const panelLabels: Record<CommentPanelStatus, string> = {
  not_checked: "未检查",
  visible: "可见",
  explicitly_empty: "明确为空",
  not_visible: "当前视口不可见",
  loading: "加载中",
  load_failed: "加载失败",
  restricted: "访问受限",
  unknown: "无法判断",
};
const states = {
  queued: "等待浏览器",
  running: "观察中",
  finished: "已完成",
  stopped: "已停止",
};
const time = (value?: string) =>
  value ? new Date(value).toLocaleString() : "—";

export default function CommentObservationPage() {
  const enabled = isLive && desktopPublishingAvailable();
  const { message } = App.useApp();
  const [accountId, setAccountId] = useState<string>();
  const [url, setUrl] = useState("");
  const [capture, setCapture] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState("");
  const [image, setImage] = useState<{ id: string; src: string }>();
  const desktop = useDouyinDesktop(enabled);
  const accounts = useQuery({
    queryKey: ["douyin", "accounts"],
    queryFn: douyinApi.accounts,
    enabled,
  });
  const history = useQuery({
    queryKey: ["comment-observations", desktop.data?.deviceId],
    queryFn: douyinApi.observations,
    enabled,
    refetchInterval: (q) =>
      q.state.data?.some((r) => !r.endedAt) ? 800 : 5000,
    retry: false,
  });
  const records = history.data ?? [];
  const current = records.find((r) => r.id === selected) ?? records[0];
  async function start() {
    if (!accountId || busy) return;
    setBusy(true);
    try {
      const record = await douyinApi.observe(accountId, url, capture);
      setCapture(false);
      setSelected(record.id);
      await history.refetch();
    } catch (error) {
      message.error(publishingMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function cancel(id: string) {
    try {
      await douyinApi.cancelObservation(id);
      await history.refetch();
    } catch (error) {
      message.error(publishingMessage(error));
    }
  }
  async function showScreenshot(id: string) {
    try {
      setImage({ id, src: await douyinApi.observationScreenshot(id) });
    } catch (error) {
      message.error(publishingMessage(error));
    }
  }
  const queryError = accounts.error ?? history.error ?? desktop.error;
  return (
    <>
      <PageHeader
        title="评论观察"
        description="使用本机已保存的抖音账号，核验作品和作者后记录评论区的可见状态。"
        actions={<Link to="/leads">AI 获客</Link>}
      />
      {!enabled ? (
        <Alert
          showIcon
          type="info"
          title={
            isLive
              ? "请在桌面客户端打开评论观察"
              : "Mock 演示模式 · 未执行真实观察"
          }
          description="真实观察需要已登录的桌面账号和本机抖音 Profile。"
        />
      ) : (
        <Space orientation="vertical" size="large" style={{ width: "100%" }}>
          {queryError && (
            <Alert
              showIcon
              type="error"
              title={publishingMessage(queryError)}
            />
          )}
          <section className="panel" style={{ padding: 20 }}>
            <Form layout="vertical" onFinish={start}>
              <Form.Item label="本机抖音账号" htmlFor="observation-account">
                <Select
                  id="observation-account"
                  placeholder="选择账号"
                  value={accountId}
                  onChange={setAccountId}
                  loading={accounts.isLoading}
                  options={accounts.data?.items
                    .filter(
                      (a) =>
                        !a.unboundAt && a.deviceId === desktop.data?.deviceId,
                    )
                    .map((a) => ({ value: a.id, label: a.name }))}
                />
              </Form.Item>
              <Form.Item
                label="标准视频链接"
                htmlFor="observation-url"
                extra="可粘贴作品详情页地址，或作者主页中点开作品后的浏览器地址。"
              >
                <Input
                  id="observation-url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://www.douyin.com/video/作品ID"
                  maxLength={2048}
                />
              </Form.Item>
              <Space wrap>
                <Button
                  type="primary"
                  htmlType="submit"
                  disabled={!accountId || !url.trim()}
                  loading={busy}
                >
                  打开并核验作品
                </Button>
                <Checkbox
                  checked={capture}
                  onChange={(e) => setCapture(e.target.checked)}
                >
                  同意仅在本次已核验作品的评论区状态异常时保存本地截图
                </Checkbox>
              </Space>
            </Form>
          </section>
          {current && (
            <section className="panel" style={{ padding: 20 }}>
              <Descriptions title="观察结果" bordered size="small" column={2}>
                <Descriptions.Item label="执行状态">
                  {states[current.state]}
                </Descriptions.Item>
                <Descriptions.Item label="评论区">
                  {panelLabels[current.panelStatus]}
                </Descriptions.Item>
                <Descriptions.Item label="输入作品 ID">
                  {current.inputWorkId || "无效链接"}
                </Descriptions.Item>
                <Descriptions.Item label="核验作品 ID">
                  {current.verifiedWorkId ?? "未核验"}
                </Descriptions.Item>
                <Descriptions.Item label="作品">
                  {current.title ?? "—"}
                </Descriptions.Item>
                <Descriptions.Item label="作者">
                  {current.author ? (
                    <span>
                      {current.author.name} · {current.author.url}
                    </span>
                  ) : (
                    "未核验"
                  )}
                </Descriptions.Item>
                <Descriptions.Item label="开始时间">
                  {time(current.startedAt)}
                </Descriptions.Item>
                <Descriptions.Item label="结束时间">
                  {time(current.endedAt)}
                </Descriptions.Item>
                <Descriptions.Item label="目标链接" span={2}>
                  {current.targetUrl || "—"}
                </Descriptions.Item>
                {current.reason && (
                  <Descriptions.Item label="原因" span={2}>
                    {current.reason}{" "}
                    {current.errorCode && <code>{current.errorCode}</code>}
                  </Descriptions.Item>
                )}
              </Descriptions>
              {current.state === "queued" && (
                <p>
                  若该账号正在人工浏览，请在账号浏览器中点击「返回工作台」。
                </p>
              )}
              {!current.endedAt && (
                <Button onClick={() => void cancel(current.id)}>
                  取消观察
                </Button>
              )}
              {current.screenshotSaved && (
                <Button onClick={() => void showScreenshot(current.id)}>
                  查看已确认保存的截图
                </Button>
              )}
              {image?.id === current.id && (
                <Image src={image.src} width={320} alt="本次观察的页面截图" />
              )}
            </section>
          )}
          <section className="panel" style={{ padding: 20 }}>
            <h2>本机观察记录</h2>
            <Table<CommentObservation>
              size="small"
              rowKey="id"
              dataSource={records}
              pagination={{ pageSize: 8 }}
              locale={{ emptyText: <Empty description="尚无观察记录" /> }}
              columns={[
                { title: "观察时间", dataIndex: "startedAt", render: time },
                {
                  title: "账号",
                  render: (_, r) =>
                    accounts.data?.items.find((a) => a.id === r.accountId)
                      ?.name ?? r.accountId,
                },
                { title: "作品 ID", dataIndex: "inputWorkId" },
                {
                  title: "执行状态",
                  render: (_, r) => <Tag>{states[r.state]}</Tag>,
                },
                {
                  title: "评论区",
                  render: (_, r) => panelLabels[r.panelStatus],
                },
                {
                  title: "",
                  render: (_, r) => (
                    <Button type="link" onClick={() => setSelected(r.id)}>
                      查看
                    </Button>
                  ),
                },
              ]}
            />
          </section>
        </Space>
      )}
    </>
  );
}
