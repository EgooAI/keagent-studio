import { useState, type CSSProperties, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Empty,
  Input,
  Modal,
  Pagination,
  Segmented,
  Spin,
} from "antd";
import {
  AudioLines,
  Bookmark,
  Check,
  ChevronRight,
  Image as Picture,
  Music2,
  RefreshCw,
  Scissors,
  TextAlignStart,
} from "lucide-react";
import type {
  CoverTemplate,
  Property,
  TemplatePartKind,
} from "@keagent/shared-types";
import {
  factoryRequest,
  matchesMix,
  mixTemplate,
  partFor,
  partKinds,
  partLabel,
  templateKey,
  type FactoryBundle,
  type FactoryLibrary,
  type FactoryPart,
} from "./factoryClient";
import "./factory-mix.css";

const partIcons = { edit: Scissors, cover: Picture, script: TextAlignStart };
const designs = {
  standard: "品牌信息栏",
  classic: "简洁标题",
  "short-tour": "醒目大标题",
};
const sources = {
  first: "首张视频素材",
  last: "末张视频素材",
  frame: "成片首秒画面",
};
const thumbnail = (library: FactoryLibrary, bundle: FactoryBundle) =>
  partFor(library.parts, bundle, "edit")?.config?.videoMode === "avatar"
    ? "/media/agent-tour.webp"
    : "/media/interior-1.jpg";

function describe(part: FactoryPart) {
  if (part.config)
    return [
      part.config.videoMode === "avatar" ? "经纪人开场" : "房源开场",
      part.config.aspectRatio,
      part.config.resolution,
    ].join(" · ");
  if (part.cover)
    return part.cover.imageSource === "frame"
      ? sources.frame
      : designs[part.cover.design] + " · " + sources[part.cover.imageSource];
  return part.language === "en-US" ? "英文口播" : "中文口播";
}

function CoverPreview({
  cover,
  edit,
  property,
  sceneIds,
  language,
}: {
  cover: CoverTemplate;
  edit: FactoryPart;
  property?: Property;
  sceneIds?: string[];
  language?: string;
}) {
  const ratio = edit.config?.aspectRatio ?? "9:16";
  const frame = cover.imageSource === "frame";
  const shortTour = edit.config?.design === "short-tour";
  const actual = !frame && !!property && !!sceneIds?.length;
  const preview = useQuery({
    queryKey: [
      "factory-cover-image",
      property?.id,
      sceneIds,
      cover.imageSource,
      ratio,
      shortTour,
    ],
    queryFn: () =>
      factoryRequest<string>("cover-image", {
        propertyId: property?.id,
        sceneIds,
        last: cover.imageSource === "last",
        aspectRatio: ratio,
        shortTour,
      }),
    enabled: actual,
    staleTime: 300_000,
    retry: false,
  });
  const home = actual ? property : undefined;
  const opening = cover.titleSource === "opening" && shortTour;
  const title = home
    ? opening
      ? home.community || home.title
      : home.title
    : cover.titleSource === "opening"
      ? "南向采光两居"
      : "示例小区两居室";
  const en = language === "en-US";
  const facts = home
    ? [
        home.areaSqm > 0 &&
          (en ? `${home.areaSqm} square metres` : `面积${home.areaSqm}平方米`),
        home.layout,
        home.priceCents > 0 &&
          (en
            ? `CNY ${home.priceCents / 100}`
            : `总价${home.priceCents / 1000000}万元`),
      ]
        .filter(Boolean)
        .join(en ? ", " : "，")
    : "两室一厅 · 86 m²";
  return (
    <section className="mix-panel mix-preview" aria-label="封面预览">
      <header>
        <h2>封面预览</h2>
        <span className="mix-ratio">{ratio}</span>
      </header>
      <div className="mix-preview-stage">
        <figure
          className={`mix-poster poster-${cover.design} ${ratio === "16:9" ? "landscape" : ""}`}
          style={
            {
              aspectRatio: ratio.replace(":", "/"),
              "--cover-color": cover.brandColor,
            } as CSSProperties
          }
        >
          {frame ? (
            <video
              aria-label="示例成片首秒"
              muted
              playsInline
              preload="auto"
              src="/media/demo-property.mp4"
              onLoadedMetadata={({ currentTarget: v }) => {
                v.currentTime = Math.min(1, v.duration / 2);
              }}
            />
          ) : actual && !preview.data ? (
            <div className="mix-preview-pending">
              {preview.isError ? (
                <Button onClick={() => void preview.refetch()}>
                  重试封面预览
                </Button>
              ) : (
                <Spin />
              )}
            </div>
          ) : (
            <>
              <img
                src={
                  actual
                    ? preview.data
                    : cover.imageSource === "last"
                      ? "/media/interior-2.jpg"
                      : "/media/interior-1.jpg"
                }
                alt="封面底图"
              />
              <figcaption>
                <strong>{title}</strong>
                {opening &&
                  cover.design === "short-tour" &&
                  home?.sellingPoints?.[0] && (
                    <strong>{home.sellingPoints[0]}</strong>
                  )}
                {cover.showFacts && facts && <span>{facts}</span>}
              </figcaption>
            </>
          )}
        </figure>
      </div>
      <small>
        {frame
          ? "示例首秒画面 · 制作完成后截取本片"
          : home
            ? home.title + " · " + sources[cover.imageSource]
            : "示例房源"}
      </small>
    </section>
  );
}

