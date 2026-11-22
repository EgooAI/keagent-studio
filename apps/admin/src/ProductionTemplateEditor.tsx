import {
  Alert,
  Form,
  Input,
  InputNumber,
  Select,
  Switch,
  Descriptions,
  Tag,
} from "antd";
import type {
  ProductionTemplateRecipe,
  ProductionTemplatePreview,
} from "@keagent/shared-types";
import { CatalogSummary, CoverExample } from "./TemplateCatalog";

export const defaultProduction: Extract<
  ProductionTemplateRecipe,
  { schemaVersion: 2 }
> = {
  schemaVersion: 2,
  scriptRules: {
    overall: "面向潜在买家，语气自然，按素材顺序讲完整套房源，避免重复。",
    opening: "用一两句交代本次带看的重点，仅引用已核实的房源事实。",
    scene: "围绕当前照片可见的内容写一两句，用其他图片辅助理解和衔接。",
    closing: "简短收束，邀请有意向的买家预约实地看房。",
  },
  config: {
    language: "zh-CN",
    videoMode: "voiceover",
    rate: 1,
    speed: 4,
    direction: 1,
    maxSweep: 100,
    aspectRatio: "9:16",
    resolution: "720p",
    subtitles: true,
    design: "standard",
    brandColor: "#167D8D",
    subtitleSize: "standard",
  },
};

const field = (key: string) => ["production", "config", key];
const choices = (values: [string | number, string][]) =>
  values.map(([value, label]) => ({ value, label }));

export function ProductionTemplateEditor({
  section = "legacy",
}: {
  section?: "edit" | "script" | "legacy";
}) {
  const editFields = section !== "script";
  const scriptFields = section !== "edit";
  const legacy = Form.useWatch(["production", "schemaVersion"]) === 1;
  const videoMode = Form.useWatch(field("videoMode"));
  const shortTour = Form.useWatch(field("design")) === "short-tour";
  const spatial = Form.useWatch(field("cameraMode")) === "spatial";
  return (
    <>
      {section === "legacy" && (
        <Alert
          type="info"
          showIcon
          title="一套模板包含整条视频的制作规则"
          description="模型参考房源资料和原图撰写讲解。全景旋转使用原始 VR 全景图；空间走动需要含三维模型与拍摄点的 Realsee VR 素材。"
        />
      )}
      <Form.Item name={["production", "schemaVersion"]} hidden>
        <InputNumber />
      </Form.Item>
      <div className="admin-form-columns">
        {scriptFields && (
          <Form.Item
            name={field("language")}
            label="文案语言"
            rules={[{ required: true }]}
          >
            <Select
              options={choices([
                ["zh-CN", "中文"],
                ["en-US", "英文"],
              ])}
            />
          </Form.Item>
        )}
        {editFields && (
          <Form.Item
            name={field("videoMode")}
            label="视频表现"
            rules={[{ required: true }]}
          >
            <Select
              options={choices([
                ["voiceover", "图片带看配音"],
                ["avatar", "经纪人开场视频"],
              ])}
            />
          </Form.Item>
        )}
      </div>
      {editFields && !legacy && (
        <Form.Item
          name={field("cameraMode")}
          label="室内镜头"
          extra="空间走动沿真实三维空间中的拍摄点移动，不生成或补画房屋结构。"
        >
          <Select
            placeholder="全景旋转（默认）"
            options={choices([
              ["panorama", "全景旋转"],
              ["spatial", "真实空间走动"],
            ])}
          />
        </Form.Item>
      )}
      {editFields && videoMode === "avatar" && (
        <p className="admin-secondary">
          制作时由用户选择本机开场视频，使用视频原声。文案和配音从房源带看开始。
        </p>
      )}
      {scriptFields && legacy && (
        <p className="admin-secondary">
          支持变量：房源标题 {"{title}"}、已核实参数 {"{facts}"}、房源卖点{" "}
          {"{sellingPoints}"}。空间文案另支持 {"{room}"} 和 {"{description}"}
          ，必须包含 {"{room}"}。不要写入具体房源事实或未经核实的承诺。
        </p>
      )}
      {scriptFields &&
        (legacy
          ? [
              ["openingTemplate", "开场文案"],
              ["sceneTemplate", "每张图片对应的空间文案"],
              ["closingTemplate", "结尾文案"],
            ]
          : [
              ["overall", "整片文案规则"],
              ["opening", "开场文案规则"],
              ["scene", "逐图文案规则"],
              ["closing", "结尾文案规则"],
            ]
        ).map(([key, label]) => (
          <Form.Item
            key={key}
            name={legacy ? field(key) : ["production", "scriptRules", key]}
            label={label}
            rules={[{ required: true, whitespace: true, max: 1500 }]}
          >
            <Input.TextArea rows={2} maxLength={1500} showCount />
          </Form.Item>
        ))}
      {editFields && (
        <div className="admin-form-columns">
          <Form.Item
            name={field("aspectRatio")}
            label="画幅"
            rules={[{ required: true }]}
          >
            <Select
              options={choices([
                ["9:16", "竖屏 9:16"],
                ["16:9", "横屏 16:9"],
              ])}
            />
          </Form.Item>
          <Form.Item
            name={field("resolution")}
            label="分辨率"
            rules={[{ required: true }]}
          >
            <Select
              options={choices([
                ["720p", "720p"],
                ["1080p", "1080p"],
              ])}
            />
          </Form.Item>
          <Form.Item
            name={field("design")}
            label={section === "legacy" ? "画面与封面样式" : "画面样式"}
            rules={[{ required: true }]}
          >
            <Select
              options={choices([
                ["standard", "标准 · 房源标题与品牌装饰"],
                ["classic", "简洁 · 传统带看"],
                ["short-tour", "短视频带看 · 醒目开场与短字幕"],
              ])}
            />
          </Form.Item>
          <Form.Item
            name={field("brandColor")}
            label="品牌色"
            rules={[
              {
                required: true,
                pattern: /^#[0-9a-fA-F]{6}$/,
                message: "例如 #167D8D",
              },
            ]}
          >
            <Input maxLength={7} placeholder="#167D8D" />
          </Form.Item>
          <Form.Item
            name={field("subtitles")}
            label="显示字幕"
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          <Form.Item
            name={field("subtitleSize")}
            label="字幕字号"
            rules={[{ required: true }]}
          >
            <Select
              options={choices([
                ["standard", "标准"],
                ["large", "大字"],
              ])}
            />
          </Form.Item>
          <Form.Item
            name={field("rate")}
            label="配音语速倍数"
            rules={[{ required: true }]}
          >
            <InputNumber min={0.5} max={2} step={0.1} />
          </Form.Item>
          <Form.Item
            name={field("speed")}
            hidden={spatial}
            label={shortTour ? "镜头基准速度（度/秒）" : "镜头速度（度/秒）"}
            rules={[{ required: true }]}
            extra={
              shortTour
                ? "同图连续镜头受最大转角限制，较长镜头会降低实际速度。"
                : undefined
            }
          >
            <InputNumber min={0.5} max={45} step={0.5} />
          </Form.Item>
          <Form.Item
            name={field("direction")}
            hidden={spatial}
            label="镜头方向"
            rules={[{ required: true }]}
          >
            <Select
              options={choices([
                [1, "向右"],
                [-1, "向左"],
              ])}
            />
          </Form.Item>
          <Form.Item
            name={field("maxSweep")}
            hidden={spatial}
            label="单镜头最大幅度（度）"
            rules={[{ required: true }]}
            extra="VR 全景使用旋转运镜，时长跟随配音，不强制拉伸。"
          >
            <InputNumber min={1} max={180} />
          </Form.Item>
        </div>
      )}
    </>
  );
}

