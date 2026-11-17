import {
  Alert,
  Button,
  Input,
  InputNumber,
  Progress,
  Select,
  Space,
  Tag,
} from "antd";
import { Link } from "react-router-dom";
import { Download, X } from "lucide-react";
import type { PanoramaScene, PanoramaSegment } from "@keagent/shared-types";
import { formatDate } from "./common";
import {
  phaseLabel,
  type FactoryAction,
  type FactoryDetail,
  type FactoryPhase,
} from "./factoryClient";
import { request, stageNames } from "./panoramaClient";
import {
  FactoryRenderSettings,
  renderKeys,
  renderSettingsError,
  type RenderEdits,
} from "./FactoryRenderSettings";

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
  reviewing,
  segments,
  scenes,
  coverTitle,
  renderSettings,
  dirty,
  busy,
  onClose,
  onEdit,
  onCamera,
  onCoverTitle,
  onRenderSettings,
  onSave,
  onConfirm,
  onOpeningLocation,
  onAct,
  onExport,
}: {
  row: FactoryDetail;
  reviewing: boolean;
  segments: PanoramaSegment[];
  scenes: PanoramaScene[];
  coverTitle: string;
  renderSettings: RenderEdits;
  dirty: boolean;
  busy: boolean;
  onClose?: () => void;
  onEdit: (id: string, text: string) => void;
  onCamera: (
    id: string,
    camera: Partial<Pick<PanoramaScene, "yaw" | "direction" | "spatial">>,
  ) => void;
  onCoverTitle: (title: string) => void;
  onRenderSettings: (settings: RenderEdits) => void;
  onSave: () => void;
  onConfirm: () => void;
  onOpeningLocation: (asset: string) => void;
  onAct: (action: FactoryAction) => void;
  onExport: (action: () => Promise<unknown>) => void;
}) {
  const { draft, job, config } = row;
  const effectiveConfig = job?.config || draft?.config || config;
  const spatial = effectiveConfig?.cameraMode === "spatial";
  const editable = reviewing && row.phase === "review";
  const reviewable =
    !!draft &&
    editable &&
    segments.every((s) => s.text.trim()) &&
    !renderSettingsError(renderSettings, spatial);
  const finished = job?.status === "succeeded";
  const location = draft?.config.openingLocation;
  const templateDefaults = draft?.templateSnapshot?.production.config;
  const opening = segments.find((segment) => segment.kind === "opening");
  return (
    <section className="factory-task-detail" aria-label="当前任务详情">
      <div className="factory-detail-heading">
        <div>
          <h2>{row.propertyTitle}</h2>
          {reviewing && (
            <p>
              {row.templateName}{" "}
              {row.templateVersion && "· " + row.templateVersion}
            </p>
          )}
        </div>
        {reviewing && <FactoryPhaseTag phase={row.phase} />}
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
      <dl
        className={
          reviewing ? "factory-detail-facts compact" : "factory-detail-facts"
        }
      >
        {!reviewing && (
          <>
            <div>
              <dt>视频模板</dt>
              <dd>
                {row.templateName}{" "}
                {row.templateVersion && "· " + row.templateVersion}
              </dd>
            </div>
            <div>
              <dt>状态</dt>
              <dd>
                <FactoryPhaseTag phase={row.phase} />
              </dd>
            </div>
          </>
        )}
        {effectiveConfig && (
          <div>
            <dt>制作规格</dt>
            <dd>
              {[
                effectiveConfig.aspectRatio,
                effectiveConfig.resolution,
                effectiveConfig.openingPhoto
                  ? "MiniMax 开场"
                  : effectiveConfig.videoMode === "avatar" &&
                      !effectiveConfig.roomOpening
                    ? "露脸"
                    : "配音",
              ]
                .filter(Boolean)
                .join(" · ")}
            </dd>
          </div>
        )}
        <div>
          <dt>创建时间</dt>
          <dd>{formatDate(row.createdAt)}</dd>
        </div>
      </dl>
      {finished && config?.openingPhoto && <Tag>AI 生成开场</Tag>}
      {row.error && <Alert showIcon type="error" title={row.error} />}
      {editable && draft ? (
        <div className="factory-detail-parameters">
          <strong>任务制作参数</strong>
          <FactoryRenderSettings
            scope="任务"
            defaults={draft.config}
            edits={renderSettings}
            spatial={spatial}
            disabled={busy}
            onChange={onRenderSettings}
            resetDisabled={
              !!templateDefaults &&
              renderKeys
                .filter((key) => !spatial || key === "rate")
                .every(
                  (key) =>
                    Number(renderSettings[key] ?? draft.config[key]) ===
                    templateDefaults[key],
                )
            }
            onReset={
              templateDefaults
                ? () =>
                    onRenderSettings(
                      Object.fromEntries(
                        renderKeys
                          .filter((key) => !spatial || key === "rate")
                          .map((key) => [key, String(templateDefaults[key])]),
                      ),
                    )
                : undefined
            }
          />
          {draft.config.design === "short-tour" && !spatial && (
            <p className="muted">
              较长镜头受最大转角限制时，会适当降低实际旋转速度。
            </p>
          )}
        </div>
      ) : (
        effectiveConfig && (
          <p className="factory-detail-parameters" aria-label="任务制作参数">
            配音语速 {effectiveConfig.rate} 倍
            {!spatial &&
              ` · 镜头速度 ${effectiveConfig.speed}°/秒 · 最大转角 ${effectiveConfig.maxSweep}°`}
          </p>
        )
      )}
      {spatial && (
        <p className="muted">
          镜头从当前拍摄点走向所选目标点，使用原房源三维模型与全景图。
        </p>
      )}
      {editable && draft?.config.design === "short-tour" && (
        <div className="factory-detail-cover">
          <label>
            <span>开场／封面标题</span>
            <Input.TextArea
              aria-label="开场／封面标题"
              rows={2}
              maxLength={120}
              value={coverTitle}
              disabled={busy}
              placeholder="留空使用房源名称和卖点"
              onChange={(event) => onCoverTitle(event.target.value)}
            />
          </label>
          <span className="muted">最多两行，只填写已核实的房源信息。</span>
        </div>
      )}
      {editable && config?.openingPhoto && (
        <p className="muted">
          开场先交代到访地点和本次带看的房源，建议
          {config.design === "short-tour" ? " 2–3 " : " 6–10 "}
          秒，配音须为 2–15 秒。确认文案后开始制作。
        </p>
      )}
      {!finished && location && (
        <div className="factory-review-segment">
          {row.openingLocationUrl && (
            <img src={row.openingLocationUrl} alt="开场地点图" />
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <strong>开场背景图</strong>
            {location.source !== "property" ? (
              <p className="muted">
                {location.source === "personal"
                  ? "创建任务时保存的个人背景图"
                  : "模板固定图片"}
              </p>
            ) : !editable ? null : row.openingLocations?.length ? (
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
            {opening &&
              (editable ? (
                <label>
                  <span>开场介绍</span>
                  <Input.TextArea
                    aria-label="开场介绍"
                    autoSize={{ minRows: 2, maxRows: 6 }}
                    maxLength={2000}
                    disabled={busy}
                    value={opening.text}
                    onChange={(event) => onEdit(opening.id, event.target.value)}
                  />
                </label>
              ) : (
                <div className="factory-read-segment">
                  <strong>开场介绍</strong>
                  <p>{opening.text}</p>
                </div>
              ))}
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
          {segments
            .filter((segment) => !(location && segment.kind === "opening"))
            .map((segment) => {
              const index = scenes.findIndex(
                (scene) => scene.id === segment.sceneId,
              );
              const scene = scenes[index];
              const label =
                segment.kind === "opening"
                  ? "开场介绍"
                  : segment.kind === "closing"
                    ? "结束介绍"
                    : index + 1 + " · " + scene?.room;
              return (
                <div className="factory-review-segment" key={segment.id}>
                  {scene && (scene.originalUrl || scene.url) && (
                    <img
                      loading="lazy"
                      alt=""
                      src={scene.originalUrl || scene.url}
                    />
                  )}
                  {editable ? (
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <label>
                        <span>{label}</span>
                        <Input.TextArea
                          aria-label={label}
                          autoSize={{ minRows: 2, maxRows: 6 }}
                          maxLength={2000}
                          disabled={busy}
                          value={segment.text}
                          onChange={(e) => onEdit(segment.id, e.target.value)}
                        />
                      </label>
                      {scene && segment.kind === "scene" && (
                        <Space wrap style={{ marginTop: 8 }}>
                          <label>
                            <span>镜头起始角度</span>
                            <InputNumber
                              aria-label={`${label}镜头起始角度`}
                              min={-180}
                              max={180}
                              suffix="°"
                              value={scene.yaw}
                              disabled={busy}
                              onChange={(yaw) => {
                                if (yaw !== null) onCamera(scene.id, { yaw });
                              }}
                            />
                          </label>
                          {spatial ? (
                            scene.spatial && (
                              <label>
                                <span>走向拍摄点</span>
                                <Select
                                  aria-label={`${label}走向拍摄点`}
                                  style={{ minWidth: 170 }}
                                  value={scene.spatial.targetPanoIndex}
                                  disabled={busy}
                                  options={scene.spatial.targets.map(
                                    (target) => ({
                                      value: target.index,
                                      label: target.label,
                                    }),
                                  )}
                                  onChange={(targetPanoIndex) =>
                                    onCamera(scene.id, {
                                      spatial: {
                                        ...scene.spatial!,
                                        targetPanoIndex,
                                      },
                                    })
                                  }
                                />
                              </label>
                            )
                          ) : (
                            <label>
                              <span>镜头方向</span>
                              <Select
                                aria-label={`${label}镜头方向`}
                                value={
                                  scene.direction || draft.config.direction
                                }
                                disabled={busy}
                                options={[
                                  { value: 1, label: "向右" },
                                  { value: -1, label: "向左" },
                                ]}
                                onChange={(direction) =>
                                  onCamera(scene.id, { direction })
                                }
                              />
                            </label>
                          )}
                        </Space>
                      )}
                    </div>
                  ) : (
                    <div className="factory-read-segment">
                      <strong>{label}</strong>
                      <p>{segment.text}</p>
                    </div>
                  )}
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
              保存修改
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
