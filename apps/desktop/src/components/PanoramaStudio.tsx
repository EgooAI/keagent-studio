import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Collapse,
  Form,
  Popconfirm,
  Select,
  Skeleton,
  Space,
  Table,
} from "antd";
import { ImagePlus, Play, Save } from "lucide-react";
import type {
  PanoramaCapabilities,
  PanoramaConfig,
  PanoramaDraft,
  PanoramaJob,
  PanoramaProperty,
  PanoramaScene,
  PanoramaSegment,
  PanoramaState,
} from "@keagent/shared-types";
import { useBlocker, useSearchParams } from "react-router-dom";
import { useWorkspace } from "../lib/workspace";
import { useVoiceLibrary } from "../lib/voiceLibrary";
import { useAvatarLibrary } from "../lib/avatarLibrary";
import { PageHeader } from "./common";
import { PanoramaTemplateEditor } from "./PanoramaTemplateEditor";
import { PanoramaResult } from "./PanoramaResult";
import { PanoramaSources, type ProductionSourceSet } from "./PanoramaSources";
import { request, stageNames, statusNames } from "./panoramaClient";
import "./panorama.css";

export function PanoramaStudio() {
  const { data: workspace } = useWorkspace();
  const voices = useVoiceLibrary();
  const avatars = useAvatarLibrary();
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const enabled = !!window.desktop;
  const capabilities = useQuery({
    queryKey: ["panorama-capabilities"],
    queryFn: () => request<PanoramaCapabilities>("capabilities"),
    enabled,
    retry: false,
  });
  const state = useQuery({
    queryKey: ["panorama-state"],
    queryFn: () => request<PanoramaState>("state"),
    enabled,
    refetchInterval: 2500,
    retry: false,
  });
  const [config, setConfig] = useState<PanoramaConfig>();
  const [property, setProperty] = useState<PanoramaProperty>();
  const [scenes, setScenes] = useState<PanoramaScene[]>([]);
  const [draft, setDraft] = useState<PanoramaDraft>();
  const [segments, setSegments] = useState<PanoramaSegment[]>([]);
  const [busy, setBusy] = useState(false);
  const [selectedJob, setSelectedJob] = useState<string>();
  const caps = capabilities.data;
  const unsaved = draft
    ? JSON.stringify(config) !== JSON.stringify(draft.config) ||
      JSON.stringify(segments) !== JSON.stringify(draft.segments)
    : scenes.length > 0;
  const blocker = useBlocker(unsaved);
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    const prompt = modal.confirm({
      title: "制作内容尚未保存",
      content: "离开会丢弃当前未保存的编辑。已保存草稿和执行中的任务会保留。",
      okText: "放弃修改并离开",
      cancelText: "继续编辑",
      onOk: () => blocker.proceed(),
      onCancel: () => blocker.reset(),
    });
    return () => prompt.destroy();
  }, [blocker, modal]);
  useEffect(() => {
    if (!caps || config) return;
    setConfig({
      ...caps.defaultConfig,
      ttsProvider: "volcengine",
      voice: voices.data?.publicVoices?.[0]?.id || "",
      avatarId: "",
    });
  }, [caps, config]);
  useEffect(() => {
    if (property || !workspace) return;
    const incoming = workspace.properties.find(
      (p) => p.id === params.get("propertyId"),
    );
    if (incoming) setProperty(incoming);
  }, [workspace, params, property]);
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => {
      if (unsaved) event.preventDefault();
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [unsaved]);
  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
      await queryClient.invalidateQueries({ queryKey: ["panorama-state"] });
    } catch (error) {
      void message.error(
        error instanceof Error ? error.message : "操作失败，请重试",
      );
    } finally {
      setBusy(false);
    }
  };
  const restore = (value: PanoramaDraft) => {
    setDraft(value);
    setConfig(
      value.config.ttsProvider === "system"
        ? { ...value.config, ttsProvider: "volcengine", voice: "" }
        : value.config,
    );
    setProperty(value.property);
    setScenes(value.scenes);
    setSegments(value.segments);
  };
  const patch = (value: Partial<PanoramaConfig>) =>
    setConfig((c) => (c ? { ...c, ...value } : c));
  const editScene = (id: string, value: Partial<PanoramaScene>) => {
    setScenes((list) =>
      list.map((s) => (s.id === id ? { ...s, ...value } : s)),
    );
    setDraft(undefined);
    setSegments([]);
  };
  const loadSources = (value: ProductionSourceSet) => {
    setProperty(value.property);
    setScenes(value.scenes);
    patch({
      materialMode: value.materialMode,
      leadSceneId: "",
      coverSceneId: "",
      coverTitle: "",
    });
    setDraft(undefined);
    setSegments([]);
  };
  const changeTemplate = (id: string) => {
    const personal = state.data?.templates?.find((t) => t.id === id);
    if (personal) {
      patch({ ...personal.config, templateId: personal.id });
      setDraft(undefined);
      setSegments([]);
      return;
    }
    const template = caps?.templates.find((t) => t.id === id);
    if (!template) return;
    patch({
      templateId: id,
      openingTemplate: template.opening,
      sceneTemplate: template.scene,
      closingTemplate: template.closing,
    });
    setDraft(undefined);
    setSegments([]);
  };
  const changeLanguage = (language: PanoramaConfig["language"]) => {
    patch({
      language,
      voice:
        config?.ttsProvider === "system"
          ? caps?.voices.find((v) => v.language === language)?.name || ""
          : config?.voice || "",
      ...(language === "en-US"
        ? {
            openingTemplate: "Let us take a look at {title}. {facts}",
            sceneTemplate: "This is the {room}. {description}",
            closingTemplate:
              "Please contact your agent to arrange an in-person viewing.",
          }
        : {
            openingTemplate: (
              caps!.templates.find((t) => t.id === config!.templateId) ||
              caps!.templates[0]
            ).opening,
            sceneTemplate: (
              caps!.templates.find((t) => t.id === config!.templateId) ||
              caps!.templates[0]
            ).scene,
            closingTemplate: (
              caps!.templates.find((t) => t.id === config!.templateId) ||
              caps!.templates[0]
            ).closing,
          }),
    });
    setDraft(undefined);
    setSegments([]);
  };
  const generate = () =>
    act(async () => {
      const value = await request<PanoramaDraft>("generate", {
        propertyId: property?.id,
        scenes,
        config,
      });
      restore(value);
      void message.success("已生成分段文案，请核对房源事实和空间对应关系");
    });
  const save = async () => {
    if (!draft) throw new Error("请先生成分段文案");
    const value = await request<PanoramaDraft>("save", {
      id: draft.id,
      revision: draft.revision,
      segments,
      config,
    });
    restore(value);
    return value;
  };
  const job =
    state.data?.jobs.find((j) => j.id === selectedJob) || state.data?.jobs[0];
  const hasRunning = state.data?.jobs.some((j) => j.status === "running");
  const dirty =
    !!draft &&
    (JSON.stringify(config) !== JSON.stringify(draft.config) ||
      JSON.stringify(segments) !== JSON.stringify(draft.segments));
  const invalidate = () => {
    setDraft(undefined);
    setSegments([]);
  };
  const replaceScenes = (next: PanoramaScene[]) => {
    setScenes(next);
    patch({
      leadSceneId: next.some((s) => s.id === config?.leadSceneId)
        ? config?.leadSceneId
        : "",
      coverSceneId: next.some((s) => s.id === config?.coverSceneId)
        ? config?.coverSceneId
        : "",
    });
    invalidate();
  };
  const unavailable =
    !property ||
    !scenes.length ||
    scenes.some(
      (s) => s.kind === "photo" || (s.kind === "expanded" && !s.approved),
    ) ||
    (config?.videoMode === "avatar" &&
      !avatars.data?.avatars.some(
        (a) => a.id === config.avatarId && a.status === "ready",
      ));
  return (
    <>
      <PageHeader
        title="房源视频工作流"
        description="整理素材 → 套用模板 → 逐段审核 → 预览出片。有全景使用全景，普通照片先扩图。"
      />
      {!enabled ? (
        <Alert
          type="info"
          showIcon
          title="请在桌面客户端制作视频"
          description="此流程需要读取本机素材、生成配音并调用 FFmpeg。"
        />
      ) : (
        <>
          {(capabilities.error || state.error) && (
            <Alert
              type="error"
              title="工作流加载失败"
              description={(capabilities.error || state.error)?.message}
              action={
                <Button
                  onClick={() => {
                    void capabilities.refetch();
                    void state.refetch();
                  }}
                >
                  重试
                </Button>
              }
            />
          )}
          {!caps || !config ? (
            <Skeleton active />
          ) : (
            <>
              {(!caps.ffmpeg || !caps.ffprobe) && (
                <Alert
                  type="warning"
                  title="尚未找到视频运行时"
                  description="请配置 FFmpeg / FFprobe 后重启客户端；可以先完成素材与文案审核。"
                />
              )}
              <Collapse
                className="panorama-sources"
                defaultActiveKey={["source"]}
                items={[
                  {
                    key: "source",
                    label: `1. 房源与素材${property ? ` · ${property.title} · ${scenes.length} 个空间` : ""}`,
                    children: (
                      <Form layout="vertical" disabled={busy}>
                        <Form.Item label="房源">
                          <Select
                            value={property?.id}
                            placeholder="选择已录入的房源"
                            showSearch
                            optionFilterProp="label"
                            options={Array.from(
                              new Map(
                                [
                                  ...(workspace?.properties || []),
                                  ...(state.data?.properties || []),
                                  ...(property ? [property] : []),
                                ].map((p) => [
                                  p.id,
                                  { value: p.id, label: p.title },
                                ]),
                              ).values(),
                            )}
                            onChange={(id) => {
                              setProperty(
                                workspace?.properties.find(
                                  (p) => p.id === id,
                                ) ||
                                  state.data?.properties?.find(
                                    (p) => p.id === id,
                                  ),
                              );
                              setScenes([]);
                              patch({
                                leadSceneId: "",
                                coverSceneId: "",
                                coverTitle: "",
                              });
                              invalidate();
                            }}
                          />
                        </Form.Item>
                        <PanoramaSources
                          caps={caps}
                          property={property}
                          scenes={scenes}
                          tasks={state.data?.imageTasks || []}
                          act={act}
                          onLoaded={loadSources}
                          onPhotos={(added, materialMode) => {
                            replaceScenes(added);
                            patch({ materialMode });
                          }}
                          onExpanded={(results) => {
                            if (
                              !scenes.some(
                                (s) =>
                                  s.kind === "photo" &&
                                  results.some(
                                    (r) => r.sceneId === s.id && r.result,
                                  ),
                              )
                            )
                              return;
                            setScenes((previous) =>
                              previous.map((s) => {
                                const result = results.find(
                                  (r) => r.sceneId === s.id,
                                )?.result;
                                return s.kind === "photo" && result
                                  ? {
                                      ...result,
                                      room: s.room,
                                      description: s.description,
                                    }
                                  : s;
                              }),
                            );
                            invalidate();
                          }}
                        />
                        <Space wrap>
                          <Button
                            icon={<ImagePlus size={16} />}
                            disabled={!property}
                            onClick={() =>
                              void act(async () => {
                                const added =
                                  await request<PanoramaScene[]>("import");
                                if (!added.length) return;
                                replaceScenes(
                                  config.materialMode === "expand"
                                    ? added
                                    : [...scenes, ...added].slice(0, 20),
                                );
                                patch({ materialMode: "panorama" });
                              })
                            }
                          >
                            导入已有全景图
                          </Button>
                          <Popconfirm
                            title="载入两个独立测试场景？"
                            description="将替换当前编辑内容；它们不代表同一套在售房源。"
                            onConfirm={() =>
                              act(async () => {
                                const sample = await request<{
                                  property: PanoramaProperty;
                                  scenes: PanoramaScene[];
                                }>("sample");
                                setProperty(sample.property);
                                replaceScenes(sample.scenes);
                                patch({
                                  materialMode: "panorama",
                                  coverTitle: "",
                                });
                              })
                            }
                          >
                            <Button>使用 CC0 测试素材</Button>
                          </Popconfirm>
                        </Space>
                        <p className="muted">
                          已有全景需为 2:1 等距柱状 JPEG / PNG，宽度至少
                          2048，单张不超过 50MB。
                        </p>
                        {property?.sample && (
                          <Alert
                            type="info"
                            title="测试素材，非在售房源"
                            description="请只用于验证制作效果，不能作为真实房源发布。"
                          />
                        )}
                      </Form>
                    ),
                  },
                ]}
              />
              <div className="template-toolbar panel">
                <div>
                  <h2>2. 模板与分段审核</h2>
                  <span className="muted">
                    模板版本固定到草稿，配音决定镜头时长。
                  </span>
                </div>
                <Space wrap>
                  <Select
                    aria-label="恢复已保存的草稿"
                    style={{ width: 240 }}
                    placeholder="恢复已保存的草稿"
                    value={draft?.id}
                    options={(state.data?.drafts || []).map((d) => ({
                      value: d.id,
                      label: `${d.property.title} · r${d.revision}`,
                    }))}
                    onChange={(id) => {
                      const value = state.data?.drafts.find((d) => d.id === id);
                      if (value) restore(value);
                    }}
                    disabled={busy}
                  />
                  <Button
                    type="primary"
                    loading={busy}
                    disabled={unavailable}
                    onClick={() => void generate()}
                  >
                    生成分段文案，进入审核
                  </Button>
                  {draft && (
                    <>
                      <Button
                        icon={<Save size={16} />}
                        loading={busy}
                        onClick={() =>
                          void act(async () => {
                            await save();
                            void message.success("文案与制作配置已保存");
                          })
                        }
                      >
                        保存修改
                      </Button>
                      <Button
                        type="primary"
                        icon={<Play size={16} />}
                        loading={busy}
                        disabled={
                          hasRunning ||
                          !caps.ffmpeg ||
                          !caps.ffprobe ||
                          (config.videoMode === "avatar" && !caps.volcAvatar)
                        }
                        onClick={() =>
                          void act(async () => {
                            const approved = dirty ? await save() : draft;
                            const created = await request<PanoramaJob>(
                              "start",
                              { id: approved.id, revision: approved.revision },
                            );
                            setSelectedJob(created.id);
                            void message.success("审核已确认，任务开始执行");
                          })
                        }
                      >
                        确认文案并制作
                      </Button>
                    </>
                  )}
                </Space>
              </div>
              {draft && (
                <p className="muted">
                  模板 v{draft.templateVersion} · 草稿 r{draft.revision} ·{" "}
                  {dirty ? "有未保存修改" : "文案已保存"}
                  ，请选择左侧段落逐段核对。
                </p>
              )}
              <PanoramaTemplateEditor
                caps={caps}
                config={config}
                property={property}
                scenes={scenes}
                segments={segments}
                templates={state.data?.templates || []}
                busy={busy}
                patch={patch}
                editScene={editScene}
                replaceScenes={replaceScenes}
                editSegment={(id, text) =>
                  setSegments((previous) =>
                    previous.map((s) => (s.id === id ? { ...s, text } : s)),
                  )
                }
                changeTemplate={changeTemplate}
                changeLanguage={changeLanguage}
                invalidate={invalidate}
                saveTemplate={(name, update) =>
                  void act(async () => {
                    const existing = state.data?.templates?.find(
                      (t) => t.id === config.templateId,
                    );
                    await request("template-save", {
                      name,
                      config,
                      ...(update && existing
                        ? { id: existing.id, version: existing.version }
                        : {}),
                    });
                    void message.success(
                      update
                        ? "模板已更新，已保存草稿保留原快照"
                        : "已保存到我的模板，可在公共设置中选择",
                    );
                  })
                }
              />
              <section className="panel panorama-review">
                <PanoramaResult job={job} busy={busy} act={act} />
              </section>
              <section className="panel panorama-history">
                <h2>本机生成记录</h2>
                <Table<PanoramaJob>
                  rowKey="id"
                  size="small"
                  dataSource={state.data?.jobs || []}
                  pagination={{ pageSize: 5 }}
                  scroll={{ x: 650 }}
                  columns={[
                    {
                      title: "房源",
                      dataIndex: "property",
                      render: (p: PanoramaProperty) => p.title,
                    },
                    {
                      title: "状态",
                      dataIndex: "status",
                      render: (s: PanoramaJob["status"]) => statusNames[s],
                    },
                    {
                      title: "阶段",
                      dataIndex: "stage",
                      render: (s: PanoramaJob["stage"]) => stageNames[s],
                    },
                    {
                      title: "创建时间",
                      dataIndex: "createdAt",
                      render: (v) => new Date(v).toLocaleString(),
                    },
                    {
                      title: "操作",
                      render: (_, value) => (
                        <Button
                          type="link"
                          onClick={() => setSelectedJob(value.id)}
                        >
                          查看
                        </Button>
                      ),
                    },
                  ]}
                />
              </section>
            </>
          )}
        </>
      )}
    </>
  );
}
