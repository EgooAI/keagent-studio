import { useEffect, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
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
  ClipboardList,
  Coins,
  Cpu,
  LayoutDashboard,
  Layers,
  Settings,
  ShieldCheck,
  Users,
  Video,
} from "lucide-react";
import {
  authRequest,
  clearAccessToken,
  type SessionUser,
} from "@keagent/api-client";
import type { AdminUser } from "@keagent/shared-types";
import AdminUsers from "./AdminUsers";
import AdminTasks from "./AdminTasks";
import AdminDouyin from "./AdminDouyin";
import AdminDashboard from "./AdminDashboard";
import AdminAI from "./AdminAI";
import AdminAudit from "./AdminAudit";
import AdminCredits from "./AdminCredits";
import AdminSettings from "./AdminSettings";
import ResourcesPanel from "./ResourcesPanel";
import { auth, unwrap, useAdminAction, userLabel } from "./admin-api";

const pages = [
  {
    key: "dashboard",
    label: "管理工作台",
    icon: <LayoutDashboard size={18} />,
    description: "掌握账号、设备与视频制作情况。",
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
    description: "配置、测试和启用制作服务，维护用户可以选择的公共音色。",
  },
  {
    key: "audit",
    label: "操作记录",
    icon: <ShieldCheck size={18} />,
    description:
      "追溯谁在什么时间对哪个对象做了什么，区分业务操作与账号安全记录。",
  },
  {
    key: "credits",
    label: "积分管理",
    icon: <Coins size={18} />,
    description: "发放和调整积分、对账在途扣费、维护价目与兑换码。",
  },
  {
    key: "douyin",
    label: "抖音发布",
    icon: <Video size={18} />,
    description: "查看抖音发布回执、执行日志和流程告警。",
  },
  {
    key: "settings",
    label: "设置",
    icon: <Settings size={18} />,
    description: "管理告警通知和当前浏览器的后台外观。",
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
  if (new URLSearchParams(location.search).get("appearance") === "1")
    return <Navigate replace to="/admin/settings?tab=appearance" />;
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
        width={204}
        breakpoint="lg"
        collapsedWidth={68}
      >
        <Link
          to="/admin/dashboard"
          className="admin-brand"
          aria-label="KeAgent Studio 管理工作台"
        >
          <span className="admin-brand-mark">
            <Layers size={18} aria-hidden="true" />
          </span>
          <div>
            <strong>KeAgent Studio</strong>
            <small>管理后台</small>
          </div>
        </Link>
        <Menu
          mode="inline"
          selectedKeys={[page?.key || "dashboard"]}
          items={pages.map(({ key, label, icon }) => ({
            key,
            label,
            icon,
            "aria-label": label,
          }))}
          onClick={({ key }) => navigate(`/admin/${key}`)}
        />
        <div className="admin-sidebar-foot">
          <ShieldCheck size={17} />
          <span>管理员工作区</span>
        </div>
      </Layout.Sider>
      <Layout>
        <Layout.Content
          className={
            page?.key === "ai" ? "admin-content" : "admin-content admin-refined"
          }
          id="admin-main"
          tabIndex={-1}
        >
          <header className="admin-page-head">
            {page && (
              <div className="admin-page-heading">
                <h1>{page.label}</h1>
                <p>{page.description}</p>
              </div>
            )}
            <Space wrap className="admin-account-controls">
              <span className="admin-account-email">{user.email}</span>
              <Button loading={busy} onClick={() => void logout()}>
                退出登录
              </Button>
            </Space>
          </header>
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
  <Route path="/admin/credits" element={<AdminCredits />} />
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
            <Route path="/admin/settings" element={<AdminSettings />} />
            <Route
              path="*"
              element={<Navigate replace to="/admin/dashboard" />}
            />
          </Routes>
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