export function FactoryMixComposer({
  library,
  current,
  onChange,
  onApply,
  onSave,
  onRefresh,
  refreshing,
  property,
  sceneIds,
  disabled,
  voiceSelect,
  musicSelect,
}: {
  library: FactoryLibrary;
  current?: FactoryBundle;
  onChange: (value: FactoryBundle) => void;
  onApply: (value: FactoryBundle) => void;
  onSave: (value: FactoryBundle, name: string) => Promise<void>;
  onRefresh: () => void;
  refreshing: boolean;
  property?: Property;
  sceneIds?: string[];
  disabled: boolean;
  voiceSelect: ReactNode;
  musicSelect: ReactNode;
}) {
  const [tab, setTab] = useState<"recommended" | "personal">(
    !library.recommended.length && library.personal.length
      ? "personal"
      : "recommended",
  );
  const [page, setPage] = useState(1);
  const [kind, setKind] = useState<TemplatePartKind>();
  const [search, setSearch] = useState("");
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const entries = library[tab];
  const perPage = 2;
  const shownPage = Math.min(
    page,
    Math.max(1, Math.ceil(entries.length / perPage)),
  );
  const edit = current && partFor(library.parts, current, "edit");
  const cover = current && partFor(library.parts, current, "cover")?.cover;
  const options = kind
    ? library.parts.filter(
        (part) =>
          part.kind === kind &&
          part.available &&
          (part.name + " " + part.version + " " + (part.description || ""))
            .toLowerCase()
            .includes(search.trim().toLowerCase()),
      )
    : [];
  const save = async () => {
    if (!current || !name.trim() || saving) return;
    setSaving(true);
    try {
      await onSave(current, name.trim());
      setNaming(false);
      setTab("personal");
      setPage(1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "搭配保存失败，请重试");
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="mix-layout">
      <div className="mix-workspace">
        <section className="mix-panel mix-library" aria-label="搭配库">
          <header>
            <Segmented
              value={tab}
              options={[
                { label: "推荐搭配", value: "recommended" },
                { label: "我的搭配", value: "personal" },
              ]}
              onChange={(value) => {
                setTab(value as typeof tab);
                setPage(1);
              }}
            />
            <Button
              type="text"
              className="mix-refresh"
              aria-label="刷新搭配"
              title="刷新搭配"
              loading={refreshing}
              onClick={onRefresh}
              icon={<RefreshCw size={15} />}
            />
          </header>
          {entries.length ? (
            <div className="mix-cards">
              {entries
                .slice((shownPage - 1) * perPage, shownPage * perPage)
                .map((bundle) => {
                  const applied = !!current && matchesMix(current, bundle);
                  const available = !!mixTemplate(library.parts, bundle);
                  const action = !available
                    ? "模板已下架"
                    : applied
                      ? "已应用"
                      : "用同款";
                  const fallback = thumbnail(library, bundle);
                  return (
                    <button
                      key={templateKey(bundle)}
                      type="button"
                      aria-pressed={applied}
                      aria-label={bundle.name + "，" + action}
                      disabled={disabled || !available}
                      onClick={() => onApply(bundle)}
                      className={"mix-card" + (applied ? " selected" : "")}
                    >
                      <img
                        src={bundle.thumbnail || fallback}
                        alt=""
                        onError={({ currentTarget: img }) => {
                          if (!img.src.endsWith(fallback)) img.src = fallback;
                        }}
                      />
                      <span className="mix-card-foot">
                        <strong>{bundle.name}</strong>
                        <span className="mix-apply">
                          {applied && <Check size={15} />}
                          {action}
                        </span>
                      </span>
                    </button>
                  );
                })}
            </div>
          ) : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                tab === "personal"
                  ? "保存当前搭配后，下次可以在这里直接使用。"
                  : "暂无已上架的推荐搭配"
              }
            />
          )}
          {entries.length > perPage && (
            <Pagination
              size="small"
              current={shownPage}
              total={entries.length}
              pageSize={perPage}
              showSizeChanger={false}
              onChange={setPage}
            />
          )}
        </section>
        <section className="mix-panel" aria-label="当前搭配">
          <header>
            <h2>当前搭配</h2>
            <Button
              icon={<Bookmark size={15} />}
              disabled={!current || disabled}
              onClick={() => {
                setName("");
                setError("");
                setNaming(true);
              }}
            >
              存为我的搭配
            </Button>
          </header>
          <div className="mix-rows">
            <div className="mix-row">
              <span className="mix-row-icon" aria-hidden="true">
                <AudioLines size={19} />
              </span>
              <b>配音音色</b>
              {voiceSelect}
            </div>
            <div className="mix-row">
              <span className="mix-row-icon" aria-hidden="true">
                <Music2 size={19} />
              </span>
              <b>背景音乐</b>
              {musicSelect}
            </div>
            {current &&
              partKinds.map((k) => {
                const Icon = partIcons[k];
                return (
                  <button
                    type="button"
                    key={k}
                    className="mix-row"
                    disabled={disabled}
                    aria-label={"更换" + partLabel[k]}
                    onClick={() => {
                      setKind(k);
                      setSearch("");
                    }}
                  >
                    <span className="mix-row-icon">
                      <Icon size={19} />
                    </span>
                    <b>{partLabel[k]}</b>
                    <span className="mix-part-name">
                      {current.parts[k].name}
                    </span>
                    <span className="mix-swap">
                      更换
                      <ChevronRight size={15} />
                    </span>
                  </button>
                );
              })}
          </div>
          {!current && (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="请选择可用的搭配"
            />
          )}
        </section>
      </div>
      {cover && edit ? (
        <CoverPreview
          cover={cover}
          edit={edit}
          property={property}
          sceneIds={sceneIds}
          language={
            current && partFor(library.parts, current, "script")?.language
          }
        />
      ) : (
        <section className="mix-panel">
          <h2>封面预览</h2>
          <Empty
            description="选择搭配后预览封面"
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          />
        </section>
      )}
      <Modal
        centered
        open={!!kind}
        title={kind ? "更换" + partLabel[kind] : ""}
        footer={null}
        onCancel={() => setKind(undefined)}
      >
        <Input.Search
          aria-label="搜索模板名称或版本"
          placeholder="搜索模板名称或版本"
          allowClear
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="mix-options">
          {kind && !search.trim() && options.length === 1 && (
            <small>当前已上架 1 款{partLabel[kind]}。</small>
          )}
          {options.length ? (
            options.map((part) => {
              const selected =
                current &&
                kind &&
                templateKey(part) === templateKey(current.parts[kind]);
              return (
                <button
                  type="button"
                  key={templateKey(part)}
                  aria-pressed={!!selected}
                  onClick={() => {
                    if (!kind || !current) return;
                    onChange({
                      ...current,
                      parts: {
                        ...current.parts,
                        [kind]: {
                          id: part.id,
                          version: part.version,
                          name: part.name,
                        },
                      },
                    });
                    setKind(undefined);
                  }}
                >
                  <span>
                    <strong>{part.name}</strong>
                    <small>
                      {describe(part)} · v{part.version}
                    </small>
                    {part.description && <small>{part.description}</small>}
                  </span>
                  {selected ? <Check size={18} /> : <ChevronRight size={16} />}
                </button>
              );
            })
          ) : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="没有匹配的已上架模板"
            />
          )}
        </div>
      </Modal>
      <Modal
        centered
        open={naming}
        title="存为我的搭配"
        okText="保存搭配"
        cancelText="取消"
        confirmLoading={saving}
        okButtonProps={{ disabled: !name.trim() }}
        onOk={() => void save()}
        onCancel={() => {
          if (!saving) setNaming(false);
        }}
      >
        <label className="mix-name">
          搭配名称
          <Input
            autoFocus
            maxLength={60}
            value={name}
            placeholder="例如：日常两居带看"
            onChange={(e) => {
              setName(e.target.value);
              setError("");
            }}
            onPressEnter={() => void save()}
          />
        </label>
        {error && <Alert type="error" showIcon title={error} />}
      </Modal>
    </div>
  );
}
