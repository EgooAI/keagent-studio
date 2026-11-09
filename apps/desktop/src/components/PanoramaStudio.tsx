import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Drawer,
  Empty,
  Input,
  Select,
  Skeleton,
  Spin,
  Tag,
} from "antd";
import {
  Check,
  Clapperboard,
  Clock3,
  FileText,
  House,
  Images,
  Sparkles,
  Video,
} from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import type {
  PanoramaCapabilities,
  PanoramaConfig,
  PanoramaDraft,
  PanoramaJob,
  PanoramaState,
} from "@keagent/shared-types";
import { useWorkspace } from "../lib/workspace";
import { useVoiceLibrary } from "../lib/voiceLibrary";
import { useAvatarLibrary } from "../lib/avatarLibrary";
import { PageHeader } from "./common";
import { FactoryResult } from "./FactoryResult";
import { request, statusNames } from "./panoramaClient";
import "./video-factory.css";

type Phase = "choose" | "preparing" | "ready" | "result" | "error";

export function PanoramaStudio() {
  const workspace = useWorkspace();
  const voices = useVoiceLibrary();
  const avatars = useAvatarLibrary();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const enabled = !!window.desktop;
  const caps = useQuery({
    queryKey: ["panorama-capabilities"],
    queryFn: () => request<PanoramaCapabilities>("capabilities"),
    enabled,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: "always",
  });
  const state = useQuery({
    queryKey: ["panorama-state"],
    queryFn: () => request<PanoramaState>("state"),
    enabled,
    refetchInterval: 2500,
    retry: false,
  });
  const [propertyId, setPropertyId] = useState(params.get("propertyId") || "");
  const [templateId, setTemplateId] = useState("");
  const [phase, setPhase] = useState<Phase>("choose");
  const [draft, setDraft] = useState<PanoramaDraft>();
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState("");
  const [createdJob, setCreatedJob] = useState<PanoramaJob>();
  const [history, setHistory] = useState(false);
  const sequence = useRef(0);
  const preparation = useRef<
    | {
        key: string;
        promise: Promise<PanoramaDraft>;
      }
    | undefined
  >(undefined);
  const confirming = useRef(false);
  const defaultTemplateApplied = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sequence.current++;
    };
  }, []);
  const properties = useMemo(
    () =>
      Array.from(
        new Map(
          [
            ...(workspace.data?.properties || []),
            ...(state.data?.properties || []),
            ...(draft ? [draft.property] : []),
          ].map((p) => [p.id, p]),
        ).values(),
      ),
    [workspace.data, state.data?.properties, draft],
  );
  const property = properties.find((p) => p.id === propertyId);
  const templates = useMemo(
    () =>
      (caps.data?.templates || []).map((t) => ({
        id: t.id,
        version: t.version,
        name: t.name,
        description: t.description || "按房源图片顺序生成视频介绍。",
        config: {
          templateId: t.id,
          ...t.production?.config,
          openingTemplate: t.opening,
          sceneTemplate: t.scene,
          closingTemplate: t.closing,
        } as Partial<PanoramaConfig>,
      })),
    [caps.data],
  );
  const template = templates.find((t) => t.id === templateId);
  useEffect(() => {
    if (defaultTemplateApplied.current || !caps.data || !workspace.data) return;
    defaultTemplateApplied.current = true;
    const preferred = workspace.data.profile.defaults.videoTemplate;
    if (
      !templateId &&
      phase === "choose" &&
      templates.some(
        (t) => t.id === preferred.id && t.version === preferred.version,
      )
    )
      setTemplateId(preferred.id);
  }, [caps.data, workspace.data, templates, templateId, phase]);
  useEffect(() => {
    if (phase === "choose" && caps.data && templateId && !template)
      setTemplateId("");
  }, [caps.data, templateId, template, phase]);
  const config = useMemo(() => {
    if (!caps.data || !template) return undefined;
    const value = { ...caps.data.defaultConfig, ...template.config };
    const preferred = workspace.data?.profile.defaults.voiceId;
    const own =
      voices.data?.voices.filter(
        (v) => v.status === "ready" && v.language === value.language,
      ) || [];
    const publicVoices =
      voices.data?.publicVoices.filter((v) => v.language === value.language) ||
      [];
    const personal =
      own.find((v) => v.id === preferred) ||
      (value.ttsProvider === "personal" ? own[0] : undefined);
    const publicVoice =
      publicVoices.find((v) => v.id === preferred) || publicVoices[0];
    value.ttsProvider = caps.data.managedVoices
      ? personal
        ? "personal"
        : "volcengine"
      : "system";
    value.voice =
      personal?.id ||
      publicVoice?.id ||
      (!caps.data.managedVoices
        ? caps.data.voices.find((v) => v.language === value.language)?.name
        : "") ||
      "";
    value.avatarId =
      avatars.data?.avatars.find(
        (a) =>
          a.id === workspace.data?.profile.defaults.avatarId &&
          a.status === "ready",
      )?.id ||
      avatars.data?.avatars.find((a) => a.status === "ready")?.id ||
      "";
    value.scriptProvider = "ai";
    if (property?.sample && property.id === "panorama-cc0-sample") {
      value.ttsProvider = "system";
      value.voice =
        caps.data.voices.find((v) => v.language === value.language)?.name || "";
      value.scriptProvider = "template";
      value.avatarId = "";
    }
    return value;
  }, [
    caps.data,
    template,
    voices.data,
    avatars.data,
    workspace.data?.profile.defaults,
    property,
  ]);
  const job = state.data?.jobs.find((j) => j.id === jobId) || createdJob;
  const running = state.data?.jobs.find((j) => j.status === "running");
  useEffect(() => {
    if (running && !jobId && phase === "choose" && !propertyId) {
      setJobId(running.id);
      setPhase("result");
    }
  }, [running, jobId, phase, propertyId]);
  useEffect(() => {
    if (!enabled || !property || !config || phase !== "choose") return;
    const token = ++sequence.current;
    setPhase("preparing");
    setError("");
    const key = JSON.stringify({
      propertyId: property.id,
      config,
      templateVersion: template?.version,
    });
    if (!preparation.current || preparation.current.key !== key)
      preparation.current = {
        key,
        promise: request<PanoramaDraft>("prepare", {
          propertyId: property.id,
          config,
          templateVersion: template?.version,
        }),
      };
    void preparation.current.promise
      .then((value) => {
        if (!mounted.current || sequence.current !== token) return;
        setDraft(value);
        setTexts(Object.fromEntries(value.segments.map((s) => [s.id, s.text])));
        setPhase("ready");
        void queryClient.invalidateQueries({ queryKey: ["panorama-state"] });
      })
      .catch((cause) => {
        if (!mounted.current || sequence.current !== token) return;
        setError(
          cause instanceof Error ? cause.message : "文案准备失败，请重试",
        );
        setPhase("error");
        if (preparation.current?.key === key) preparation.current = undefined;
      });
  }, [enabled, property, config, phase, queryClient]);
  const reset = (nextProperty = propertyId, nextTemplate = templateId) => {
    sequence.current++;
    preparation.current = undefined;
    setPropertyId(nextProperty);
    setTemplateId(nextTemplate);
    setDraft(undefined);
    setTexts({});
    setJobId("");
    setCreatedJob(undefined);
    setError("");
    setPhase("choose");
  };
  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
      await queryClient.invalidateQueries({ queryKey: ["panorama-state"] });
    } catch (cause) {
      void message.error(
        cause instanceof Error ? cause.message : "操作失败，请重试",
      );
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const confirm = async () => {
    if (!draft || confirming.current) return;
    confirming.current = true;
    await act(async () => {
      const resolvedConfig =
        config && config.language === draft.config.language
          ? {
              ...draft.config,
              voice: config.voice,
              ttsProvider: config.ttsProvider,
              avatarId: config.avatarId,
            }
          : draft.config;
      const changed =
        draft.segments.some((s) => texts[s.id] !== s.text) ||
        JSON.stringify(resolvedConfig) !== JSON.stringify(draft.config);
      const saved = changed
        ? await request<PanoramaDraft>("save", {
            id: draft.id,
            revision: draft.revision,
            config: resolvedConfig,
            segments: draft.segments.map((s) => ({ ...s, text: texts[s.id] })),
          })
        : draft;
      setDraft(saved);
      const value = await request<PanoramaJob>("start", {
        id: saved.id,
        revision: saved.revision,
        confirmed: true,
      });
      setCreatedJob(value);
      setJobId(value.id);
      setPhase("result");
    });
    confirming.current = false;
  };
  const resume = (value: PanoramaDraft) => {
    sequence.current++;
    setPropertyId(value.property.id);
    setTemplateId(value.config.templateId);
    setDraft(value);
    setTexts(Object.fromEntries(value.segments.map((s) => [s.id, s.text])));
    setPhase("ready");
    setHistory(false);
    setError("");
  };
  const waiting = phase === "preparing" || busy;
  const step = phase === "result" ? 2 : phase === "ready" ? 1 : 0;
  const readyConfig = draft?.config || config;
  const voiceMissing = !!readyConfig && !(config?.voice || readyConfig.voice);
  const runtimeError = caps.error || state.error || workspace.error;
  return (
    <div className="video-factory">
      <PageHeader
        title="AI 视频工厂"
        description="选好房源和模板，确认一次文案，等待视频完成。"
        actions={
          <Button icon={<Clock3 size={16} />} onClick={() => setHistory(true)}>
            我的视频
          </Button>
        }
      />
      <div className="factory-steps" aria-label="视频制作流程">
        {[
          { icon: House, label: "选择房源和模板" },
          { icon: FileText, label: "确认文案" },
          { icon: Video, label: "生成视频" },
        ].map((item, index) => (
          <div
            className={`factory-step ${step === index ? "current" : step > index ? "done" : ""}`}
            key={item.label}
          >
            <span>
              {step > index ? <Check size={17} /> : <item.icon size={17} />}
            </span>
            {item.label}
          </div>
        ))}
      </div>
      {!enabled && (
        <Alert
          type="info"
          showIcon
          title="请在桌面客户端制作视频"
          description="这里会使用房源的真实图片制作视频。"
        />
      )}
      {runtimeError && (
        <Alert
          type="error"
          title="暂时无法加载创作资料"
          description={runtimeError.message}
          action={
            <Button
              onClick={() => {
                void caps.refetch();
                void state.refetch();
                void workspace.refetch();
              }}
            >
              重新加载
            </Button>
          }
        />
      )}
      {enabled && (!caps.data || !state.data || !workspace.data) ? (
        <Skeleton active />
      ) : (
        <>
          {phase !== "result" && (
            <section
              className="panel factory-selection"
              aria-label="选择房源和模板"
            >
              <div className="factory-section-heading">
                <div>
                  <span className="factory-eyebrow">开始创作</span>
                  <h2>为一套房源，制作一条视频</h2>
                </div>
                <Sparkles size={24} />
              </div>
              <div className="factory-select-grid">
                <label>
                  <span>房源</span>
                  <Select
                    aria-label="选择房源"
                    size="large"
                    showSearch
                    optionFilterProp="label"
                    placeholder="选择要制作的房源"
                    value={propertyId || undefined}
                    disabled={!enabled || waiting}
                    options={properties.map((p) => ({
                      value: p.id,
                      label: p.title,
                    }))}
                    onChange={(id) => reset(id)}
                  />
                </label>
                <label>
                  <span>视频模板</span>
                  <Select
                    aria-label="选择视频模板"
                    size="large"
                    placeholder="选择一种视频风格"
                    value={templateId || undefined}
                    disabled={!enabled || waiting}
                    options={templates.map((t) => ({
                      value: t.id,
                      label: `${t.name} · ${t.version}`,
                    }))}
                    onChange={(id) => reset(propertyId, id)}
                  />
                </label>
              </div>
              <div className="factory-selection-footer">
                <p>{template?.description || "图片将按房源素材的顺序排列。"}</p>
                <Link to="/properties">管理房源与素材</Link>
              </div>
              {property?.sample && (
                <p className="factory-ai-note">
                  内置测试素材来自两个独立场景，不代表真实在售房源。使用模板文案与本机配音，无云端生成费用，可测试成片预览与下载。
                </p>
              )}
            </section>
          )}
          {phase === "choose" && (
            <section className="panel factory-empty">
              <div className="factory-empty-icon">
                <Clapperboard size={38} />
              </div>
              <h2>你选房源，AI 来准备</h2>
              <p>
                每张图片都有对应的介绍文案，确认后自动处理图片、配音并合成视频。
              </p>
              {!properties.length && (
                <Link to="/properties">先去添加一套房源</Link>
              )}
              {enabled && caps.data && !templates.length && (
                <p>暂无已上架的视频模板，请联系管理员添加。</p>
              )}
              {enabled && (
                <Button
                  type="link"
                  loading={caps.isFetching}
                  onClick={() => void caps.refetch()}
                >
                  刷新视频模板
                </Button>
              )}
            </section>
          )}
          {phase === "preparing" && (
            <section className="panel factory-waiting" role="status">
              <Spin size="large" />
              <h2>正在为这套房源准备文案</h2>
              <p>按图片顺序整理素材，并套用你选择的视频模板。</p>
            </section>
          )}
          {phase === "error" && (
            <section className="panel factory-error">
              <Alert
                showIcon
                type="error"
                title="文案还没有准备好"
                description={error}
              />
              <div className="factory-error-actions">
                <Button type="primary" onClick={() => setPhase("choose")}>
                  重新准备
                </Button>
                <Link
                  to={propertyId ? `/properties/${propertyId}` : "/properties"}
                >
                  查看房源素材
                </Link>
              </div>
            </section>
          )}
          {phase === "ready" && draft && (
            <section className="panel factory-script" aria-label="整条视频文案">
              <div className="factory-section-heading">
                <div>
                  <span className="factory-eyebrow">文案已准备好</span>
                  <h2>{draft.property.title}</h2>
                  <p>
                    {draft.scenes.length}{" "}
                    张图片，按以下顺序组成视频。可以直接修改文案，然后一次确认。
                  </p>
                </div>
                <Tag color="green">
                  <Check size={13} /> 等待确认
                </Tag>
              </div>
              {draft.segments
                .filter((s) => s.kind === "opening")
                .map((s) => (
                  <label className="factory-bookend" key={s.id}>
                    <span>开场介绍</span>
                    <Input.TextArea
                      aria-label="开场介绍"
                      autoSize={{ minRows: 2, maxRows: 5 }}
                      maxLength={2000}
                      value={texts[s.id]}
                      disabled={busy}
                      onChange={(e) =>
                        setTexts((v) => ({ ...v, [s.id]: e.target.value }))
                      }
                    />
                  </label>
                ))}
              <div className="factory-script-list">
                {draft.scenes.map((scene, index) => {
                  const segment = draft.segments.find(
                    (s) => s.kind === "scene" && s.sceneId === scene.id,
                  );
                  return (
                    <article className="factory-image-script" key={scene.id}>
                      <div className="factory-photo">
                        <img
                          src={scene.originalUrl || scene.url}
                          alt={`第 ${index + 1} 张房源图片`}
                        />
                        <span>{String(index + 1).padStart(2, "0")}</span>
                      </div>
                      <div className="factory-image-copy">
                        <div className="factory-image-heading">
                          <Images size={16} />
                          <strong>{scene.room}</strong>
                        </div>
                        {segment && (
                          <Input.TextArea
                            aria-label={`第 ${index + 1} 张图片文案`}
                            value={texts[segment.id]}
                            disabled={busy}
                            maxLength={2000}
                            autoSize={{ minRows: 3, maxRows: 8 }}
                            onChange={(e) =>
                              setTexts((v) => ({
                                ...v,
                                [segment.id]: e.target.value,
                              }))
                            }
                          />
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
              {draft.segments
                .filter((s) => s.kind === "closing")
                .map((s) => (
                  <label className="factory-bookend" key={s.id}>
                    <span>结束介绍</span>
                    <Input.TextArea
                      aria-label="结束介绍"
                      autoSize={{ minRows: 2, maxRows: 5 }}
                      maxLength={2000}
                      value={texts[s.id]}
                      disabled={busy}
                      onChange={(e) =>
                        setTexts((v) => ({ ...v, [s.id]: e.target.value }))
                      }
                    />
                  </label>
                ))}
              {voiceMissing && (
                <Alert
                  type="info"
                  title="还没有可用的配音声音"
                  description={
                    <span>
                      请先到<Link to="/settings/voices">声音设置</Link>
                      配置声音，再开始生成。
                    </span>
                  }
                />
              )}
              <div className="factory-confirm">
                <p>确认后自动完成图片处理、配音和视频合成。</p>
                <Button
                  type="primary"
                  size="large"
                  icon={<Sparkles size={17} />}
                  loading={busy}
                  disabled={
                    voiceMissing ||
                    !!running ||
                    draft.segments.some((s) => !texts[s.id]?.trim()) ||
                    !caps.data?.ffmpeg ||
                    !caps.data.ffprobe
                  }
                  onClick={() => void confirm()}
                >
                  确认文案，开始生成
                </Button>
              </div>
            </section>
          )}
          {phase === "result" && (
            <FactoryResult
              job={job}
              busy={busy}
              act={act}
              onNew={() => reset("", templateId)}
            />
          )}
        </>
      )}
      <Drawer
        title="我的视频"
        open={history}
        onClose={() => setHistory(false)}
        size="large"
      >
        {!!state.data?.jobs.length && (
          <div className="factory-history-list">
            {state.data.jobs.map((value) => (
              <button
                className="factory-history-item"
                key={value.id}
                onClick={() => {
                  sequence.current++;
                  setJobId(value.id);
                  setCreatedJob(undefined);
                  setPhase("result");
                  setHistory(false);
                }}
              >
                {value.coverUrl ? (
                  <img src={value.coverUrl} alt="" />
                ) : (
                  <Video size={25} />
                )}
                <span>
                  <strong>{value.property.title}</strong>
                  <small>{new Date(value.createdAt).toLocaleString()}</small>
                </span>
                <Tag>{statusNames[value.status]}</Tag>
              </button>
            ))}
          </div>
        )}
        {!!state.data?.drafts.filter((d) => d.confirmation === "whole")
          .length && (
          <>
            <h3>待确认的文案</h3>
            {state.data.drafts
              .filter(
                (d) =>
                  d.confirmation === "whole" &&
                  !state.data.jobs.some((j) => j.draftId === d.id),
              )
              .map((value) => (
                <button
                  className="factory-history-item"
                  key={value.id}
                  onClick={() => resume(value)}
                >
                  <FileText size={24} />
                  <span>
                    <strong>{value.property.title}</strong>
                    <small>{value.scenes.length} 张图片 · 继续制作</small>
                  </span>
                </button>
              ))}
          </>
        )}
        {!state.data?.jobs.length &&
          !state.data?.drafts.some((d) => d.confirmation === "whole") && (
            <Empty description="还没有制作记录" />
          )}
      </Drawer>
    </div>
  );
}
