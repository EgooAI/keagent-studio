import { useEffect, useState } from "react";
import {
  Button,
  Empty,
  Form,
  Input,
  InputNumber,
  Select,
  Slider,
  Space,
  Tabs,
  Tag,
} from "antd";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import type {
  PanoramaCapabilities,
  PanoramaConfig,
  PanoramaProperty,
  PanoramaScene,
  PanoramaSegment,
  PanoramaTemplate,
} from "@keagent/shared-types";
import { PanoramaSettings } from "./PanoramaSettings";

export function PanoramaTemplateEditor({
  caps,
  config,
  property,
  scenes,
  segments,
  templates,
  busy,
  patch,
  editScene,
  replaceScenes,
  editSegment,
  changeTemplate,
  changeLanguage,
  invalidate,
  saveTemplate,
}: {
  caps: PanoramaCapabilities;
  config: PanoramaConfig;
  property?: PanoramaProperty;
  scenes: PanoramaScene[];
  segments: PanoramaSegment[];
  templates: PanoramaTemplate[];
  busy: boolean;
  patch: (value: Partial<PanoramaConfig>) => void;
  editScene: (id: string, value: Partial<PanoramaScene>) => void;
  replaceScenes: (value: PanoramaScene[]) => void;
  editSegment: (id: string, text: string) => void;
  changeTemplate: (id: string) => void;
  changeLanguage: (value: PanoramaConfig["language"]) => void;
  invalidate: () => void;
  saveTemplate: (name: string, update: boolean) => void;
}) {
  const [selected, setSelected] = useState("opening");
  const [position, setPosition] = useState(50);
  const [name, setName] = useState("");
  useEffect(() => {
    if (
      !["opening", "closing", "cover"].includes(selected) &&
      !scenes.some((s) => s.id === selected)
    )
      setSelected("opening");
  }, [scenes, selected]);
  const cover = selected === "cover";
  const shortTour = config.design === "short-tour";
  const scene =
    scenes.find(
      (s) =>
        s.id ===
        (cover
          ? config.coverSceneId || config.leadSceneId
          : selected === "closing" && shortTour
            ? scenes.at(-1)?.id
            : selected === "opening" || selected === "closing"
              ? config.leadSceneId
              : selected),
    ) || scenes[0];
  const segment = segments.find((s) => s.id === selected);
  const spatial = !["opening", "closing", "cover"].includes(selected);
  const personal = templates.find((t) => t.id === config.templateId);
  const options = scenes.map((s) => ({ value: s.id, label: s.room }));
  const facts = property
    ? [
        property.layout,
        property.areaSqm > 0 ? `${property.areaSqm}㎡` : "",
        property.priceCents > 0 ? `${property.priceCents / 1000000}万元` : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  const heading =
    selected === "closing"
      ? config.language === "en-US"
        ? "Arrange a viewing"
        : "欢迎预约实地看房"
      : cover
        ? config.coverTitle || property?.title
        : selected === "opening"
          ? property?.title
          : "";
  const detail =
    selected === "closing"
      ? [config.agentName, config.agentContact].filter(Boolean).join(" · ")
      : facts;
  const hook =
    shortTour && !config.coverTitle ? property?.sellingPoints[0] || "" : "";
  const shortHeading =
    config.coverTitle || property?.community || property?.title || "";
  const shortLine = (value: string, count = 12) =>
    Array.from(value).length > count
      ? Array.from(value)
          .slice(0, count - 1)
          .join("") + "…"
      : value;
  const title = cover
    ? "封面"
    : selected === "opening"
      ? "开场"
      : selected === "closing"
        ? "结尾"
        : scene?.room || "空间";
  const rank = (s: PanoramaScene) => {
    const index = [
      /客厅|起居|living/i,
      /卧室|bed/i,
      /厨房|kitchen/i,
      /卫生|浴|洗手|bath/i,
      /阳台|balcony/i,
    ].findIndex((r) => r.test(s.room));
    return index < 0 ? 99 : index;
  };
  const templateCaps = {
    ...caps,
    templates: [
      ...caps.templates,
      ...templates.map((t) => ({
        id: t.id,
        name: `${t.name} · 我的模板`,
        version: String(t.version),
        opening: t.config.openingTemplate || "",
        scene: t.config.sceneTemplate || "",
        closing: t.config.closingTemplate || "",
      })),
    ],
  };
  const move = (offset: number) => {
    const index = scenes.findIndex((s) => s.id === selected);
    if (index < 0 || index + offset < 0 || index + offset >= scenes.length)
      return;
    const next = [...scenes];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    replaceScenes(next);
  };
  return (
    <div className="template-layout" aria-label="视频模板编辑器">
      <aside className="panel template-structure">
        <div className="template-panel-heading">
          <h2>视频结构</h2>
          <Tag>配音决定时长</Tag>
        </div>
        <Button
          block
          size="small"
          disabled={busy || scenes.length < 2}
          onClick={() =>
            replaceScenes([...scenes].sort((a, b) => rank(a) - rank(b)))
          }
        >
          按空间整理
        </Button>
        <nav aria-label="视频段落">
          {[
            { id: "opening", label: "开场", hint: "代表镜头 · 房源简介" },
            ...scenes.map((s, i) => ({
              id: s.id,
              label: `${i + 1}. ${s.room}`,
              hint:
                !s.kind || s.kind === "panorama"
                  ? "全景旋转"
                  : "请更换 VR 全景图",
            })),
            { id: "closing", label: "结尾", hint: "预约引导 · 经纪人" },
            { id: "cover", label: "封面", hint: "代表图 · 房源标题" },
          ].map((item) => (
            <button
              type="button"
              key={item.id}
              aria-pressed={selected === item.id}
              className={`template-step ${selected === item.id ? "active" : ""}`}
              onClick={() => setSelected(item.id)}
            >
              <strong>{item.label}</strong>
              <span>{item.hint}</span>
            </button>
          ))}
        </nav>
        {spatial && (
          <Space wrap>
            <Button
              aria-label="上移当前空间"
              disabled={busy || scenes[0]?.id === selected}
              icon={<ArrowUp size={14} />}
              onClick={() => move(-1)}
            />
            <Button
              aria-label="下移当前空间"
              disabled={busy || scenes.at(-1)?.id === selected}
              icon={<ArrowDown size={14} />}
              onClick={() => move(1)}
            />
            <Button
              aria-label="删除当前空间"
              disabled={busy}
              danger
              icon={<Trash2 size={14} />}
              onClick={() =>
                replaceScenes(scenes.filter((s) => s.id !== selected))
              }
            />
          </Space>
        )}
      </aside>
      <section
        className="panel template-preview-panel"
        aria-label="模板排版预览"
      >
        <div className="template-panel-heading">
          <h2>{title}预览</h2>
          <Tag>{config.aspectRatio}</Tag>
        </div>
        {scene ? (
          <>
            <div
              className={`template-preview ${config.aspectRatio === "9:16" ? "portrait" : "landscape"} ${shortTour ? "short-tour" : ""}`}
              style={{
                aspectRatio: config.aspectRatio === "9:16" ? "9/16" : "16/9",
              }}
            >
              <img
                src={scene.url}
                alt={`${scene.room}排版预览`}
                style={{ objectPosition: `${position}% center` }}
              />
              <div className="template-preview-shade" />
              {(!shortTour || property?.sample) && (
                <div className="template-preview-label">
                  {scene.room}
                  {property?.sample ? " · 测试素材" : ""}
                </div>
              )}
              {config.design !== "classic" &&
                heading &&
                !(shortTour && selected === "closing") && (
                  <div
                    className="template-preview-card"
                    style={
                      shortTour &&
                      selected === "opening" &&
                      !config.roomOpening &&
                      (config.openingPhoto || config.openingClip)
                        ? { top: "4%" }
                        : undefined
                    }
                  >
                    <span
                      className="template-preview-accent"
                      style={{
                        backgroundColor: config.brandColor || "#167D8D",
                      }}
                    />
                    <strong
                      style={
                        shortTour
                          ? { color: config.brandColor || "#FFD447" }
                          : undefined
                      }
                    >
                      {shortTour
                        ? shortLine(shortHeading, hook ? 12 : 24)
                        : heading}
                    </strong>
                    {hook && (
                      <strong style={{ color: config.brandColor || "#FFD447" }}>
                        {shortLine(hook)}
                      </strong>
                    )}
                    {detail && <p>{detail}</p>}
                  </div>
                )}
              {!cover && config.subtitles && (
                <div
                  className={`template-preview-caption ${config.subtitleSize === "large" ? "large" : ""}`}
                >
                  {segment?.text?.slice(0, shortTour ? 12 : undefined) ||
                    "生成文案后，可在此预览并逐段审核"}
                </div>
              )}
            </div>
            <Slider
              aria-label="预览取景位置"
              value={position}
              onChange={setPosition}
            />
            <p className="muted">
              排版与取景示意；全景投影、镜头运动和配音请以生成的视频为准。
            </p>
          </>
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="先获取或导入素材，再预览模板"
          />
        )}
      </section>
      <section className="panel template-settings" aria-label="段落与公共设置">
        <Form layout="vertical" disabled={busy}>
          <Tabs
            items={[
              {
                key: "segment",
                label: "当前段落",
                children: (
                  <>
                    <h2>{title}设置</h2>
                    {(selected === "opening" || cover) && (
                      <Form.Item label={cover ? "封面图片" : "开场代表镜头"}>
                        <Select
                          aria-label={cover ? "封面图片" : "开场代表镜头"}
                          value={
                            (cover
                              ? config.coverSceneId || config.leadSceneId
                              : config.leadSceneId) || scenes[0]?.id
                          }
                          options={options}
                          onChange={(id) => {
                            patch(
                              cover
                                ? { coverSceneId: id }
                                : { leadSceneId: id },
                            );
                            if (!cover) invalidate();
                          }}
                        />
                      </Form.Item>
                    )}
                    {cover && (
                      <Form.Item label="本条视频的封面标题">
                        <Input
                          maxLength={120}
                          placeholder={property?.title || "默认使用房源标题"}
                          value={config.coverTitle || ""}
                          onChange={(e) =>
                            patch({ coverTitle: e.target.value })
                          }
                        />
                      </Form.Item>
                    )}
                    {selected === "closing" && (
                      <>
                        <Form.Item label="经纪人姓名">
                          <Input
                            maxLength={120}
                            value={config.agentName || ""}
                            onChange={(e) =>
                              patch({ agentName: e.target.value })
                            }
                          />
                        </Form.Item>
                        <Form.Item label="预约联系方式">
                          <Input
                            maxLength={120}
                            value={config.agentContact || ""}
                            onChange={(e) =>
                              patch({ agentContact: e.target.value })
                            }
                          />
                        </Form.Item>
                        <p className="muted">
                          未填写的信息不展示；这些身份信息不会保存进模板。
                        </p>
                      </>
                    )}
                    {spatial && scene && (
                      <>
                        <Form.Item label="空间名称">
                          <Input
                            aria-label="当前空间名称"
                            maxLength={80}
                            value={scene.room}
                            onChange={(e) =>
                              editScene(scene.id, { room: e.target.value })
                            }
                          />
                        </Form.Item>
                        <Form.Item label="已核实的空间说明">
                          <Input.TextArea
                            aria-label="当前空间说明"
                            maxLength={1500}
                            autoSize={{ minRows: 3 }}
                            value={scene.description}
                            placeholder="可留空，不把AI补画内容写成房屋事实"
                            onChange={(e) =>
                              editScene(scene.id, {
                                description: e.target.value,
                              })
                            }
                          />
                        </Form.Item>
                        <Form.Item label="镜头方向">
                          <Select
                            value={scene.direction || config.direction}
                            options={[
                              { value: 1, label: "向右" },
                              { value: -1, label: "向左" },
                            ]}
                            onChange={(direction) =>
                              editScene(scene.id, { direction })
                            }
                          />
                        </Form.Item>
                        {(!scene.kind || scene.kind === "panorama") && (
                          <Form.Item label="全景起始视角">
                            <InputNumber
                              min={-180}
                              max={180}
                              value={scene.yaw}
                              onChange={(yaw) =>
                                editScene(scene.id, { yaw: yaw ?? 0 })
                              }
                            />
                          </Form.Item>
                        )}
                        {scene.kind && scene.kind !== "panorama" && (
                          <p>请更换为原始 VR 全景图后重新生成文案。</p>
                        )}
                      </>
                    )}
                    {!cover && (
                      <Form.Item label="分段文案">
                        <Input.TextArea
                          aria-label={`审核${selected === "opening" ? "开场" : selected === "closing" ? "结尾" : "空间"}文案`}
                          disabled={!segment || busy}
                          value={segment?.text || ""}
                          placeholder="生成分段文案后，在这里审核和修改"
                          maxLength={2000}
                          autoSize={{ minRows: 4, maxRows: 10 }}
                          onChange={(e) =>
                            segment && editSegment(segment.id, e.target.value)
                          }
                        />
                      </Form.Item>
                    )}
                  </>
                ),
              },
              {
                key: "global",
                label: "公共设置",
                children: (
                  <>
                    <PanoramaSettings
                      caps={templateCaps}
                      config={config}
                      patch={patch}
                      changeTemplate={changeTemplate}
                      changeLanguage={changeLanguage}
                      invalidate={invalidate}
                    />
                    <h2>画面与封面样式</h2>
                    <Form.Item label="画面设计">
                      <Select
                        value={config.design || "standard"}
                        options={[
                          { value: "standard", label: "标准带看 · 标题信息卡" },
                          {
                            value: "classic",
                            label: "简洁画面 · 仅空间与字幕",
                          },
                          {
                            value: "short-tour",
                            label: "短视频带看 · 醒目开场与短字幕",
                          },
                        ]}
                        onChange={(design) => patch({ design })}
                      />
                    </Form.Item>
                    <Form.Item label="品牌颜色">
                      <input
                        aria-label="品牌颜色"
                        type="color"
                        disabled={busy}
                        value={config.brandColor || "#167D8D"}
                        onChange={(e) => patch({ brandColor: e.target.value })}
                      />
                    </Form.Item>
                    <Form.Item label="字幕大小">
                      <Select
                        value={config.subtitleSize || "standard"}
                        options={[
                          { value: "standard", label: "标准" },
                          { value: "large", label: "大字" },
                        ]}
                        onChange={(subtitleSize) => patch({ subtitleSize })}
                      />
                    </Form.Item>
                    <h2>我的模板（本机）</h2>
                    <Form.Item label="模板名称">
                      <Input
                        aria-label="模板名称"
                        maxLength={60}
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder={personal?.name || "例如：门店标准带看"}
                      />
                    </Form.Item>
                    <Space wrap>
                      <Button
                        disabled={!name.trim()}
                        onClick={() => saveTemplate(name, false)}
                      >
                        另存模板
                      </Button>
                      {personal && (
                        <Button
                          onClick={() =>
                            saveTemplate(name.trim() || personal.name, true)
                          }
                        >
                          更新当前模板
                        </Button>
                      )}
                    </Space>
                    <p className="muted">
                      保存结构规则、文案和样式，不保存本套房源照片、具体文案或身份信息。已保存草稿使用自己的模板快照。
                    </p>
                  </>
                ),
              },
            ]}
          />
        </Form>
      </section>
    </div>
  );
}
