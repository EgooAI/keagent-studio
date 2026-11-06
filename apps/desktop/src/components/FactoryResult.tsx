import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Empty, Progress, Tag } from "antd";
import { Download, Film, Plus, RefreshCw, Send } from "lucide-react";
import { Link } from "react-router-dom";
import type { PanoramaJob } from "@keagent/shared-types";
import { artifactMedia } from "../lib/artifactMedia";
import { request, stageNames } from "./panoramaClient";

export function FactoryResult({
  job,
  busy,
  act,
  onNew,
}: {
  job?: PanoramaJob;
  busy: boolean;
  act: (action: () => Promise<void>) => Promise<void>;
  onNew: () => void;
}) {
  const { message } = App.useApp();
  const [registered, setRegistered] = useState("");
  const current = useRef(job?.id);
  current.current = job?.id;
  useEffect(() => setRegistered(""), [job?.id]);
  if (!job)
    return (
      <section className="panel factory-waiting">
        <Empty description="正在读取视频进度" />
      </section>
    );
  if (job.status === "running")
    return (
      <section className="panel factory-rendering" role="status">
        <div className="factory-render-icon">
          <Film size={38} />
        </div>
        <Tag color="processing">视频制作中</Tag>
        <h2>正在把这套房源变成视频</h2>
        <p>{job.property.title}</p>
        <Progress percent={job.progress} status="active" />
        <p>{stageNames[job.stage] || "正在生成视频"}，完成后会在这里展示。</p>
        <Button
          disabled={busy}
          onClick={() =>
            void act(async () => {
              await request("cancel", { id: job.id });
            })
          }
        >
          取消制作
        </Button>
      </section>
    );
  if (job.status !== "succeeded")
    return (
      <section className="panel factory-error">
        <Alert
          type={job.status === "canceled" ? "info" : "error"}
          showIcon
          title={
            job.status === "canceled" ? "已取消本次制作" : "视频暂未生成成功"
          }
          description={job.error || "已完成的处理结果会保留。"}
        />
        <div className="factory-error-actions">
          <Button
            type="primary"
            loading={busy}
            icon={<RefreshCw size={16} />}
            onClick={() =>
              void act(async () => {
                await request("retry", { id: job.id });
              })
            }
          >
            继续制作
          </Button>
          <Button onClick={onNew}>制作其他视频</Button>
        </div>
      </section>
    );
  return (
    <section className="panel factory-finished" aria-label="生成的视频">
      <div className="factory-section-heading">
        <div>
          <span className="factory-eyebrow">视频已完成</span>
          <h2>{job.property.title}</h2>
          <p>
            {job.duration ? `约 ${Math.round(job.duration)} 秒 · ` : ""}
            可以播放检查，也可以保存到发布中心。
          </p>
        </div>
        <Tag color="success">制作完成</Tag>
      </div>
      <video
        src={job.videoUrl}
        poster={job.coverUrl}
        controls
        preload="metadata"
        className="factory-final-video"
      />
      <div className="factory-result-actions">
        <Button
          icon={<Download size={16} />}
          loading={busy}
          onClick={() =>
            void act(async () => {
              if (await request("export", { id: job.id }))
                void message.success("视频已下载");
            })
          }
        >
          下载视频
        </Button>
        {!job.sample &&
          window.desktop?.artifactMedia &&
          (registered ? (
            <Link
              className="factory-publish-link"
              to={`/publish/${registered}`}
            >
              前往发布中心
            </Link>
          ) : (
            <Button
              type="primary"
              icon={<Send size={16} />}
              loading={busy}
              onClick={() =>
                void act(async () => {
                  const id = job.id;
                  const result = await artifactMedia.registerOutput(id);
                  if (current.current === id) setRegistered(result.id);
                  void message.success("视频已保存到发布中心");
                })
              }
            >
              保存到发布中心
            </Button>
          ))}
        <Button icon={<Plus size={16} />} onClick={onNew}>
          再制作一条
        </Button>
      </div>
      {job.sample && (
        <p className="factory-ai-note">
          这是测试素材生成的视频，不能保存为正式发布成果。
        </p>
      )}
    </section>
  );
}
