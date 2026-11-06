import { useState } from "react";
import {
  Alert,
  App,
  Button,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  Typography,
} from "antd";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { serviceRequest, type SessionUser } from "@keagent/api-client";
import type { AdminDevice, AdminUser } from "@keagent/shared-types";
import {
  auth,
  dateTime,
  listPagination,
  roleLabel,
  unwrap,
  useAdminAction,
  useAdminList,
  useAdminParams,
  userLabel,
} from "./admin-api";
import AdminUserSelect from "./AdminUserSelect";

export default function AdminUsers({
  currentUser,
  pendingExit,
  setPendingExit,
}: {
  currentUser: SessionUser;
  pendingExit: AdminUser | null;
  setPendingExit: (user: AdminUser | null) => void;
}) {
  const { params, setParams } = useAdminParams();
  const tab = params.get("tab") === "devices" ? "devices" : "users";
  return (
    <>
      <Tabs
        activeKey={tab}
        onChange={(key) =>
          setParams({
            tab: key === "devices" ? "devices" : undefined,
            q: undefined,
            role: undefined,
            banned: undefined,
            ownerId: undefined,
            revoked: undefined,
          })
        }
        items={[
          {
            key: "users",
            label: "用户",
            children: (
              <UsersTable
                currentUser={currentUser}
                pendingExit={pendingExit}
                setPendingExit={setPendingExit}
              />
            ),
          },
          { key: "devices", label: "设备", children: <DevicesTable /> },
        ]}
        destroyOnHidden
      />
      <UserDetail />
    </>
  );
}

