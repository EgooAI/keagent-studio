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
import type { PanoramaDraft, PanoramaSegment } from "@keagent/shared-types";
import { useVoiceLibrary } from "../lib/voiceLibrary";
import { PageHeader, formatDate } from "./common";
import { FactoryPicker } from "./FactoryPicker";
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
  const [propertyIds, setPropertyIds] = useState<string[]>(() =>
    initialProperty ? [initialProperty] : [],
  );
  const [templateIds, setTemplateIds] = useState<string[]>([]);
  const [knownProperties, setKnownProperties] = useState<
    Record<string, string>
  >({});
  const [voiceId, setVoiceId] = useState<string>();
  const [openingAuthorized, setOpeningAuthorized] = useState(false);
  const [excluded, setExcluded] = useState(new Set<string>());
  const [expanded, setExpanded] = useState(false);
  const [pairPage, setPairPage] = useState(1);
  const [picker, setPicker] = useState<"property" | "template">();
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
  }>();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [wide, setWide] = useState(
    () => window.matchMedia("(min-width: 1400px)").matches,
  );
  const dirty =
    !!edits &&
    edits.segments.some((s, i) => s.text !== edits.draft.segments[i].text);
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
      title: "文案尚未保存",
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
  const faceTemplates = new Set(
    templates
      .filter(
        (template) =>
          template.config.videoMode === "avatar" && !template.opening,
      )
      .map(templateKey),
  );
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
      title: "文案尚未保存",
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
  function pairTitle(pair: FactoryPair) {
    return (
      (knownProperties[pair.propertyId] || pair.propertyId) +
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
    const openingClipId = needsOpeningForBatch ? openingClip?.id : undefined;
    const openingPhotoId = useMiniMax ? openingPhoto?.id : undefined;
    const openingBackgroundId = useMiniMax
      ? catalog.data?.openingBackground?.id
      : undefined;
    const signature = JSON.stringify([
      pairs,
      voiceId,
      openingClipId,
      openingPhotoId,
      openingBackgroundId,
    ]);
    if (submission.current?.signature !== signature)
      submission.current = { signature, id: crypto.randomUUID() };
    const result = await factoryRequest<{
      batchId?: string;
      issues: FactoryIssue[];
    }>("create", {
      requestId: submission.current.id,
      pairs,
      voiceId,
      openingClip: openingClipId,
      openingPhoto: openingPhotoId,
      openingBackground: openingBackgroundId,
      openingAuthorized: useMiniMax && openingAuthorized,
      openingRecipe: true,
    });
    setIssues(result.issues);
    if (!result.batchId) return;
    void message.success("已创建 " + pairs.length + " 条视频任务");
    submission.current = undefined;
    setPropertyIds([]);
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
      config: draft.config,
      segments,
    });
    client.setQueryData<FactoryDetail>(
      ["factory-detail", detailId],
      (current) =>
        current && { ...current, draft: saved, revision: saved.revision },
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
      void message.warning("请先保存当前文案，再对这条任务执行操作");
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
        }));
      }}
      onSave={() =>
        void run(async () => {
          await save();
          await refresh();
          void message.success("文案已保存");
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

  return (
    <div className="video-factory">
      <PageHeader
        title="AI 视频工厂"
        description="选择房源和模板生成文案，审核后进入视频制作队列。"
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
                每套房源按所选模板生成独立任务。先生成文案，确认后再制作视频。
              </p>
            </div>
            <div className="factory-compose-main">
              <div className="factory-compose-picks">
                <div className="compose-field">
                  <h3>房源</h3>
                  <p className="muted">选择本次要制作视频的房源。</p>
                  <Button
                    icon={<House size={16} />}
                    disabled={busy}
                    onClick={() => setPicker("property")}
                  >
                    {propertyIds.length
                      ? "房源 " + propertyIds.length + " 套"
                      : "选择房源"}
                  </Button>
                </div>
                <div className="compose-field">
                  <h3>视频模板</h3>
                  <p className="muted">模板决定视频结构和画面风格。</p>
                  <Button
                    icon={<Clapperboard size={16} />}
                    disabled={busy || catalog.isPending}
                    onClick={() => setPicker("template")}
                  >
                    {templateIds.length
                      ? "模板 " + templateIds.length + " 个"
                      : "选择视频模板"}
                  </Button>
                </div>
                <div className="compose-field">
                  <h3>音色与组合</h3>
                  <p className="muted">可沿用默认配置，或逐条检查组合。</p>
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
              <div className="factory-compose-submit">
                <span className="factory-equation">
                  {propertyIds.length} 套 × {templateIds.length} 个
                  {pairs.length === propertyIds.length * templateIds.length
                    ? " ="
                    : " · 保留"}{" "}
                  <strong>{pairs.length}</strong> 条
                </span>
                <Button
                  type="primary"
                  loading={busy && !!submission.current}
                  disabled={
                    busy ||
                    !pairs.length ||
                    pairs.length > 200 ||
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
            </div>
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
                      options={
                        catalog.data?.managedVoices
                          ? [
                              ...(voices.data?.publicVoices || []),
                              ...(voices.data?.voices || []).filter(
                                (v) =>
                                  v.status === "ready" &&
                                  voices.data?.cloneEnabled,
                              ),
                            ].map((v) => ({
                              value: v.id,
                              label: v.name + " · " + v.language,
                            }))
                          : (catalog.data?.voices || []).map((v) => ({
                              value: v.name,
                              label: v.name + " · " + v.language,
                            }))
                      }
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
          </section>
          <section
            ref={taskList}
            tabIndex={-1}
            className="panel factory-queue"
            aria-label="视频任务"
            hidden={creating}
          >
            <div className="factory-queue-tabs" aria-label="按状态筛选">
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
              <Space wrap>
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
              </Space>
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
                wide && detailId && !reviewing
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
                scroll={{ x: 660, y: "max(240px, calc(100vh - 340px))" }}
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
                    ),
                  },
                  {
                    title: "模板",
                    ellipsis: true,
                    width: wide && detailId && !reviewing ? 130 : "22%",
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
                    width: 142,
                    render: (_, value) => (
                      <FactoryPhaseTag phase={value.phase} />
                    ),
                  },
                  {
                    title: "当前步骤",
                    width: 146,
                    ellipsis: true,
                    render: (_, value) =>
                      value.phase === "running" ? (
                        (value.stage ? stageNames[value.stage] : "检查配置") +
                        " " +
                        value.progress +
                        "%"
                      ) : value.error ? (
                        <Tooltip title={value.error}>{value.error}</Tooltip>
                      ) : (
                        "—"
                      ),
                  },
                  {
                    title: "操作",
                    width: 84,
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
              {wide && detailId && !reviewing && (
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
        </>
      )}
    </div>
  );
}
