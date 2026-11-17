import { Button, Empty } from "antd";
import { ArrowUpRight, House, Plus } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { stageLabels } from "@keagent/shared-types";
import { PageHeader, StatusTag } from "../components/common";
import { useWorkspace } from "../lib/workspace";
import "./DashboardPage.css";

function TaskCover({ image }: { image: string }) {
  return (
    <span className="dashboard-cover" aria-hidden="true">
      <House size={22} />
      {image && (
        <img
          key={image}
          src={image}
          alt=""
          onError={(event) => {
            event.currentTarget.hidden = true;
          }}
        />
      )}
    </span>
  );
}

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
  const todos = [...pending, ...unpublished].slice(0, 4);
  const recent = [...data.tasks]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 6);

  return (
    <div className="studio-index-page creator-dashboard">
      <PageHeader
        title={`${data.profile.name}的创作工作台`}
        description="查看制作进度，处理审核与发布待办。"
        actions={
          <Button
            type="primary"
            icon={<Plus size={19} />}
            onClick={() => navigate("/studio/create")}
          >
            创建 AI 视频
          </Button>
        }
      />
      <div className="dashboard-columns">
        <section
          className="panel dashboard-card"
          aria-labelledby="dashboard-todos-title"
        >
          <h2 id="dashboard-todos-title">需要你处理</h2>
          <p className="dashboard-counts">
            {pending.length} 条待审核 · {unpublished.length} 条待发布
          </p>
          {todos.length ? (
            <ul className="dashboard-inbox">
              {todos.map((task) => {
                const review = task.status === "awaiting_review";
                return (
                  <li key={task.id}>
                    <Link
                      className="dashboard-inbox-link"
                      to={
                        review
                          ? `/studio/tasks/${task.id}/review`
                          : `/publish/${task.id}`
                      }
                    >
                      <TaskCover image={task.propertySnapshot.image} />
                      <span className="dashboard-task-copy">
                        <strong>{task.propertySnapshot.community}</strong>
                        <span>
                          {review
                            ? "文案待确认，审核后继续制作"
                            : "成片已完成，可以安排发布"}
                        </span>
                      </span>
                      <span className="dashboard-action">
                        {review ? "审核文案" : "查看成片"}{" "}
                        <ArrowUpRight aria-hidden="true" size={16} />
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="dashboard-empty">
              <h3>当前没有待办</h3>
              <p>可以添加房源，或开始制作下一批视频。</p>
            </div>
          )}
        </section>
        <aside
          className="panel dashboard-card"
          aria-labelledby="dashboard-summary-title"
        >
          <h2 id="dashboard-summary-title">工作区概况</h2>
          <dl className="dashboard-stats">
            <div>
              <dt>房源</dt>
              <dd>
                <strong>{data.properties.length}</strong> 套
              </dd>
            </div>
            <div>
              <dt>制作中</dt>
              <dd>
                <strong>{active.length}</strong> 条
              </dd>
            </div>
            <div>
              <dt>已完成</dt>
              <dd>
                <strong>{finished.length}</strong> 条
              </dd>
            </div>
          </dl>
          <div className="dashboard-library-actions">
            <Button onClick={() => navigate("/properties?import=1")}>
              导入房源
            </Button>
            <Link className="dashboard-action" to="/properties">
              查看房源库
            </Link>
          </div>
        </aside>
      </div>
      <section
        className="panel dashboard-card dashboard-recent"
        aria-labelledby="dashboard-recent-title"
      >
        <header>
          <h2 id="dashboard-recent-title">最近制作</h2>
          <Link className="dashboard-action" to="/studio">
            全部任务 <ArrowUpRight aria-hidden="true" size={16} />
          </Link>
        </header>
        {recent.length ? (
          <div
            className="dashboard-table-scroll"
            tabIndex={0}
            role="region"
            aria-labelledby="dashboard-recent-title"
          >
            <table
              className="dashboard-table"
              aria-labelledby="dashboard-recent-title"
            >
              <thead>
                <tr>
                  <th scope="col">房源</th>
                  <th scope="col">视频模式</th>
                  <th scope="col">当前阶段</th>
                  <th scope="col">状态</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((task) => (
                  <tr key={task.id}>
                    <td>
                      <Link
                        className="dashboard-property-link"
                        to={`/studio/tasks/${task.id}`}
                      >
                        <TaskCover image={task.propertySnapshot.image} />
                        <span className="dashboard-task-copy">
                          <strong>{task.propertySnapshot.community}</strong>
                          <span>
                            {task.propertySnapshot.layout} ·{" "}
                            {task.propertySnapshot.areaSqm} ㎡
                          </span>
                        </span>
                      </Link>
                    </td>
                    <td>
                      {task.configSnapshot.videoMode === "avatar"
                        ? "经纪人露脸"
                        : "纯口播"}
                    </td>
                    <td>{stageLabels[task.stage]}</td>
                    <td>
                      <StatusTag status={task.status} />
                    </td>
                    <td>
                      <Link
                        className="dashboard-action"
                        to={
                          task.status === "succeeded"
                            ? `/publish/${task.id}`
                            : `/studio/tasks/${task.id}`
                        }
                      >
                        {task.status === "awaiting_review"
                          ? "审核文案"
                          : task.status === "succeeded"
                            ? "查看成片"
                            : "查看任务"}
                        <ArrowUpRight aria-hidden="true" size={15} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty description="还没有制作任务，先创建一条视频吧" />
        )}
      </section>
    </div>
  );
}
