import { useEffect, useRef, useState } from "react";
import {
  App,
  Button,
  Collapse,
  Empty,
  Form,
  Modal,
  Select,
  Segmented,
  Skeleton,
  Switch,
  Table,
  Tag,
  Tabs,
} from "antd";
import {
  ArrowRight,
  AudioLines,
  Check,
  ChevronRight,
  Film,
  House,
  Image,
  Mic,
  Plus,
  Save,
  Sparkles,
  UserRound,
  Volume2,
} from "lucide-react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { demoApi, isLive } from "@keagent/api-client";
import { useAvatarLibrary } from "../lib/avatarLibrary";
import { useVoiceLibrary } from "../lib/voiceLibrary";
import type {
  ProductionConfig,
  Resource,
  ResourceRef,
  ResourceType,
  VideoMode,
} from "@keagent/shared-types";
import { useWorkspace } from "../lib/workspace";
import { PageHeader, formatDate, formatPrice } from "../components/common";
import { PropertyPicker } from "../components/PropertyPicker";
import { ResourcePicker } from "../components/ResourcePicker";
import { PanoramaStudio } from "../components/PanoramaStudio";

function TemplateField({
  label,
  resource,
  onClick,
}: {
  label: string;
  resource?: Resource;
  onClick: () => void;
}) {
  return (
    <div className="template-field">
      <span className="form-label">{label}</span>
      <button type="button" className="template-field-button" onClick={onClick}>
        {resource ? (
          <img src={resource.thumbnail} alt="" />
        ) : (
          <Film size={22} />
        )}
        <span>
          <strong>{resource?.name ?? `选择${label}`}</strong>
          <small>
            {resource
              ? `${resource.category} · v${resource.version}`
              : "查看可用模板与预览"}
          </small>
        </span>
        <ChevronRight size={17} />
      </button>
    </div>
  );
}

export function StudioPage() {
  return (
    <Tabs
      tabBarStyle={{ marginBottom: 0 }}
      defaultActiveKey={window.desktop ? "panorama" : "existing"}
      items={[
        { key: "panorama", label: "全景工作流", children: <PanoramaStudio /> },
        {
          key: "existing",
          label: "原有任务",
          children: <ExistingStudioPage />,
        },
      ]}
    />
  );
}

