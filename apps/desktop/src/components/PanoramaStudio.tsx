import { useEffect, useMemo, useRef, useState } from "react";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Drawer,
  Empty,
  Input,
  Modal,
  Pagination,
  Select,
  Space,
  Table,
  Tabs,
  Tooltip,
} from "antd";
import {
  ChevronDown,
  ChevronUp,
  Clapperboard,
  House,
  Pause,
  Play,
  Search,
} from "lucide-react";
import {
  Link,
  useBlocker,
  useNavigate,
  useLocation,
  useSearchParams,
} from "react-router-dom";
import type {
  PanoramaDraft,
  PanoramaScene,
  PanoramaSegment,
} from "@keagent/shared-types";
import { authRequest, isLive } from "@keagent/api-client";
import {
  estimateBatchCost,
  estimateBreakdownText,
  estimateSummaryText,
  ESTIMATED_CHARS_PER_VIDEO,
  type CreditPricing,
} from "../lib/creditEstimate";
import { useVoiceLibrary } from "../lib/voiceLibrary";
import { useWorkspace } from "../lib/workspace";
import { PageHeader, formatDate } from "./common";
import { FactoryPicker } from "./FactoryPicker";
import { FactoryImagePicker } from "./FactoryImagePicker";
import {
  FactoryRenderSettings,
  renderKeys,
  renderOverrides,
  renderSettingsError,
  type RenderEdits,
  type RenderSettings,
} from "./FactoryRenderSettings";
import { FactoryPhaseTag, FactoryTaskDetail } from "./FactoryResult";
import {
  factoryRequest,
  pairKey,
  phaseLabel,
  templateKey,
  type FactoryAction,
  type FactoryActionResult,
  type FactoryCatalog,
  type FactoryDetail,
  type FactoryIssue,
  type FactoryList,
  type FactoryOpeningClip,
  type FactoryPair,
  type FactoryProperties,
  type FactoryProperty,
  type FactoryRow,
} from "./factoryClient";
import { request, stageNames } from "./panoramaClient";
import "./video-factory.css";

const tabs = [
  ["all", "全部"],
  ["preparing", "准备中"],
  ["review", "待审核"],
  ["queued", "排队"],
  ["running", "制作中"],
  ["done", "完成"],
  ["failed", "失败"],
  ["canceled", "取消"],
];

function TaskStep({ row }: { row: FactoryRow }) {
  if (row.phase !== "running") {
    return row.error ? (
      <Tooltip title={row.error}>
        <span>{row.error}</span>
      </Tooltip>
    ) : (
      "—"
    );
  }

  const stage = (row.stage && stageNames[row.stage]) || "检查配置";
  const progress = Number.isFinite(row.progress)
    ? Math.max(0, Math.min(100, row.progress))
    : undefined;
  return (
    <div className="factory-task-step">
      <span>
        {stage}
        {progress !== undefined && ` ${progress}%`}
      </span>
      <progress
        className="factory-task-progress"
        aria-label={`${row.propertyTitle}的制作进度`}
        max={100}
        value={progress}
      />
    </div>
  );
}

const actions: {
  action: FactoryAction;
  label: string;
  matches: (row: FactoryRow) => boolean;
}[] = [
  {
    action: "confirm",
    label: "确认文案并入队",
    matches: (row) => row.phase === "review",
  },
  {
    action: "withdraw",
    label: "撤回",
    matches: (row) => row.phase === "queued" && !row.started,
  },
  {
    action: "retry",
    label: "重试",
    matches: (row) =>
      ["failed", "archiveFailed", "canceled"].includes(row.phase),
  },
  {
    action: "cancel",
    label: "取消任务",
    matches: (row) =>
      ["pending", "preparing", "review", "queued", "running"].includes(
        row.phase,
      ),
  },
];

