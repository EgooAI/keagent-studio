import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Descriptions,
  Drawer,
  Empty,
  Input,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from "antd";
import { Link } from "react-router-dom";
import type { AdminAudit as AuditRecord } from "@keagent/shared-types";
import {
  dateTime,
  listPagination,
  useAdminList,
  useAdminParams,
  userLabel,
} from "./admin-api";
import AdminUserSelect from "./AdminUserSelect";
import { resourceTypeLabels } from "./ResourcesPanel";
import type { ResourceType } from "@keagent/shared-types";

export const auditActionLabels: Record<string, string> = {
  "admin.create-user": "创建用户",
  "admin.ban-user": "停用用户",
  "admin.unban-user": "启用用户",
  "admin.set-user-password": "重置密码",
  "admin.revoke-user-sessions": "强制用户退出",
  "admin.revoke-user-session": "撤销登录会话",
  "admin.set-role": "调整用户角色",
  "admin.update-user": "修改用户资料",
  "admin.remove-user": "删除用户",
  "admin.impersonate-user": "代用户登录",
  "admin.stop-impersonating": "结束代登录",
  "resource.create": "创建模板草稿",
  "resource.update": "编辑模板草稿",
  "resource.publish": "上架模板",
  "resource.unpublish": "下架模板",
  "device.revoke": "解绑设备",
  "ai.save": "保存 AI 服务候选配置",
  "ai.test": "发起 AI 服务测试",
  "ai.test.result": "记录 AI 服务测试结果",
  "ai.activate": "启用 AI 服务配置",
  "ai.rollback": "恢复上一版 AI 服务配置为候选",
  resources: "模板目录变更（旧记录）",
  "devices/revoke": "解绑设备（旧记录）",
};
const statusLabels: Record<string, string> = {
  started: "已开始",
  succeeded: "成功",
  failed: "失败",
};
const detailLabels: Record<string, string> = {
  name: "名称",
  version: "版本",
  type: "模板类型",
  published: "上架状态",
  deviceName: "设备名称",
  ownerId: "归属用户编号",
  reason: "操作原因",
  role: "角色",
  email: "邮箱",
  banReason: "停用原因",
  platform: "设备系统",
  service: "服务",
  result: "结果",
};

function detailValue(key: string, value: string) {
  if (key === "published") return value === "true" ? "已上架" : "未上架";
  if (key === "type")
    return resourceTypeLabels[value as ResourceType] || "其他模板";
  if (key === "platform")
    return (
      (
        {
          win32: "Windows",
          darwin: "macOS",
          linux: "Linux",
          test: "测试设备",
        } as Record<string, string>
      )[value] || "其他系统"
    );
  return value;
}

