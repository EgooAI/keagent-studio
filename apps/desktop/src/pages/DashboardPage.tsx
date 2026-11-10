import { Button, Empty, Space, Table } from "antd";
import { ArrowUpRight, Plus } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import type { ProductionTask } from "@keagent/shared-types";
import { stageLabels } from "@keagent/shared-types";
import { PageHeader, StatusTag } from "../components/common";
import { useWorkspace } from "../lib/workspace";

export default function DashboardPage() {
  const { data } = useWorkspace();
  const navigate = useNavigate();
  if (!data) return null;
  const pending = data.tasks.filter(
    (task) => task.status === "awaiting_review",
  );
  const finished = data.tasks.filter((task) => task.status === "succeeded");
  const unpublished = finished.filter(
    (task) =>
      !data.publishTasks.some((item) => item.productionTaskId === task.id),
  );
  const active = data.tasks.filter(
    (task) => task.status === "running" || task.status === "queued",
  );
  const recent = [...data.tasks]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 6);

  return (
    <>
      <PageHeader
        title={`${data.profile.name}的创作工作台`}
        description="查看制作进度，处理审核与发布待办。"
        actions={
          <Button
            type="primary"
            icon={<Plus size={16} />}
            onClick={() => navigate("/studio/create")}
          >
            创建 AI 视频
          </Button>
        }
      />
      <div className="dashboard-workspace">
        <section className="panel dashboard-todos">
          <div className="section-heading">
            <h2>需要你处理</h2>
            <span className="muted">
              {pending.length} 条待审核 · {unpublished.length} 条待发布
            </span>
          </div>
          {pending.length === 0 && unpublished.length === 0 ? (
            <div className="dashboard-clear">
              <h3>当前没有待办</h3>
              <p className="muted">可以添加房源，或开始制作下一批视频。</p>
            </div>
          ) : (
            <div className="dashboard-todo-list">
              {[...pending, ...unpublished].slice(0, 4).map((task) => (
                <Link
                  key={task.id}
                  className="dashboard-todo"
                  to={
                    task.status === "awaiting_review"
                      ? `/studio/tasks/${task.id}/review`
                      : `/publish/${task.id}`
                  }
                >
                  <div>
                    <strong>{task.propertySnapshot.community}</strong>
                    <small>
                      {task.status === "awaiting_review"
                        ? "文案待确认，审核后继续制作"
                        : "成片已完成，可以安排发布"}
                    </small>
                  </div>
                  <span>
                    {task.status === "awaiting_review"
                      ? "审核文案"
                      : "查看成片"}
                    <ArrowUpRight size={15} />
                  </span>
                </Link>
              ))}
            </div>
          )}
        </section>
        <aside className="dashboard-overview">
          <h2>工作区概况</h2>
          <dl>
            <div>
              <dt>房源</dt>
              <dd>{data.properties.length} 套</dd>
            </div>
            <div>
              <dt>制作中</dt>
              <dd>{active.length} 条</dd>
            </div>
            <div>
              <dt>已完成</dt>
              <dd>{finished.length} 条</dd>
            </div>
          </dl>
          <Button
            onClick={() => navigate("/properties?import=1")}
            icon={<Plus size={15} />}
          >
            导入房源
          </Button>
          <Link to="/properties">
            查看房源库 <ArrowUpRight size={14} />
          </Link>
        </aside>
      </div>
      <section className="panel" style={{ overflow: "hidden" }}>
        <div
          className="section-heading"
          style={{
            padding: "20px 24px 12px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <h2 style={{ fontSize: 17, margin: 0 }}>最近制作</h2>
          <Button type="text" onClick={() => navigate("/studio")}>
            全部任务 <ArrowUpRight size={14} />
          </Button>
        </div>
        <Table<ProductionTask>
          rowKey="id"
          dataSource={recent}
          pagination={false}
          size="middle"
          locale={{
            emptyText: <Empty description="还没有制作任务，先创建一条视频吧" />,
          }}
          columns={[
            {
              title: "房源",
              key: "property",
              render: (_, task) => (
                <Space>
                  <img
                    src={task.propertySnapshot.image}
                    alt=""
                    style={{
                      width: 62,
                      height: 44,
                      objectFit: "cover",
                      borderRadius: 6,
                    }}
                  />
                  <div>
                    <Link to={`/studio/tasks/${task.id}`}>
                      {task.propertySnapshot.community}
                    </Link>
                    <div style={{ color: "#667085", fontSize: 12 }}>
                      {task.propertySnapshot.layout} ·{" "}
                      {task.propertySnapshot.areaSqm} ㎡
                    </div>
                  </div>
                </Space>
              ),
            },
            {
              title: "视频模式",
              key: "mode",
              render: (_, task) =>
                task.configSnapshot.videoMode === "avatar"
                  ? "经纪人露脸"
                  : "纯口播",
            },
            {
              title: "当前阶段",
              dataIndex: "stage",
              render: (stage: ProductionTask["stage"]) => stageLabels[stage],
            },
            {
              title: "状态",
              dataIndex: "status",
              render: (status: string) => <StatusTag status={status} />,
            },
            {
              title: "操作",
              key: "action",
              align: "right",
              render: (_, task) => (
                <Button
                  type="link"
                  onClick={() =>
                    navigate(
                      task.status === "succeeded"
                        ? `/publish/${task.id}`
                        : `/studio/tasks/${task.id}`,
                    )
                  }
                >
                  {task.status === "awaiting_review"
                    ? "审核文案"
                    : task.status === "succeeded"
                      ? "查看成片"
                      : "查看任务"}
                </Button>
              ),
            },
          ]}
          scroll={{ x: 680 }}
        />
      </section>
    </>
  );
}
