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

export function ProductionTemplateEditor() {
  const legacy = Form.useWatch(["production", "schemaVersion"]) === 1;
  return (
    <>
      <Alert
        type="info"
        showIcon
        title="一套模板包含整条视频的制作规则"
        description="模型参考整套房源资料和图片，按原图顺序撰写开场、逐图讲解和结尾。全景图和普通照片可在同一成片中使用。"
      />
      <Form.Item name={["production", "schemaVersion"]} hidden>
        <InputNumber />
      </Form.Item>
      <div className="admin-form-columns">
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
        <Form.Item
          name={field("videoMode")}
          label="视频表现"
          rules={[{ required: true }]}
          extra="露脸模式需要用户已配置可用形象。"
        >
          <Select
            options={choices([
              ["voiceover", "图片带看配音"],
              ["avatar", "经纪人开场露脸"],
            ])}
          />
        </Form.Item>
      </div>
      {legacy && (
        <p className="admin-secondary">
          支持变量：房源标题 {"{title}"}、已核实参数 {"{facts}"}、房源卖点{" "}
          {"{sellingPoints}"}。空间文案另支持 {"{room}"} 和 {"{description}"}
          ，必须包含 {"{room}"}。不要写入具体房源事实或未经核实的承诺。
        </p>
      )}
      {(legacy
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
          label="画面与封面样式"
          rules={[{ required: true }]}
        >
          <Select
            options={choices([
              ["standard", "标准 · 房源标题与品牌装饰"],
              ["classic", "简洁 · 传统带看"],
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
          label="镜头速度（度/秒）"
          rules={[{ required: true }]}
        >
          <InputNumber min={0.5} max={12} step={0.5} />
        </Form.Item>
        <Form.Item
          name={field("direction")}
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
          label="单镜头最大幅度（度）"
          rules={[{ required: true }]}
          extra="全景为旋转，扩图为平移；时长跟随配音，不强制拉伸。"
        >
          <InputNumber min={1} max={180} />
        </Form.Item>
      </div>
    </>
  );
}

export function ProductionPreview({
  value,
}: {
  value: ProductionTemplatePreview;
}) {
  const c = value.template.production.config;
  return (
    <>
      <Alert
        showIcon
        type="success"
        title="规则校验通过，可以上架此版本"
        description={
          value.template.production.schemaVersion === 2
            ? "多模态模型根据示例图片生成文案，供检查图文对应和版式。"
            : "这是示例房源的文案和版式示意，不生成收费 AI 图片、配音或视频。真实文案会依据所选房源生成，最终效果以生成视频为准。"
        }
      />
      <h2>
        {value.template.name} · {value.template.version}
      </h2>
      <div
        style={{
          margin: "20px auto",
          width: c.aspectRatio === "9:16" ? 200 : "100%",
          maxWidth: 420,
          aspectRatio: c.aspectRatio.replace(":", "/"),
          background: "linear-gradient(145deg, #e6e2dc, #adb6b0)",
          position: "relative",
          overflow: "hidden",
          borderRadius: 12,
          borderBottom: `6px solid ${c.brandColor}`,
          color: "#17333a",
          padding: 18,
        }}
      >
        <strong
          style={{
            background: c.design === "standard" ? c.brandColor : "#222",
            color: "white",
            padding: 6,
          }}
        >
          示例小区两居室
        </strong>
        <div
          style={{
            position: "absolute",
            top: "45%",
            left: 0,
            right: 0,
            textAlign: "center",
          }}
        >
          客厅 · 版式示意
        </div>
        {c.subtitles && (
          <div
            style={{
              position: "absolute",
              bottom: 24,
              left: 12,
              right: 12,
              textAlign: "center",
              color: "white",
              background: "#0009",
              fontSize: c.subtitleSize === "large" ? 18 : 14,
              padding: 8,
            }}
          >
            {value.segments[1]?.text.slice(0, 40)}
          </div>
        )}
      </div>
      <Descriptions
        size="small"
        column={2}
        items={[
          {
            key: "format",
            label: "成片",
            children: `${c.aspectRatio} · ${c.resolution}`,
          },
          {
            key: "mode",
            label: "表现",
            children:
              c.videoMode === "avatar" ? "经纪人开场露脸" : "图片带看配音",
          },
          {
            key: "motion",
            label: "镜头",
            children: `${c.direction === 1 ? "向右" : "向左"} ${c.speed}°/秒，上限 ${c.maxSweep}°`,
          },
          {
            key: "voice",
            label: "配音",
            children: `${c.language} · ${c.rate} 倍速`,
          },
        ]}
      />
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
      <p className="admin-secondary">
        按原图顺序逐张生成文案，用户确认整条文案后才开始制作。配音和形象使用用户自己的设置。
      </p>
    </>
  );
}

export function ProductionTemplateRules() {
  return (
    <>
      <h3>1. 从完整视频模板开始</h3>
      <p>
        推荐复制一套已上架模板，填写新的版本号和适用说明，再调整文案、画面、镜头和字幕。新建时默认给出一套可用规则。旧版风格、封面、字幕、提示词目录不会出现在新版视频工厂。
      </p>
      <h3>2. 结构与素材处理固定</h3>
      <p>
        开场 → 每张图片一个空间 →
        结尾，保持房源素材顺序。全景图旋转运镜，普通照片在文案确认后扩图并平移运镜。封面默认第一张图与房源标题。
      </p>
      <h3>3. 只填写可复用规则</h3>
      <p>
        写清整片受众与风格、开场重点、逐图要求和结尾方式。每条规则最多 1500
        字。具体房源事实来自房源资料，模板只规定写法。
      </p>
      <h3>4. 保存、预览、上架</h3>
      <p>
        保存草稿后，点击“预览校验”让模型根据示例图片写稿。检查图文对应与版式后上架。修改制作内容后需要重新预览。
      </p>
      <h3>5. 发布后的版本保持不变</h3>
      <p>
        已上架过的版本只允许上下架。内容变更用“复制新版本”，新版本以独立条目上架；检查后可手动下架旧版本。用户会看到模板名称和版本。下架禁止新任务选用，已有文案与视频保留当时的模板快照并可继续生成。
      </p>
    </>
  );
}
