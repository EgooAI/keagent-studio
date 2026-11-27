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
import { RefreshCw } from "lucide-react";
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
  "resource.delete": "删除模板",
  "device.revoke": "解绑设备",
  "credit.grant": "积分发放",
  "credit.adjust": "积分调整",
  "credit.settle.capture": "积分对账（确认扣费）",
  "credit.settle.release": "积分对账（退款）",
  "credit.code.create": "生成兑换码",
  "credit.packs.update": "修改试点积分包",
  "credit.provider-rate.update": "修改供应商成本费率",
  "credit.lead_trial.update": "修改 AI 获客试用额度",
  "credit.pricing.update": "修改积分价目",
  "credit.welcome.update": "修改欢迎赠送配置",
  "ai.save": "保存 AI 服务配置",
  "ai.test": "发起 AI 服务测试",
  "ai.verify-enable": "验证并启用 AI 服务配置",
  "ai.test.result": "记录 AI 服务测试结果",
  "ai.activate": "启用 AI 服务配置",
  "ai.rollback": "恢复上一版 AI 服务配置为候选",
  resources: "模板目录变更（旧记录）",
  "devices/revoke": "解绑设备（旧记录）",
};
const sensitiveActions = new Set([
  "admin.ban-user",
  "admin.set-user-password",
  "admin.revoke-user-sessions",
  "admin.remove-user",
  "device.revoke",
  "resource.delete",
]);
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
    return (
      resourceTypeLabels[value as keyof typeof resourceTypeLabels] || "其他模板"
    );
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
          { key: "business", label: "业务操作" },
        ]}
      />
      <section
        className="admin-panel admin-table-panel"
        aria-labelledby="admin-audit-list"
      >
        <div className="admin-section-heading">
          <div>
            <h2 id="admin-audit-list">记录列表</h2>
            <p className="admin-secondary">
              {account
                ? "记录管理员的账号管理操作，不包含所有用户的登录历史。同一次操作可能分别记录开始和最终结果。"
                : "这里记录模板变更、设备解绑和 AI 服务管理操作。旧记录可能仅保留原始编号。"}
            </p>
          </div>
          <Button
            icon={<RefreshCw size={14} />}
            onClick={() => void query.refetch()}
            loading={query.isFetching}
          >
            刷新
          </Button>
        </div>
        <div className="admin-filter-strip">
          <Space wrap size={[10, 10]}>
            <Select
              aria-label="操作类型"
              value={params.get("action") || ""}
              style={{ width: 195 }}
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
                style={{ width: 124 }}
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
                placeholder="搜索操作对象"
                allowClear
                onSearch={(q) => setParams({ q })}
                style={{ width: 220 }}
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
              width: 185,
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
              render: (action: string) => (
                <Tag
                  color={sensitiveActions.has(action) ? "orange" : "default"}
                >
                  {auditActionLabels[action] || "其他管理操作"}
                </Tag>
              ),
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
                    width: 100,
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
              align: "right",
              render: (_, r) => (
                <Button
                  type="link"
                  className="admin-row-actions"
                  onClick={() => setDetail(r)}
                >
                  查看
                </Button>
              ),
            },
          ]}
        />
      </section>
      <Drawer
        rootClassName="admin-detail-drawer"
        title="操作记录详情"
        open={!!detail}
        onClose={() => setDetail(null)}
        width={600}
      >
        {detail && (
          <>
            <div className="admin-detail-summary">
              <strong>
                {auditActionLabels[detail.action] || "其他管理操作"}
              </strong>
              {account && (
                <Tag
                  color={
                    detail.status === "failed"
                      ? "red"
                      : detail.status === "succeeded"
                        ? "green"
                        : "default"
                  }
                >
                  {statusLabels[detail.status || ""] || "未记录"}
                </Tag>
              )}
              <span className="admin-secondary" style={{ margin: 0 }}>
                {dateTime(detail.createdAt)}
              </span>
            </div>
            <Descriptions
              bordered
              size="small"
              column={1}
              items={[
                {
                  key: "time",
                  label: "时间（北京时间）",
                  children: dateTime(detail.createdAt),
                },
                {
                  key: "actor",
                  label: "操作人",
                  children: userLabel(detail.actor, detail.actorId),
                },
                {
                  key: "action",
                  label: "操作",
                  children: auditActionLabels[detail.action] || "其他管理操作",
                },
                {
                  key: "target",
                  label: "对象",
                  children: detail.targetLabel || "对象不可用",
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
                {
                  key: "targetId",
                  label: "对象编号",
                  children: (
                    <Typography.Text copyable>
                      {detail.targetId || "未记录"}
                    </Typography.Text>
                  ),
                },
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
                  children: <code className="admin-code">{detail.action}</code>,
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
          </>
        )}
      </Drawer>
    </>
  );
}
