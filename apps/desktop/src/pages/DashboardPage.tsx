import { Button, Empty, Space, Table, Tag } from "antd";
import {
  ArrowRight,
  ArrowUpRight,
  Building2,
  Clapperboard,
  FileCheck2,
  Plus,
} from "lucide-react";
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
            onClick={() => navigate("/studio")}
          >
            创建 AI 视频
          </Button>
        }
      />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1.55fr) minmax(280px, 1fr)",
          gap: 20,
          marginBottom: 24,
        }}
      >
        <section
          className="panel"
          style={{
            padding: 26,
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            minHeight: 180,
          }}
        >
          <div>
            <Clapperboard size={26} color="#2563eb" />
            <h2 style={{ margin: "14px 0 7px", fontSize: 20 }}>
              批量制作房源视频
            </h2>
            <p style={{ color: "#667085", margin: 0 }}>
              一套配置支持多套房源，每套生成独立成片。
            </p>
          </div>
          <Space style={{ marginTop: 20 }}>
            <Button
              onClick={() => navigate("/studio")}
              icon={<ArrowRight size={15} />}
            >
              进入视频工厂
            </Button>
            <Button type="text" onClick={() => navigate("/properties")}>
              查看房源
            </Button>
          </Space>
        </section>
        <section className="panel" style={{ padding: 26 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <Building2 size={24} color="#64748b" />
            <Tag variant="filled">房源库</Tag>
          </div>
          <h2 style={{ margin: "14px 0 7px", fontSize: 20 }}>先把素材准备好</h2>
          <p style={{ color: "#667085", marginBottom: 20 }}>
            当前有 {data.properties.length} 套示例房源，可继续批量导入。
          </p>
          <Button
            onClick={() => navigate("/properties?import=1")}
            icon={<Plus size={15} />}
          >
            导入房源
          </Button>
        </section>
      </div>
      <div
        style={{
          display: "flex",
          gap: 32,
          padding: "0 2px 24px",
          flexWrap: "wrap",
        }}
      >
        <Link to="/studio">
          <strong style={{ fontSize: 22, marginRight: 8 }}>
            {active.length}
          </strong>
          <span style={{ color: "#667085" }}>正在制作</span>
        </Link>
        <Link to="/studio">
          <strong style={{ fontSize: 22, marginRight: 8 }}>
            {pending.length}
          </strong>
          <span style={{ color: "#667085" }}>待审核文案</span>
        </Link>
        <Link to="/publish">
          <strong style={{ fontSize: 22, marginRight: 8 }}>
            {unpublished.length}
          </strong>
          <span style={{ color: "#667085" }}>待安排发布</span>
        </Link>
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
      {pending.length > 0 && (
        <section
          className="panel"
          style={{
            padding: "18px 24px",
            marginTop: 20,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 16,
          }}
        >
          <Space>
            <FileCheck2 size={20} color="#b7791f" />
            <div>
              <strong>有 {pending.length} 条文案等你确认</strong>
              <p style={{ margin: "4px 0 0", color: "#667085" }}>
                审核通过后，将继续配音和视频合成。
              </p>
            </div>
          </Space>
          <Button
            onClick={() => navigate(`/studio/tasks/${pending[0].id}/review`)}
          >
            去审核
          </Button>
        </section>
      )}
    </>
  );
}