export default function AdminAudit() {
  const { params, setParams } = useAdminParams();
  const account = params.get("tab") !== "business";
  const query = useAdminList(account ? "auth-audit" : "audit");
  const [detail, setDetail] = useState<AuditRecord | null>(null);
  useEffect(() => setDetail(null), [account]);
  const actions = Object.entries(auditActionLabels).filter(([key]) =>
    account ? key.startsWith("admin.") : !key.startsWith("admin."),
  );
  function changeTab(tab: string) {
    setParams({
      tab,
      q: undefined,
      action: undefined,
      status: undefined,
      actorId: undefined,
      targetId: undefined,
      from: undefined,
      to: undefined,
    });
  }
  const userLink = (user: AuditRecord["actor"], id: string) =>
    user ? (
      <Link to={`/admin/users?userId=${encodeURIComponent(user.id)}`}>
        {userLabel(user)}
      </Link>
    ) : (
      <span title={id}>{id ? "用户不存在" : "系统操作"}</span>
    );
  return (
    <>
      <Tabs
        activeKey={account ? "account" : "business"}
        onChange={changeTab}
        items={[
          { key: "account", label: "账号操作" },
          { key: "business", label: "模板与设备操作" },
        ]}
      />
      <p className="admin-secondary admin-notice">
        {account
          ? "记录管理员的账号管理操作，不包含所有用户的登录历史。同一次操作可能分别记录开始和最终结果。"
          : "这里记录已成功提交的模板与设备变更。旧记录未保存完整动作和对象摘要时，会保留原始编号供核查。"}
      </p>
      <section className="admin-panel" aria-label="操作记录列表">
        <div className="admin-toolbar">
          <Space wrap>
            <Select
              aria-label="操作类型"
              value={params.get("action") || ""}
              style={{ width: 200 }}
              onChange={(action) => setParams({ action })}
              options={[
                { value: "", label: "全部操作" },
                ...actions.map(([value, label]) => ({ value, label })),
              ]}
            />
            {account && (
              <Select
                aria-label="操作结果"
                value={params.get("status") || ""}
                style={{ width: 130 }}
                onChange={(status) => setParams({ status })}
                options={[
                  { value: "", label: "全部结果" },
                  ...Object.entries(statusLabels).map(([value, label]) => ({
                    value,
                    label,
                  })),
                ]}
              />
            )}
            <AdminUserSelect
              label="操作人"
              value={params.get("actorId") || undefined}
              onChange={(actorId) => setParams({ actorId })}
            />
            {account && (
              <AdminUserSelect
                label="操作对象"
                value={params.get("targetId") || undefined}
                onChange={(targetId) => setParams({ targetId })}
              />
            )}
            {!account && (
              <Input.Search
                key={params.get("q") || ""}
                defaultValue={params.get("q") || ""}
                aria-label="搜索操作对象"
                placeholder="搜索模板或设备名称"
                allowClear
                onSearch={(q) => setParams({ q })}
                style={{ width: 240 }}
              />
            )}
            <label className="admin-date-filter">
              开始日期
              <Input
                type="date"
                aria-label="开始日期"
                value={params.get("from")?.slice(0, 10) || ""}
                onChange={(e) =>
                  setParams({
                    from: e.target.value
                      ? `${e.target.value}T00:00:00+08:00`
                      : undefined,
                  })
                }
              />
            </label>
            <label className="admin-date-filter">
              结束日期
              <Input
                type="date"
                aria-label="结束日期"
                value={params.get("to")?.slice(0, 10) || ""}
                onChange={(e) =>
                  setParams({
                    to: e.target.value
                      ? `${e.target.value}T23:59:59.999+08:00`
                      : undefined,
                  })
                }
              />
            </label>
            <Button
              onClick={() =>
                setParams({
                  q: undefined,
                  action: undefined,
                  status: undefined,
                  actorId: undefined,
                  targetId: undefined,
                  from: undefined,
                  to: undefined,
                })
              }
            >
              清除筛选
            </Button>
          </Space>
          <Button
            onClick={() => void query.refetch()}
            loading={query.isFetching}
          >
            刷新
          </Button>
        </div>
        {query.error && (
          <Alert
            className="admin-notice"
            type="error"
            showIcon
            title="操作记录读取失败"
            description={query.error.message}
            action={<Button onClick={() => void query.refetch()}>重试</Button>}
          />
        )}
        <Table<AuditRecord>
          rowKey="id"
          loading={query.isPending && !query.error}
          dataSource={query.data?.items || []}
          scroll={{ x: 1000 }}
          pagination={listPagination(query.data, params, setParams)}
          locale={{
            emptyText: (
              <Empty description="没有符合条件的操作记录。可调整时间范围或清除筛选。" />
            ),
          }}
          columns={[
            {
              title: "时间（北京时间）",
              dataIndex: "createdAt",
              width: 190,
              render: dateTime,
            },
            {
              title: "操作人",
              key: "actor",
              render: (_, r) => userLink(r.actor, r.actorId),
            },
            {
              title: "操作",
              dataIndex: "action",
              render: (action: string) =>
                auditActionLabels[action] || "其他管理操作",
            },
            {
              title: "对象",
              key: "target",
              render: (_, r) =>
                r.target
                  ? userLink(r.target, r.targetId)
                  : r.targetLabel || "对象不可用",
            },
            ...(account
              ? [
                  {
                    title: "结果",
                    key: "status",
                    render: (_: unknown, r: AuditRecord) => (
                      <Tag
                        color={
                          r.status === "failed"
                            ? "red"
                            : r.status === "succeeded"
                              ? "green"
                              : "default"
                        }
                      >
                        {statusLabels[r.status || ""] || "未记录结果"}
                      </Tag>
                    ),
                  },
                ]
              : []),
            {
              title: "详情",
              key: "details",
              width: 85,
              render: (_, r) => (
                <Button size="small" onClick={() => setDetail(r)}>
                  查看
                </Button>
              ),
            },
          ]}
        />
      </section>
      <Drawer
        title="操作记录详情"
        open={!!detail}
        onClose={() => setDetail(null)}
        width={600}
      >
        {detail && (
          <Descriptions
            bordered
            column={1}
            items={[
              {
                key: "time",
                label: "时间（北京时间）",
                children: dateTime(detail.createdAt),
              },
              {
                key: "action",
                label: "操作",
                children: auditActionLabels[detail.action] || "其他管理操作",
              },
              {
                key: "actor",
                label: "操作人",
                children: userLabel(detail.actor, detail.actorId),
              },
              {
                key: "target",
                label: "对象",
                children: detail.targetLabel || "对象不可用",
              },
              {
                key: "targetId",
                label: "对象编号",
                children: (
                  <Typography.Text copyable>
                    {detail.targetId || "未记录"}
                  </Typography.Text>
                ),
              },
              ...(account
                ? [
                    {
                      key: "status",
                      label: "结果",
                      children: statusLabels[detail.status || ""] || "未记录",
                    },
                  ]
                : []),
              ...(detail.reason
                ? [{ key: "reason", label: "原因", children: detail.reason }]
                : []),
              ...Object.entries(detail.details || {}).map(([key, value]) => ({
                key: `detail-${key}`,
                label: detailLabels[key] || "补充说明",
                children: (
                  <span className="admin-prewrap">
                    {detailValue(key, value)}
                  </span>
                ),
              })),
              {
                key: "actionId",
                label: "原始动作标识",
                children: detail.action,
              },
              {
                key: "id",
                label: "记录编号",
                children: (
                  <Typography.Text copyable>{detail.id}</Typography.Text>
                ),
              },
              ...(detail.operationId
                ? [
                    {
                      key: "operationId",
                      label: "关联操作编号",
                      children: (
                        <Typography.Text copyable>
                          {detail.operationId}
                        </Typography.Text>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        )}
      </Drawer>
    </>
  );
}
