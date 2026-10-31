import { useEffect, useState } from "react";
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
  Select,
  Space,
  Switch,
  Table,
  Tag,
} from "antd";
import { createAuthClient } from "@app/auth-sdk/react";
import { adminClient } from "@app/auth-sdk/client/plugins";
import { serviceRequest, type SessionUser } from "@keagent/api-client";

const auth = createAuthClient({ plugins: [adminClient({ auditLog: true })] });
type Row = Record<string, unknown>;
const pages = [
  { key: "users", label: "用户管理" },
  { key: "devices", label: "设备管理" },
  { key: "resources", label: "资源管理" },
  { key: "tasks", label: "任务监控" },
  { key: "ai-config", label: "AI 配置" },
  { key: "audit", label: "业务审计" },
  { key: "auth-audit", label: "身份审计" },
];
async function unwrap<T>(
  promise: Promise<{ data: T | null; error: { message?: string } | null }>,
): Promise<T> {
  const value = await promise;
  if (value.error || !value.data)
    throw new Error(value.error?.message || "请求失败");
  return value.data;
}

export default function LiveAdmin() {
  const { message } = App.useApp();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [ready, setReady] = useState(false);
  const [page, setPage] = useState("users");
  const [data, setData] = useState<Row[]>([]);
  const [config, setConfig] = useState<Row>({});
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [editor, setEditor] = useState(false);
  const [resourceEditor, setResourceEditor] = useState(false);
  const [form] = Form.useForm();
  async function session() {
    try {
      setUser(await serviceRequest<SessionUser>("/api/session"));
    } catch {
      setUser(null);
      setData([]);
    } finally {
      setReady(true);
    }
  }
  useEffect(() => {
    void session();
    const timer = setInterval(() => void session(), 15000);
    return () => clearInterval(timer);
  }, []);
  async function load() {
    if (!user) return;
    setLoading(true);
    setError("");
    setData([]);
    try {
      if (page === "users") {
        const result = await unwrap(
          auth.admin.listUsers({ query: { limit: 100 } }),
        );
        setData(result.users as unknown as Row[]);
      } else if (page === "auth-audit") {
        const result = await serviceRequest<{ entries: Row[] }>(
          "/api/auth/admin/audit-logs?limit=100",
        );
        setData(result.entries);
      } else if (page === "ai-config")
        setConfig(await serviceRequest<Row>("/v1/admin/ai-config"));
      else setData(await serviceRequest<Row[]>(`/v1/admin/${page}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, [page, user?.userId]);
  async function act(fn: () => Promise<unknown>) {
    try {
      await fn();
      message.success("已保存");
      await load();
    } catch (e) {
      message.error(e instanceof Error ? e.message : "操作失败");
    }
  }
  if (!ready) return <p>正在验证身份…</p>;
  if (!user)
    return (
      <main
        style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}
      >
        <Card title="登录管理后台" style={{ width: 400 }}>
          {error && <Alert type="error" title={error} />}
          <Form
            layout="vertical"
            onFinish={async (values) => {
              setError("");
              try {
                await unwrap(auth.signIn.email(values));
                await session();
              } catch (e) {
                setError(e instanceof Error ? e.message : "登录失败");
              }
            }}
          >
            <Form.Item
              label="邮箱"
              name="email"
              rules={[{ required: true, type: "email" }]}
            >
              <Input autoComplete="username" />
            </Form.Item>
            <Form.Item
              label="密码"
              name="password"
              rules={[{ required: true }]}
            >
              <Input.Password autoComplete="current-password" />
            </Form.Item>
            <Button type="primary" htmlType="submit" block>
              登录
            </Button>
          </Form>
        </Card>
      </main>
    );
  if (!user.role.split(",").includes("admin"))
    return (
      <Card title="无管理权限">
        <p>当前账号：{user.email}</p>
        <Button
          onClick={() =>
            void act(async () => {
              await auth.signOut();
              await session();
            })
          }
        >
          退出登录
        </Button>
      </Card>
    );
  const text = (value: unknown) =>
    typeof value === "object" ? JSON.stringify(value) : String(value ?? "—");
  const keys =
    page === "users"
      ? ["name", "email", "role", "banned"]
      : page === "devices"
        ? ["name", "platform", "ownerId", "revoked", "lastSeenAt"]
        : page === "resources"
          ? ["name", "type", "version", "published"]
          : page === "tasks"
            ? ["ownerId", "stage", "status", "script", "error"]
            : ["actorId", "action", "targetId", "status", "createdAt"];
  const labels: Record<string, string> = {
    name: "名称",
    email: "邮箱",
    role: "角色",
    banned: "封禁",
    platform: "系统",
    ownerId: "归属用户",
    revoked: "已解绑",
    lastSeenAt: "最近在线",
    type: "类型",
    version: "版本",
    published: "已发布",
    stage: "阶段",
    status: "状态",
    script: "文案",
    error: "诊断",
    actorId: "操作人",
    action: "动作",
    targetId: "目标",
    createdAt: "时间",
  };
  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Layout.Sider theme="light" width={220}>
        <h2 style={{ padding: 20 }}>KeAgent 管理后台</h2>
        <Menu
          selectedKeys={[page]}
          items={pages}
          onClick={({ key }) => setPage(key)}
        />
      </Layout.Sider>
      <Layout>
        <Layout.Header
          style={{
            background: "white",
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <span>云端管理 · {user.email}</span>
          <Button
            onClick={() =>
              void act(async () => {
                await unwrap(auth.signOut());
                await session();
              })
            }
          >
            退出登录
          </Button>
        </Layout.Header>
        <Layout.Content style={{ padding: 28 }}>
          <h1>{pages.find((p) => p.key === page)?.label}</h1>
          <Space style={{ marginBottom: 20 }}>
            <Button onClick={() => void load()}>刷新</Button>
            {page === "users" && (
              <Button
                type="primary"
                onClick={() => {
                  form.resetFields();
                  setEditor(true);
                }}
              >
                创建用户
              </Button>
            )}
            {page === "resources" && (
              <Button
                type="primary"
                onClick={() => {
                  form.resetFields();
                  setResourceEditor(true);
                }}
              >
                新建资源版本
              </Button>
            )}
          </Space>
          {error && (
            <Alert type="error" title={error} style={{ marginBottom: 16 }} />
          )}
          {page === "ai-config" ? (
            <Card title="服务端 AI 配置">
              <p>
                <Tag color={config.configured ? "green" : "default"}>
                  {config.configured ? "已配置" : "未配置"}
                </Tag>
              </p>
              <p>模型：{text(config.model)}</p>
              <p>接口：{text(config.baseURL)}</p>
              <p>{text(config.note)}</p>
              <Alert
                type="info"
                title="当前支持云端 OpenAI 兼容文案接口。TTS、数字人、本地合成与平台发布尚未接通。"
              />
            </Card>
          ) : (
            <Table<Row>
              rowKey="id"
              loading={loading}
              dataSource={data}
              scroll={{ x: 900 }}
              columns={[
                ...keys.map((key) => ({
                  title: labels[key] || key,
                  key,
                  render: (_: unknown, row: Row) => text(row[key]),
                })),
                ...(page === "users"
                  ? [
                      {
                        title: "操作",
                        key: "actions",
                        render: (_: unknown, row: Row) => (
                          <Space>
                            <Button
                              disabled={row.id === user.userId}
                              danger={!row.banned}
                              onClick={() =>
                                Modal.confirm({
                                  title: row.banned
                                    ? "解除封禁？"
                                    : "封禁用户并撤销会话？",
                                  onOk: () =>
                                    act(() =>
                                      row.banned
                                        ? unwrap(
                                            auth.admin.unbanUser({
                                              userId: String(row.id),
                                            }),
                                          )
                                        : unwrap(
                                            auth.admin.banUser({
                                              userId: String(row.id),
                                              banReason: "管理员停用账号",
                                            }),
                                          ),
                                    ),
                                })
                              }
                            >
                              {row.banned ? "启用" : "停用"}
                            </Button>
                            <Button
                              onClick={() =>
                                void act(() =>
                                  unwrap(
                                    auth.admin.revokeUserSessions({
                                      userId: String(row.id),
                                    }),
                                  ),
                                )
                              }
                            >
                              撤销全部会话
                            </Button>
                          </Space>
                        ),
                      },
                    ]
                  : page === "devices"
                    ? [
                        {
                          title: "操作",
                          key: "actions",
                          render: (_: unknown, row: Row) => (
                            <Button
                              disabled={Boolean(row.revoked)}
                              danger
                              onClick={() =>
                                void act(() =>
                                  serviceRequest("/v1/admin/devices/revoke", {
                                    id: row.id,
                                  }),
                                )
                              }
                            >
                              解绑
                            </Button>
                          ),
                        },
                      ]
                    : page === "resources"
                      ? [
                          {
                            title: "上下架",
                            key: "actions",
                            render: (_: unknown, row: Row) => (
                              <Switch
                                checked={Boolean(row.published)}
                                onChange={(published) =>
                                  void act(() =>
                                    serviceRequest("/v1/admin/resources", {
                                      ...row,
                                      published,
                                    }),
                                  )
                                }
                              />
                            ),
                          },
                        ]
                      : []),
              ]}
            />
          )}
        </Layout.Content>
      </Layout>
      <Modal
        title={editor ? "创建用户" : "新建资源版本"}
        open={editor || resourceEditor}
        onCancel={() => {
          setEditor(false);
          setResourceEditor(false);
        }}
        onOk={() => form.submit()}
        destroyOnHidden
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(values) =>
            void act(async () => {
              if (editor)
                await unwrap(
                  auth.admin.createUser({ ...values, role: "user" }),
                );
              else
                await serviceRequest("/v1/admin/resources", {
                  ...values,
                  description: "",
                  category: "通用",
                  thumbnail: "",
                  compatibleModes: ["voiceover", "avatar"],
                  published: false,
                  sizeMb: 0,
                });
              setEditor(false);
              setResourceEditor(false);
            })
          }
        >
          <Form.Item name="name" label="名称" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          {editor ? (
            <>
              <Form.Item
                name="email"
                label="邮箱"
                rules={[{ required: true, type: "email" }]}
              >
                <Input />
              </Form.Item>
              <Form.Item
                name="password"
                label="初始密码"
                rules={[{ required: true, min: 12 }]}
              >
                <Input.Password />
              </Form.Item>
            </>
          ) : (
            <>
              <Form.Item name="type" label="类型" rules={[{ required: true }]}>
                <Select
                  options={[
                    "video",
                    "style",
                    "cover",
                    "subtitle",
                    "prompt",
                  ].map((value) => ({ value, label: value }))}
                />
              </Form.Item>
              <Form.Item
                name="version"
                label="版本"
                rules={[{ required: true }]}
              >
                <Input />
              </Form.Item>
            </>
          )}
        </Form>
      </Modal>
    </Layout>
  );
}
