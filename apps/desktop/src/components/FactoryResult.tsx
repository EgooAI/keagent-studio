import { Alert, Button, Input, Progress, Select, Space, Tag } from "antd";
import { Link } from "react-router-dom";
import { Download, X } from "lucide-react";
import type { PanoramaSegment } from "@keagent/shared-types";
import { formatDate } from "./common";
import {
  phaseLabel,
  type FactoryAction,
  type FactoryDetail,
  type FactoryPhase,
} from "./factoryClient";
import { request, stageNames } from "./panoramaClient";

const phaseColor: Partial<Record<FactoryPhase, string>> = {
  preparing: "processing",
  review: "warning",
  running: "processing",
  archiving: "processing",
  done: "success",
  archived: "success",
  failed: "error",
  archiveFailed: "error",
};
export function FactoryPhaseTag({ phase }: { phase: FactoryPhase }) {
  return <Tag color={phaseColor[phase]}>{phaseLabel[phase]}</Tag>;
}

export function FactoryTaskDetail({
  row,
  segments,
  dirty,
  busy,
  onClose,
  onEdit,
  onSave,
  onConfirm,
  onOpeningLocation,
  onAct,
  onExport,
}: {
  row: FactoryDetail;
  segments: PanoramaSegment[];
  dirty: boolean;
  busy: boolean;
  onClose?: () => void;
  onEdit: (id: string, text: string) => void;
  onSave: () => void;
  onConfirm: () => void;
  onOpeningLocation: (asset: string) => void;
  onAct: (action: FactoryAction) => void;
  onExport: (action: () => Promise<unknown>) => void;
}) {
  const { draft, job, config } = row;
  const editable = row.phase === "review";
  const reviewable =
    !!draft && editable && segments.every((s) => s.text.trim());
  const finished = job?.status === "succeeded";
  const location = draft?.config.openingLocation;
  return (
    <section className="factory-task-detail" aria-label="当前任务详情">
      <div className="factory-detail-heading">
        <div>
          <h2>{row.propertyTitle}</h2>
          <p>
            {row.templateName}{" "}
            {row.templateVersion && "· " + row.templateVersion}
          </p>
        </div>
        {onClose && (
          <Button
            type="text"
            size="small"
            aria-label="关闭任务详情"
            icon={<X size={17} />}
            onClick={onClose}
          />
        )}
      </div>
      <div className="factory-detail-meta">
        <FactoryPhaseTag phase={row.phase} />
        <span>
          {config?.aspectRatio} · {config?.resolution} ·{" "}
          {config?.openingPhoto
            ? "MiniMax 开场"
            : config?.videoMode === "avatar" && !config.roomOpening
              ? "露脸"
              : "配音"}
        </span>
        {finished && config?.openingPhoto && <Tag>AI 生成开场</Tag>}
        <span>{formatDate(row.createdAt)}</span>
      </div>
      {row.error && <Alert showIcon type="error" title={row.error} />}
      {editable && config?.openingPhoto && (
        <p className="muted">
          开场解说建议一句话，豆包语音合成后须为 2–6 秒。确认文案后开始制作。
        </p>
      )}
      {!finished && location && (
        <div className="factory-review-segment">
          {row.openingLocationUrl && (
            <img src={row.openingLocationUrl} alt="开场地点图" />
          )}
          <div>
            <strong>开场地点图</strong>
            {location.source === "fixed" ? (
              <p className="muted">模板固定图片</p>
            ) : row.openingLocations?.length ? (
              <Select
                aria-label="更换开场地点图"
                value={location.asset}
                disabled={!editable || busy}
                options={row.openingLocations.map((option, index) => ({
                  value: option.asset,
                  url: option.url,
                  label: `${index + 1} · ${option.label}`,
                }))}
                optionRender={({ data }) => (
                  <Space>
                    <img
                      width={48}
                      height={32}
                      style={{ objectFit: "cover" }}
                      src={data.url}
                      alt=""
                    />
                    {data.label}
                  </Space>
                )}
                onChange={onOpeningLocation}
              />
            ) : (
              <p className="muted">
                这套房源暂无可用实拍图。可补充原图后重新创建任务，或选择「改用房源开场」。
              </p>
            )}
          </div>
        </div>
      )}
      {row.phase === "running" && (
        <div className="factory-detail-progress" role="status">
          <span>{row.stage ? stageNames[row.stage] : "正在检查制作配置"}</span>
          <Progress size="small" percent={row.progress} />
        </div>
      )}
      {finished ? (
        <video
          className="factory-final-video"
          src={job.videoUrl}
          poster={job.coverUrl}
          controls
          preload="metadata"
        />
      ) : draft && segments.length ? (
        <div className="factory-review-list">
          {segments.map((segment) => {
            const index = draft.scenes.findIndex(
              (scene) => scene.id === segment.sceneId,
            );
            const scene = draft.scenes[index];
            const label = scene
              ? index + 1 + " · " + scene.room
              : segment.kind === "opening"
                ? "开场介绍"
                : "结束介绍";
            return (
              <div className="factory-review-segment" key={segment.id}>
                {scene && (scene.originalUrl || scene.url) && (
                  <img
                    loading="lazy"
                    alt=""
                    src={scene.originalUrl || scene.url}
                  />
                )}
                <label>
                  <span>{label}</span>
                  <Input.TextArea
                    aria-label={label}
                    autoSize={{ minRows: 2, maxRows: 6 }}
                    maxLength={2000}
                    readOnly={!editable}
                    disabled={busy}
                    value={segment.text}
                    onChange={(e) => onEdit(segment.id, e.target.value)}
                  />
                </label>
              </div>
            );
          })}
        </div>
      ) : (
        !row.error &&
        row.phase !== "running" && (
          <p className="muted">
            {row.phase === "preparing"
              ? "正在读取房源素材并准备分段文案。"
              : phaseLabel[row.phase]}
          </p>
        )
      )}
      <div className="factory-detail-actions">
        {editable && (
          <Space wrap>
            <Button disabled={!dirty || !reviewable || busy} onClick={onSave}>
              保存文案
            </Button>
            <Button
              type="primary"
              disabled={!reviewable || busy || (!!location && !location.asset)}
              onClick={onConfirm}
            >
              确认并下一条
            </Button>
          </Space>
        )}
        {row.phase === "queued" && !job && (
          <Button disabled={busy} onClick={() => onAct("withdraw")}>
            撤回到待审核
          </Button>
        )}
        {["pending", "preparing", "review", "queued", "running"].includes(
          row.phase,
        ) && (
          <Button
            type="text"
            danger
            disabled={busy}
            onClick={() => onAct("cancel")}
          >
            取消任务
          </Button>
        )}
        {["failed", "archiveFailed", "canceled"].includes(row.phase) && (
          <Button type="primary" disabled={busy} onClick={() => onAct("retry")}>
            {row.phase === "archiveFailed" ? "重试归档" : "重试任务"}
          </Button>
        )}
        {row.phase === "failed" && config?.openingPhoto && (
          <Button disabled={busy} onClick={() => onAct("edit-opening")}>
            调整开场文案
          </Button>
        )}
        {["review", "failed"].includes(row.phase) &&
          (config?.openingPhoto ||
            (config?.videoMode === "avatar" && !config.roomOpening)) && (
            <Button disabled={busy} onClick={() => onAct("room-opening")}>
              改用房源开场
            </Button>
          )}
        {finished && (
          <>
            <Button
              icon={<Download size={15} />}
              disabled={busy}
              onClick={() => onExport(() => request("export", { id: job.id }))}
            >
              下载视频
            </Button>
            {row.artifactId && (
              <Link
                className="factory-result-link"
                to={"/publish/" + row.artifactId}
              >
                在发布中心查看
              </Link>
            )}
            {row.legacy && !job.sample && row.phase === "done" && (
              <Button
                type="primary"
                disabled={busy}
                onClick={() => onAct("archive")}
              >
                保存到发布中心
              </Button>
            )}
          </>
        )}
        {(row.phase === "running" || finished || row.phase === "failed") && (
          <Button type="text" disabled={busy} onClick={() => onAct("copy")}>
            复制为新任务
          </Button>
        )}
      </div>
      {job?.sample && (
        <p className="muted">
          测试样片仅供预览与下载。请选择真实房源生成视频，成片归档后会出现在发布中心。
        </p>
      )}
    </section>
  );
}