export function ProductionPreview({
  value,
}: {
  value: ProductionTemplatePreview;
}) {
  const c = value.template.production.config;
  const shortTour = c.design === "short-tour";
  const kind = value.definition?.kind;
  const showEdit = !kind || kind === "edit" || kind === "bundle";
  const showScript = !kind || kind === "script" || kind === "bundle";
  return (
    <>
      <Alert
        showIcon
        type="success"
        title="模板规则校验通过"
        description={
          !showScript
            ? "根据当前版本的设置展示示例房源版式。"
            : value.template.production.schemaVersion === 2
              ? "多模态模型根据示例图片生成文案，供检查图文对应和版式。"
              : "这是示例房源的文案和版式示意，不生成收费 AI 图片、配音或视频。真实文案会依据所选房源生成，最终效果以生成视频为准。"
        }
      />
      <h2>
        {value.template.name} · {value.template.version}
      </h2>
      {value.definition?.kind === "bundle" && (
        <CatalogSummary definition={value.definition} />
      )}
      <div className={kind === "bundle" ? "admin-preview-pair" : undefined}>
        {value.cover && (
          <CoverExample cover={value.cover} aspect={c.aspectRatio} />
        )}
        {showEdit && (
          <div className="admin-edit-example">
            <div
              style={{
                aspectRatio: c.aspectRatio.replace(":", "/"),
                background:
                  "linear-gradient(#ffffff30,#00000030), url('/media/interior-1.jpg') center / cover",
                position: "relative",
                overflow: "hidden",
                borderRadius: 12,
                borderBottom: shortTour
                  ? undefined
                  : `6px solid ${c.brandColor}`,
                color: "#17333a",
                padding: 18,
              }}
            >
              <div
                style={
                  shortTour
                    ? {
                        position: "absolute",
                        top: c.videoMode === "avatar" ? "4%" : "13%",
                        left: 18,
                        right: 18,
                      }
                    : undefined
                }
              >
                <strong
                  style={{
                    display: "block",
                    background: shortTour
                      ? undefined
                      : c.design === "standard"
                        ? c.brandColor
                        : "#222",
                    color: shortTour ? c.brandColor : "white",
                    padding: 6,
                    textAlign: shortTour ? "center" : undefined,
                    textShadow: shortTour
                      ? "-1px -1px #111, 1px 1px #111, 1px -1px #111, -1px 1px #111"
                      : undefined,
                  }}
                >
                  示例小区两居室
                </strong>
                {shortTour && (
                  <p
                    style={{
                      textAlign: "center",
                      color: "white",
                      textShadow: "1px 1px 2px black",
                      fontSize: 11,
                    }}
                  >
                    房源已核实参数
                  </p>
                )}
              </div>
              {c.subtitles && (
                <div
                  style={{
                    position: "absolute",
                    bottom: shortTour ? "26%" : 24,
                    left: 12,
                    right: 12,
                    textAlign: "center",
                    color: "white",
                    background: shortTour ? undefined : "#0009",
                    fontSize: c.subtitleSize === "large" ? 18 : 14,
                    fontWeight: shortTour ? 700 : undefined,
                    textShadow: shortTour
                      ? "-1px -1px #111, 1px 1px #111, 1px -1px #111, -1px 1px #111"
                      : undefined,
                    padding: 8,
                  }}
                >
                  {value.segments[1]?.text.slice(0, shortTour ? 12 : 40) ||
                    "一起看看这间客厅"}
                </div>
              )}
            </div>
            {kind && <p className="admin-preview-caption">剪辑版式示意</p>}
          </div>
        )}
      </div>
      {showEdit && (
        <>
          <Descriptions
            size="small"
            column={2}
            items={[
              {
                key: "format",
                label: "成片",
                children: `${c.aspectRatio} · ${c.resolution} · ${shortTour ? 30 : 25} fps`,
              },
              {
                key: "mode",
                label: "表现",
                children:
                  c.videoMode === "avatar" ? "经纪人开场视频" : "图片带看配音",
              },
              {
                key: "motion",
                label: "镜头",
                children:
                  c.cameraMode === "spatial"
                    ? "真实三维空间中从起点走向目标拍摄点，时长跟随配音"
                    : shortTour
                      ? `${c.direction === 1 ? "向右" : "向左"}，基准 ${c.speed}°/秒，最大转角 ${c.maxSweep}°；长镜头会适当减速`
                      : `${c.direction === 1 ? "向右" : "向左"} ${c.speed}°/秒，上限 ${c.maxSweep}°`,
              },
              {
                key: "voice",
                label: "配音",
                children:
                  kind === "edit"
                    ? c.rate + " 倍速"
                    : `${c.language} · ${c.rate} 倍速`,
              },
            ]}
          />
        </>
      )}
      {kind && showScript && (
        <h3>示例文案 · {c.language === "en-US" ? "英文" : "中文"}</h3>
      )}
      {value.segments.map((segment, index) => (
        <div
          key={segment.id}
          style={{
            marginTop: 18,
            padding: 16,
            background: "var(--ant-color-fill-quaternary, #f5f5f5)",
            borderRadius: 8,
          }}
        >
          <Tag>
            {segment.id === "opening"
              ? "开场"
              : segment.id === "closing"
                ? "结尾"
                : `图片 ${index}`}
          </Tag>
          {segment.id.startsWith("preview-") && (
            <img
              src={`/media/interior-${index}.jpg`}
              alt={`示例图片 ${index}`}
              width={180}
              style={{ display: "block", marginTop: 8 }}
            />
          )}
          <p style={{ whiteSpace: "pre-wrap" }}>{segment.text}</p>
        </div>
      ))}
      {showScript && (
        <p className="admin-secondary">
          按原图顺序逐张生成文案，用户确认整条文案后才开始制作。配音和形象使用用户自己的设置。
        </p>
      )}
    </>
  );
}

export function ProductionTemplateRules() {
  return (
    <>
      <h3>1. 从完整视频模板开始</h3>
      <p>
        点击“更新版本”，填写版本号和适用说明，再调整文案、画面、镜头和字幕。完整模板供早期客户端使用。
      </p>
      <h3>2. 结构与素材处理固定</h3>
      <p>
        开场 → 每张图片一个空间 → 结尾，保持房源素材顺序。仅使用原始 VR
        全景图旋转运镜。封面默认第一张图与房源标题。
      </p>
      <h3>3. 只填写可复用规则</h3>
      <p>
        写清整片受众与风格、开场重点、逐图要求和结尾方式。每条规则最多 1500
        字。具体房源事实来自房源资料，模板只规定写法。
      </p>
      <h3>4. 保存、预览、启用</h3>
      <p>
        保存草稿后，点击“预览校验”检查示例文案和版式。模板内容未变时可查看已有校验结果。修改后请重新校验。
      </p>
      <h3>5. 在版本记录里切换版本</h3>
      <p>
        启用后的版本内容会锁定。在编辑页顶部的版本记录中选择要查看或启用的版本。启用另一个版本会同时停用原版本。已有任务保留当时的模板快照。
      </p>
    </>
  );
}
