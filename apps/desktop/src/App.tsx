import { lazy, Suspense, useEffect } from "react";
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
  Badge,
  Button,
  Drawer,
  Empty,
  Popconfirm,
  Progress,
  Skeleton,
  Tag,
} from "antd";
import { useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  Building2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clapperboard,
  Cloud,
  FolderOpen,
  House,
  LayoutDashboard,
  LogOut,
  PanelLeftClose,
  Settings,
  Sparkles,
  Users,
  Workflow,
} from "lucide-react";
import { demoApi } from "@keagent/api-client";
import { stageLabels } from "@keagent/shared-types";
import { useUiStore, useWorkspace } from "./lib/workspace";
import { StatusTag, formatDate } from "./components/common";
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
const PublishPage = lazy(() => import("./pages/PublishPage"));
const PublishDetailPage = lazy(() =>
  import("./pages/PublishPage").then((m) => ({ default: m.PublishDetailPage })),
);
const LeadsPage = lazy(() => import("./pages/LeadsPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));

const navigation = [
  { path: "/dashboard", label: "工作台", icon: LayoutDashboard },
  { path: "/properties", label: "房源中心", icon: Building2 },
  { path: "/studio", label: "AI 视频工厂", icon: Clapperboard },
  { path: "/publish", label: "发布中心", icon: FolderOpen },
  { path: "/leads", label: "AI 获客", icon: Users },
];

export default function App() {
  const { data, error, isPending } = useWorkspace();
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const { tasksOpen, setTasksOpen } = useUiStore();
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
  const current = navigation.find((n) => location.pathname.startsWith(n.path));
  const activeTasks =
    data?.tasks.filter((t) =>
      ["queued", "running", "awaiting_review"].includes(t.status),
    ).length ?? 0;
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        跳至主要内容
      </a>
      <aside className="sidebar">
        <Link to="/dashboard" className="brand">
          <span className="brand-mark">
            <House size={23} strokeWidth={2.2} />
          </span>
          <span>
            <strong>
              KeAgent<span> Studio</span>
            </strong>
            <small>房产创作工作台</small>
          </span>
        </Link>
        <div className="workspace-switch">
          <span className="workspace-avatar">沪</span>
          <span>
            我的创作空间<small>个人工作区</small>
          </span>
          <ChevronDown size={15} />
        </div>
        <nav aria-label="主要导航">
          {navigation.map(({ path, label, icon: Icon }) => (
            <NavLink
              to={path}
              key={path}
              className={({ isActive }) =>
                `nav-item${isActive ? " active" : ""}`
              }
            >
              <Icon size={19} />
              <span>{label}</span>
              {path === "/studio" && activeTasks > 0 && (
                <span className="nav-count">{activeTasks}</span>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="workspace-note">
            <Workflow size={18} />
            <div>
              <strong>让好房源，被看见</strong>
              <p>从一套房源，开始你的创作。</p>
            </div>
          </div>
          <NavLink
            to="/settings"
            className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}
          >
            <Settings size={19} />
            <span>设置</span>
          </NavLink>
          <div className="sidebar-profile">
            <Avatar
              size={34}
              style={{ background: "#e9eff9", color: "#31547d" }}
            >
              林
            </Avatar>
            <span>
              <strong>{data?.profile.name ?? "演示经纪人"}</strong>
              <small>演示工作区</small>
            </span>
            <Tag variant="filled">V1</Tag>
          </div>
        </div>
      </aside>
      <div className="app-workspace">
        <header className="app-header">
          <div className="breadcrumb">
            <span>工作空间</span>
            <ChevronRight size={14} />
            <strong>{current?.label ?? "设置"}</strong>
          </div>
          <div className="header-actions">
            <span className="demo-indicator">Mock 演示</span>
            <span className="cloud-state">
              <Cloud size={16} /> 本地模拟数据
            </span>
            <Button
              className="task-center-button"
              icon={<Bell size={17} />}
              onClick={() => setTasksOpen(true)}
            >
              任务中心
              {activeTasks > 0 && <Badge count={activeTasks} color="#2563eb" />}
            </Button>
            <Avatar
              size={30}
              style={{ background: "#dae6f7", color: "#274b7a" }}
            >
              林
            </Avatar>
          </div>
        </header>
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
                <Route
                  path="/publish/:productionTaskId"
                  element={<PublishDetailPage />}
                />
                <Route path="/leads" element={<LeadsPage />} />
                <Route path="/settings" element={<SettingsPage />} />
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
            <span>前端交互演示 · 房源、生成与平台结果均为模拟</span>
          </footer>
        </main>
      </div>
      <Drawer
        title="任务中心"
        open={tasksOpen}
        onClose={() => setTasksOpen(false)}
        size={440}
      >
        <p className="muted">离开当前页面后，模拟任务仍会继续推进。</p>
        {data?.tasks.map((task) => (
          <Link
            className="drawer-task"
            to={`/studio/tasks/${task.id}`}
            key={task.id}
            onClick={() => setTasksOpen(false)}
          >
            <div>
              <strong>{task.propertySnapshot.community}</strong>
              <StatusTag status={task.status} />
            </div>
            <p>
              {stageLabels[task.stage]} · {formatDate(task.createdAt)}
            </p>
            {task.status === "running" && (
              <Progress
                percent={task.progress}
                size="small"
                format={() => "模拟进度"}
              />
            )}
          </Link>
        ))}
        {data?.resources
          .filter((r) => r.downloadStatus === "downloading")
          .map((r) => (
            <div className="drawer-task" key={r.id}>
              <strong>下载 {r.name}</strong>
              <Progress percent={r.downloadProgress} size="small" />
            </div>
          ))}
        {data?.publishTasks
          .filter((p) => ["running", "queued", "unknown"].includes(p.status))
          .map((p) => (
            <Link
              className="drawer-task"
              key={p.id}
              to={`/publish/${p.productionTaskId}`}
              onClick={() => setTasksOpen(false)}
            >
              <strong>{p.title}</strong>
              <StatusTag status={p.status} />
            </Link>
          ))}
      </Drawer>
    </div>
  );
}
