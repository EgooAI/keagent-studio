import { lazy, Suspense, useEffect, useState } from "react";
import {
  Link,
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import {
  Alert,
  App as AntApp,
  Avatar,
  Button,
  Dropdown,
  Empty,
  Popconfirm,
  Skeleton,
} from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Building2,
  House,
  LogOut,
  Send,
  Settings,
  SquarePlay,
  UsersRound,
} from "lucide-react";
import { demoApi, insufficientCreditsEvent, isLive } from "@keagent/api-client";
import { creditSummaryQuery } from "./lib/creditSummary";
import { useWorkspace } from "./lib/workspace";
import DouyinBrowserWorkspace from "./components/DouyinBrowserWorkspace";
const DashboardPage = lazy(() => import("./pages/DashboardPage"));
const PropertiesPage = lazy(() => import("./pages/PropertiesPage"));
const PropertyDetailPage = lazy(() =>
  import("./pages/PropertiesPage").then((m) => ({
    default: m.PropertyDetailPage,
  })),
);
const StudioPage = lazy(() =>
  import("./pages/StudioPage").then((m) => ({ default: m.StudioPage })),
);
const BatchDetailPage = lazy(() =>
  import("./pages/ProductionPages").then((m) => ({
    default: m.BatchDetailPage,
  })),
);
const ProductionTaskPage = lazy(() =>
  import("./pages/ProductionPages").then((m) => ({
    default: m.ProductionTaskPage,
  })),
);
const DemoPublishPage = lazy(() => import("./pages/DemoPublishPage"));
const DemoPublishDetailPage = lazy(() =>
  import("./pages/DemoPublishPage").then((m) => ({
    default: m.PublishDetailPage,
  })),
);
const PublishPage = lazy(() => import("./pages/PublishPage"));
const PublishDetailPage = lazy(() =>
  import("./pages/PublishPage").then((m) => ({ default: m.PublishDetailPage })),
);
const CommentObservationPage = lazy(
  () => import("./pages/CommentObservationPage"),
);
const LeadsPage = lazy(() => import("./pages/LeadsPage"));
const CollectionPage = lazy(() => import("./pages/CollectionPage"));
const CommentLeadPage = lazy(() => import("./pages/CommentLeadPage"));
const LeadWorkspace = lazy(() => import("./pages/leads/LeadWorkspace"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const creditsPath = "/settings/credits";

const navigation = [
  { path: "/dashboard", label: "工作台", icon: House },
  { path: "/properties", label: "房源中心", icon: Building2 },
  { path: "/studio", label: "AI 视频工厂", icon: SquarePlay },
  { path: "/publish", label: "发布中心", icon: Send },
  { path: "/leads", label: "AI 获客", icon: UsersRound },
];

export default function App({ onLogout }: { onLogout?: () => Promise<void> }) {
  const { data, error, isPending } = useWorkspace();
  const queryClient = useQueryClient();
  const creditSummary = useQuery({
    ...creditSummaryQuery,
    enabled: isLive,
    refetchInterval: 30_000,
  });
  const location = useLocation();
  const socialScope = new URLSearchParams(location.search);
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  useEffect(
    () =>
      demoApi.subscribe(() => {
        void queryClient.invalidateQueries({ queryKey: ["workspace"] });
      }),
    [queryClient],
  );
  useEffect(() => {
    const timer = window.setInterval(() => {
      void Promise.resolve(demoApi.tick()).catch(() => {});
    }, 1200);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    document.querySelector(".app-main")?.scrollTo(0, 0);
  }, [location.pathname]);
  useEffect(() => {
    const onInsufficient = () => {
      void queryClient.invalidateQueries({
        queryKey: creditSummaryQuery.queryKey,
      });
      message.warning({
        content: "积分不足，请点击左下角「积分兑换」。",
        onClick: () => navigate(creditsPath),
      });
    };
    window.addEventListener(insufficientCreditsEvent, onInsufficient);
    return () =>
      window.removeEventListener(insufficientCreditsEvent, onInsufficient);
  }, [message, navigate, queryClient]);
  const activeTasks =
    data?.tasks.filter((t) =>
      ["queued", "running", "awaiting_review"].includes(t.status),
    ).length ?? 0;
  const profileName =
    data?.profile.name.trim() || (isLive ? "用户" : "演示经纪人");
  const balance = creditSummary.data;
  const availableCredits =
    (balance?.purchased?.available ?? 0) + (balance?.granted?.available ?? 0);
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        跳至主要内容
      </a>
      <aside className="sidebar">
        <Link
          to="/dashboard"
          className="brand"
          aria-label="KeAgent Studio 工作台"
        >
          <span className="brand-mark">
            <House size={38} strokeWidth={2.1} aria-hidden="true" />
          </span>
          <span>
            <strong>KeAgent Studio</strong>
            <small>房产创作工作台</small>
          </span>
        </Link>
        <nav aria-label="主要导航">
          {navigation.map(({ path, label, icon: Icon }) => (
            <NavLink
              to={path}
              key={path}
              aria-label={label}
              title={label}
              className={({ isActive }) =>
                `nav-item${isActive ? " active" : ""}`
              }
            >
              <Icon size={23} strokeWidth={1.9} aria-hidden="true" />
              <span>{label}</span>
              {path === "/studio" && activeTasks > 0 && (
                <span className="nav-count">{activeTasks}</span>
              )}
            </NavLink>
          ))}
          {isLive &&
            location.pathname.startsWith("/leads") &&
            socialScope.get("platform") !== "xhs" && (
              <div className="lead-subnav">
                {[
                  ["/leads", "我的待办"],
                  ["/leads/works", "作品与评论"],
                  ["/leads/review", "线索审核"],
                  ["/leads/queue", "账号队列"],
                ].map(([path, label]) => {
                  const search = new URLSearchParams();
                  for (const key of ["platform", "accountId"])
                    if (socialScope.get(key))
                      search.set(key, socialScope.get(key)!);
                  return (
                    <NavLink
                      key={path}
                      end
                      to={{ pathname: path, search: search.toString() }}
                      title={label}
                    >
                      {label}
                    </NavLink>
                  );
                })}
              </div>
            )}
        </nav>
        <div className="sidebar-bottom">
          <NavLink
            to="/settings"
            aria-label="设置"
            title="设置"
            className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}
          >
            <Settings size={23} strokeWidth={1.9} aria-hidden="true" />
            <span>设置</span>
          </NavLink>
          <Dropdown
            trigger={["click"]}
            placement="topLeft"
            open={userMenuOpen}
            onOpenChange={setUserMenuOpen}
            disabled={!onLogout}
            menu={{
              items: onLogout
                ? [
                    {
                      key: "logout",
                      label: "退出登录",
                      icon: <LogOut size={16} />,
                      onClick: () =>
                        void onLogout().catch((e: Error) =>
                          message.error(e.message),
                        ),
                    },
                  ]
                : [],
            }}
          >
            <button
              type="button"
              className="sidebar-profile"
              title={profileName}
              aria-label="用户菜单"
              aria-describedby={isLive ? "sidebar-credit-balance" : undefined}
              aria-haspopup="menu"
              aria-expanded={userMenuOpen}
              disabled={!onLogout}
            >
              <Avatar size={44}>{Array.from(profileName)[0]}</Avatar>
              <span>
                <strong>{profileName}</strong>
                {isLive ? (
                  <small
                    id="sidebar-credit-balance"
                    className="sidebar-credit-balance"
                  >
                    <span>可用积分</span>
                    <b>
                      {balance
                        ? availableCredits.toLocaleString("zh-CN")
                        : creditSummary.isError
                          ? "暂不可用"
                          : "—"}
                    </b>
                  </small>
                ) : (
                  <small>演示工作区</small>
                )}
              </span>
            </button>
          </Dropdown>
          {isLive && (
            <NavLink to={creditsPath} className="sidebar-credit-link" end>
              积分兑换 <ArrowRight size={13} aria-hidden="true" />
            </NavLink>
          )}
        </div>
      </aside>
      <div className="app-workspace">
        <main id="main-content" className="app-main" tabIndex={-1}>
          {error ? (
            <div className="panel error-boundary">
              <Alert
                type="error"
                showIcon
                message="演示数据暂时无法读取"
                description={error.message}
              />
              <p>
                为保护已有草稿，系统不会自动清除数据。可先重试，或确认恢复初始演示数据。
              </p>
              <Button
                onClick={() =>
                  void queryClient.invalidateQueries({
                    queryKey: ["workspace"],
                  })
                }
              >
                重试读取
              </Button>{" "}
              <Popconfirm
                title="清空本浏览器的演示数据？"
                description="房源、任务和草稿会恢复到初始演示状态。"
                onConfirm={async () => {
                  try {
                    await demoApi.resetDemo();
                    void queryClient.invalidateQueries({
                      queryKey: ["workspace"],
                    });
                  } catch (e) {
                    message.error((e as Error).message);
                  }
                }}
              >
                <Button danger>重置演示</Button>
              </Popconfirm>
            </div>
          ) : isPending ? (
            <Skeleton active paragraph={{ rows: 12 }} />
          ) : (
            <Suspense fallback={<Skeleton active paragraph={{ rows: 10 }} />}>
              <Routes>
                <Route index element={<Navigate to="/dashboard" replace />} />
                <Route path="/dashboard" element={<DashboardPage />} />
                <Route path="/properties" element={<PropertiesPage />} />
                <Route
                  path="/properties/:propertyId"
                  element={<PropertyDetailPage />}
                />
                <Route path="/studio" element={<StudioPage />} />
                <Route path="/studio/create" element={<StudioPage />} />
                <Route
                  path="/studio/batches/:batchId"
                  element={<BatchDetailPage />}
                />
                <Route
                  path="/studio/tasks/:taskId"
                  element={<ProductionTaskPage />}
                />
                <Route
                  path="/studio/tasks/:taskId/review"
                  element={<ProductionTaskPage />}
                />
                <Route path="/publish" element={<PublishPage />} />
                <Route path="/publish/demo" element={<DemoPublishPage />} />
                <Route
                  path="/publish/demo/:productionTaskId"
                  element={<DemoPublishDetailPage />}
                />
                <Route
                  path="/publish/:productionTaskId"
                  element={<PublishDetailPage />}
                />
                <Route
                  path="/leads"
                  element={isLive ? <LeadWorkspace /> : <LeadsPage />}
                />
                {isLive && (
                  <Route path="/leads/:area" element={<LeadWorkspace />} />
                )}
                <Route path="/leads/collection" element={<CollectionPage />} />
                <Route
                  path="/leads/comment-lead"
                  element={<CommentLeadPage />}
                />
                <Route
                  path="/leads/comment-observation"
                  element={<CommentObservationPage />}
                />
                <Route path="/settings" element={<SettingsPage />} />
                <Route
                  path="/settings/profile"
                  element={<Navigate to="/settings/account" replace />}
                />
                <Route
                  path="/settings/defaults"
                  element={<Navigate to="/settings/service-status" replace />}
                />
                <Route path="/settings/:section" element={<SettingsPage />} />
                <Route
                  path="*"
                  element={
                    <Empty description="页面不存在">
                      <Button onClick={() => navigate("/dashboard")}>
                        返回工作台
                      </Button>
                    </Empty>
                  }
                />
              </Routes>
            </Suspense>
          )}
          <footer className="app-footer">
            <span>KeAgent Studio</span>
            <span>
              {isLive
                ? "云端联调 · 未接入的能力会明确提示"
                : "前端交互演示 · 房源、生成与平台结果均为模拟"}
            </span>
          </footer>
        </main>
        {isLive && <DouyinBrowserWorkspace />}
      </div>
    </div>
  );
}
