import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Empty,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Select,
  Skeleton,
  Space,
  Table,
} from "antd";
import {
  ArrowDown,
  ArrowUp,
  ImagePlus,
  Play,
  Save,
  Trash2,
} from "lucide-react";
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
import { PageHeader } from "./common";
import { PanoramaSettings } from "./PanoramaSettings";
import { PanoramaResult } from "./PanoramaResult";
import { request, stageNames, statusNames } from "./panoramaClient";
import "./panorama.css";

export function PanoramaStudio() {
  const { data: workspace } = useWorkspace();
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
      voice: caps.voices.find((v) => v.language === "zh-CN")?.name || "",
      avatarId: caps.avatarId,
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
    setConfig(value.config);
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
  const changeTemplate = (id: string) => {
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
            openingTemplate: caps!.templates.find(
              (t) => t.id === config!.templateId,
            )!.opening,
            sceneTemplate: caps!.templates.find(
              (t) => t.id === config!.templateId,
            )!.scene,
            closingTemplate: caps!.templates.find(
              (t) => t.id === config!.templateId,
            )!.closing,
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
  return (
    <>
      <PageHeader
        title="全景视频工作流"
        description="导入全景、核对文案，再用配音时长驱动镜头与剪辑。"
      />
      {!enabled ? (
        <Alert
          type="info"
          showIcon
          title="在桌面客户端生成全景视频"
          description="此流程需要读取本机图片、生成配音并调用 FFmpeg。浏览器中的原有任务仍可查看。"
        />
      ) : (
        <>
          {(capabilities.error || state.error) && (
            <Alert
              type="error"
              showIcon
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
                  showIcon
                  title="尚未找到视频运行时"
                  description="请安装 FFmpeg / FFprobe 或设置 FFMPEG_PATH、FFPROBE_PATH 后重启客户端。可以先完成素材与文案审核。"
                />
              )}
              <div className="panorama-layout">
                <section
                  className="panel panorama-editor"
                  aria-label="全景制作配置"
                >
                  <h2>房源与全景素材</h2>
                  <Form layout="vertical" disabled={busy}>
                    <Form.Item label="房源">
                      <Select
                        value={property?.id}
                        placeholder="选择已录入的房源"
                        showSearch
                        optionFilterProp="label"
                        options={[
                          ...(workspace?.properties || []).map((p) => ({
                            value: p.id,
                            label: p.title,
                          })),
                          ...(property?.sample
                            ? [{ value: property.id, label: property.title }]
                            : []),
                        ]}
                        onChange={(id) => {
                          setProperty(
                            workspace?.properties.find((p) => p.id === id),
                          );
                          setScenes([]);
                          setDraft(undefined);
                          setSegments([]);
                        }}
                      />
                    </Form.Item>
                    <Space wrap>
                      <Button
                        icon={<ImagePlus size={16} />}
                        disabled={!property}
                        onClick={() =>
                          void act(async () => {
                            const added =
                              await request<PanoramaScene[]>("import");
                            setScenes((previous) =>
                              [...previous, ...added].slice(0, 20),
                            );
                            setDraft(undefined);
                            setSegments([]);
                          })
                        }
                      >
                        导入全景图
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
                            setScenes(sample.scenes);
                            setDraft(undefined);
                            setSegments([]);
                          })
                        }
                      >
                        <Button>使用 CC0 测试素材</Button>
                      </Popconfirm>
                    </Space>
                    <p className="muted">
                      支持 2:1 等距柱状 JPEG / PNG；宽度 2048–16384，单张不超过
                      50 MB。
                    </p>
                    {property?.sample && (
                      <Alert
                        showIcon
                        type="info"
                        title="独立测试场景，非在售房源"
                        description="两张全景来自 Poly Haven，不应作为同一套房源对外发布。"
                      />
                    )}
                    {!scenes.length && (
                      <Empty
                        image={Empty.PRESENTED_IMAGE_SIMPLE}
                        description="为每个空间添加全景图与已核对的说明"
                      />
                    )}
                    {scenes.map((scene, index) => (
                      <div className="panorama-scene" key={scene.id}>
                        <img src={scene.url} alt={`${scene.room}全景原图`} />
                        <div className="panorama-scene-fields">
                          <Form.Item label={`空间 ${index + 1}`}>
                            <Input
                              aria-label={`空间 ${index + 1} 名称`}
                              maxLength={80}
                              value={scene.room}
                              onChange={(e) =>
                                editScene(scene.id, { room: e.target.value })
                              }
                            />
                          </Form.Item>
                          <Form.Item label="空间说明">
                            <Input.TextArea
                              aria-label={`空间 ${index + 1} 说明`}
                              autoSize={{ minRows: 2, maxRows: 6 }}
                              maxLength={1500}
                              placeholder="只写这张全景图对应的已确认事实，供文案和配音使用"
                              value={scene.description}
                              onChange={(e) =>
                                editScene(scene.id, {
                                  description: e.target.value,
                                })
                              }
                            />
                          </Form.Item>
                          <Space wrap>
                            <label>
                              起始视角{" "}
                              <InputNumber
                                aria-label={`空间 ${index + 1} 起始视角`}
                                min={-180}
                                max={180}
                                value={scene.yaw}
                                onChange={(value) =>
                                  editScene(scene.id, { yaw: value ?? 0 })
                                }
                                addonAfter="°"
                              />
                            </label>
                            {[
                              [-1, ArrowUp, "上移"],
                              [1, ArrowDown, "下移"],
                            ].map(([offset, Icon, label]) => {
                              const direction = offset as number;
                              const MoveIcon = Icon as typeof ArrowUp;
                              return (
                                <Button
                                  key={direction}
                                  aria-label={`${label}空间 ${index + 1}`}
                                  icon={<MoveIcon size={15} />}
                                  disabled={
                                    index + direction < 0 ||
                                    index + direction >= scenes.length
                                  }
                                  onClick={() => {
                                    const next = [...scenes];
                                    [next[index], next[index + direction]] = [
                                      next[index + direction],
                                      next[index],
                                    ];
                                    setScenes(next);
                                    setDraft(undefined);
                                    setSegments([]);
                                  }}
                                />
                              );
                            })}
                            <Button
                              aria-label={`删除空间 ${index + 1}`}
                              danger
                              icon={<Trash2 size={15} />}
                              onClick={() => {
                                setScenes(
                                  scenes.filter((s) => s.id !== scene.id),
                                );
                                setDraft(undefined);
                                setSegments([]);
                              }}
                            />
                          </Space>
                        </div>
                      </div>
                    ))}
                    <PanoramaSettings
                      caps={caps}
                      config={config}
                      patch={patch}
                      changeTemplate={changeTemplate}
                      changeLanguage={changeLanguage}
                      invalidate={() => {
                        setDraft(undefined);
                        setSegments([]);
                      }}
                    />
                    <Button
                      type="primary"
                      block
                      loading={busy}
                      disabled={!property || !scenes.length}
                      onClick={() => void generate()}
                    >
                      生成分段文案，进入审核
                    </Button>
                  </Form>
                </section>
                <section
                  className="panel panorama-review"
                  aria-label="文案审核与成片预览"
                >
                  <h2>文案审核</h2>
                  <Select
                    aria-label="恢复已保存的草稿"
                    style={{ width: "100%" }}
                    placeholder="恢复已保存的草稿"
                    value={draft?.id}
                    options={(state.data?.drafts || []).map((d) => ({
                      value: d.id,
                      label: `${d.property.title} · ${new Date(d.createdAt).toLocaleString()} · r${d.revision}`,
                    }))}
                    onChange={(id) => {
                      const value = state.data?.drafts.find((d) => d.id === id);
                      if (value) restore(value);
                    }}
                    disabled={busy}
                  />
                  {!draft ? (
                    <Empty
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description="生成后在这里逐段核对，再确认制作"
                    />
                  ) : (
                    <>
                      <p className="muted">
                        r{draft.revision} · 每个空间对应自己的文案和配音。
                        {dirty ? "有未保存修改" : "文案已保存"}
                      </p>
                      {segments.map((segment, index) => (
                        <Form.Item
                          key={segment.id}
                          label={
                            segment.kind === "opening"
                              ? "开场"
                              : segment.kind === "closing"
                                ? "结尾"
                                : scenes.find((s) => s.id === segment.sceneId)
                                    ?.room
                          }
                        >
                          <Input.TextArea
                            aria-label={`审核${segment.kind === "opening" ? "开场" : segment.kind === "closing" ? "结尾" : "空间"}文案`}
                            disabled={busy}
                            autoSize={{ minRows: 2, maxRows: 8 }}
                            maxLength={2000}
                            value={segment.text}
                            onChange={(e) =>
                              setSegments((previous) =>
                                previous.map((s, i) =>
                                  i === index
                                    ? { ...s, text: e.target.value }
                                    : s,
                                ),
                              )
                            }
                          />
                        </Form.Item>
                      ))}
                      <Space wrap>
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
                                {
                                  id: approved.id,
                                  revision: approved.revision,
                                },
                              );
                              setSelectedJob(created.id);
                              void message.success("审核已确认，任务开始执行");
                            })
                          }
                        >
                          确认文案并制作
                        </Button>
                      </Space>
                    </>
                  )}
                  <PanoramaResult job={job} busy={busy} act={act} />
                </section>
              </div>
              <section className="panel panorama-history">
                <h2>本机生成记录</h2>
                <p className="muted">
                  按登录账号保存素材、草稿和执行检查点。更换电脑需要重新导入素材；云端原有任务在另一个标签内。
                </p>
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
                      render: (status: PanoramaJob["status"]) =>
                        statusNames[status],
                    },
                    {
                      title: "阶段",
                      dataIndex: "stage",
                      render: (stage: PanoramaJob["stage"]) =>
                        stageNames[stage],
                    },
                    {
                      title: "创建时间",
                      dataIndex: "createdAt",
                      render: (value) => new Date(value).toLocaleString(),
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
