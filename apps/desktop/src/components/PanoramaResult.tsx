import { Alert, App, Button, Empty, Progress, Space, Table, Tag } from "antd";
import { Download, RefreshCw } from "lucide-react";
import type { PanoramaJob } from "@keagent/shared-types";
import { request, stageNames, statusNames } from "./panoramaClient";
export function PanoramaResult({
  job,
  busy,
  act,
}: {
  job?: PanoramaJob;
  busy: boolean;
  act: (action: () => Promise<void>) => Promise<void>;
}) {
  const { message } = App.useApp();
  return (
    <>
      {" "}
      <h2>成片与时间轴</h2>
      {job ? (
        <>
          <p>
            <Tag
              color={
                job.status === "failed"
                  ? "error"
                  : job.status === "succeeded"
                    ? "success"
                    : "default"
              }
            >
              {statusNames[job.status]}
            </Tag>
            {job.property.title} · 草稿 r{job.draftRevision}
          </p>
          <p className="muted">{stageNames[job.stage]}</p>
          <Progress
            percent={job.progress}
            status={
              job.status === "failed"
                ? "exception"
                : job.status === "succeeded"
                  ? "success"
                  : "normal"
            }
          />
          {job.error && <Alert type="error" title={job.error} showIcon />}
          {job.videoUrl && (
            <video
              className="panorama-video"
              src={job.videoUrl}
              poster={job.coverUrl}
              controls
              preload="metadata"
            />
          )}
          {job.duration && (
            <p className="muted">
              实际成片 {job.duration.toFixed(2)} 秒 ·{" "}
              {job.config.ttsProvider === "system" ? "本机配音" : "火山 TTS"}
            </p>
          )}
          <Space wrap>
            {job.status === "running" && (
              <Button
                danger
                onClick={() =>
                  void act(async () => {
                    await request("cancel", { id: job.id });
                  })
                }
              >
                取消任务
              </Button>
            )}
            {["failed", "canceled"].includes(job.status) && (
              <Button
                icon={<RefreshCw size={16} />}
                loading={busy}
                onClick={() =>
                  void act(async () => {
                    await request("retry", { id: job.id });
                  })
                }
              >
                重试，复用已有素材
              </Button>
            )}
            {job.status === "succeeded" && (
              <Button
                icon={<Download size={16} />}
                onClick={() =>
                  void act(async () => {
                    if (
                      await request<boolean>("export", {
                        id: job.id,
                      })
                    )
                      void message.success("成片已导出");
                  })
                }
              >
                导出 MP4
              </Button>
            )}
          </Space>
          {job.timeline && (
            <Table
              size="small"
              pagination={false}
              rowKey="id"
              dataSource={job.timeline}
              columns={[
                {
                  title: "段落",
                  dataIndex: "id",
                  render: (id) =>
                    job.segments.find((s) => s.id === id)?.kind === "opening"
                      ? "开场"
                      : job.segments.find((s) => s.id === id)?.kind ===
                          "closing"
                        ? "结尾"
                        : job.scenes.find((s) => s.id === id)?.room,
                },
                {
                  title: "起始",
                  dataIndex: "start",
                  render: (n: number) => `${n.toFixed(2)}s`,
                },
                {
                  title: "时长",
                  dataIndex: "duration",
                  render: (n: number) => `${n.toFixed(2)}s`,
                },
                {
                  title: "镜头",
                  dataIndex: "camera",
                  render: (camera: { sweep: number } | null, row) =>
                    camera
                      ? `${camera.sweep.toFixed(1)}°`
                      : job.config.videoMode === "avatar" &&
                          job.segments.find((s) => s.id === row.id)?.kind ===
                            "opening"
                        ? "数字人"
                        : job.config.materialMode === "expand"
                          ? "扩图平移"
                          : "数字人",
                },
              ]}
            />
          )}
          {job.coverUrl && (
            <div className="panorama-cover-result">
              <img src={job.coverUrl} alt="成片封面" />
              <span className="muted">
                生成的封面 · {job.config.coverTitle || job.property.title}
              </span>
            </div>
          )}
        </>
      ) : (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="审核后即可生成第一条视频"
        />
      )}
    </>
  );
}
