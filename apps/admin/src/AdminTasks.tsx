import {
  Alert,
  Button,
  Descriptions,
  Drawer,
  Empty,
  Input,
  Select,
  Space,
  Skeleton,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import { serviceRequest } from "@keagent/api-client";
import {
  stageLabels,
  statusLabels,
  type AdminTaskDetail,
  type AdminTaskSummary,
} from "@keagent/shared-types";
import {
  dateTime,
  listPagination,
  useAdminList,
  useAdminParams,
  userLabel,
} from "./admin-api";
import AdminUserSelect from "./AdminUserSelect";

export default function AdminTasks() {
  const { params, setParams } = useAdminParams();
  const query = useAdminList("tasks");
  const taskId = params.get("taskId") || "";
  const detail = useQuery({
    queryKey: ["admin", "task", taskId],
    enabled: !!taskId,
    queryFn: () =>
      serviceRequest<AdminTaskDetail>(
        `/v1/admin/tasks/${encodeURIComponent(taskId)}`,
      ),
  });
  const task = detail.data?.task;
  const hasFilters =
    params.has("q") ||
    params.has("ownerId") ||
    params.has("status") ||
    params.has("stage");
  return (
    <>
      <section
        className="admin-panel admin-table-panel"
        aria-labelledby="admin-task-list"
      >
        <div className="admin-section-heading">
          <div>
            <h2 id="admin-task-list">任务列表</h2>
            <p className="admin-secondary">
              在这里排查云端生产任务。文案审核、重试和本机全景制作在用户客户端完成。
            </p>
          </div>
          <Button
            icon={<RefreshCw size={14} />}
            loading={query.isFetching}
            onClick={() => void query.refetch()}
          >
            刷新列表
          </Button>
        </div>
        <div className="admin-toolbar">
          <Space wrap>
            <Input.Search
              key={params.get("q") || ""}
              aria-label="搜索任务"
              placeholder="搜索房源、任务号或批次号"
              defaultValue={params.get("q") || ""}
              onSearch={(q) => setParams({ q: q || undefined })}
              allowClear
              style={{ width: 260 }}
            />
            <Select
              aria-label="任务状态"
              placeholder="全部状态"
              value={params.get("status") || undefined}
              onChange={(status) => setParams({ status })}
              allowClear
              style={{ width: 140 }}
              options={Object.entries(statusLabels).map(([value, label]) => ({
                value,
                label,
              }))}
            />
            <Select
              aria-label="生产阶段"
              placeholder="全部阶段"
              value={params.get("stage") || undefined}
              onChange={(stage) => setParams({ stage })}
              allowClear
              style={{ width: 155 }}
              options={Object.entries(stageLabels).map(([value, label]) => ({
                value,
                label,
              }))}
            />
            <AdminUserSelect
              value={params.get("ownerId") || undefined}
              onChange={(ownerId) => setParams({ ownerId })}
              label="所属用户"
            />
          </Space>
        </div>
        {hasFilters && (
          <div className="admin-filter-note">
            <span>正在按条件筛选</span>
            <Button
              type="link"
              onClick={() =>
                setParams({
                  q: undefined,
                  ownerId: undefined,
                  status: undefined,
                  stage: undefined,
                })
              }
            >
              清除筛选
            </Button>
          </div>
        )}
        {query.error && (
          <Alert
            className="admin-notice"
            type="error"
            showIcon
            title="任务加载失败"
            description={query.error.message}
            action={<Button onClick={() => void query.refetch()}>重试</Button>}
          />
        )}
        <Table<AdminTaskSummary>
          rowKey="id"
          loading={query.isPending || query.isFetching}
          dataSource={query.data?.items || []}
          pagination={listPagination(query.data, params, setParams)}
          scroll={{ x: 1100 }}
          locale={{ emptyText: <Empty description="没有符合条件的云端任务" /> }}
          columns={[
            {
              title: "任务与房源",
              key: "task",
              width: 240,
              render: (_, row) => (
                <div className="admin-user-cell">
                  <Button
                    type="link"
                    className="admin-cell-link"
                    onClick={() => setParams({ taskId: row.id }, false)}
                  >
                    {row.propertyTitle ||
                      row.propertyNumber ||
                      "房源信息不可用"}
                  </Button>
                  <span className="admin-secondary">
                    房源号：{row.propertyNumber || "未记录"}
                  </span>
                </div>
              ),
            },
            {
              title: "所属用户",
              key: "owner",
              width: 200,
              render: (_, row) => (
                <Link
                  to={`/admin/users?userId=${encodeURIComponent(row.ownerId)}`}
                >
                  {userLabel(row.owner, row.ownerId)}
                </Link>
              ),
            },
            {
              title: "视频模式",
              key: "mode",
              width: 115,
              render: (_, row) => (
                <Tag>
                  {row.videoMode === "avatar" ? "经纪人露脸" : "纯口播"}
                </Tag>
              ),
            },
            {
              title: "当前阶段",
              dataIndex: "stage",
              width: 120,
              render: (value: AdminTaskSummary["stage"]) => (
                <Tag>{stageLabels[value] || "未知阶段"}</Tag>
              ),
            },
            {
              title: "状态",
              dataIndex: "status",
              width: 110,
              render: (value: AdminTaskSummary["status"]) => (
                <TaskStatus value={value} />
              ),
            },
            {
              title: "失败原因",
              dataIndex: "error",
              width: 240,
              ellipsis: true,
              render: (value?: string) =>
                value ? (
                  <Tooltip title={value}>
                    <span style={{ color: "var(--admin-danger)" }}>
                      {value}
                    </span>
                  </Tooltip>
                ) : (
                  <span className="admin-empty-val">—</span>
                ),
            },
            {
              title: "创建时间",
              dataIndex: "createdAt",
              width: 175,
              render: dateTime,
            },
          ]}
        />
      </section>
      <Drawer
        rootClassName="admin-detail-drawer"
        title="云端任务详情"
        width={720}
        open={!!taskId}
        onClose={() => setParams({ taskId: undefined }, false)}
      >
        {detail.isPending && <Skeleton active />}
        {detail.error && (
          <Alert
            type="error"
            showIcon
            title="无法读取任务详情"
            description={detail.error.message}
            action={<Button onClick={() => void detail.refetch()}>重试</Button>}
          />
        )}
        {task && detail.data && (
          <>
            <div className="admin-detail-summary">
              <TaskStatus value={task.status} />
              <span>当前阶段 · {stageLabels[task.stage] || "未知阶段"}</span>
            </div>
            {(task.status === "failed" || task.error) && (
              <Alert
                className="admin-notice"
                type="error"
                showIcon
                title="失败原因"
                description={
                  <>
                    <p style={{ marginBottom: 6 }}>
                      {task.error ||
                        "服务端尚未提供诊断，请核对任务阶段与服务配置。"}
                    </p>
                    <Link to="/admin/ai">前往 AI 服务检查配置</Link>
                  </>
                }
              />
            )}
            <h3 className="admin-detail-heading">任务信息</h3>
            <Descriptions
              column={1}
              bordered
              size="small"
              items={[
                {
                  key: "id",
                  label: "任务编号",
                  children: (
                    <Typography.Text copyable>{task.id}</Typography.Text>
                  ),
                },
                {
                  key: "batch",
                  label: "所属批次",
                  children: (
                    <Typography.Text copyable>{task.batchId}</Typography.Text>
                  ),
                },
                {
                  key: "owner",
                  label: "所属用户",
                  children: (
                    <Link
                      to={`/admin/users?userId=${encodeURIComponent(detail.data.ownerId)}`}
                    >
                      {userLabel(detail.data.owner, detail.data.ownerId)}
                    </Link>
                  ),
                },
                {
                  key: "property",
                  label: "房源",
                  children: `${task.propertySnapshot.title || task.propertySnapshot.community} · ${task.propertySnapshot.propertyNumber}`,
                },
                {
                  key: "time",
                  label: "创建时间",
                  children: dateTime(task.createdAt),
                },
                {
                  key: "complete",
                  label: "完成时间",
                  children: task.completedAt
                    ? dateTime(task.completedAt)
                    : "尚未完成",
                },
              ]}
            />
            <h3 className="admin-detail-heading">生成配置快照</h3>
            <Descriptions
              column={1}
              bordered
              size="small"
              items={[
                {
                  key: "mode",
                  label: "视频模式",
                  children:
                    task.configSnapshot.videoMode === "avatar"
                      ? "经纪人露脸"
                      : "纯口播",
                },
                {
                  key: "size",
                  label: "画面规格",
                  children: `${task.configSnapshot.aspectRatio} · ${task.configSnapshot.outputResolution}`,
                },
                {
                  key: "review",
                  label: "文案审核",
                  children: task.configSnapshot.requireScriptReview
                    ? "需要用户审核"
                    : "自动继续",
                },
                ...(
                  [
                    "promptTemplate",
                    "videoTemplate",
                    "styleTemplate",
                    "coverTemplate",
                    "subtitleTemplate",
                  ] as const
                )
                  .filter((key) => task.configSnapshot[key])
                  .map((key) => ({
                    key,
                    label: {
                      promptTemplate: "提示词模板",
                      videoTemplate: "视频模板",
                      styleTemplate: "风格模板",
                      coverTemplate: "封面模板",
                      subtitleTemplate: "字幕模板",
                    }[key],
                    children: (
                      <>
                        <span>版本 {task.configSnapshot[key]?.version}</span>
                        <span className="admin-secondary">
                          （编号：{task.configSnapshot[key]?.id}）
                        </span>
                      </>
                    ),
                  })),
                {
                  key: "voice",
                  label: "声音编号",
                  children: task.configSnapshot.voiceId || "未记录",
                },
              ]}
            />
            <h3 className="admin-detail-heading">
              当前文案 · 第 {task.scriptRevision} 版
            </h3>
            <div className="admin-script">{task.script || "尚未生成文案"}</div>
            <p className="admin-secondary admin-block">
              详情仅供排查，不会代替用户修改文案、审核或重新生成。
            </p>
          </>
        )}
      </Drawer>
    </>
  );
}

function TaskStatus({ value }: { value: AdminTaskSummary["status"] }) {
  return (
    <Tag
      color={
        value === "failed"
          ? "red"
          : value === "succeeded"
            ? "green"
            : value === "awaiting_review"
              ? "orange"
              : "default"
      }
    >
      {statusLabels[value] || "未知状态"}
    </Tag>
  );
}