function UsersTable({
  currentUser,
  pendingExit,
  setPendingExit,
}: {
  currentUser: SessionUser;
  pendingExit: AdminUser | null;
  setPendingExit: (user: AdminUser | null) => void;
}) {
  const { modal, message } = App.useApp();
  const { params, setParams } = useAdminParams();
  const query = useAdminList("users");
  const action = useAdminAction();
  const [createOpen, setCreateOpen] = useState(false);
  const [resetUser, setResetUser] = useState<AdminUser | null>(null);
  const [createForm] = Form.useForm<{
    name: string;
    email: string;
    password: string;
  }>();
  const [passwordForm] = Form.useForm<{ password: string; confirm: string }>();

  function confirmExit(row: AdminUser) {
    modal.confirm({
      title: "强制退出该用户？",
      content: (
        <p>
          {userLabel(row)}{" "}
          的所有登录会话将立即失效，用户需要重新登录。不会删除业务数据。
        </p>
      ),
      okText: "确认强制退出",
      cancelText: "取消",
      okButtonProps: { danger: true },
      onOk: async () => {
        if (
          !(await action.run(
            () => unwrap(auth.admin.revokeUserSessions({ userId: row.id })),
            "已撤销该用户全部登录会话",
          ))
        )
          throw new Error("强制退出失败");
      },
    });
  }
  function toggleUser(row: AdminUser) {
    let reason = "管理员停用账号";
    modal.confirm({
      title: row.banned ? "启用该用户？" : "停用该用户并强制退出？",
      content: (
        <>
          <p>{userLabel(row)}</p>
          <p>
            {row.banned
              ? "启用后，用户可以重新登录使用客户端。"
              : "停用后将阻止登录，并撤销现有会话。用户的房源和制作记录会保留。"}
          </p>
          {!row.banned && (
            <Input
              aria-label="停用原因"
              defaultValue={reason}
              maxLength={200}
              onChange={(event) => {
                reason = event.target.value;
              }}
            />
          )}
        </>
      ),
      okText: row.banned ? "确认启用" : "确认停用",
      cancelText: "取消",
      okButtonProps: { danger: !row.banned },
      onOk: async () => {
        if (!row.banned && !reason.trim()) {
          message.error("请填写停用原因");
          throw new Error("缺少停用原因");
        }
        if (
          !(await action.run(
            () =>
              row.banned
                ? unwrap(auth.admin.unbanUser({ userId: row.id }))
                : unwrap(
                    auth.admin.banUser({
                      userId: row.id,
                      banReason: reason.trim(),
                    }),
                  ),
            row.banned ? "用户已启用" : "用户已停用，登录会话已撤销",
          ))
        )
          throw new Error("账号状态更新失败");
      },
    });
  }
  async function resetPassword() {
    if (!resetUser) return;
    let values;
    try {
      values = await passwordForm.validateFields();
    } catch {
      return;
    }
    let changed = false;
    const success = await action.run(async () => {
      await unwrap(
        auth.admin.setUserPassword({
          userId: resetUser.id,
          newPassword: values.password,
        }),
      );
      changed = true;
      passwordForm.resetFields();
      await unwrap(auth.admin.revokeUserSessions({ userId: resetUser.id }));
    }, "密码已重置，全部登录会话已撤销");
    if (success) {
      setResetUser(null);
      setPendingExit(null);
    } else if (changed) {
      setPendingExit(resetUser);
      setResetUser(null);
    }
  }
  return (
    <section className="admin-panel">
      <div className="admin-toolbar">
        <Space wrap>
          <Input.Search
            key={params.get("q") || ""}
            aria-label="搜索用户"
            placeholder="搜索姓名或邮箱"
            defaultValue={params.get("q") || ""}
            onSearch={(q) => setParams({ q: q || undefined })}
            allowClear
            style={{ width: 260 }}
          />
          <Select
            aria-label="用户角色"
            placeholder="全部角色"
            value={params.get("role") || undefined}
            onChange={(role) => setParams({ role })}
            allowClear
            style={{ width: 140 }}
            options={[
              { value: "user", label: "普通用户" },
              { value: "admin", label: "管理员" },
            ]}
          />
          <Select
            aria-label="账号状态"
            placeholder="全部状态"
            value={params.get("banned") || undefined}
            onChange={(banned) => setParams({ banned })}
            allowClear
            style={{ width: 140 }}
            options={[
              { value: "false", label: "正常" },
              { value: "true", label: "已停用" },
            ]}
          />
        </Space>
        <Space>
          <Button
            loading={query.isFetching}
            onClick={() => void query.refetch()}
          >
            刷新列表
          </Button>
          <Button
            type="primary"
            onClick={() => {
              createForm.resetFields();
              setCreateOpen(true);
            }}
          >
            创建用户
          </Button>
        </Space>
      </div>
      <p className="admin-secondary admin-list-description">
        账号由管理员开通。停用和强制退出会立即影响用户登录，不删除房源或制作记录。
      </p>
      {query.error && (
        <Alert
          className="admin-block"
          type="error"
          showIcon
          title="用户列表加载失败"
          description={query.error.message}
          action={<Button onClick={() => void query.refetch()}>重试</Button>}
        />
      )}
      <Table<AdminUser>
        rowKey="id"
        loading={query.isPending || query.isFetching}
        dataSource={query.data?.items || []}
        pagination={listPagination(query.data, params, setParams)}
        scroll={{ x: 1050 }}
        locale={{ emptyText: <Empty description="没有符合条件的用户" /> }}
        columns={[
          {
            title: "用户",
            key: "user",
            width: 260,
            render: (_, row) => (
              <>
                <Button
                  type="link"
                  className="admin-cell-link"
                  onClick={() => setParams({ userId: row.id }, false)}
                >
                  {row.name || "未命名用户"}
                </Button>
                <p className="admin-secondary">{row.email}</p>
                {row.id === currentUser.userId && (
                  <>
                    <Tag>当前账号</Tag>
                    <p className="admin-secondary">
                      不能在此停用、重置密码或强制退出自己。
                    </p>
                  </>
                )}
              </>
            ),
          },
          { title: "角色", dataIndex: "role", render: roleLabel },
          {
            title: "账号状态",
            key: "state",
            render: (_, row) => (
              <Tag color={row.banned ? "default" : "green"}>
                {row.banned ? "已停用" : "正常"}
              </Tag>
            ),
          },
          { title: "创建时间", dataIndex: "createdAt", render: dateTime },
          {
            title: "操作",
            key: "actions",
            width: 340,
            render: (_, row) => (
              <Space wrap size={0}>
                <Button
                  type="link"
                  disabled={action.busy || row.id === currentUser.userId}
                  danger={!row.banned}
                  onClick={() => toggleUser(row)}
                >
                  {row.banned ? "启用" : "停用"}
                </Button>
                <Button
                  type="link"
                  disabled={
                    action.busy ||
                    row.id === currentUser.userId ||
                    !!pendingExit
                  }
                  onClick={() => {
                    passwordForm.resetFields();
                    setResetUser(row);
                  }}
                >
                  重置密码
                </Button>
                <Button
                  type="link"
                  disabled={action.busy || row.id === currentUser.userId}
                  onClick={() => confirmExit(row)}
                >
                  强制退出
                </Button>
              </Space>
            ),
          },
        ]}
      />
      <Modal
        title="创建普通用户"
        open={createOpen}
        onCancel={() => {
          if (!action.busy) {
            setCreateOpen(false);
            createForm.resetFields();
          }
        }}
        onOk={() => createForm.submit()}
        okText="确认创建"
        cancelText="取消"
        confirmLoading={action.busy}
        destroyOnHidden
      >
        <p className="admin-secondary">
          开通后，用户使用邮箱和初始密码登录客户端。新账号的角色为普通用户。
        </p>
        <Form
          form={createForm}
          layout="vertical"
          className="admin-block"
          onFinish={async (values) => {
            if (
              await action.run(
                () =>
                  unwrap(
                    auth.admin.createUser({
                      ...values,
                      name: values.name.trim(),
                      email: values.email.trim(),
                      role: "user",
                    }),
                  ),
                "用户已创建",
              )
            ) {
              setCreateOpen(false);
              createForm.resetFields();
            }
          }}
        >
          <Form.Item
            name="name"
            label="用户姓名"
            rules={[
              { required: true, whitespace: true, message: "请输入用户姓名" },
              { max: 60 },
            ]}
          >
            <Input autoComplete="off" />
          </Form.Item>
          <Form.Item
            name="email"
            label="登录邮箱"
            rules={[
              { required: true, type: "email", message: "请输入有效邮箱" },
            ]}
          >
            <Input autoComplete="off" />
          </Form.Item>
          <Form.Item
            name="password"
            label="初始密码"
            rules={[
              { required: true, message: "请输入初始密码" },
              { min: 12, message: "至少 12 个字符" },
            ]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title="重置密码并强制退出"
        open={!!resetUser}
        onCancel={() => {
          if (!action.busy) {
            setResetUser(null);
            passwordForm.resetFields();
          }
        }}
        onOk={() => void resetPassword()}
        okText="确认重置并强制退出"
        cancelText="取消"
        confirmLoading={action.busy}
        destroyOnHidden
      >
        <p>{resetUser ? userLabel(resetUser) : ""}</p>
        <Alert
          type="warning"
          showIcon
          title="新密码将立即生效"
          description="随后撤销该用户的全部登录会话，用户需要使用新密码重新登录。"
        />
        <Form form={passwordForm} layout="vertical" className="admin-block">
          <Form.Item
            name="password"
            label="新密码"
            rules={[
              { required: true, message: "请输入新密码" },
              { min: 12, message: "至少 12 个字符" },
            ]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item
            name="confirm"
            label="确认新密码"
            dependencies={["password"]}
            rules={[
              { required: true, message: "请再次输入新密码" },
              ({ getFieldValue }) => ({
                validator: (_, value) =>
                  !value || getFieldValue("password") === value
                    ? Promise.resolve()
                    : Promise.reject(new Error("两次密码不一致")),
              }),
            ]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>
    </section>
  );
}

function DevicesTable() {
  const { modal } = App.useApp();
  const { params, setParams } = useAdminParams();
  const query = useAdminList("devices");
  const action = useAdminAction();
  return (
    <section className="admin-panel">
      <div className="admin-toolbar">
        <Space wrap>
          <Input.Search
            key={params.get("q") || ""}
            aria-label="搜索设备"
            placeholder="搜索设备或用户姓名、邮箱"
            defaultValue={params.get("q") || ""}
            onSearch={(q) => setParams({ q: q || undefined })}
            allowClear
            style={{ width: 280 }}
          />
          <Select
            aria-label="设备绑定状态"
            placeholder="全部绑定状态"
            value={params.get("revoked") || undefined}
            onChange={(revoked) => setParams({ revoked })}
            allowClear
            style={{ width: 155 }}
            options={[
              { value: "false", label: "已绑定" },
              { value: "true", label: "已解绑" },
            ]}
          />
          <AdminUserSelect
            value={params.get("ownerId") || undefined}
            onChange={(ownerId) => setParams({ ownerId })}
            label="所属用户"
          />
        </Space>
        <Button loading={query.isFetching} onClick={() => void query.refetch()}>
          刷新列表
        </Button>
      </div>
      <p className="admin-secondary admin-list-description">
        最近活动为设备最后一次上报时间。解绑后该设备的后续业务请求会被拒绝，不会删除用户电脑上的文件。
      </p>
      {query.error && (
        <Alert
          className="admin-block"
          type="error"
          showIcon
          title="设备列表加载失败"
          description={query.error.message}
          action={<Button onClick={() => void query.refetch()}>重试</Button>}
        />
      )}
      <Table<AdminDevice>
        rowKey="id"
        loading={query.isPending || query.isFetching}
        dataSource={query.data?.items || []}
        pagination={listPagination(query.data, params, setParams)}
        scroll={{ x: 950 }}
        locale={{ emptyText: <Empty description="没有符合条件的设备" /> }}
        columns={[
          {
            title: "设备名称",
            dataIndex: "name",
            render: (value) => value || "未命名设备",
          },
          {
            title: "所属用户",
            key: "owner",
            render: (_, row) => (
              <Button
                type="link"
                className="admin-cell-link"
                onClick={() => setParams({ userId: row.ownerId }, false)}
              >
                {userLabel(row.owner, row.ownerId)}
              </Button>
            ),
          },
          {
            title: "操作系统",
            dataIndex: "platform",
            render: (value: string) =>
              ({
                win32: "Windows",
                darwin: "macOS",
                linux: "Linux",
                web: "浏览器",
                test: "测试设备",
              })[value] || (value ? "其他系统" : "未记录"),
          },
          {
            title: "绑定状态",
            key: "state",
            render: (_, row) => (
              <Tag color={row.revoked ? "default" : "green"}>
                {row.revoked ? "已解绑" : "已绑定"}
              </Tag>
            ),
          },
          { title: "最近活动", dataIndex: "lastSeenAt", render: dateTime },
          {
            title: "操作",
            key: "action",
            render: (_, row) => (
              <Button
                danger
                disabled={row.revoked || action.busy}
                onClick={() =>
                  modal.confirm({
                    title: "解绑该设备？",
                    content: (
                      <>
                        <p>
                          {row.name || "未命名设备"} ·{" "}
                          {userLabel(row.owner, row.ownerId)}
                        </p>
                        <p>
                          解绑会阻止该设备后续访问业务服务，不会删除本机文件。此处不提供重新绑定操作。
                        </p>
                      </>
                    ),
                    okText: "确认解绑",
                    cancelText: "取消",
                    okButtonProps: { danger: true },
                    onOk: async () => {
                      if (
                        !(await action.run(
                          () =>
                            serviceRequest("/v1/admin/devices/revoke", {
                              id: row.id,
                            }),
                          "设备已解绑",
                        ))
                      )
                        throw new Error("解绑失败");
                    },
                  })
                }
              >
                解绑设备
              </Button>
            ),
          },
        ]}
      />
    </section>
  );
}

function UserDetail() {
  const { params, setParams } = useAdminParams();
  const userId = params.get("userId") || "";
  const query = useQuery({
    queryKey: ["admin", "user", userId],
    enabled: !!userId,
    queryFn: () => unwrap(auth.admin.getUser({ query: { id: userId } })),
  });
  const user = query.data;
  return (
    <Drawer
      title="用户详情"
      width={580}
      open={!!userId}
      onClose={() => setParams({ userId: undefined }, false)}
    >
      {query.isPending && <Spin tip="正在读取用户…" />}
      {query.error && (
        <Alert
          type="error"
          showIcon
          title="无法读取用户详情"
          description={query.error.message}
          action={<Button onClick={() => void query.refetch()}>重试</Button>}
        />
      )}
      {user && (
        <>
          <Descriptions
            bordered
            column={1}
            size="small"
            items={[
              {
                key: "name",
                label: "用户姓名",
                children: user.name || "未命名用户",
              },
              { key: "email", label: "登录邮箱", children: user.email },
              {
                key: "role",
                label: "角色",
                children: roleLabel(user.role || "user"),
              },
              {
                key: "state",
                label: "账号状态",
                children: user.banned ? "已停用" : "正常",
              },
              ...(user.banned
                ? [
                    {
                      key: "reason",
                      label: "停用原因",
                      children: user.banReason || "未记录原因",
                    },
                  ]
                : []),
              {
                key: "created",
                label: "创建时间",
                children: dateTime(String(user.createdAt)),
              },
              {
                key: "id",
                label: "用户编号",
                children: <Typography.Text copyable>{user.id}</Typography.Text>,
              },
            ]}
          />
          <h3 className="admin-detail-heading">关联记录</h3>
          <Space wrap>
            <Link
              to={`/admin/users?tab=devices&ownerId=${encodeURIComponent(user.id)}`}
            >
              <Button>查看该用户设备</Button>
            </Link>
            <Link to={`/admin/tasks?ownerId=${encodeURIComponent(user.id)}`}>
              <Button>查看该用户任务</Button>
            </Link>
            <Link
              to={`/admin/audit?tab=account&targetId=${encodeURIComponent(user.id)}`}
            >
              <Button>查看账号操作记录</Button>
            </Link>
          </Space>
          <p className="admin-secondary admin-block">
            仅展示账号资料，不显示登录凭据。账号操作请在用户列表中执行。
          </p>
        </>
      )}
    </Drawer>
  );
}