export function PanoramaStudio() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const creating = params.has("view")
    ? params.get("view") === "create"
    : location.pathname.endsWith("/create") || params.has("propertyId");
  function changeView(view: string) {
    setParams((current) => {
      current.set("view", view);
      return current;
    });
  }
  const navigate = useNavigate();
  const initialProperty = params.get("propertyId");
  const { modal, message } = App.useApp();
  const client = useQueryClient();
  const desktop = !!window.desktop;
  const voices = useVoiceLibrary();
  const { data: workspace } = useWorkspace();
  const [propertyIds, setPropertyIds] = useState<string[]>(() =>
    initialProperty ? [initialProperty] : [],
  );
  const [templateIds, setTemplateIds] = useState<string[]>([]);
  const [knownProperties, setKnownProperties] = useState<
    Record<string, string>
  >({});
  const [voiceId, setVoiceId] = useState<string>();
  const [batchRenderEdits, setBatchRenderEdits] = useState<RenderEdits>({});
  const [openingAuthorized, setOpeningAuthorized] = useState(false);
  const [excluded, setExcluded] = useState(new Set<string>());
  const [expanded, setExpanded] = useState(false);
  const [pairPage, setPairPage] = useState(1);
  const [picker, setPicker] = useState<"property" | "template">();
  const [imagePicker, setImagePicker] = useState(false);
  const [sceneIdsByProperty, setSceneIdsByProperty] = useState<
    Record<string, string[]>
  >({});
  const [issues, setIssues] = useState<FactoryIssue[]>([]);
  const submission = useRef<{ signature: string; id: string } | undefined>(
    undefined,
  );
  const [search, setSearch] = useState("");
  const [batchId, setBatchId] = useState<string>();
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [selection, setSelection] = useState<FactoryRow[]>([]);
  const [detailId, setDetailId] = useState<string>();
  const [reviewing, setReviewing] = useState(false);
  const detailTrigger = useRef<HTMLElement>(null);
  const taskList = useRef<HTMLElement>(null);
  const [edits, setEdits] = useState<{
    draft: PanoramaDraft;
    segments: PanoramaSegment[];
    scenes: PanoramaScene[];
    coverTitle: string;
    renderSettings: RenderEdits;
  }>();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [wide, setWide] = useState(
    () => window.matchMedia("(min-width: 1400px)").matches,
  );
  const dirty =
    !!edits &&
    (edits.segments.some((s, i) => s.text !== edits.draft.segments[i].text) ||
      edits.scenes.some(
        (scene, i) =>
          scene.yaw !== edits.draft.scenes[i].yaw ||
          scene.direction !== edits.draft.scenes[i].direction ||
          scene.spatial?.targetPanoIndex !==
            edits.draft.scenes[i].spatial?.targetPanoIndex,
      ) ||
      edits.coverTitle !== (edits.draft.config.coverTitle || "") ||
      renderKeys.some(
        (key) =>
          edits.renderSettings[key] !== undefined &&
          (edits.renderSettings[key]?.trim() === "" ||
            Number(edits.renderSettings[key]) !== edits.draft.config[key]),
      ));
  const blocker = useBlocker(dirty);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1400px)");
    const update = () => setWide(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    const dialog = modal.confirm({
      title: "任务修改尚未保存",
      content: "离开页面会丢弃本次修改。",
      okText: "放弃并离开",
      cancelText: "继续编辑",
      onOk: () => blocker.proceed(),
      onCancel: () => blocker.reset(),
    });
    return () => dialog.destroy();
  }, [blocker, modal]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const catalog = useQuery({
    queryKey: ["factory-catalog"],
    queryFn: () => factoryRequest<FactoryCatalog>("catalog"),
    enabled: desktop,
    retry: false,
    staleTime: 30_000,
  });
  const pricing = useQuery({
    queryKey: ["credit-pricing"],
    queryFn: () => authRequest<CreditPricing>("credits.pricing"),
    enabled: desktop && isLive,
    retry: false,
    staleTime: 60_000,
  });
  const defaults = useQuery({
    queryKey: ["factory-preferences"],
    queryFn: () => factoryRequest<FactoryProperties>("properties", { page: 1 }),
    enabled: desktop,
    retry: false,
    staleTime: 30_000,
  });
  const initialized = useRef(false);
  useEffect(() => {
    if (initialized.current || !defaults.data || !catalog.data) return;
    initialized.current = true;
    const preferred = defaults.data.defaults?.videoTemplate;
    if (
      preferred &&
      catalog.data.templates.some(
        (t) => templateKey(t) === templateKey(preferred),
      )
    )
      setTemplateIds((current) =>
        current.length ? current : [templateKey(preferred)],
      );
    setKnownProperties((current) => ({
      ...Object.fromEntries(
        defaults.data.rows.map((row) => [row.id, row.title]),
      ),
      ...current,
    }));
  }, [defaults.data, catalog.data]);
  const templates = catalog.data?.templates || [];
  const firstProperty = propertyIds.length
    ? workspace?.properties.find((property) => property.id === propertyIds[0])
    : undefined;
  const propertyName =
    firstProperty?.community ||
    knownProperties[propertyIds[0]] ||
    firstProperty?.title;
  const templateName = templates.find(
    (t) => templateKey(t) === templateIds[0],
  )?.name;
  const voiceOptions = catalog.data?.managedVoices
    ? [
        ...(voices.data?.publicVoices || []),
        ...(voices.data?.voices || []).filter(
          (voice) => voice.status === "ready" && voices.data?.cloneEnabled,
        ),
      ].map((voice) => ({
        value: voice.id,
        label: voice.name + " · " + voice.language,
      }))
    : (catalog.data?.voices || []).map((voice) => ({
        value: voice.name,
        label: voice.name + " · " + voice.language,
      }));
  const pairs = useMemo(
    () =>
      propertyIds.flatMap((propertyId) =>
        templateIds
          .map((key) => {
            const [templateId, version] = JSON.parse(key) as [string, string];
            return { propertyId, templateId, version };
          })
          .filter((pair) => !excluded.has(pairKey(pair))),
      ),
    [propertyIds, templateIds, excluded],
  );
  const hasExcludedPairs =
    pairs.length < propertyIds.length * templateIds.length;
  const voiceSummary = voiceId
    ? voiceOptions.find((voice) => voice.value === voiceId)?.label || voiceId
    : hasExcludedPairs
      ? "已调整组合"
      : "沿用默认配置";
  const activeTemplateKeys = new Set(
    pairs.map((pair) =>
      templateKey({ id: pair.templateId, version: pair.version }),
    ),
  );
  const selectedTemplates = templates.filter(
    (template) =>
      templateIds.includes(templateKey(template)) &&
      (!propertyIds.length || activeTemplateKeys.has(templateKey(template))),
  );
  const spatialBatch =
    selectedTemplates.length > 0 &&
    selectedTemplates.every(
      (template) => template.config.cameraMode === "spatial",
    );
  const batchRenderDefaults: Partial<RenderSettings> = Object.fromEntries(
    renderKeys.flatMap((key) => {
      const value = selectedTemplates[0]?.config[key];
      return value !== undefined &&
        selectedTemplates.every((template) => template.config[key] === value)
        ? [[key, value]]
        : [];
    }),
  );
  const faceTemplates = new Set(
    templates
      .filter(
        (template) =>
          template.config.videoMode === "avatar" && !template.opening,
      )
      .map(templateKey),
  );
  const imageProperties = [
    ...new Set(pairs.map((pair) => pair.propertyId)),
  ].map((id) => ({ id, title: propertyTitle(id) }));
  const selectedPropertyCount = imageProperties.filter(
    ({ id }) =>
      sceneIdsByProperty[id]?.length >= 2 && sceneIdsByProperty[id].length <= 7,
  ).length;
  const miniMaxTemplates = new Set(
    templates
      .filter((template) => template.opening === "minimax")
      .map(templateKey),
  );
  const useMiniMax = pairs.some((pair) =>
    miniMaxTemplates.has(
      templateKey({ id: pair.templateId, version: pair.version }),
    ),
  );
  const needsOpeningForBatch = pairs.some((pair) =>
    faceTemplates.has(
      templateKey({ id: pair.templateId, version: pair.version }),
    ),
  );
  const costEstimate = useMemo(
    () =>
      estimateBatchCost(pricing.data, {
        tasks: pairs.length,
        withOpening: useMiniMax,
      }),
    [pricing.data, pairs.length, useMiniMax],
  );
  const openingClip = catalog.data?.openingClip;
  const openingPhoto = catalog.data?.openingPhoto;
  const miniMaxReady =
    catalog.data?.minimaxOpening &&
    catalog.data.managedVoices &&
    openingPhoto &&
    openingAuthorized;
  const filters = {
    search,
    batchId,
    status: status === "all" ? undefined : status,
  };
  const list = useQuery({
    queryKey: ["factory-list", filters, page, detailId],
    queryFn: () =>
      factoryRequest<FactoryList>("list", {
        ...filters,
        page,
        focusId: detailId,
      }),
    enabled: desktop,
    retry: false,
    refetchInterval: 2500,
    placeholderData: keepPreviousData,
  });
  const detail = useQuery({
    queryKey: ["factory-detail", detailId],
    queryFn: () => factoryRequest<FactoryDetail>("detail", { id: detailId }),
    enabled: desktop && !!detailId,
    retry: false,
  });
  const focused =
    list.data?.focused?.id === detailId ? list.data?.focused : undefined;
  const loaded = detail.data;
  const refetchDetail = detail.refetch;
  useEffect(() => {
    if (
      focused &&
      loaded &&
      (focused.phase !== loaded.phase || focused.revision !== loaded.revision)
    )
      void refetchDetail();
  }, [
    focused?.id,
    focused?.phase,
    focused?.revision,
    loaded?.id,
    loaded?.phase,
    loaded?.revision,
    refetchDetail,
  ]);
  const row =
    loaded &&
    (focused
      ? {
          ...loaded,
          progress: focused.progress,
          stage: focused.stage,
        }
      : loaded);
  const detailPane = useRef<HTMLElement>(null);
  useEffect(() => {
    if (wide && !reviewing && loaded?.id)
      detailPane.current?.focus({ preventScroll: true });
  }, [wide, reviewing, loaded?.id]);
  const segments = edits?.segments || row?.draft?.segments || [];
  const scenes = edits?.scenes || row?.draft?.scenes || [];
  const coverTitle = edits?.coverTitle ?? row?.draft?.config.coverTitle ?? "";
  const taskRenderEdits = edits?.renderSettings || {};
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ["factory-list"] }),
      client.invalidateQueries({ queryKey: ["factory-detail"] }),
    ]);
  async function run(action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      void message.error(
        error instanceof Error ? error.message : "操作失败，请重试",
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  function switchDetail(id?: string, review = false, trigger?: HTMLElement) {
    if (inFlight.current || (id === detailId && review === reviewing)) return;
    const change = () => {
      if (trigger) detailTrigger.current = trigger;
      setEdits(undefined);
      setDetailId(id);
      setReviewing(review);
      if (!id) restoreDetailFocus();
    };
    if (!dirty) {
      change();
      return;
    }
    modal.confirm({
      title: "任务修改尚未保存",
      content: "可返回保存修改，或放弃修改后切换任务。",
      okText: "放弃修改",
      cancelText: "返回编辑",
      onOk: change,
    });
  }
  function restoreDetailFocus() {
    requestAnimationFrame(() => {
      const trigger = detailTrigger.current;
      (trigger?.isConnected ? trigger : taskList.current)?.focus({
        preventScroll: true,
      });
    });
  }
  function remember(rows: Pick<FactoryProperty, "id" | "title">[]) {
    setKnownProperties((current) => ({
      ...current,
      ...Object.fromEntries(rows.map((p) => [p.id, p.title])),
    }));
  }
  function propertyTitle(id: string) {
    return (
      knownProperties[id] ||
      (firstProperty?.id === id && firstProperty.title) ||
      id
    );
  }
  function pairTitle(pair: FactoryPair) {
    return (
      propertyTitle(pair.propertyId) +
      " · " +
      (templates.find(
        (t) => t.id === pair.templateId && t.version === pair.version,
      )?.name || pair.templateId)
    );
  }
  function exclude(rows: FactoryPair[]) {
    setExcluded((current) => new Set([...current, ...rows.map(pairKey)]));
    setIssues([]);
  }
  async function create() {
    const overrides = renderOverrides(batchRenderEdits, spatialBatch);
    const selectedImages = Object.fromEntries(
      imageProperties.map(({ id }) => [id, sceneIdsByProperty[id]]),
    );
    const openingClipId = needsOpeningForBatch ? openingClip?.id : undefined;
    const openingPhotoId = useMiniMax ? openingPhoto?.id : undefined;
    const openingBackgroundId = useMiniMax
      ? catalog.data?.openingBackground?.id
      : undefined;
    const signature = JSON.stringify([
      pairs,
      selectedImages,
      voiceId,
      openingClipId,
      openingPhotoId,
      openingBackgroundId,
      overrides,
    ]);
    if (submission.current?.signature !== signature)
      submission.current = { signature, id: crypto.randomUUID() };
    const result = await factoryRequest<{
      batchId?: string;
      issues: FactoryIssue[];
    }>("create", {
      requestId: submission.current.id,
      pairs,
      sceneIdsByProperty: selectedImages,
      voiceId,
      openingClip: openingClipId,
      openingPhoto: openingPhotoId,
      openingBackground: openingBackgroundId,
      openingAuthorized: useMiniMax && openingAuthorized,
      openingRecipe: true,
      ...(Object.keys(overrides).length ? { renderOverrides: overrides } : {}),
    });
    setIssues(result.issues);
    if (!result.batchId) return;
    void message.success("已创建 " + pairs.length + " 条视频任务");
    submission.current = undefined;
    setPropertyIds([]);
    setSceneIdsByProperty({});
    setBatchRenderEdits({});
    setOpeningAuthorized(false);
    setExcluded(new Set());
    setPairPage(1);
    setBatchId(result.batchId);
    setStatus("all");
    setSearch("");
    setPage(1);
    setSelection([]);
    changeView("tasks");
    await refresh();
  }
  async function importOpening() {
    const selected = await request<FactoryOpeningClip | null>(
      "opening-clip-import",
    );
    if (!selected) return;
    client.setQueryData<FactoryCatalog>(
      ["factory-catalog"],
      (current) => current && { ...current, openingClip: selected },
    );
    setIssues([]);
  }
  async function save() {
    const draft = edits?.draft || row?.draft;
    if (!draft || !dirty) return draft;
    const saved = await request<PanoramaDraft>("save", {
      id: draft.id,
      revision: draft.revision,
      config: {
        ...draft.config,
        ...renderOverrides(
          taskRenderEdits,
          draft.config.cameraMode === "spatial",
        ),
        ...(draft.config.design === "short-tour" ? { coverTitle } : {}),
      },
      segments,
      scenes,
    });
    client.setQueryData<FactoryDetail>(
      ["factory-detail", detailId],
      (current) =>
        current && {
          ...current,
          config: saved.config,
          draft: saved,
          revision: saved.revision,
        },
    );
    setEdits(undefined);
    return saved;
  }
  async function act(
    action: FactoryAction,
    rows: { id: string; revision?: number }[],
  ) {
    const results = await factoryRequest<FactoryActionResult[]>("act", {
      action,
      rows,
    });
    const copied = results.find((result) => result.createdId);
    if (copied) {
      setReviewing(false);
      setDetailId(copied.createdId);
    }
    const failed = results.filter((result) => !result.ok);
    setSelection((selected) =>
      selected.filter(
        (item) => !results.some((result) => result.id === item.id && result.ok),
      ),
    );
    await refresh();
    if (failed.length)
      modal.warning({
        title:
          "成功 " +
          (results.length - failed.length) +
          " 条，失败 " +
          failed.length +
          " 条",
        content: (
          <ul className="factory-errors">
            {failed.map((failure) => (
              <li key={failure.id}>
                {list.data?.rows.find((value) => value.id === failure.id)
                  ?.propertyTitle ||
                  selection.find((value) => value.id === failure.id)
                    ?.propertyTitle ||
                  row?.propertyTitle}
                ：{failure.error}
              </li>
            ))}
          </ul>
        ),
      });
    else
      void message.success(
        action === "confirm"
          ? "已确认 " + results.length + " 条文案并入队"
          : "已处理 " + results.length + " 条任务",
      );
    return failed.length === 0;
  }
  function bulk(action: FactoryAction, selected: FactoryRow[], label: string) {
    if (dirty && selected.some((value) => value.id === detailId)) {
      void message.warning("请先保存当前任务修改，再对这条任务执行操作");
      return;
    }
    const submit = () =>
      run(async () => {
        for (let i = 0; i < selected.length; i += 200)
          await act(action, selected.slice(i, i + 200));
      });
    if (action === "confirm" || action === "cancel")
      modal.confirm({
        title: label + "（" + selected.length + " 条）",
        content:
          action === "confirm"
            ? "确认后将按顺序自动制作视频。"
            : "取消所选任务，同批其他任务继续执行。",
        okText: label,
        cancelText: "返回",
        onOk: submit,
      });
    else void submit();
  }
  async function confirmNext() {
    if (!row) return;
    const draft = await save();
    if (
      !draft ||
      !(await act("confirm", [{ id: row.id, revision: draft.revision }]))
    )
      return;
    const result = await factoryRequest<FactoryList>("list", {
      ...filters,
      page,
      afterId: row.id,
    });
    setEdits(undefined);
    setDetailId(result.nextReviewId);
    if (!result.nextReviewId) {
      setReviewing(false);
      restoreDetailFocus();
    }
  }
  function filter(next: () => void) {
    next();
    setSelection([]);
    setPage(1);
  }

  const currentRows = list.data?.rows || [];
  const selectedRows = selection.map(
    (value) => currentRows.find((current) => current.id === value.id) || value,
  );
  const shownPairs = pairs.slice((pairPage - 1) * 8, pairPage * 8);
  const detailPanel = row ? (
    <FactoryTaskDetail
      row={row}
      reviewing={reviewing}
      segments={segments}
      scenes={scenes}
      coverTitle={coverTitle}
      renderSettings={taskRenderEdits}
      dirty={dirty}
      busy={busy}
      onClose={wide && !reviewing ? () => switchDetail() : undefined}
      onEdit={(id, text) => {
        if (!row.draft) return;
        const draft = row.draft;
        setEdits((current) => ({
          draft: current?.draft || draft,
          segments: (current?.segments || draft.segments).map((s) =>
            s.id === id ? { ...s, text } : s,
          ),
          scenes: current?.scenes || draft.scenes,
          coverTitle: current?.coverTitle ?? draft.config.coverTitle ?? "",
          renderSettings: current?.renderSettings || {},
        }));
      }}
      onCamera={(id, camera) => {
        if (!row.draft) return;
        const draft = row.draft;
        setEdits((current) => ({
          draft: current?.draft || draft,
          segments: current?.segments || draft.segments,
          scenes: (current?.scenes || draft.scenes).map((scene) =>
            scene.id === id ? { ...scene, ...camera } : scene,
          ),
          coverTitle: current?.coverTitle ?? draft.config.coverTitle ?? "",
          renderSettings: current?.renderSettings || {},
        }));
      }}
      onCoverTitle={(title) => {
        if (!row.draft) return;
        const draft = row.draft;
        setEdits((current) => ({
          draft: current?.draft || draft,
          segments: current?.segments || draft.segments,
          scenes: current?.scenes || draft.scenes,
          coverTitle: title,
          renderSettings: current?.renderSettings || {},
        }));
      }}
      onRenderSettings={(renderSettings) => {
        if (!row.draft) return;
        const draft = row.draft;
        setEdits((current) => ({
          draft: current?.draft || draft,
          segments: current?.segments || draft.segments,
          scenes: current?.scenes || draft.scenes,
          coverTitle: current?.coverTitle ?? draft.config.coverTitle ?? "",
          renderSettings,
        }));
      }}
      onSave={() =>
        void run(async () => {
          await save();
          await refresh();
          void message.success("文案和镜头设置已保存");
        })
      }
      onConfirm={() => void run(confirmNext)}
      onOpeningLocation={(asset) =>
        void run(async () => {
          const draft = await save();
          if (!draft) return;
          await factoryRequest("opening-location", {
            id: row.id,
            revision: draft.revision,
            asset,
          });
          await refresh();
        })
      }
      onAct={(action) => {
        if (action === "edit-opening" || action === "withdraw") {
          void run(async () => {
            if (await act(action, [row])) setReviewing(true);
          });
          return;
        }
        bulk(
          action,
          [row],
          actions.find((item) => item.action === action)?.label ||
            (action === "room-opening" ? "改用房源开场" : action),
        );
      }}
      onExport={(action) =>
        void run(async () => {
          if (await action()) void message.success("视频已下载");
        })
      }
    />
  ) : detail.error ? (
    <Alert
      type="error"
      showIcon
      title={detail.error.message}
      action={<Button onClick={() => void detail.refetch()}>重试</Button>}
    />
  ) : (
    <p className="muted" role="status">
      正在读取任务详情…
    </p>
  );

  const inlineDetail = wide && !!detailId && !reviewing;
  return (
    <div
      className={
        desktop
          ? `video-factory factory-desktop-view ${creating ? "factory-create-view" : "factory-tasks-view"}`
          : "video-factory"
      }
    >
      <PageHeader
        title="AI 视频工厂"
        description="选择房源、模板和图片生成文案，审核后进入视频制作队列。"
        actions={
          <Space>
            {desktop && (
              <Button
                disabled={!list.data || busy}
                icon={
                  list.data?.paused ? <Play size={15} /> : <Pause size={15} />
                }
                onClick={() =>
                  void run(async () => {
                    await factoryRequest(
                      list.data?.paused ? "resume" : "pause",
                    );
                    await refresh();
                  })
                }
              >
                {list.data?.paused ? "恢复队列" : "暂停队列"}
              </Button>
            )}
            <Button onClick={() => navigate("/publish")}>发布中心</Button>
          </Space>
        }
      />
      {!desktop ? (
        <Alert
          showIcon
          type="info"
          title="请在桌面客户端制作视频"
          action={<Link to="/properties">管理房源与素材</Link>}
        />
      ) : (
        <>
          {list.data?.storageError && (
            <Alert
              type="error"
              showIcon
              title={list.data.storageError}
              description="请检查本机存储，再恢复队列。"
            />
          )}
          {!!list.data?.interrupted && (
            <Alert
              showIcon
              type="warning"
              title={
                list.data.interrupted + " 条任务在上次退出或登录中断时暂停"
              }
              description="恢复队列后继续处理，待审核文案仍需确认。"
            />
          )}
          {(catalog.error || list.error) && (
            <Alert
              showIcon
              type="error"
              title={(catalog.error || list.error)?.message}
              action={
                <Button
                  onClick={() => {
                    void catalog.refetch();
                    void list.refetch();
                  }}
                >
                  重新加载
                </Button>
              }
            />
          )}
          <Tabs
            className="workspace-tabs"
            activeKey={creating ? "create" : "tasks"}
            onChange={changeView}
            items={[
              { key: "tasks", label: "制作任务" },
              { key: "create", label: "新建视频" },
            ]}
          />
          <section
            className="panel factory-composer"
            aria-label="批量配置"
            hidden={!creating}
          >
            <div className="compose-intro">
              <h2>新建一批视频</h2>
              <p className="muted">
                每套房源按所选模板生成独立任务。先选 2–7
                张图片生成文案，确认后再制作视频。
              </p>
            </div>
            <div className="factory-compose-picks">
              <div className="compose-field">
                <h3>房源</h3>
                <div className="compose-field-controls">
                  <Button
                    icon={<House size={16} />}
                    disabled={busy}
                    onClick={() => setPicker("property")}
                  >
                    {propertyIds.length
                      ? "房源 " + propertyIds.length + " 套"
                      : "选择房源"}
                  </Button>
                  {propertyName && (
                    <span
                      className="compose-selection-summary"
                      title={propertyName}
                    >
                      {propertyName}
                      {propertyIds.length > 1 && " 等"}
                    </span>
                  )}
                </div>
              </div>
              <div className="compose-field">
                <h3>视频模板</h3>
                <div className="compose-field-controls">
                  <Button
                    icon={<Clapperboard size={16} />}
                    disabled={busy || catalog.isPending}
                    onClick={() => setPicker("template")}
                  >
                    {templateIds.length
                      ? "模板 " + templateIds.length + " 个"
                      : "选择视频模板"}
                  </Button>
                  {templateName && (
                    <span
                      className="compose-selection-summary"
                      title={templateName}
                    >
                      {templateName}
                      {templateIds.length > 1 && " 等"}
                    </span>
                  )}
                </div>
              </div>
              <div className="compose-field">
                <h3>音色与组合</h3>
                <div className="compose-field-controls">
                  <span
                    className="compose-selection-summary"
                    title={voiceSummary}
                  >
                    {voiceSummary}
                  </span>
                  <Button
                    type="text"
                    aria-expanded={expanded}
                    disabled={busy}
                    icon={
                      expanded ? (
                        <ChevronUp size={15} />
                      ) : (
                        <ChevronDown size={15} />
                      )
                    }
                    onClick={() => setExpanded(!expanded)}
                  >
                    {expanded ? "收起配置" : "配置与组合"}
                  </Button>
                </div>
              </div>
            </div>
            {selectedTemplates.length > 0 && (
              <div className="factory-compose-note factory-compose-parameters">
                <h3>本批制作参数</h3>
                <p className="muted">
                  {selectedTemplates.length === 1
                    ? `未修改项沿用「${selectedTemplates[0].name} · ${selectedTemplates[0].version}」，调整仅用于本批任务。`
                    : "自定义值用于本批所有模板；未修改的项分别沿用各模板默认值。"}
                  {selectedTemplates.some(
                    (template) => template.config.cameraMode === "spatial",
                  ) && "空间走动只使用配音语速，旋转参数不影响空间镜头。"}
                </p>
                <FactoryRenderSettings
                  scope="批次"
                  defaults={batchRenderDefaults}
                  edits={batchRenderEdits}
                  spatial={spatialBatch}
                  disabled={busy}
                  resetDisabled={!Object.keys(batchRenderEdits).length}
                  onChange={(value) => {
                    setBatchRenderEdits(value);
                    setIssues([]);
                  }}
                  onReset={() => {
                    setBatchRenderEdits({});
                    setIssues([]);
                  }}
                />
              </div>
            )}
            {imageProperties.length > 0 && (
              <div className="factory-compose-note factory-compose-images">
                <Space wrap>
                  <Button disabled={busy} onClick={() => setImagePicker(true)}>
                    选择视频图片
                  </Button>
                  <span>
                    每套选择 2–7 张全景图 · 已选 {selectedPropertyCount} /{" "}
                    {imageProperties.length} 套
                  </span>
                </Space>
              </div>
            )}
            {useMiniMax && (
              <div className="factory-compose-note">
                <strong>MiniMax H3 开场</strong>
                <Space wrap>
                  <Link to="/settings/appearance">设置经纪人照片与背景</Link>
                  <span>{openingPhoto?.name || "尚未上传经纪人照片"}</span>
                  <span>
                    {catalog.data?.openingBackground?.name ||
                      "尚未上传个人背景图"}
                  </span>
                </Space>
                <Checkbox
                  checked={openingAuthorized}
                  disabled={busy}
                  onChange={(event) => {
                    setOpeningAuthorized(event.target.checked);
                    setIssues([]);
                  }}
                >
                  我确认已获得经纪人照片和开场素材的使用授权
                </Checkbox>
                <div>
                  审核通过后，照片、地点图和豆包开场配音将发送给
                  MiniMax，生成视频会计费。
                </div>
                {!catalog.data?.minimaxOpening && (
                  <div>
                    请在管理后台的「AI 服务」启用 MiniMax 开场，再刷新配置。
                  </div>
                )}
              </div>
            )}
            {needsOpeningForBatch && (
              <div className="factory-compose-note">
                <Space wrap size={8}>
                  <Button
                    size="small"
                    disabled={busy}
                    onClick={() => void run(importOpening)}
                  >
                    {openingClip ? "更换真人开场视频" : "导入真人开场视频"}
                  </Button>
                  <span>
                    {openingClip
                      ? `${openingClip.name} · ${openingClip.duration.toFixed(1)} 秒`
                      : "请选择 2–30 秒的 MP4"}
                  </span>
                </Space>
                <div>
                  本机保存，可在露脸批次复用。建议选无对白镜头，开场使用房源文案的配音。
                </div>
              </div>
            )}
            {!templates.length && catalog.isSuccess && (
              <div className="factory-compose-note">
                暂无已上架的视频模板。
                <Button
                  type="link"
                  size="small"
                  onClick={() => void catalog.refetch()}
                >
                  刷新模板
                </Button>
              </div>
            )}
            {pairs.length > 200 && (
              <Alert
                showIcon
                type="warning"
                title="单批最多 200 条，请减少组合或分批生成。"
              />
            )}
            {issues.length > 0 && (
              <Alert
                showIcon
                type="warning"
                title={issues.length + " 个组合需要调整"}
                description={
                  <ul className="factory-errors">
                    {issues.map((issue) => (
                      <li key={pairKey(issue)}>
                        {issue.propertyTitle && issue.templateName
                          ? issue.propertyTitle + " · " + issue.templateName
                          : pairTitle(issue)}
                        ：{issue.error}
                      </li>
                    ))}
                  </ul>
                }
                action={
                  <Button size="small" onClick={() => exclude(issues)}>
                    移除这些组合
                  </Button>
                }
              />
            )}
            {expanded && (
              <div className="factory-compose-expanded">
                <Space wrap>
                  <label>
                    音色{" "}
                    <Select
                      aria-label="批次音色"
                      className="factory-config-select"
                      allowClear
                      showSearch
                      optionFilterProp="label"
                      placeholder="使用默认配置"
                      value={voiceId}
                      disabled={busy}
                      onChange={(value) => {
                        setVoiceId(value);
                        setIssues([]);
                      }}
                      options={voiceOptions}
                    />
                  </label>
                  <Link to="/properties">管理房源素材</Link>
                  {!!excluded.size && (
                    <Button
                      size="small"
                      disabled={busy}
                      onClick={() => {
                        setExcluded(new Set());
                        setPairPage(1);
                      }}
                    >
                      恢复移除的组合
                    </Button>
                  )}
                </Space>
                {pairs.length > 0 && (
                  <>
                    <ul className="factory-pair-list">
                      {shownPairs.map((pair) => (
                        <li key={pairKey(pair)}>
                          <span>{pairTitle(pair)}</span>
                          <Button
                            size="small"
                            type="text"
                            disabled={busy}
                            aria-label={"移除 " + pairTitle(pair)}
                            onClick={() => {
                              exclude([pair]);
                              if (shownPairs.length === 1)
                                setPairPage(Math.max(1, pairPage - 1));
                            }}
                          >
                            移除
                          </Button>
                        </li>
                      ))}
                    </ul>
                    <Pagination
                      size="small"
                      current={pairPage}
                      total={pairs.length}
                      pageSize={8}
                      onChange={setPairPage}
                      showSizeChanger={false}
                      hideOnSinglePage
                    />
                  </>
                )}
              </div>
            )}
            <div className="factory-compose-submit">
              <span className="factory-equation">
                {propertyIds.length} 套 × {templateIds.length} 个
                {hasExcludedPairs ? " · 保留" : " ="}{" "}
                <strong>{pairs.length}</strong> 条
              </span>
              {costEstimate && (
                <Tooltip
                  title={`${estimateSummaryText(costEstimate)}。按每条约 ${ESTIMATED_CHARS_PER_VIDEO} 字估算；实际按生成文案的千字数计费，供应商失败会退回。`}
                >
                  <span className="factory-cost-estimate">
                    <strong>预计消耗约 {costEstimate.total} 积分</strong>
                    <small>
                      {pairs.length > 1 && `每条 ${costEstimate.perTask}：`}
                      {estimateBreakdownText(costEstimate)}
                    </small>
                  </span>
                </Tooltip>
              )}
              <Button
                type="primary"
                loading={busy && !!submission.current}
                disabled={
                  busy ||
                  !pairs.length ||
                  !!renderSettingsError(batchRenderEdits, spatialBatch) ||
                  pairs.length > 200 ||
                  selectedPropertyCount !== imageProperties.length ||
                  (needsOpeningForBatch && !openingClip) ||
                  (useMiniMax && !miniMaxReady) ||
                  !!catalog.error ||
                  !catalog.data
                }
                onClick={() => void run(create)}
              >
                生成 {pairs.length} 条文案
              </Button>
            </div>
          </section>
          <section
            ref={taskList}
            tabIndex={-1}
            className="panel factory-queue"
            aria-label="视频任务"
            hidden={creating}
          >
            <div
              className="factory-queue-tabs"
              role="group"
              aria-label="按状态筛选"
            >
              {tabs.map(([id, label]) => (
                <button
                  type="button"
                  key={id}
                  aria-pressed={status === id}
                  onClick={() => filter(() => setStatus(id))}
                >
                  {label}
                  <span>{list.data?.counts[id] || 0}</span>
                </button>
              ))}
            </div>
            <div className="factory-queue-toolbar">
              <div className="factory-queue-filters">
                <Input
                  aria-label="搜索视频任务"
                  placeholder="搜索房源号、标题或模板"
                  prefix={<Search size={15} />}
                  value={search}
                  allowClear
                  maxLength={120}
                  onChange={(e) => filter(() => setSearch(e.target.value))}
                />
                <Select
                  aria-label="筛选批次"
                  placeholder="全部批次"
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  className="factory-batch-filter"
                  value={batchId}
                  onChange={(value) => filter(() => setBatchId(value))}
                  options={(list.data?.batches || []).map((batch) => ({
                    value: batch.id,
                    label:
                      formatDate(batch.createdAt) + " · " + batch.count + " 条",
                  }))}
                />
              </div>
              {!!selection.length && (
                <Space wrap>
                  <span>已选 {selection.length} 条</span>
                  {actions.map(({ action, label, matches }) => {
                    const eligible = selectedRows.filter(matches);
                    return (
                      eligible.length > 0 && (
                        <Button
                          key={action}
                          size="small"
                          type={action === "confirm" ? "primary" : "default"}
                          disabled={busy}
                          onClick={() => bulk(action, eligible, label)}
                        >
                          {label} {eligible.length} 条
                        </Button>
                      )
                    );
                  })}
                  <Button
                    size="small"
                    type="text"
                    onClick={() => setSelection([])}
                  >
                    清空
                  </Button>
                </Space>
              )}
            </div>
            <div
              className={
                inlineDetail
                  ? "factory-workbench has-detail"
                  : "factory-workbench"
              }
            >
              <Table<FactoryRow>
                className="factory-task-table"
                size="small"
                rowKey="id"
                dataSource={currentRows}
                loading={list.isPending}
                scroll={{
                  x: inlineDetail ? 610 : 850,
                  y: "max(240px, calc(100vh - 340px))",
                }}
                rowClassName={(value) =>
                  value.id === detailId ? "factory-active-row" : ""
                }
                rowSelection={{
                  preserveSelectedRowKeys: true,
                  selectedRowKeys: selection.map((item) => item.id),
                  onChange: (_, selected) => setSelection(selected),
                  getCheckboxProps: (value) => ({
                    "aria-label": "选择 " + value.propertyTitle,
                  }),
                }}
                pagination={{
                  size: "small",
                  pageSize: 50,
                  showSizeChanger: false,
                  current: list.data?.page || 1,
                  total: list.data?.total || 0,
                  onChange: setPage,
                  showTotal: (total) => "共 " + total + " 条",
                }}
                locale={{
                  emptyText: (
                    <Empty
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description={
                        search || batchId || status !== "all"
                          ? "没有符合筛选条件的任务"
                          : "选好房源和模板后，生成的任务会出现在这里"
                      }
                    />
                  ),
                }}
                columns={[
                  {
                    title: "房源",
                    ellipsis: true,
                    render: (_, value) => (
                      <div className="factory-task-identity">
                        <Tooltip
                          title={[
                            value.propertyTitle,
                            value.propertyNumber,
                            formatDate(value.createdAt),
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        >
                          <button
                            type="button"
                            className="factory-row-title"
                            onClick={(event) =>
                              switchDetail(
                                value.id,
                                value.phase === "review",
                                event.currentTarget,
                              )
                            }
                          >
                            {value.propertyTitle}
                          </button>
                        </Tooltip>
                        {value.propertyNumber && (
                          <small className="factory-task-number">
                            房源号：{value.propertyNumber}
                          </small>
                        )}
                      </div>
                    ),
                  },
                  {
                    title: "模板",
                    ellipsis: true,
                    width: inlineDetail ? 104 : "16%",
                    render: (_, value) => (
                      <Tooltip
                        title={
                          value.templateName +
                          " · " +
                          (value.templateVersion || "")
                        }
                      >
                        {value.templateName}
                      </Tooltip>
                    ),
                  },
                  {
                    title: "状态",
                    width: inlineDetail ? 108 : "16%",
                    render: (_, value) => (
                      <FactoryPhaseTag phase={value.phase} />
                    ),
                  },
                  {
                    title: "当前步骤",
                    width: inlineDetail ? 116 : "19%",
                    ellipsis: true,
                    render: (_, value) => <TaskStep row={value} />,
                  },
                  {
                    title: "操作",
                    width: inlineDetail ? 70 : 94,
                    render: (_, value) => (
                      <Button
                        type="link"
                        size="small"
                        onClick={(event) =>
                          switchDetail(
                            value.id,
                            value.phase === "review",
                            event.currentTarget,
                          )
                        }
                      >
                        {value.phase === "review"
                          ? "审核"
                          : [
                                "done",
                                "archiving",
                                "archived",
                                "archiveFailed",
                              ].includes(value.phase)
                            ? "看成片"
                            : "详情"}
                      </Button>
                    ),
                  },
                ]}
              />
              {inlineDetail && (
                <aside
                  ref={detailPane}
                  className="factory-detail-pane"
                  tabIndex={-1}
                  aria-label="当前任务"
                >
                  {detailPanel}
                </aside>
              )}
            </div>
          </section>
          {!wide && !reviewing && (
            <Drawer
              title="任务详情"
              classNames={{ body: "factory-task-drawer" }}
              open={!!detailId}
              onClose={() => switchDetail()}
              size={460}
              destroyOnHidden
            >
              {detailPanel}
            </Drawer>
          )}
          <Modal
            centered
            width={880}
            title="审核文案"
            open={reviewing && !!detailId}
            className="factory-review-modal"
            classNames={{ body: "workbench-form-body factory-review-body" }}
            closable={!busy}
            keyboard={!busy}
            mask={{ closable: false }}
            onCancel={() => switchDetail()}
            footer={null}
            afterOpenChange={(open) => {
              if (!open && !detailId) restoreDetailFocus();
            }}
          >
            {reviewing && detailPanel}
          </Modal>
          {picker && (
            <FactoryPicker
              key={picker}
              kind={picker}
              templates={templates}
              value={picker === "property" ? propertyIds : templateIds}
              onProperties={remember}
              onClose={() => setPicker(undefined)}
              onConfirm={(ids) => {
                if (picker === "property") setPropertyIds(ids);
                else setTemplateIds(ids);
                setIssues([]);
                setPairPage(1);
                setPicker(undefined);
              }}
            />
          )}
          {imagePicker && imageProperties.length > 0 && (
            <FactoryImagePicker
              properties={imageProperties}
              value={sceneIdsByProperty}
              onClose={() => setImagePicker(false)}
              onConfirm={(value) => {
                setSceneIdsByProperty(value);
                setImagePicker(false);
                setIssues([]);
              }}
            />
          )}
        </>
      )}
    </div>
  );
}
