import type { CSSProperties } from "react";
import { Alert, Button, Empty, Form, Input, Select, Switch } from "antd";
import { useQuery } from "@tanstack/react-query";
import { Clapperboard, Files, Image, Layers3, TextQuote } from "lucide-react";
import { serviceRequest } from "@keagent/api-client";
import type {
  CatalogKind,
  CatalogTemplate,
  CoverTemplate,
  TemplatePartOption,
  TemplatePartKind,
  TemplatePartRef,
} from "@keagent/shared-types";

export const catalogSections = {
  bundle: {
    label: "推荐搭配",
    icon: Layers3,
    description: "将三个已上架的模板版本组合成一套创作方案。",
  },
  edit: {
    label: "剪辑模板",
    icon: Clapperboard,
    description: "设置开场方式、室内运镜、画幅和字幕。",
  },
  cover: {
    label: "封面模板",
    icon: Image,
    description: "选择封面取图、标题来源和房源信息版式。",
  },
  script: {
    label: "文案模板",
    icon: TextQuote,
    description: "维护开场、逐图讲解和结尾的写作规则。",
  },
  legacy: {
    label: "旧版完整模板",
    icon: Files,
    description: "维护早期客户端使用的完整制作版本。",
  },
} as const;
export type CatalogSection = keyof typeof catalogSections;
export const partKinds: TemplatePartKind[] = ["edit", "cover", "script"];
const sections: CatalogKind[] = ["bundle", ...partKinds];
const designLabels = {
  standard: "品牌信息栏",
  classic: "简洁标题",
  "short-tour": "醒目大标题",
};
export const defaultCover: CoverTemplate = {
  kind: "cover",
  design: "standard",
  brandColor: "#167D8D",
  imageSource: "first",
  titleSource: "opening",
  showFacts: true,
};

export function CatalogNav({
  current,
  onSelect,
}: {
  current: CatalogSection;
  onSelect: (value: CatalogSection) => void;
}) {
  return (
    <nav className="admin-catalog-nav" aria-label="公共模板分类">
      {sections.map((key) => {
        const { icon: Icon, label } = catalogSections[key];
        return (
          <button
            type="button"
            key={key}
            aria-pressed={current === key}
            onClick={() => onSelect(key)}
          >
            <Icon size={19} aria-hidden="true" />
            {label}
          </button>
        );
      })}
    </nav>
  );
}

export function CatalogSummary({
  definition,
}: {
  definition: CatalogTemplate;
}) {
  switch (definition.kind) {
    case "bundle":
      return (
        <dl className="admin-bundle-parts">
          {partKinds.map((key) => {
            const part = definition.parts[key];
            return (
              <div key={key}>
                <dt>{catalogSections[key].label.slice(0, 2)}</dt>
                <dd>
                  {part.name} <small>v{part.version}</small>
                </dd>
              </div>
            );
          })}
        </dl>
      );
    case "edit": {
      const c = definition.config;
      return (
        <span>
          {c.cameraMode === "spatial" ? "空间走动" : "全景旋转"} ·{" "}
          {c.videoMode === "avatar" ? "经纪人开场" : "房源开场"}
          <br />
          <small>
            {c.aspectRatio} · {c.resolution} ·{" "}
            {c.subtitles ? "含字幕" : "无字幕"}
          </small>
        </span>
      );
    }
    case "cover":
      if (definition.imageSource === "frame")
        return <span>取成片首秒画面</span>;
      return (
        <span className="admin-cover-summary">
          <i style={{ backgroundColor: definition.brandColor }} />
          {designLabels[definition.design]} ·{" "}
          {definition.imageSource === "first" ? "首张素材" : "末张素材"}
        </span>
      );
    case "script":
      return (
        <span className="admin-script-summary">
          {definition.language === "en-US" ? "英文" : "中文"} ·{" "}
          {"scriptRules" in definition
            ? definition.scriptRules.overall
            : definition.phrases.openingTemplate}
        </span>
      );
  }
}

function VersionSelect({
  id,
  value,
  onChange,
  choices,
  disabled,
  loading,
}: {
  id?: string;
  value?: TemplatePartRef;
  onChange?: (v: TemplatePartRef) => void;
  choices: TemplatePartOption[];
  disabled?: boolean;
  loading?: boolean;
}) {
  const options = choices.map((part) => ({
    value: part.id,
    label: part.name + " · v" + part.version,
  }));
  if (value && !options.some((o) => o.value === value.id)) {
    options.push({
      value: value.id,
      label:
        value.name +
        " · v" +
        value.version +
        (disabled || loading ? "" : "（历史版本）"),
    });
  }
  return (
    <Select
      id={id}
      disabled={disabled}
      loading={loading}
      value={value?.id}
      options={options}
      placeholder="选择已上架版本"
      showSearch={{ optionFilterProp: "label" }}
      virtual={false}
      notFoundContent={
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="暂无匹配的已上架版本"
        />
      }
      onChange={(id) => {
        const part = choices.find((o) => o.id === id);
        if (part)
          onChange?.({ id: part.id, version: part.version, name: part.name });
      }}
    />
  );
}

