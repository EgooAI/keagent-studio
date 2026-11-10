import { useEffect, useRef, useState } from "react";
import { App, Button, Space, Tabs, Alert } from "antd";
import { ArrowLeft, ArrowRight, RotateCw, X } from "lucide-react";
import {
  douyinDesktop,
  publishingMessage,
  useDouyinDesktop,
} from "../lib/douyin";
/** React owns chrome and measured geometry; the native view has no application preload. */
export default function DouyinBrowserWorkspace() {
  const { data, refetch } = useDouyinDesktop();
  const viewport = useRef<HTMLDivElement>(null);
  const { message } = App.useApp();
  const [busy, setBusy] = useState(false);
  const tab = data?.tabs.find(
    (value) => value.accountId === data.activeAccountId,
  );
  const locked =
    !!tab &&
    data?.activeRecord?.accountId === tab.accountId &&
    ["running", "submitting"].includes(data.activeRecord.state);
  async function action(method: string, input: unknown) {
    setBusy(true);
    try {
      await douyinDesktop(method, input);
      await refetch();
    } catch (error) {
      message.error(publishingMessage(error));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!tab || !viewport.current) return;
    const element = viewport.current;
    const update = () => {
      const bounds = element.getBoundingClientRect();
      const overlay = !!document.querySelector(
        ".ant-modal-wrap:not([style*='display: none']), .ant-drawer-open, .ant-popover:not(.ant-popover-hidden), .ant-select-dropdown:not(.ant-select-dropdown-hidden)",
      );
      void douyinDesktop("browser.viewport", {
        accountId: tab.accountId,
        bounds: {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
        },
        visible: !locked && !overlay && !document.hidden,
      }).catch(() => {});
    };
    const resize = new ResizeObserver(update);
    resize.observe(element);
    const observer = new MutationObserver(update);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    window.addEventListener("resize", update);
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      resize.disconnect();
      observer.disconnect();
      window.removeEventListener("resize", update);
      document.removeEventListener("visibilitychange", update);
      void douyinDesktop("browser.viewport", {
        accountId: tab.accountId,
        bounds: { x: 0, y: 0, width: 0, height: 0 },
        visible: false,
      }).catch(() => {});
    };
  }, [tab?.accountId, locked]);
  if (!tab) return null;
  return (
    <section className="douyin-browser-workspace" aria-label="抖音账号浏览器">
      <div className="douyin-browser-tabs">
        <Button onClick={() => void action("browser.hide", {})}>
          返回工作台
        </Button>
        <Tabs
          activeKey={tab.accountId}
          onChange={(accountId) => void action("account.open", { accountId })}
          items={data!.tabs.map((value) => ({
            key: value.accountId,
            label: (
              <span>
                {value.title || "抖音账号"}{" "}
                <Button
                  type="text"
                  size="small"
                  aria-label="关闭账号标签"
                  icon={<X size={12} />}
                  disabled={
                    data?.activeRecord?.accountId === value.accountId &&
                    ["running", "submitting"].includes(data.activeRecord.state)
                  }
                  onClick={(event) => {
                    event.stopPropagation();
                    void action("browser.action", {
                      accountId: value.accountId,
                      action: "close",
                    });
                  }}
                />
              </span>
            ),
          }))}
        />
      </div>
      <div className="douyin-browser-toolbar">
        <Space>
          <Button
            aria-label="后退"
            icon={<ArrowLeft size={15} />}
            disabled={locked || !tab.canGoBack}
            onClick={() =>
              void action("browser.action", {
                accountId: tab.accountId,
                action: "back",
              })
            }
          />
          <Button
            aria-label="前进"
            icon={<ArrowRight size={15} />}
            disabled={locked || !tab.canGoForward}
            onClick={() =>
              void action("browser.action", {
                accountId: tab.accountId,
                action: "forward",
              })
            }
          />
          <Button
            aria-label="刷新页面"
            icon={<RotateCw size={15} />}
            disabled={locked || busy}
            onClick={() =>
              void action("browser.action", {
                accountId: tab.accountId,
                action: "reload",
              })
            }
          />
        </Space>
        <output>
          {tab.loading ? "正在加载… " : ""}
          {tab.url}
        </output>
        <Button
          type="primary"
          disabled={locked || busy}
          onClick={() =>
            void action("account.save", { accountId: tab.accountId })
          }
        >
          {tab.saved ? "重新检查账号" : "保存账号"}
        </Button>
      </div>
      {locked && (
        <Alert
          type="info"
          title="正在通过抖音网页发布，可返回工作台查看进度。"
        />
      )}
      <div ref={viewport} className="douyin-browser-viewport" />
    </section>
  );
}