function ExistingStudioPage() {
  const ownAvatars = useAvatarLibrary();
  const voiceLibrary = useVoiceLibrary();
  const { data } = useWorkspace();
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [config, setConfig] = useState<ProductionConfig>();
  const [propertyOpen, setPropertyOpen] = useState(false);
  const [resourceType, setResourceType] = useState<ResourceType>();
  const [busy, setBusy] = useState(false);
  const [saveState, setSaveState] = useState("配置已保存");
  const [incoming, setIncoming] = useState<string[]>([]);
  const savedFingerprint = useRef("");
  const handledIncoming = useRef("");
  const submission = useRef({ fingerprint: "", key: "" });
  const incomingKey = searchParams.getAll("propertyId").join(",");

  useEffect(() => {
    if (data && !config) {
      savedFingerprint.current = JSON.stringify(data.draft);
      setConfig(structuredClone(data.draft));
    }
  }, [data, config]);

  useEffect(() => {
    if (
      !data ||
      !config ||
      !incomingKey ||
      handledIncoming.current === incomingKey
    )
      return;
    handledIncoming.current = incomingKey;
    const ids = incomingKey
      .split(",")
      .filter((id) => data.properties.some((property) => property.id === id));
    if (!ids.length) {
      void message.warning("房源不存在，请从房源中心重新选择。");
      return;
    }
    if (ids.every((id) => config.propertyIds.includes(id))) return;
    if (config.propertyIds.length) setIncoming(ids);
    else setConfig({ ...config, propertyIds: ids });
  }, [incomingKey, config, data, message]);

  useEffect(() => {
    if (!config || JSON.stringify(config) === savedFingerprint.current) return;
    let current = true;
    setSaveState("自动保存中…");
    void demoApi
      .saveDraft(config)
      .then(() => {
        savedFingerprint.current = JSON.stringify(config);
        if (current) setSaveState("配置已保存");
      })
      .catch((error: unknown) => {
        if (current) {
          setSaveState("保存失败，请重试");
          void message.error(
            error instanceof Error ? error.message : "草稿保存失败",
          );
        }
      });
    return () => {
      current = false;
    };
  }, [config, message]);

  if (!data || !config) return <Skeleton active paragraph={{ rows: 12 }} />;
  const patch = (updates: Partial<ProductionConfig>) =>
    setConfig({ ...config, ...updates });
  const selectedProperties = config.propertyIds
    .map((id) => data.properties.find((property) => property.id === id))
    .filter((property) => !!property);
  const firstProperty = selectedProperties[0];
  const resource = (ref: ResourceRef) =>
    data.resources.find(
      (item) => item.id === ref.id && item.version === ref.version,
    );
  const name = (ref: ResourceRef) => resource(ref)?.name ?? "未选择";
  const voices = isLive
    ? [
        ...(voiceLibrary.data?.publicVoices || []).map((item) => ({
          ...item,
          status: "ready" as const,
          description: "管理员提供的公共音色",
          isDefault: false,
        })),
        ...(voiceLibrary.data?.voices || [])
          .filter((item) => item.status === "ready")
          .map((item) => ({
            ...item,
            status: "ready" as const,
            description: "本人的专属音色",
            isDefault: false,
          })),
      ]
    : data.voices;
  const voice = voices.find((item) => item.id === config.voiceId);
  const avatars = isLive
    ? (ownAvatars.data?.avatars || [])
        .filter((item) => item.status === "ready")
        .map((item) => ({
          ...item,
          image: "",
          status: "ready" as const,
          isDefault: false,
        }))
    : data.avatars;
  const avatar = avatars.find((item) => item.id === config.avatarId);
  const selectedResource =
    resourceType === "video"
      ? config.videoTemplate
      : resourceType === "style"
        ? config.styleTemplate
        : resourceType === "cover"
          ? config.coverTemplate
          : config.subtitleTemplate;
  const chooseResource = (ref: ResourceRef) => {
    if (resourceType === "video") patch({ videoTemplate: ref });
    else if (resourceType === "style") patch({ styleTemplate: ref });
    else if (resourceType === "cover") patch({ coverTemplate: ref });
    else if (resourceType === "subtitle") patch({ subtitleTemplate: ref });
    setResourceType(undefined);
  };
  const save = async () => {
    try {
      await demoApi.saveDraft(config);
      savedFingerprint.current = JSON.stringify(config);
      setSaveState("配置已保存");
      void message.success("当前配置已保存在本机演示数据中");
    } catch (error) {
      void message.error(
        error instanceof Error ? error.message : "保存失败，请重试",
      );
    }
  };
  const create = async () => {
    const fingerprint = JSON.stringify(config);
    if (submission.current.fingerprint !== fingerprint)
      submission.current = { fingerprint, key: crypto.randomUUID() };
    setBusy(true);
    try {
      const batch = await demoApi.createBatch(config, submission.current.key);
      void message.success(
        `已创建 ${config.propertyIds.length} 个独立视频任务（模拟）`,
      );
      navigate(`/studio/batches/${batch.id}`);
    } catch (error) {
      void message.error(
        error instanceof Error ? error.message : "创建失败，请检查配置后重试",
      );
    } finally {
      setBusy(false);
    }
  };
  const listen = () => {
    if (isLive) {
      navigate("/settings/voices");
      return;
    }
    if (!("speechSynthesis" in window)) {
      void message.info("当前环境不支持系统语音试听");
      return;
    }
    window.speechSynthesis.cancel();
    const speech = new SpeechSynthesisUtterance(
      "您好，我是您的房产顾问。今天带您看看这套采光通透的好房。",
    );
    speech.lang = "zh-CN";
    window.speechSynthesis.speak(speech);
    void message.info("正在播放系统演示语音，并非克隆音色");
  };

  return (
    <>
      <PageHeader
        title="AI 视频工厂"
        description="选好房源与模板，让每一套好房都有自己的视频。"
        actions={
          <Button
            onClick={() =>
              document
                .getElementById("production-history")
                ?.scrollIntoView({ behavior: "smooth" })
            }
          >
            生成记录
          </Button>
        }
      />
      <div className="studio-grid">
        <section className="config-panel panel">
          <div className="section-heading">
            <h2>
              <Film size={19} /> 视频生成配置
            </h2>
            <span className="muted">
              <Check size={13} /> {saveState}
            </span>
          </div>
          <Form layout="vertical" className="studio-form">
            <Form.Item label="视频模式">
              <Segmented
                block
                value={config.videoMode}
                onChange={(value) => patch({ videoMode: value as VideoMode })}
                options={[
                  {
                    value: "voiceover",
                    label: (
                      <span className="segmented-label">
                        <AudioLines size={17} />
                        纯口播
                      </span>
                    ),
                  },
                  {
                    value: "avatar",
                    label: (
                      <span className="segmented-label">
                        <UserRound size={17} />
                        经纪人露脸
                      </span>
                    ),
                  },
                ]}
              />
              <p className="form-hint">
                {config.videoMode === "voiceover"
                  ? "房源实景 + 口播配音 + 字幕，专注展现房子本身。"
                  : "经纪人数字人开场 + 房源实景，让好内容更有辨识度。"}
              </p>
            </Form.Item>
            <Form.Item
              label={
                <span className="label-between">
                  房源素材{" "}
                  <span className="muted">每套房源独立生成一条视频</span>
                </span>
              }
              required
            >
              <button
                type="button"
                className={`property-select-button ${selectedProperties.length ? "has-selection" : ""}`}
                onClick={() => setPropertyOpen(true)}
              >
                {selectedProperties.length ? (
                  <>
                    <div className="selected-property-stack">
                      {selectedProperties.slice(0, 3).map((property) => (
                        <img key={property.id} src={property.image} alt="" />
                      ))}
                    </div>
                    <span>
                      <strong>已选择 {selectedProperties.length} 套房源</strong>
                      <small>
                        {selectedProperties
                          .slice(0, 2)
                          .map((property) => property.community)
                          .join("、")}
                        {selectedProperties.length > 2 ? "等" : ""}
                      </small>
                    </span>
                    <span className="select-edit">
                      更改选择 <ChevronRight size={15} />
                    </span>
                  </>
                ) : (
                  <>
                    <span className="property-select-icon">
                      <House size={23} />
                    </span>
                    <span>
                      <strong>选择要生成视频的房源</strong>
                      <small>支持多选，使用同一套配置批量生成</small>
                    </span>
                    <Plus size={20} />
                  </>
                )}
              </button>
            </Form.Item>
            <div className="studio-form-divider" />
            <Form.Item label="提示词模板" required>
              <Select
                aria-label="提示词模板"
                value={config.promptTemplate.id}
                options={data.resources
                  .filter((item) => item.type === "prompt" && item.published)
                  .map((item) => ({ value: item.id, label: item.name }))}
                onChange={(id) => {
                  const item = data.resources.find((entry) => entry.id === id);
                  if (item)
                    patch({ promptTemplate: { id, version: item.version } });
                }}
              />
              <p className="form-hint">
                {resource(config.promptTemplate)?.description ??
                  "选择适合房源的口播表达方式。"}
              </p>
            </Form.Item>
            <div className="form-two-columns">
              <TemplateField
                label="视频模板"
                resource={resource(config.videoTemplate)}
                onClick={() => setResourceType("video")}
              />
              <TemplateField
                label="风格模板"
                resource={resource(config.styleTemplate)}
                onClick={() => setResourceType("style")}
              />
            </div>
            <TemplateField
              label="封面模板"
              resource={resource(config.coverTemplate)}
              onClick={() => setResourceType("cover")}
            />
            <div className="studio-form-divider" />
            <div className="form-two-columns">
              <Form.Item label="配音声音" required>
                <div className="inline-field">
                  <Select
                    aria-label="配音声音"
                    value={config.voiceId}
                    onChange={(voiceId) => patch({ voiceId })}
                    options={voices
                      .filter((item) => item.status === "ready")
                      .map((item) => ({ value: item.id, label: item.name }))}
                  />
                  <Button
                    aria-label="试听系统演示声音"
                    icon={<Volume2 size={16} />}
                    onClick={listen}
                  />
                </div>
                <p className="form-hint">
                  <Link to="/settings/voices">管理声音</Link> ·
                  {isLive ? "前往设置试听公共或本人音色" : "试听为系统演示语音"}
                </p>
              </Form.Item>
              {config.videoMode === "avatar" ? (
                <Form.Item label="经纪人形象" required>
                  <Select
                    aria-label="经纪人形象"
                    placeholder="请选择数字人形象"
                    value={config.avatarId}
                    onChange={(avatarId) => patch({ avatarId })}
                    options={avatars
                      .filter((item) => item.status === "ready")
                      .map((item) => ({ value: item.id, label: item.name }))}
                    notFoundContent={
                      <Link to="/settings/avatars">前往设置创建形象</Link>
                    }
                  />
                </Form.Item>
              ) : (
                <div className="voice-description">
                  <Mic size={17} />
                  <span>
                    {voice?.description ?? "选用默认声音，让观众记住你的表达。"}
                  </span>
                </div>
              )}
            </div>
            <div className="review-setting">
              <div>
                <strong>生成文案后人工审核</strong>
                <p>确认内容准确，再继续配音与剪辑。</p>
              </div>
              <Switch
                checked={config.requireScriptReview}
                onChange={(requireScriptReview) =>
                  patch({ requireScriptReview })
                }
                aria-label="生成文案后人工审核"
              />
            </div>
            <Collapse
              ghost
              items={[
                {
                  key: "advanced",
                  label: "高级设置",
                  children: (
                    <div className="form-two-columns">
                      <Form.Item label="画面比例">
                        <Select
                          aria-label="画面比例"
                          value={config.aspectRatio}
                          onChange={(aspectRatio) => patch({ aspectRatio })}
                          options={[
                            { value: "9:16", label: "9:16 竖屏" },
                            { value: "16:9", label: "16:9 横屏" },
                          ]}
                        />
                      </Form.Item>
                      <Form.Item label="导出分辨率">
                        <Select
                          aria-label="导出分辨率"
                          value={config.outputResolution}
                          onChange={(outputResolution) =>
                            patch({ outputResolution })
                          }
                          options={[
                            { value: "1080p", label: "1080p 高清" },
                            { value: "720p", label: "720p 标清" },
                          ]}
                        />
                      </Form.Item>
                      <div style={{ gridColumn: "1 / -1" }}>
                        <TemplateField
                          label="字幕模板"
                          resource={
                            config.subtitleTemplate
                              ? resource(config.subtitleTemplate)
                              : undefined
                          }
                          onClick={() => setResourceType("subtitle")}
                        />
                      </div>
                    </div>
                  ),
                },
              ]}
            />
          </Form>
        </section>
        <aside className="preview-panel panel">
          <div className="section-heading">
            <h2>
              <Image size={18} /> 效果预览
            </h2>
            <Tag>模板示意</Tag>
          </div>
          <div
            className={`studio-preview ${config.aspectRatio === "16:9" ? "landscape" : ""}`}
          >
            <img
              src={firstProperty?.image ?? "/media/interior-1.jpg"}
              alt="房源视频模板静态示意"
            />
            <div className="preview-property-caption">
              <span>
                {config.videoMode === "avatar"
                  ? "经纪人露脸 · 数字人开场"
                  : "实景好房 · 专业解读"}
              </span>
              <h3>{firstProperty?.community ?? "让每一套好房被看见"}</h3>
              <p>
                {firstProperty
                  ? `${firstProperty.layout} / ${firstProperty.areaSqm} ㎡ / ${formatPrice(firstProperty.priceCents)}`
                  : "选择房源，开始创作"}
              </p>
              <span className="preview-agent">
                {data.profile.name} · {data.profile.brokerage}
              </span>
            </div>
          </div>
          <p className="preview-disclaimer">
            静态模板示意，实际成片请在生成任务中查看。
          </p>
          <dl className="config-summary">
            <div>
              <dt>视频模板</dt>
              <dd>{name(config.videoTemplate)}</dd>
            </div>
            <div>
              <dt>风格模板</dt>
              <dd>{name(config.styleTemplate)}</dd>
            </div>
            <div>
              <dt>提示词</dt>
              <dd>{name(config.promptTemplate)}</dd>
            </div>
            <div>
              <dt>声音</dt>
              <dd>{voice?.name ?? "未选择"}</dd>
            </div>
            {config.videoMode === "avatar" && (
              <div>
                <dt>经纪人形象</dt>
                <dd>{avatar?.name ?? "未选择"}</dd>
              </div>
            )}
            <div>
              <dt>文案审核</dt>
              <dd>
                {config.requireScriptReview ? "人工审核后继续" : "自动继续"}
              </dd>
            </div>
          </dl>
          <div className="batch-summary">
            <House size={19} />
            <span>
              已选 <strong>{config.propertyIds.length}</strong> 套房源，将创建{" "}
              <strong>{config.propertyIds.length}</strong> 个视频任务
            </span>
          </div>
          <div className="studio-submit">
            <Button icon={<Save size={16} />} onClick={() => void save()}>
              保存配置
            </Button>
            <Button
              type="primary"
              icon={<Sparkles size={16} />}
              loading={busy}
              disabled={!config.propertyIds.length}
              onClick={() => void create()}
            >
              创建生成任务
            </Button>
          </div>
          {!config.propertyIds.length && (
            <p className="form-hint">请先选择至少一套房源。</p>
          )}
        </aside>
      </div>
      <section className="panel production-history" id="production-history">
        <div className="section-heading">
          <h2>最近生成批次</h2>
          <span className="muted">每套房源单独跟踪进度</span>
        </div>
        {data.batches.length ? (
          <Table
            rowKey="id"
            size="middle"
            pagination={{ pageSize: 5, hideOnSinglePage: true }}
            dataSource={[...data.batches].reverse()}
            columns={[
              {
                title: "生成批次",
                dataIndex: "id",
                render: (id: string) => (
                  <Link to={`/studio/batches/${id}`}>{id}</Link>
                ),
              },
              {
                title: "房源数量",
                render: (_, batch) => `${batch.taskIds.length} 套`,
              },
              {
                title: "生成方式",
                render: (_, batch) =>
                  batch.configSnapshot.videoMode === "voiceover"
                    ? "纯口播"
                    : "经纪人露脸",
              },
              {
                title: "任务情况",
                render: (_, batch) => {
                  const tasks = data.tasks.filter(
                    (item) => item.batchId === batch.id,
                  );
                  return `${tasks.filter((item) => item.status === "succeeded").length} 已完成 / ${tasks.filter((item) => item.status === "awaiting_review").length} 待审核`;
                },
              },
              {
                title: "创建时间",
                render: (_, batch) => formatDate(batch.createdAt),
              },
              {
                title: "",
                key: "action",
                render: (_, batch) => (
                  <Button
                    type="link"
                    onClick={() => navigate(`/studio/batches/${batch.id}`)}
                  >
                    查看批次 <ArrowRight size={14} />
                  </Button>
                ),
              },
            ]}
          />
        ) : (
          <Empty description="还没有生成记录，选择房源开始创作吧" />
        )}
      </section>
      <PropertyPicker
        open={propertyOpen}
        value={config.propertyIds}
        onClose={() => setPropertyOpen(false)}
        onConfirm={(propertyIds) => {
          patch({ propertyIds });
          setPropertyOpen(false);
        }}
      />
      {resourceType && (
        <ResourcePicker
          open
          type={resourceType}
          value={selectedResource}
          videoMode={config.videoMode}
          onClose={() => setResourceType(undefined)}
          onConfirm={chooseResource}
        />
      )}
      <Modal
        open={!!incoming.length}
        title="将房源带入视频工厂"
        onCancel={() => setIncoming([])}
        footer={
          <div className="button-row">
            <Button onClick={() => setIncoming([])}>保持原选择</Button>
            <Button
              onClick={() => {
                patch({ propertyIds: incoming });
                setIncoming([]);
              }}
            >
              替换已选房源
            </Button>
            <Button
              type="primary"
              onClick={() => {
                patch({
                  propertyIds: [
                    ...new Set([...config.propertyIds, ...incoming]),
                  ],
                });
                setIncoming([]);
              }}
            >
              合并到已选
            </Button>
          </div>
        }
      >
        <p>
          当前草稿已选择 {config.propertyIds.length}{" "}
          套房源。你可以合并带入的房源，或替换当前房源；其余生成配置保持不变。
        </p>
      </Modal>
    </>
  );
}
