import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Form, Input, Spin } from "antd";
import { useQueryClient } from "@tanstack/react-query";
import {
  authRequest,
  ServiceRequestError,
  type SessionUser,
} from "@keagent/api-client";
import App from "./App";
import "./login.css";

export default function LoginGate() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [checking, setChecking] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const client = useQueryClient();
  const lock = useCallback(() => {
    setUser(null);
    setChecking(false);
    client.clear();
  }, [client]);
  const monitorSession = !busy && (checking || user !== null);
  useEffect(() => {
    if (!monitorSession) return;
    let active = true;
    let pending = false;
    const invalidate = () => {
      active = false;
      lock();
    };
    const check = async () => {
      if (!active || pending) return;
      pending = true;
      try {
        const session = await authRequest<SessionUser>("session");
        if (!active) return;
        setUser(session);
        setChecking(false);
        setRetrying(false);
      } catch (e) {
        if (!active) return;
        if (
          e instanceof ServiceRequestError &&
          (e.status === 401 || e.status === 403)
        ) {
          setError(e.status === 403 ? e.message : "");
          invalidate();
        } else {
          setRetrying(true);
        }
      } finally {
        pending = false;
      }
    };
    void check();
    const timer = setInterval(() => {
      void check();
    }, 15000);
    window.addEventListener("keagent:unauthorized", invalidate);
    window.addEventListener("keagent:check-session", check);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("keagent:unauthorized", invalidate);
      window.removeEventListener("keagent:check-session", check);
    };
  }, [monitorSession, lock]);
  if (checking)
    return (
      <main className="login-page login-gate">
        <div role="status" className="login-checking">
          <Spin />
          <p>
            {retrying ? "暂时无法连接登录服务，正在重试…" : "正在验证登录身份…"}
          </p>
        </div>
      </main>
    );
  if (user)
    return (
      <App
        onLogout={async () => {
          setBusy(true);
          try {
            await authRequest("logout");
          } finally {
            lock();
            setBusy(false);
          }
        }}
      />
    );
  return (
    <main className="login-page login-gate">
      <section className="login-panel" aria-labelledby="login-title">
        <header>
          <img src="./keagent-icon.png" width="48" height="48" alt="" />
          <h1 id="login-title">登录 KeAgent Studio</h1>
          <p>使用管理员开通的账号登录。</p>
        </header>
        {error && (
          <Alert type="error" title={error} style={{ marginBottom: 16 }} />
        )}
        <Form
          layout="vertical"
          onFinish={async (values) => {
            setBusy(true);
            setError("");
            try {
              await authRequest("login", [values]);
              client.clear();
              setRetrying(false);
              setChecking(true);
            } catch (e) {
              setError(e instanceof Error ? e.message : "登录失败");
            } finally {
              setBusy(false);
            }
          }}
        >
          <Form.Item
            name="email"
            label="邮箱"
            rules={[{ required: true, type: "email" }]}
          >
            <Input
              type="email"
              autoComplete="username"
              spellCheck={false}
              autoCapitalize="none"
            />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={busy} block>
            登录
          </Button>
        </Form>
      </section>
    </main>
  );
}
