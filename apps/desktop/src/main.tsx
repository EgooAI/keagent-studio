import React from "react";
import ReactDOM from "react-dom/client";
import { App as AntApp, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createHashRouter, RouterProvider } from "react-router-dom";
import App from "./App";
import LoginGate from "./LoginGate";
import { isLive } from "@keagent/api-client";
import { ThemeProvider } from "@keagent/theme";
import "antd/dist/reset.css";
import "./styles.css";

const queryClient = new QueryClient();
const router = createHashRouter([
  { path: "*", element: isLive ? <LoginGate /> : <App /> },
]);
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <ConfigProvider
        locale={zhCN}
        theme={{
          token: {
            fontFamily:
              '"Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
            borderRadius: 8,
            colorText: "#26303d",
            colorBorder: "#dee4ed",
            controlHeight: 38,
          },
          components: {
            Button: { primaryShadow: "none" },
            Modal: { borderRadiusLG: 12 },
            Table: { headerBg: "#f7f9fc" },
          },
        }}
      >
        <AntApp>
          <QueryClientProvider client={queryClient}>
            <RouterProvider router={router} />
          </QueryClientProvider>
        </AntApp>
      </ConfigProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
