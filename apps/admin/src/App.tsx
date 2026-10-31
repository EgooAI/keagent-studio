import { Component, useEffect, useState, type ReactNode } from "react";
import {
  App as AntApp,
  Alert,
  Avatar,
  Button,
  ConfigProvider,
  Empty,
  Form,
  Input,
  Layout,
  Menu,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Upload,
  message,
} from "antd";
import zhCN from "antd/locale/zh_CN";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { HashRouter, Link, useLocation, useNavigate } from "react-router-dom";
import {
  Boxes,
  ChevronRight,
  Clapperboard,
  Cpu,
  LayoutDashboard,
  Monitor,
  Plus,
  Settings,
  ShieldCheck,
  UploadCloud,
  Users,
} from "lucide-react";
import { demoApi } from "@keagent/api-client";
import type { ProductionTask } from "@keagent/shared-types";
import { stageLabels, statusLabels } from "@keagent/shared-types";
import ResourcesPanel from "./ResourcesPanel";
import { useAdminState, type Release } from "./admin-state";
import "antd/dist/reset.css";
import "./admin.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});
const menuItems = [
  { key: "dashboard", icon: <LayoutDashboard size={18} />, label: "仪表盘" },
  { key: "users", icon: <Users size={18} />, label: "用户管理" },
  { key: "devices", icon: <Monitor size={18} />, label: "设备管理" },
  { key: "resources", icon: <Boxes size={18} />, label: "资源管理" },
  { key: "ai", icon: <Cpu size={18} />, label: "AI 配置" },
  { key: "tasks", icon: <Clapperboard size={18} />, label: "任务监控" },
  { key: "releases", icon: <UploadCloud size={18} />, label: "客户端版本" },
  { key: "settings", icon: <Settings size={18} />, label: "系统设置" },
];
const pageDescriptions: Record<string, string> = {
  dashboard: "查看演示工作区的用户、资源和任务状态。",
  users: "管理示例用户状态；真实身份与权限尚未接入。",
  devices: "查看演示设备与版本，模拟连接和解绑。",
  resources: "维护模板、风格与提示词的资源目录。",
  ai: "设置服务商与模型路由，不在浏览器保存真实密钥。",
  tasks: "按阶段追踪视频生产，定位失败与待审核任务。",
  releases: "管理各目标平台的演示安装包记录。",
  settings: "管理演示功能开关，查看本地操作审计。",
};

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
      <div className="admin-error">
        <Alert
          type="error"
          showIcon
          title="后台数据暂时无法读取"
          description={this.state.error}
        />
        <Button onClick={() => location.reload()}>重新加载</Button>
      </div>
    ) : (
      this.props.children
    );
  }
}

