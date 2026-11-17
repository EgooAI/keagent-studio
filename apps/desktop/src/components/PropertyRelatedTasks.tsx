import { Empty } from "antd";
import { ArrowUpRight, Clapperboard } from "lucide-react";
import { Link } from "react-router-dom";
import { statusLabels, type ProductionTask } from "@keagent/shared-types";
import { formatDate, StatusTag } from "./common";
import "./property-related-tasks.css";

export function PropertyRelatedTasks({ tasks }: { tasks: ProductionTask[] }) {
  return (
    <section
      className="panel property-related-tasks"
      aria-labelledby="related-tasks-title"
    >
      <h2 id="related-tasks-title">关联生成任务</h2>
      {tasks.length ? (
        <table aria-labelledby="related-tasks-title">
          <thead>
            <tr>
              <th scope="col">视频模式</th>
              <th scope="col">创建时间</th>
              <th scope="col">状态</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => {
              const mode =
                task.configSnapshot.videoMode === "avatar"
                  ? "经纪人露脸"
                  : "纯口播";
              const createdAt = formatDate(task.createdAt);
              return (
                <tr key={task.id}>
                  <td>
                    <span className="related-task-mode">
                      <span className="related-task-icon">
                        <Clapperboard size={20} aria-hidden="true" />
                      </span>
                      {mode}
                    </span>
                  </td>
                  <td>
                    <time dateTime={task.createdAt}>{createdAt}</time>
                  </td>
                  <td>
                    <StatusTag
                      status={task.status}
                      label={statusLabels[task.status]}
                    />
                  </td>
                  <td>
                    <Link
                      className="related-task"
                      to={`/studio/tasks/${task.id}`}
                      aria-label={`查看任务：${mode}，${createdAt}`}
                    >
                      查看任务 <ArrowUpRight size={15} aria-hidden="true" />
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="还没有生成任务"
        />
      )}
    </section>
  );
}
