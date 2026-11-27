import { useEffect, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Form,
  Input,
  Layout,
  Menu,
  Modal,
  Space,
  Spin,
  type MenuProps,
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
  LogOut,
  Settings,
  ShieldAlert,
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
    group: "总览",
    icon: <LayoutDashboard size={17} />,
    description: "掌握账号、设备与视频制作情况。",
  },
  {
    key: "users",
    label: "用户与设备",
    group: "运营与生产",
    icon: <Users size={17} />,
    description: "开通或停用用户账号，处理登录问题，查看并解绑用户设备。",
  },
  {
    key: "resources",
    label: "公共模板",
    group: "运营与生产",
    icon: <Boxes size={17} />,
    description: "维护剪辑、封面与文案模板，为视频创作发布推荐搭配。",
  },
  {
    key: "tasks",
    label: "云端任务",
    group: "运营与生产",
    icon: <ClipboardList size={17} />,
    description:
      "按用户和房源定位云端生产任务，查看当前阶段、失败原因与生成配置。",
  },
  {
    key: "ai",
    label: "AI 服务",
    group: "运营与生产",
    icon: <Cpu size={17} />,
    description: "配置、测试和启用制作服务，维护用户可以选择的公共音色。",
  },
  {
    key: "audit",
    label: "操作记录",
    group: "审计与商业化",
    icon: <ShieldCheck size={17} />,
    description:
      "追溯谁在什么时间对哪个对象做了什么，区分业务操作与账号安全记录。",
  },
  {
    key: "credits",
    label: "积分管理",
    group: "审计与商业化",
    icon: <Coins size={17} />,
    description: "发放和调整积分、对账在途扣费、维护价目与兑换码。",
  },
  {
    key: "douyin",
    label: "抖音发布",
    group: "审计与商业化",
    icon: <Video size={17} />,
    description: "查看抖音发布回执、执行日志和流程告警。",
  },
  {
    key: "settings",
    label: "设置",
    group: "系统",
    icon: <Settings size={17} />,
    description: "管理告警通知和当前浏览器的后台外观。",
  },
];

const menuGroups = ["总览", "运营与生产", "审计与商业化", "系统"] as const;

const menuItems: MenuProps["items"] = menuGroups.map((group) => ({
  type: "group",
  key: `group-${group}`,
  label: group,
  children: pages
    .filter((item) => item.group === group)
    .map(({ key, label, icon }) => ({
      key,
      label,
      icon,
      "aria-label": label,
    })),
}));

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
        <div className="admin-login-loading">
          <Spin size="large" tip="正在验证管理员身份…" />
        </div>
      </main>
    );
  if (!user)
    return (
      <main className="admin-login">
        <section
          className="admin-login-card"
          aria-labelledby="admin-login-title"
        >
          <div className="admin-login-brand">
            <img
              className="admin-brand-mark"
              src="./keagent-icon.png"
              width="40"
              height="40"
              alt=""
            />
            <div>
              <h1 id="admin-login-title">登录 AI来客管理后台</h1>
              <p className="admin-secondary">
                使用管理员账号维护用户、公共模板与云端服务。
              </p>
            </div>
          </div>
          {error && <Alert type="error" showIcon title={error} />}
          <Form
            layout="vertical"
            requiredMark={false}
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
              <Input
                size="large"
                placeholder="admin@example.com"
                autoComplete="username"
              />
            </Form.Item>
            <Form.Item
              name="password"
              label="密码"
              rules={[{ required: true, message: "请输入密码" }]}
            >
              <Input.Password
                size="large"
                placeholder="输入登录密码"
                autoComplete="current-password"
              />
            </Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              size="large"
              loading={busy}
              block
            >
              登录
            </Button>
          </Form>
        </section>
      </main>
    );
  if (!user.role.split(",").includes("admin"))
    return (
      <main className="admin-login">
        <section
          className="admin-login-card admin-denied-card"
          aria-labelledby="admin-denied-title"
        >
          <div className="admin-denied-icon" aria-hidden="true">
            <ShieldAlert size={26} />
          </div>
          <h1 id="admin-denied-title">当前账号没有管理权限</h1>
          <p className="admin-denied-email">{user.email}</p>
          <p className="admin-secondary">请使用管理员账号登录。</p>
          <Button
            type="primary"
            size="large"
            onClick={() => void logout()}
            loading={busy}
            block
          >
            退出并切换账号
          </Button>
        </section>
      </main>
    );
  if (new URLSearchParams(location.search).get("appearance") === "1")
    return <Navigate replace to="/admin/settings?tab=appearance" />;

  const accountInitial = (user.name || user.email || "A")
    .trim()
    .slice(0, 1)
    .toUpperCase();

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
        width={224}
        breakpoint="lg"
        collapsedWidth={68}
      >
        <div className="admin-sider-inner">
          <Link
            to="/admin/dashboard"
            className="admin-brand"
            aria-label="AI来客 · 管理后台"
          >
            <img
              className="admin-brand-mark"
              src="./keagent-icon.png"
              width="34"
              height="34"
              alt=""
            />
            <div className="admin-brand-text">
              <strong>AI来客</strong>
              <small>管理后台</small>
            </div>
          </Link>
          <div className="admin-sider-menu">
            <Menu
              mode="inline"
              selectedKeys={[page?.key || "dashboard"]}
              items={menuItems}
              onClick={({ key }) => navigate(`/admin/${key}`)}
            />
          </div>
          <div className="admin-sidebar-foot">
            <span className="admin-avatar" aria-hidden="true">
              {accountInitial}
            </span>
            <div className="admin-sidebar-user">
              <strong>{user.name || "系统管理员"}</strong>
              {user.email && <span title={user.email}>{user.email}</span>}
            </div>
          </div>
        </div>
      </Layout.Sider>
      <Layout className="admin-workspace">
        <Layout.Content className="admin-content" id="admin-main" tabIndex={-1}>
          <header className="admin-page-head">
            {page && (
              <div className="admin-page-heading">
                <h1>{page.label}</h1>
                <p>{page.description}</p>
              </div>
            )}
            <Space wrap className="admin-account-controls">
              {user.email && (
                <span className="admin-account-email">{user.email}</span>
              )}
              <Button
                icon={<LogOut size={15} />}
                loading={busy}
                onClick={() => void logout()}
              >
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