function AdminWorkspace() {
  const client = useQueryClient();
  const { data, error, isPending, refetch } = useQuery({
    queryKey: ["workspace"],
    queryFn: () => {
      if (
        import.meta.env.VITE_API_MODE &&
        import.meta.env.VITE_API_MODE !== "mock"
      )
        throw new Error(
          "当前后台仅提供前端演示，请将 VITE_API_MODE 设置为 mock。",
        );
      return demoApi.getWorkspace();
    },
  });
  const { state, update } = useAdminState();
  const location = useLocation();
  const navigate = useNavigate();
  const selected =
    location.pathname.split("/").filter(Boolean).at(-1) || "dashboard";
  const page = menuItems.find((item) => item.key === selected)
    ? selected
    : "dashboard";
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [tickError, setTickError] = useState("");
  const [releaseFile, setReleaseFile] = useState("");
  const [releaseForm] = Form.useForm<{ version: string; platform: string }>();
  const [aiForm] = Form.useForm();
  useEffect(() => {
    const unsubscribe = demoApi.subscribe(() => {
      void client.invalidateQueries({ queryKey: ["workspace"] });
    });
    const timer = window.setInterval(() => {
      void demoApi
        .tick()
        .catch((problem) =>
          setTickError(
            problem instanceof Error ? problem.message : "模拟任务状态保存失败",
          ),
        );
    }, 1200);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, [client]);
  useEffect(() => {
    aiForm.setFieldsValue({ ...state.ai, apiKey: "" });
  }, [state.ai, aiForm]);
  function adminAction(patch: Parameters<typeof update>[0], action: string) {
    try {
      update(patch, action);
      message.success(`${action}（模拟）`);
    } catch (problem) {
      message.error(
        problem instanceof Error ? problem.message : "无法保存演示配置",
      );
    }
  }
  const taskColumns = [
    {
      title: "房源",
      key: "property",
      render: (_: unknown, task: ProductionTask) => (
        <>
          <strong>{task.propertySnapshot.community}</strong>
          <p className="admin-secondary">{task.id}</p>
        </>
      ),
    },
    {
      title: "模式",
      key: "mode",
      render: (_: unknown, task: ProductionTask) =>
        task.configSnapshot.videoMode === "avatar" ? "经纪人露脸" : "纯口播",
    },
    {
      title: "阶段",
      dataIndex: "stage",
      render: (value: ProductionTask["stage"]) => stageLabels[value],
    },
    {
      title: "状态",
      dataIndex: "status",
      render: (value: ProductionTask["status"]) => (
        <Tag
          color={
            value === "succeeded"
              ? "green"
              : value === "failed"
                ? "red"
                : value === "awaiting_review"
                  ? "orange"
                  : "blue"
          }
        >
          {statusLabels[value]}
        </Tag>
      ),
    },
    {
      title: "诊断",
      key: "error",
      render: (_: unknown, task: ProductionTask) => task.error || "—",
    },
  ];
  async function addRelease() {
    try {
      const values = await releaseForm.validateFields();
      if (!releaseFile) {
        message.warning("请选择演示安装包");
        return;
      }
      const release: Release = {
        id: crypto.randomUUID(),
        ...values,
        fileName: releaseFile,
        published: false,
        createdAt: new Date().toISOString(),
      };
      update(
        { releases: [release, ...state.releases] },
        `新增客户端版本 ${values.version}`,
      );
      setReleaseOpen(false);
      message.success("演示安装包记录已创建");
    } catch (problem) {
      if (problem instanceof Error) message.error(problem.message);
    }
  }
  let content: ReactNode = null;
  if (isPending)
    content = (
      <div className="admin-loading">
        <Spin tip="正在读取演示数据" />
      </div>
    );
  else if (error || !data)
    content = (
      <Alert
        type="error"
        showIcon
        title="数据加载失败"
        description={error?.message}
        action={<Button onClick={() => void refetch()}>重试</Button>}
      />
    );
  else if (page === "dashboard")
    content = (
      <>
        <div className="admin-summary">
          <div>
            <span>示例用户</span>
            <strong>1</strong>
            <Tag color={state.userEnabled ? "green" : "default"}>
              {state.userEnabled ? "已启用" : "已停用"}
            </Tag>
          </div>
          <div>
            <span>演示设备</span>
            <strong>{state.deviceBound ? 1 : 0}</strong>
            <small>当前工作区</small>
          </div>
          <div>
            <span>已发布资源</span>
            <strong>
              {data.resources.filter((resource) => resource.published).length}
            </strong>
            <small>可在资源目录查看</small>
          </div>
          <div>
            <span>待审核任务</span>
            <strong>
              {
                data.tasks.filter((task) => task.status === "awaiting_review")
                  .length
              }
            </strong>
            <small>等待经纪人确认</small>
          </div>
        </div>
        <section className="admin-panel">
          <h2>最近生产任务</h2>
          <Table<ProductionTask>
            rowKey="id"
            columns={taskColumns}
            dataSource={data.tasks.slice(0, 5)}
            pagination={false}
            scroll={{ x: 750 }}
          />
        </section>
        <section className="admin-panel" style={{ marginTop: 22 }}>
          <h2>运行说明</h2>
          <p className="admin-secondary">
            管理后台为独立网页应用，当前使用本地演示数据，与桌面客户端的数据分开保存。接入云端后再共享业务数据；当前管理操作不会影响真实用户、账号或安装包分发。
          </p>
          <Space>
            <Tag>Go API 待接入</Tag>
            <Tag>对象存储待接入</Tag>
            <Tag>密钥管理待接入</Tag>
          </Space>
        </section>
      </>
    );
  else if (page === "users")
    content = (
      <section className="admin-panel">
        <Alert
          type="info"
          title="启用与停用仅更新后台演示记录，客户端的真实权限管理待接入。"
          style={{ marginBottom: 22 }}
        />
        <Table
          rowKey="id"
          pagination={false}
          dataSource={[
            {
              id: "demo-user",
              name: data.profile.name,
              brokerage: data.profile.brokerage,
              city: data.profile.city,
            },
          ]}
          columns={[
            {
              title: "用户",
              dataIndex: "name",
              render: (value) => (
                <Space>
                  <Avatar style={{ background: "#eff6ff", color: "#2563eb" }}>
                    {String(value).slice(-2)}
                  </Avatar>
                  <strong>{value}</strong>
                </Space>
              ),
            },
            { title: "门店", dataIndex: "brokerage" },
            { title: "城市", dataIndex: "city" },
            {
              title: "状态",
              key: "state",
              render: () => (
                <Tag color={state.userEnabled ? "green" : "default"}>
                  {state.userEnabled ? "正常" : "已停用"}
                </Tag>
              ),
            },
            {
              title: "操作",
              key: "action",
              render: () => (
                <Popconfirm
                  title={`${state.userEnabled ? "停用" : "启用"}这个演示用户？`}
                  onConfirm={() =>
                    adminAction(
                      { userEnabled: !state.userEnabled },
                      state.userEnabled ? "停用用户" : "启用用户",
                    )
                  }
                  okText="确认"
                  cancelText="取消"
                >
                  <Button type="link" danger={state.userEnabled}>
                    {state.userEnabled ? "停用" : "启用"}
                  </Button>
                </Popconfirm>
              ),
            },
          ]}
        />
      </section>
    );
  else if (page === "devices")
    content = (
      <section className="admin-panel">
        <Alert
          type="info"
          title="这里展示示例设备记录，不检测真实系统或安装状态。"
          style={{ marginBottom: 22 }}
        />
        <Table
          rowKey="id"
          pagination={false}
          dataSource={[
            {
              id: "demo-device",
              name: "经纪人工作站（示例）",
              os: "Windows x64",
              version: "0.1.0",
            },
          ]}
          columns={[
            { title: "设备", dataIndex: "name" },
            { title: "系统", dataIndex: "os" },
            { title: "客户端版本", dataIndex: "version" },
            {
              title: "绑定状态",
              key: "state",
              render: () => (
                <Tag color={state.deviceBound ? "green" : "default"}>
                  {state.deviceBound ? "模拟已绑定" : "已解绑"}
                </Tag>
              ),
            },
            {
              title: "操作",
              key: "action",
              render: () => (
                <Popconfirm
                  title={`${state.deviceBound ? "解绑" : "重新绑定"}演示设备？`}
                  onConfirm={() =>
                    adminAction(
                      { deviceBound: !state.deviceBound },
                      state.deviceBound ? "解绑设备" : "绑定设备",
                    )
                  }
                  okText="确认"
                  cancelText="取消"
                >
                  <Button type="link" danger={state.deviceBound}>
                    {state.deviceBound ? "解绑" : "模拟绑定"}
                  </Button>
                </Popconfirm>
              ),
            },
          ]}
        />
      </section>
    );
  else if (page === "resources")
    content = (
      <section className="admin-panel">
        <ResourcesPanel
          resources={data.resources}
          onAudit={(action) => {
            try {
              update({}, action);
            } catch {
              message.warning("资源已更新，但本地审计记录保存失败");
            }
          }}
        />
      </section>
    );
  else if (page === "ai")
    content = (
      <section className="admin-panel">
        <Alert
          type="warning"
          title="请勿输入真实密钥。此表单只保存演示配置，密钥输入不会写入本地存储或发起网络请求。"
          style={{ marginBottom: 24 }}
        />
        <Form
          form={aiForm}
          layout="vertical"
          style={{ maxWidth: 680 }}
          onFinish={(values) => {
            adminAction(
              {
                ai: {
                  textProvider: values.textProvider,
                  textModel: values.textModel,
                  ttsProvider: values.ttsProvider,
                  avatarProvider: values.avatarProvider,
                  endpoint: values.endpoint ?? "",
                },
              },
              "保存 AI 演示配置",
            );
            aiForm.setFieldValue("apiKey", "");
          }}
        >
          <div className="admin-form-columns">
            <Form.Item
              name="textProvider"
              label="文案服务商"
              rules={[{ required: true, message: "请输入演示服务商名称" }]}
            >
              <Input />
            </Form.Item>
            <Form.Item
              name="textModel"
              label="文案模型"
              rules={[{ required: true, message: "请输入模型名称" }]}
            >
              <Input />
            </Form.Item>
          </div>
          <div className="admin-form-columns">
            <Form.Item name="ttsProvider" label="TTS 服务商">
              <Input />
            </Form.Item>
            <Form.Item name="avatarProvider" label="数字人服务商">
              <Input />
            </Form.Item>
          </div>
          <Form.Item
            name="endpoint"
            label="服务地址（仅演示）"
            rules={[{ type: "url", message: "请输入完整 URL" }]}
          >
            <Input placeholder="https://api.example.com" />
          </Form.Item>
          <Form.Item name="apiKey" label="示例密钥（不保存）">
            <Input.Password
              autoComplete="off"
              placeholder="只输入示例值，切勿使用真实密钥"
            />
          </Form.Item>
          <Space>
            <Button type="primary" htmlType="submit">
              保存演示配置
            </Button>
            <Button
              onClick={() =>
                message.info("模拟检测通过；没有请求任何真实服务商")
              }
            >
              模拟连接检测
            </Button>
          </Space>
        </Form>
        <h3 style={{ marginTop: 34 }}>提示词模板</h3>
        <Table
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={data.resources.filter(
            (resource) => resource.type === "prompt",
          )}
          columns={[
            { title: "名称", dataIndex: "name" },
            { title: "版本", dataIndex: "version" },
            { title: "说明", dataIndex: "description" },
            {
              title: "状态",
              dataIndex: "published",
              render: (value) => <Tag>{value ? "已发布" : "未发布"}</Tag>,
            },
          ]}
        />
      </section>
    );
  else if (page === "tasks")
    content = (
      <section className="admin-panel">
        <Table<ProductionTask>
          rowKey="id"
          columns={taskColumns}
          dataSource={data.tasks}
          pagination={{ pageSize: 10 }}
          scroll={{ x: 900 }}
        />
      </section>
    );
  else if (page === "releases")
    content = (
      <section className="admin-panel">
        <div className="admin-toolbar">
          <span className="admin-secondary">
            仅记录安装包名称，不上传文件或分发更新。
          </span>
          <Button
            type="primary"
            icon={<Plus size={15} />}
            onClick={() => {
              setReleaseFile("");
              releaseForm.resetFields();
              setReleaseOpen(true);
            }}
          >
            新增版本
          </Button>
        </div>
        <Table<Release>
          rowKey="id"
          dataSource={state.releases}
          pagination={{ pageSize: 8 }}
          scroll={{ x: 800 }}
          columns={[
            { title: "版本", dataIndex: "version" },
            { title: "目标平台", dataIndex: "platform" },
            { title: "安装包", dataIndex: "fileName" },
            {
              title: "状态",
              dataIndex: "published",
              render: (value) => (
                <Tag color={value ? "green" : "default"}>
                  {value ? "模拟已发布" : "草稿"}
                </Tag>
              ),
            },
            {
              title: "操作",
              key: "action",
              render: (_, release) => (
                <Button
                  type="link"
                  onClick={() =>
                    adminAction(
                      {
                        releases: state.releases.map((item) =>
                          item.id === release.id
                            ? { ...item, published: !item.published }
                            : item,
                        ),
                      },
                      `${release.published ? "下架" : "发布"}版本 ${release.version}`,
                    )
                  }
                >
                  {release.published ? "下架" : "模拟发布"}
                </Button>
              ),
            },
          ]}
        />
      </section>
    );
  else
    content = (
      <>
        <section className="admin-panel">
          <h2>功能开关</h2>
          <Alert
            type="info"
            title="这些开关仅保存本地后台演示配置，不会远程改变客户端功能。"
            style={{ marginBottom: 20 }}
          />
          {(
            [
              {
                key: "avatar",
                title: "经纪人露脸",
                description: "数字人开场相关功能",
              },
              {
                key: "publishing",
                title: "平台草稿流程",
                description: "抖音和小红书任务入口",
              },
              {
                key: "leadAnalysis",
                title: "AI 获客",
                description: "评论分析和跟进建议",
              },
            ] as const
          ).map((flag) => (
            <div key={flag.key} className="admin-setting-row">
              <div>
                <strong>{flag.title}</strong>
                <p className="admin-secondary">{flag.description}</p>
              </div>
              <Switch
                aria-label={flag.title}
                checked={state.flags[flag.key]}
                onChange={(checked) =>
                  adminAction(
                    { flags: { ...state.flags, [flag.key]: checked } },
                    `${checked ? "开启" : "关闭"}${flag.title}`,
                  )
                }
              />
            </div>
          ))}
        </section>
        <section className="admin-panel" style={{ marginTop: 22 }}>
          <h2>本地操作审计</h2>
          <Table
            rowKey="id"
            size="small"
            pagination={{ pageSize: 8 }}
            dataSource={state.audit}
            locale={{ emptyText: <Empty description="还没有后台操作记录" /> }}
            columns={[
              { title: "操作", dataIndex: "action" },
              {
                title: "时间",
                dataIndex: "at",
                render: (value) => new Date(value).toLocaleString("zh-CN"),
              },
            ]}
          />
        </section>
      </>
    );
  return (
    <Layout className="admin-shell">
      <Layout.Sider
        width={222}
        theme="light"
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
        <div className="admin-nav-label">工作区管理</div>
        <Menu
          mode="inline"
          selectedKeys={[page]}
          items={menuItems}
          onClick={({ key }) => navigate(`/admin/${key}`)}
        />
        <div className="admin-sidebar-foot">
          <ShieldCheck size={17} />
          <span>演示管理员</span>
        </div>
      </Layout.Sider>
      <Layout>
        <Layout.Header className="admin-header">
          <Space>
            <span>管理后台</span>
            <ChevronRight size={14} />
            <span>{menuItems.find((item) => item.key === page)?.label}</span>
          </Space>
          <Space size={18}>
            <Tag>本地 Mock</Tag>
            <Avatar style={{ background: "#eaf0fb", color: "#2563eb" }}>
              管
            </Avatar>
          </Space>
        </Layout.Header>
        <Layout.Content className="admin-content">
          <div className="admin-page-heading">
            <h1>{menuItems.find((item) => item.key === page)?.label}</h1>
            <p>{pageDescriptions[page]}</p>
          </div>
          {tickError && (
            <Alert
              type="error"
              showIcon
              title={tickError}
              action={
                <Button
                  size="small"
                  onClick={() => {
                    setTickError("");
                    void refetch();
                  }}
                >
                  重试
                </Button>
              }
              style={{ marginBottom: 18 }}
            />
          )}
          {content}
        </Layout.Content>
      </Layout>
      <Modal
        title="新增客户端版本（演示）"
        open={releaseOpen}
        onCancel={() => setReleaseOpen(false)}
        onOk={() => void addRelease()}
        okText="创建记录"
      >
        <Form form={releaseForm} layout="vertical">
          <Form.Item
            name="version"
            label="版本号"
            rules={[
              { required: true, message: "请输入版本号" },
              { pattern: /^\d+\.\d+\.\d+$/, message: "版本格式为 0.1.0" },
            ]}
          >
            <Input placeholder="0.1.0" />
          </Form.Item>
          <Form.Item
            name="platform"
            label="目标平台"
            rules={[{ required: true, message: "请选择目标平台" }]}
          >
            <Select
              options={["Windows x64", "macOS x64", "macOS arm64"].map(
                (value) => ({ value, label: value }),
              )}
            />
          </Form.Item>
          <Form.Item label="安装包" required>
            <Upload
              accept=".exe,.dmg,.zip"
              showUploadList={false}
              beforeUpload={(file) => {
                if (!/\.(exe|dmg|zip)$/i.test(file.name)) {
                  message.error("请选择 exe、dmg 或 zip 文件");
                  return false;
                }
                setReleaseFile(file.name);
                return false;
              }}
            >
              <Button icon={<UploadCloud size={15} />}>
                {releaseFile || "选择演示文件（不上传）"}
              </Button>
            </Upload>
          </Form.Item>
        </Form>
      </Modal>
    </Layout>
  );
}

export default function App() {
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: "#2563eb",
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
              <AdminWorkspace />
            </AdminBoundary>
          </HashRouter>
        </QueryClientProvider>
      </AntApp>
    </ConfigProvider>
  );
}