export function BundleEditor({
  readOnly,
  disabled,
}: {
  readOnly: boolean;
  disabled: boolean;
}) {
  const query = useQuery({
    queryKey: ["admin", "template-part-options"],
    enabled: !readOnly,
    queryFn: () =>
      serviceRequest<TemplatePartOption[]>("/v1/admin/resources/parts"),
  });
  return (
    <div className="admin-bundle-editor">
      {query.error && (
        <Alert
          type="error"
          showIcon
          title="模板版本读取失败"
          description={query.error.message}
          action={<Button onClick={() => void query.refetch()}>重试</Button>}
        />
      )}
      {partKinds.map((key) => {
        const { label, icon: Icon } = catalogSections[key];
        const choices = (query.data || []).filter((part) => part.kind === key);
        return (
          <div className="admin-bundle-slot" key={key}>
            <Icon size={20} aria-hidden="true" />
            <Form.Item
              label={label}
              name={["parts", key]}
              rules={[
                { required: true, message: "请选择" + label },
                {
                  validator: async (_, value?: TemplatePartRef) => {
                    if (
                      value &&
                      !readOnly &&
                      query.isSuccess &&
                      !choices.some(
                        (part) =>
                          part.id === value.id &&
                          part.version === value.version,
                      )
                    ) {
                      throw new Error("请替换为已上架的" + label + "版本");
                    }
                  },
                },
              ]}
              extra={
                !readOnly && query.isSuccess && !choices.length
                  ? "请先在" + label + "目录中上架一个版本。"
                  : undefined
              }
            >
              <VersionSelect
                disabled={disabled || readOnly}
                loading={query.isFetching}
                choices={choices}
              />
            </Form.Item>
          </div>
        );
      })}
    </div>
  );
}

export function CoverExample({
  cover,
  aspect = "9:16",
}: {
  cover: CoverTemplate;
  aspect?: "9:16" | "16:9";
}) {
  return (
    <figure className="admin-cover-example">
      <div
        className={"admin-cover-frame design-" + cover.design}
        style={
          {
            "--cover-color": cover.brandColor,
            aspectRatio: aspect.replace(":", "/"),
          } as CSSProperties
        }
      >
        {cover.imageSource === "frame" ? (
          <video
            aria-label="示例成片首秒画面"
            muted
            preload="auto"
            playsInline
            src="/media/demo-property.mp4"
            onLoadedMetadata={(event) => {
              const movie = event.currentTarget;
              movie.currentTime = Math.min(1, movie.duration / 2);
            }}
          />
        ) : (
          <>
            <img
              src={
                cover.imageSource === "first"
                  ? "/media/interior-1.jpg"
                  : "/media/interior-2.jpg"
              }
              alt="示例房源素材"
            />
            <div className="admin-cover-caption">
              <strong>
                {cover.titleSource === "opening"
                  ? "带你看这套两居"
                  : "示例小区两居室"}
              </strong>
              {cover.showFacts && <span>两室一厅 · 80 m²</span>}
            </div>
          </>
        )}
      </div>
      <figcaption>示例封面 · {aspect}</figcaption>
    </figure>
  );
}

export function CoverEditor() {
  const cover: CoverTemplate | undefined = Form.useWatch("cover");
  const frame = cover?.imageSource === "frame";
  return (
    <div className="admin-cover-editor">
      <div>
        <Form.Item
          name={["cover", "imageSource"]}
          label="封面取图"
          rules={[{ required: true }]}
        >
          <Select
            options={[
              { value: "first", label: "首张视频素材" },
              { value: "last", label: "末张视频素材" },
              { value: "frame", label: "取成片首秒画面" },
            ]}
          />
        </Form.Item>
        <Form.Item
          name={["cover", "design"]}
          hidden={frame}
          label="封面版式"
          rules={[{ required: true }]}
        >
          <Select
            options={Object.entries(designLabels).map(([value, label]) => ({
              value,
              label,
            }))}
          />
        </Form.Item>
        <Form.Item
          name={["cover", "brandColor"]}
          hidden={frame}
          label="封面品牌色"
          rules={[
            {
              required: true,
              pattern: /^#[\da-f]{6}$/i,
              message: "请输入六位十六进制颜色，例如 #167D8D",
            },
          ]}
        >
          <Input
            maxLength={7}
            prefix={
              <span
                className="admin-color-swatch"
                style={{
                  backgroundColor: /^#[\da-f]{6}$/i.test(
                    cover?.brandColor || "",
                  )
                    ? cover?.brandColor
                    : defaultCover.brandColor,
                }}
                aria-hidden="true"
              />
            }
          />
        </Form.Item>
        <Form.Item
          name={["cover", "titleSource"]}
          hidden={frame}
          label="封面标题来源"
          rules={[{ required: true }]}
        >
          <Select
            options={[
              { value: "opening", label: "沿用片头标题" },
              { value: "property", label: "使用房源标题" },
            ]}
          />
        </Form.Item>
        <Form.Item
          name={["cover", "showFacts"]}
          hidden={frame}
          label="展示房源参数"
          valuePropName="checked"
        >
          <Switch />
        </Form.Item>
      </div>
      <CoverExample cover={{ ...defaultCover, ...cover }} />
    </div>
  );
}

export function CatalogRules() {
  return (
    <div className="admin-catalog-rules">
      <h3>发布模板</h3>
      <p>
        分别维护剪辑、封面与文案。保存草稿并完成预览校验后，即可在版本记录中启用。
      </p>
      <h3>组合推荐搭配</h3>
      <p>
        每项选择一个已上架版本。预览时可以同时核对剪辑参数、独立封面和根据示例房源生成的口播。
      </p>
      <h3>更新搭配</h3>
      <p>
        已发布的搭配固定引用选定版本。点击「更新版本」可以替换其中一项。要同时提供两种方案，在版本页选择「复制搭配」并为新方案命名。
      </p>
      <h3>当前桌面端</h3>
      <p>
        视频工厂的「新建视频」展示已上架的推荐搭配。用户可以用同款，独立更换剪辑、封面或文案，并保存到自己的搭配库。
      </p>
    </div>
  );
}
