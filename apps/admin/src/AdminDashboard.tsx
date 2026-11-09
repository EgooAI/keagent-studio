import { Alert, Button, Empty, Spin, Table, Tag } from "antd";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { serviceRequest } from "@keagent/api-client";
import {
  stageLabels,
  statusLabels,
  type AdminOverview,
  type AdminTaskSummary,
} from "@keagent/shared-types";
import { dateTime, userLabel } from "./admin-api";
import { AIState, configLabel } from "./AdminAI";

export default function AdminDashboard() {
  const query = useQuery({
    queryKey: ["admin", "overview"],
    queryFn: () => serviceRequest<AdminOverview>("/v1/admin/overview"),
  });
  if (query.isPending)
    return (
      <div className="admin-loading">
        <Spin tip="正在汇总管理数据…" />
      </div>
    );
  if (query.error)
    return (
      <Alert
        type="error"
        showIcon
        title="概览数据加载失败"
        description={query.error.message}
        action={<Button onClick={() => void query.refetch()}>重试</Button>}
      />
    );
  const data = query.data;
  if (!data) return null;
  return (
    <>
      <div className="admin-toolbar">
        <p className="admin-secondary">
          以下为云端真实记录，点击数量进入对应列表。
        </p>
        <Button loading={query.isFetching} onClick={() => void query.refetch()}>
          刷新概览
        </Button>
      </div>
      <div className="admin-overview-counts">
        <Link to="/admin/users">
          <span>用户账号</span>
          <strong>{data.users}</strong>
          <small>查看账号与登录状态</small>
        </Link>
        <Link to="/admin/users?tab=devices&revoked=false">
          <span>已绑定设备</span>
          <strong>{data.devices}</strong>
          <small>查看设备与最近活动</small>
        </Link>
        <Link to="/admin/resources?state=published">
          <span>已上架模板</span>
          <strong>{data.publishedResources}</strong>
          <small>用户可选的公共目录</small>
        </Link>
        <Link to="/admin/tasks?status=failed">
          <span>失败任务</span>
          <strong>{data.failedTasks}</strong>
          <small>需要进一步排查</small>
        </Link>
      </div>
      <section className="admin-panel">
        <div className="admin-section-heading">
          <h2>优先排查的失败任务</h2>
          <Link to="/admin/tasks?status=failed">查看全部失败任务</Link>
        </div>
        <Table<AdminTaskSummary>
          rowKey="id"
          dataSource={data.recentFailedTasks}
          pagination={false}
          scroll={{ x: 850 }}
          locale={{ emptyText: <Empty description="暂无失败任务" /> }}
          columns={[
            {
              title: "任务与房源",
              key: "property",
              render: (_, row) => (
                <>
                  <Link
                    to={`/admin/tasks?taskId=${encodeURIComponent(row.id)}`}
                  >
                    {row.propertyTitle ||
                      row.propertyNumber ||
                      "房源信息不可用"}
                  </Link>
                  <p className="admin-secondary">
                    {row.propertyNumber || "未记录房源号"}
                  </p>
                </>
              ),
            },
            {
              title: "所属用户",
              key: "owner",
              render: (_, row) => (
                <Link
                  to={`/admin/users?userId=${encodeURIComponent(row.ownerId)}`}
                >
                  {userLabel(row.owner, row.ownerId)}
                </Link>
              ),
            },
            {
              title: "当前阶段",
              key: "stage",
              render: (_, row) => stageLabels[row.stage] || "未知阶段",
            },
            {
              title: "状态",
              key: "status",
              render: (_, row) => (
                <Tag color="red">{statusLabels[row.status] || "未知状态"}</Tag>
              ),
            },
            {
              title: "失败原因",
              dataIndex: "error",
              ellipsis: true,
              render: (value) => value || "尚未提供诊断",
            },
            { title: "创建时间", dataIndex: "createdAt", render: dateTime },
          ]}
        />
      </section>
      <section className="admin-panel admin-block">
        <div className="admin-section-heading">
          <h2>AI 配置缺项</h2>
          <Link to="/admin/ai">查看所有 AI 服务</Link>
        </div>
        {data.services.filter((service) => service.state !== "configured")
          .length === 0 ? (
          <p className="admin-secondary">
            各项配置已齐全；实际连接和生成结果仍需在业务中验证。
          </p>
        ) : (
          data.services
            .filter((service) => service.state !== "configured")
            .map((service) => (
              <div key={service.id} className="admin-service-row">
                <div>
                  <Link
                    to={`/admin/ai?service=${encodeURIComponent(service.id)}`}
                  >
                    <strong>{service.label}</strong>
                  </Link>
                  <p className="admin-secondary">
                    {[
                      ...service.missing.map(configLabel),
                      ...service.issues,
                    ].join("；") || service.note}
                  </p>
                </div>
                <AIState state={service.state} />
              </div>
            ))
        )}
      </section>
      <p className="admin-secondary admin-block">
        任务统计仅包含云端生产任务。本机全景制作、安装包分发与远程功能开关尚未接入本后台。
      </p>
    </>
  );
}
