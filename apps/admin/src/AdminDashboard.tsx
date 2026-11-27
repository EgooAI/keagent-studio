import { Alert, Button, Empty, Skeleton, Tag } from "antd";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  ArrowUpRight,
  Boxes,
  CheckCircle2,
  CircleAlert,
  Laptop,
  RefreshCw,
  Users,
} from "lucide-react";
import { serviceRequest } from "@keagent/api-client";
import { stageLabels, type AdminOverview } from "@keagent/shared-types";
import { dateTime, userLabel } from "./admin-api";
import {
  AIState,
  bailianSpeechLabel,
  configLabel,
  isBailianSpeech,
  isSpeechService,
  speechUpgradeMessage,
  speechUpgradeTitle,
} from "./AdminAI";

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
  const speechUpgradeRequired = data.services.some(
    (service) => isSpeechService(service) && !isBailianSpeech(service),
  );
  const serviceIssues = data.services.filter(
    (service) =>
      service.state !== "configured" &&
      service.id !== "voice-clone" &&
      service.id !== "opening" &&
      (!isSpeechService(service) || isBailianSpeech(service)),
  );
  const hasFailures = data.failedTasks > 0;
  return (
    <div className="admin-workbench-layout">
      <section className="admin-kpi-grid" aria-label="业务指标">
        <Link className="admin-kpi-card" to="/admin/users">
          <div className="admin-kpi-top">
            <span className="admin-kpi-label">
              <span className="admin-kpi-icon" aria-hidden="true">
                <Users size={16} />
              </span>
              用户账号
            </span>
            <ArrowUpRight
              size={15}
              className="admin-kpi-arrow"
              aria-hidden="true"
            />
          </div>
          <strong className="admin-kpi-value">{data.users}</strong>
        </Link>
        <Link
          className="admin-kpi-card"
          to="/admin/users?tab=devices&revoked=false"
        >
          <div className="admin-kpi-top">
            <span className="admin-kpi-label">
              <span className="admin-kpi-icon" aria-hidden="true">
                <Laptop size={16} />
              </span>
              已绑定设备
            </span>
            <ArrowUpRight
              size={15}
              className="admin-kpi-arrow"
              aria-hidden="true"
            />
          </div>
          <strong className="admin-kpi-value">{data.devices}</strong>
        </Link>
        <Link className="admin-kpi-card" to="/admin/resources?state=published">
          <div className="admin-kpi-top">
            <span className="admin-kpi-label">
              <span
                className="admin-kpi-icon admin-kpi-icon-success"
                aria-hidden="true"
              >
                <Boxes size={16} />
              </span>
              已上架推荐搭配
            </span>
            <ArrowUpRight
              size={15}
              className="admin-kpi-arrow"
              aria-hidden="true"
            />
          </div>
          <strong className="admin-kpi-value">{data.publishedResources}</strong>
        </Link>
        <Link className="admin-kpi-card" to="/admin/tasks?status=failed">
          <div className="admin-kpi-top">
            <span className="admin-kpi-label">
              <span
                className={
                  hasFailures
                    ? "admin-kpi-icon admin-kpi-icon-danger"
                    : "admin-kpi-icon admin-kpi-icon-success"
                }
                aria-hidden="true"
              >
                <AlertTriangle size={16} />
              </span>
              失败任务
            </span>
            <ArrowUpRight
              size={15}
              className="admin-kpi-arrow"
              aria-hidden="true"
            />
          </div>
          <strong
            className={
              hasFailures
                ? "admin-kpi-value admin-kpi-value-danger"
                : "admin-kpi-value"
            }
          >
            {data.failedTasks}
          </strong>
        </Link>
      </section>

      <div className="admin-workbench-grid">
        <section
          className="admin-panel"
          aria-labelledby="admin-workbench-tasks"
        >
          <div
            className={
              hasFailures
                ? "admin-workbench-focus"
                : "admin-workbench-focus admin-workbench-focus-ok"
            }
            aria-labelledby="admin-workbench-focus"
          >
            <span className="admin-workbench-focus-icon" aria-hidden="true">
              {hasFailures ? (
                <CircleAlert size={20} />
              ) : (
                <CheckCircle2 size={20} />
              )}
            </span>
            <div>
              <h2 id="admin-workbench-focus">
                {data.failedTasks} 项任务待排查
              </h2>
              <p>
                {hasFailures
                  ? "先查看失败阶段，再决定下一步。"
                  : "目前没有失败的云端任务。"}
              </p>
            </div>
            <Link
              to="/admin/tasks?status=failed"
              className="admin-focus-action"
            >
              查看任务 <ArrowUpRight size={15} aria-hidden="true" />
            </Link>
          </div>

          <div className="admin-section-heading">
            <h2 id="admin-workbench-tasks">近期失败任务</h2>
            <Button
              size="small"
              icon={<RefreshCw size={14} />}
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
                    <Tag color="red">
                      {stageLabels[row.stage] || "未知阶段"}
                    </Tag>
                    <p className="admin-workbench-error">
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

        <aside className="admin-panel">
          <section aria-labelledby="admin-workbench-ai">
            <div className="admin-section-heading">
              <h2 id="admin-workbench-ai">AI 配置缺项</h2>
              <Link to="/admin/ai">查看 AI 服务</Link>
            </div>
            {speechUpgradeRequired && (
              <Alert
                className="admin-notice"
                type="warning"
                showIcon
                title={speechUpgradeTitle}
                description={speechUpgradeMessage}
              />
            )}
            {serviceIssues.length === 0 && !speechUpgradeRequired ? (
              <div className="admin-health-ok">
                <CheckCircle2 size={18} aria-hidden="true" />
                <p>各项配置已齐全；实际连接和生成结果仍需在业务中验证。</p>
              </div>
            ) : (
              serviceIssues.map((service) => (
                <div key={service.id} className="admin-service-row">
                  <div>
                    <Link
                      to={`/admin/ai?service=${encodeURIComponent(service.id)}`}
                    >
                      <strong>
                        {service.id === "tts"
                          ? bailianSpeechLabel
                          : service.label}
                      </strong>
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
    </div>
  );
}
