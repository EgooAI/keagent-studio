import { Component, type ReactNode } from "react";
import { Alert, App as AntApp, Button, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HashRouter } from "react-router-dom";
import { ThemeProvider } from "@keagent/theme";
import LiveAdmin from "./LiveAdmin";
import "antd/dist/reset.css";
import "./admin.css";

const defaultAdminPalette = {
  id: "blue",
  name: "经典蓝",
  primary: "#2563eb",
};

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

class AdminBoundary extends Component<
  { children: ReactNode },
  { error: string }
> {
  state = { error: "" };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    return this.state.error ? (
      <main className="admin-error">
        <Alert
          type="error"
          showIcon
          title="后台暂时无法显示"
          description={this.state.error}
        />
        <Button onClick={() => location.reload()}>重新加载</Button>
      </main>
    ) : (
      this.props.children
    );
  }
}

export default function App() {
  return (
    <ThemeProvider defaultPalette={defaultAdminPalette}>
      <ConfigProvider
        locale={zhCN}
        theme={{
          token: {
            colorBgLayout: "#f5f7fa",
            colorBgContainer: "#ffffff",
            colorBorder: "#d9e0ea",
            colorBorderSecondary: "#e6ebf2",
            colorText: "#0f172a",
            colorTextSecondary: "#475569",
            colorTextTertiary: "#64748b",
            borderRadius: 8,
            borderRadiusLG: 12,
            controlHeight: 34,
            fontFamily:
              '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
          },
          components: {
            Button: {
              primaryShadow: "none",
              defaultShadow: "none",
              dangerShadow: "none",
            },
            Table: {
              headerBg: "#f8fafc",
              headerColor: "#475569",
              headerSplitColor: "transparent",
              rowHoverBg: "#f8fafc",
              borderColor: "#edf1f7",
              cellPaddingBlock: 13,
              cellPaddingBlockSM: 10,
              cellPaddingInline: 16,
            },
            Tabs: {
              inkBarColor: "var(--accent)",
              itemSelectedColor: "var(--accent)",
              itemHoverColor: "var(--accent)",
              titleFontSize: 14,
              horizontalMargin: "0 0 18px 0",
            },
            Descriptions: {
              labelBg: "#f8fafc",
            },
            Tag: {
              borderRadiusSM: 6,
            },
            Drawer: {
              colorBgElevated: "#ffffff",
            },
            Modal: {
              borderRadiusLG: 14,
            },
          },
        }}
      >
        <AntApp>
          <QueryClientProvider client={queryClient}>
            <HashRouter>
              <AdminBoundary>
                <LiveAdmin />
              </AdminBoundary>
            </HashRouter>
          </QueryClientProvider>
        </AntApp>
      </ConfigProvider>
    </ThemeProvider>
  );
}
