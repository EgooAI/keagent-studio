import { Alert, Button, Empty, Skeleton } from "antd";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ArrowUpRight, CircleAlert } from "lucide-react";
import { serviceRequest } from "@keagent/api-client";
import { stageLabels, type AdminOverview } from "@keagent/shared-types";
import { dateTime, userLabel } from "./admin-api";
import { AIState, configLabel } from "./AdminAI";

export default function AdminDashboard() {
  const query = useQuery({
    queryKey: ["admin", "overview"],
    queryFn: () => serviceRequest<AdminOverview>("/v1/admin/overview"),
  });
  if (query.isPending)
    return (
      <section
        className="admin-panel"
        aria-label="正在汇总管理数据"
        aria-busy="true"
      >
        <Skeleton active paragraph={{ rows: 4 }} />
      </section>
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
  const serviceIssues = data.services.filter(
    (service) => service.state !== "configured",
  );
  return (
    <div className="admin-workbench-grid">
      <div className="admin-workbench-primary">
        <section
          className="admin-workbench-focus"
          aria-labelledby="admin-workbench-focus"
        >
          <CircleAlert size={22} aria-hidden="true" />
          <div>
            <h2 id="admin-workbench-focus">{data.failedTasks} 项任务待排查</h2>
            <p>
              {data.failedTasks
                ? "先查看失败阶段，再决定下一步。"
                : "目前没有失败的云端任务。"}
            </p>
          </div>
          <Link to="/admin/tasks?status=failed" className="admin-focus-action">
            查看任务 <ArrowUpRight size={16} aria-hidden="true" />
          </Link>
        </section>
        <section
          className="admin-workbench-queue"
          aria-labelledby="admin-workbench-tasks"
        >
          <div className="admin-section-heading">
            <h2 id="admin-workbench-tasks">近期失败任务</h2>
            <Button
              loading={query.isFetching}
              onClick={() => void query.refetch()}
            >
              刷新概览
            </Button>
          </div>
          {data.recentFailedTasks.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="暂无失败任务"
            />
          ) : (
            <ul className="admin-workbench-rows">
              {data.recentFailedTasks.map((row) => (
                <li key={row.id}>
                  <div>
                    <Link
                      className="admin-workbench-task"
                      to={"/admin/tasks?taskId=" + encodeURIComponent(row.id)}
                    >
                      {row.propertyTitle ||
                        row.propertyNumber ||
                        "房源信息不可用"}
                    </Link>
                    <p className="admin-secondary">
                      {row.propertyNumber || "未记录房源号"}
                    </p>
                  </div>
                  <div>
                    <strong>{stageLabels[row.stage] || "未知阶段"}</strong>
                    <p className="admin-secondary">
                      {row.error || "尚未提供诊断"}
                    </p>
                  </div>
                  <div>
                    <Link
                      to={
                        "/admin/users?userId=" + encodeURIComponent(row.ownerId)
                      }
                    >
                      {userLabel(row.owner, row.ownerId)}
                    </Link>
                    <p className="admin-secondary">{dateTime(row.createdAt)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <aside className="admin-workbench-sidebar">
        <h2>运营概况</h2>
        <section className="admin-workbench-metrics" aria-label="业务指标">
          <Link to="/admin/users">
            <span className="admin-metric-label">
              用户账号
              <ArrowUpRight size={16} aria-hidden="true" />
            </span>
            <strong>{data.users}</strong>
          </Link>
          <Link to="/admin/users?tab=devices&revoked=false">
            <span className="admin-metric-label">
              已绑定设备
              <ArrowUpRight size={16} aria-hidden="true" />
            </span>
            <strong>{data.devices}</strong>
          </Link>
          <Link to="/admin/resources?state=published">
            <span className="admin-metric-label">
              已上架模板
              <ArrowUpRight size={16} aria-hidden="true" />
            </span>
            <strong>{data.publishedResources}</strong>
          </Link>
          <Link to="/admin/tasks?status=failed">
            <span className="admin-metric-label">
              失败任务
              <ArrowUpRight size={16} aria-hidden="true" />
            </span>
            <strong
              className={
                data.failedTasks ? "admin-metric-attention" : undefined
              }
            >
              {data.failedTasks}
            </strong>
          </Link>
        </section>
        <section
          className="admin-workbench-health"
          aria-labelledby="admin-workbench-ai"
        >
          <div className="admin-section-heading">
            <h2 id="admin-workbench-ai">AI 配置缺项</h2>
            <Link to="/admin/ai">查看 AI 服务</Link>
          </div>
          {serviceIssues.length === 0 ? (
            <p className="admin-secondary">
              各项配置已齐全；实际连接和生成结果仍需在业务中验证。
            </p>
          ) : (
            serviceIssues.map((service) => (
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
      </aside>
    </div>
  );
}
