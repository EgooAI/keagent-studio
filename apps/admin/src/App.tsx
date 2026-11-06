import { Component, type ReactNode } from "react";
import { Alert, App as AntApp, Button, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HashRouter } from "react-router-dom";
import { ThemeProvider } from "@keagent/theme";
import LiveAdmin from "./LiveAdmin";
import "antd/dist/reset.css";
import "./admin.css";

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
    <ThemeProvider>
      <ConfigProvider
        locale={zhCN}
        theme={{
          token: {
            colorBgLayout: "#f7f8fa",
            colorText: "#111827",
            borderRadius: 8,
            fontFamily:
              '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif',
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
