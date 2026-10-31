import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Card, Form, Input, Spin } from "antd";
import { useQueryClient } from "@tanstack/react-query";
import { authRequest, type SessionUser } from "@keagent/api-client";
import App from "./App";

export default function LoginGate() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const client = useQueryClient();
  const lock = useCallback(() => {
    setUser(null);
    client.clear();
  }, [client]);
  useEffect(() => {
    let active = true;
    const check = () =>
      authRequest<SessionUser>("session")
        .then((u) => {
          if (active) setUser(u);
        })
        .catch(() => {
          if (active) lock();
        })
        .finally(() => {
          if (active) setChecking(false);
        });
    void check();
    const timer = setInterval(() => {
      void check();
    }, 15000);
    window.addEventListener("keagent:unauthorized", lock);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("keagent:unauthorized", lock);
    };
  }, [lock]);
  if (checking)
    return (
      <div style={{ padding: 80, textAlign: "center" }}>
        <Spin />
        <p>正在验证登录身份…</p>
      </div>
    );
  if (user)
    return (
      <App
        onLogout={async () => {
          try {
            await authRequest("logout");
          } finally {
            lock();
          }
        }}
      />
    );
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: "#f6f8fb",
      }}
    >
      <Card title="登录 KeAgent Studio" style={{ width: 400 }}>
        <p>使用管理员开通的账号登录。</p>
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
              setUser(await authRequest<SessionUser>("session"));
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
            <Input autoComplete="username" />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={busy} block>
            登录
          </Button>
        </Form>
      </Card>
    </main>
  );
}
