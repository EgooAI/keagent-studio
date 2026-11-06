import { useEffect, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Drawer,
  Form,
  Input,
  Layout,
  Menu,
  Modal,
  Space,
  Spin,
} from "antd";
import { useQueryClient } from "@tanstack/react-query";
import {
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import {
  Boxes,
  ChevronRight,
  ClipboardList,
  Cpu,
  LayoutDashboard,
  Palette,
  ShieldCheck,
  Users,
} from "lucide-react";
import {
  authRequest,
  clearAccessToken,
  type SessionUser,
} from "@keagent/api-client";
import { ThemeSettings } from "@keagent/theme";
import type { AdminUser } from "@keagent/shared-types";
import AdminUsers from "./AdminUsers";
import AdminTasks from "./AdminTasks";
import AdminDouyin from "./AdminDouyin";
import AdminDashboard from "./AdminDashboard";
import AdminAI from "./AdminAI";
import AdminAudit from "./AdminAudit";
import ResourcesPanel from "./ResourcesPanel";
import {
  auth,
  unwrap,
  useAdminAction,
  useAdminParams,
  userLabel,
} from "./admin-api";

const pages = [
  {
    key: "douyin",
    label: "抖音发布",
    icon: <ClipboardList size={18} />,
    description: "查看抖音发布回执、执行日志和流程告警。",
  },
  {
    key: "dashboard",
    label: "管理概览",
    icon: <LayoutDashboard size={18} />,
    description: "查看账号、设备和公共模板，优先处理失败任务与服务配置缺项。",
  },
  {
    key: "users",
    label: "用户与设备",
    icon: <Users size={18} />,
    description: "开通或停用用户账号，处理登录问题，查看并解绑用户设备。",
  },
  {
    key: "resources",
    label: "公共模板",
    icon: <Boxes size={18} />,
    description:
      "配置视频工厂使用的文案、镜头、字幕和封面规则，预览后发布模板版本。",
  },
  {
    key: "tasks",
    label: "云端任务",
    icon: <ClipboardList size={18} />,
    description:
      "按用户和房源定位云端生产任务，查看当前阶段、失败原因与生成配置。",
  },
  {
    key: "ai",
    label: "AI 服务",
    icon: <Cpu size={18} />,
    description:
      "检查文案、配音和数字人的服务配置，维护用户可以选择的公共音色。",
  },
  {
    key: "audit",
    label: "操作记录",
    icon: <ShieldCheck size={18} />,
    description:
      "追溯谁在什么时间对哪个对象做了什么，区分业务操作与账号安全记录。",
  },
];

export default function LiveAdmin() {
  const client = useQueryClient();
  const { message } = App.useApp();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingExit, setPendingExit] = useState<AdminUser | null>(null);
  const pendingAction = useAdminAction();
  const identity = useRef("");
  const mounted = useRef(true);
  const location = useLocation();
  const navigate = useNavigate();
  const { params, setParams } = useAdminParams();
  const page = pages.find((item) => location.pathname === `/admin/${item.key}`);
  function clearAdminState() {
    client.clear();
    setPendingExit(null);
    Modal.destroyAll();
  }
  async function session() {
    try {
      const value = await authRequest<SessionUser>("session");
      if (!mounted.current) return;
      if (identity.current !== `${value.userId}:${value.role}`)
        clearAdminState();
      identity.current = `${value.userId}:${value.role}`;
      setUser(value);
    } catch {
      if (!mounted.current) return;
      clearAdminState();
      identity.current = "";
      setUser(null);
    } finally {
      if (mounted.current) setReady(true);
    }
  }
  useEffect(() => {
    mounted.current = true;
    void session();
    const timer = setInterval(() => void session(), 15000);
    const lock = () => {
      clearAdminState();
      identity.current = "";
      setUser(null);
      clearAccessToken();
    };
    window.addEventListener("keagent:unauthorized", lock);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      window.removeEventListener("keagent:unauthorized", lock);
    };
  }, [client]);
  async function logout() {
    setBusy(true);
    try {
      await authRequest("logout");
      clearAdminState();
      identity.current = "";
      setUser(null);
    } catch (problem) {
      message.error(
        problem instanceof Error ? problem.message : "退出失败，请重试",
      );
    } finally {
      setBusy(false);
    }
  }
  if (!ready)
    return (
      <main className="admin-login">
        <Spin tip="正在验证管理员身份…" />
      </main>
    );
  if (!user)
    return (
      <main className="admin-login">
        <Card title="登录管理后台" className="admin-login-card">
          <p className="admin-secondary">
            使用管理员账号维护用户、公共模板与云端服务。
          </p>
          {error && <Alert type="error" showIcon title={error} />}
          <Form
            layout="vertical"
            onFinish={async (values) => {
              setBusy(true);
              setError("");
              try {
                await authRequest("login", [values]);
                await session();
              } catch (problem) {
                setError(
                  problem instanceof Error ? problem.message : "登录失败",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            <Form.Item
              name="email"
              label="邮箱"
              rules={[
                { required: true, type: "email", message: "请输入有效邮箱" },
              ]}
            >
              <Input autoComplete="username" />
            </Form.Item>
            <Form.Item
              name="password"
              label="密码"
              rules={[{ required: true, message: "请输入密码" }]}
            >
              <Input.Password autoComplete="current-password" />
            </Form.Item>
            <Button type="primary" htmlType="submit" loading={busy} block>
              登录
            </Button>
          </Form>
        </Card>
      </main>
    );
  if (!user.role.split(",").includes("admin"))
    return (
      <main className="admin-login">
        <Card title="当前账号没有管理权限">
          <p>{user.email}</p>
          <p>请使用管理员账号登录。</p>
          <Button onClick={() => void logout()} loading={busy}>
            退出并切换账号
          </Button>
        </Card>
      </main>
    );
  return (
    <Layout className="admin-shell">
      <a
        href="#admin-main"
        className="admin-skip"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("admin-main")?.focus();
        }}
      >
        跳至主要内容
      </a>
      <Layout.Sider
        theme="light"
        width={222}
        breakpoint="lg"
        collapsedWidth={68}
      >
        <Link to="/admin/dashboard" className="admin-brand">
          <span className="admin-brand-mark">K</span>
          <div>
            <strong>KeAgent Studio</strong>
            <small>管理后台</small>
          </div>
        </Link>
        <Menu
          mode="inline"
          selectedKeys={[page?.key || "dashboard"]}
          items={pages.map(({ key, label, icon }) => ({ key, label, icon }))}
          onClick={({ key }) => navigate(`/admin/${key}`)}
        />
        <div className="admin-sidebar-foot">
          <ShieldCheck size={17} />
          <span>管理员工作区</span>
        </div>
      </Layout.Sider>
      <Layout>
        <Layout.Header className="admin-header">
          <Space>
            <span>管理后台</span>
            <ChevronRight size={14} />
            <span>{page?.label || "管理概览"}</span>
          </Space>
          <Space wrap className="admin-account-controls">
            <span className="admin-account-email">{user.email}</span>
            <Button
              icon={<Palette size={16} />}
              onClick={() => setParams({ appearance: "1" }, false)}
            >
              外观设置
            </Button>
            <Button loading={busy} onClick={() => void logout()}>
              退出登录
            </Button>
          </Space>
        </Layout.Header>
        <Layout.Content className="admin-content" id="admin-main" tabIndex={-1}>
          {pendingExit && (
            <Alert
              className="admin-notice"
              type="warning"
              showIcon
              title="密码已更改，但强制退出未完成"
              description={`${userLabel(pendingExit)} 的新密码已经生效，旧会话可能仍然有效。请重试强制退出，无需再次重置密码。请完成此步骤后再刷新或退出后台。`}
              action={
                <Button
                  danger
                  loading={pendingAction.busy}
                  onClick={async () => {
                    if (
                      await pendingAction.run(
                        () =>
                          unwrap(
                            auth.admin.revokeUserSessions({
                              userId: pendingExit.id,
                            }),
                          ),
                        "登录会话已撤销，密码重置处理完成",
                      )
                    )
                      setPendingExit(null);
                  }}
                >
                  重试强制退出
                </Button>
              }
            />
          )}
          {page && (
            <div className="admin-page-heading">
              <h1>{page.label}</h1>
              <p>{page.description}</p>
            </div>
          )}
          <Routes>
            <Route path="/admin/dashboard" element={<AdminDashboard />} />
            <Route
              path="/admin/users"
              element={
                <AdminUsers
                  currentUser={user}
                  pendingExit={pendingExit}
                  setPendingExit={(value) => {
                    if (identity.current === `${user.userId}:${user.role}`)
                      setPendingExit(value);
                  }}
                />
              }
            />
            <Route path="/admin/resources" element={<ResourcesPanel />} />
            <Route path="/admin/tasks" element={<AdminTasks />} />
            <Route path="/admin/douyin" element={<AdminDouyin />} />
            <Route path="/admin/ai" element={<AdminAI />} />
            <Route path="/admin/audit" element={<AdminAudit />} />
            <Route
              path="/admin/devices"
              element={<Navigate replace to="/admin/users?tab=devices" />}
            />
            <Route
              path="/admin/auth-audit"
              element={<Navigate replace to="/admin/audit?tab=account" />}
            />
            <Route
              path="/admin/ai-config"
              element={<Navigate replace to="/admin/ai" />}
            />
            <Route
              path="/admin/settings"
              element={<Navigate replace to="/admin/dashboard?appearance=1" />}
            />
            <Route
              path="*"
              element={<Navigate replace to="/admin/dashboard" />}
            />
          </Routes>
        </Layout.Content>
      </Layout>
      <Drawer
        title="外观设置"
        open={params.get("appearance") === "1"}
        onClose={() => setParams({ appearance: undefined }, false)}
        width={480}
      >
        <ThemeSettings />
        <p className="admin-secondary">
          只影响当前浏览器，不更改用户客户端或系统功能。
        </p>
      </Drawer>
    </Layout>
  );
}
