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

export const defaultProduction: ProductionTemplateRecipe = {
  schemaVersion: 1,
  config: {
    language: "zh-CN",
    openingTemplate: "一起看看{title}。{facts}",
    sceneTemplate: "这里是{room}。{description}",
    closingTemplate: "欢迎预约实地看房，具体情况以现场核验为准。",
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
  return (
    <>
      <Alert
        type="info"
        showIcon
        title="一套模板包含整条视频的制作规则"
        description="固定为开场 → 按原图顺序逐空间介绍 → 结尾。优先使用原全景图；仅有普通图时先扩图。封面取第一张素材和房源标题。"
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
      <p className="admin-secondary">
        支持变量：房源标题 {"{title}"}、已核实参数 {"{facts}"}、房源卖点{" "}
        {"{sellingPoints}"}。空间文案另支持 {"{room}"} 和 {"{description}"}
        ，必须包含 {"{room}"}。不要写入具体房源事实或未经核实的承诺。
      </p>
      {(
        [
          ["openingTemplate", "开场文案"],
          ["sceneTemplate", "每张图片对应的空间文案"],
          ["closingTemplate", "结尾文案"],
        ] as const
      ).map(([key, label]) => (
        <Form.Item
          key={key}
          name={field(key)}
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
        description="这是示例房源的文案和版式示意，不生成收费 AI 图片、配音或视频。真实文案会依据所选房源生成，最终效果以生成视频为准。"
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
          <Tag>{["开场", "图片 1 · 客厅", "结尾"][index]}</Tag>
          <p style={{ whiteSpace: "pre-wrap" }}>{segment.text}</p>
        </div>
      ))}
      <p className="admin-secondary">
        多张图片时，中间的空间文案按原素材顺序逐张生成。AI
        文案服务可按上述句式改写；用户确认整条文案后才开始制作。声音使用用户可用的配音，模板不绑定个人声音或形象。
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
        结尾，保持房源素材顺序。原全景图优先；没有全景图时普通图先进行 AI
        扩图，并在结果保留 AI
        标识。封面默认第一张图与房源标题。模板不能改变此流程。
      </p>
      <h3>3. 只填写可复用规则</h3>
      <p>
        使用字段旁说明中的变量，空间句式必须包含 {"{room}"}
        。开场和结尾不能使用空间专属变量。每段最多 1500 字，版本使用 1.0.0
        格式。禁止把特定房源价格、面积、学区、收益承诺写成固定文案；禁止放入密钥、素材链接、个人声音或形象
        ID。
      </p>
      <h3>4. 保存、预览、上架</h3>
      <p>
        先保存草稿，再在列表点击“预览校验”。服务会检查变量、参数范围和规则完整性。检查示例文案与版式后上架。修改任何制作内容后，需要重新预览。
      </p>
      <h3>5. 发布后的版本保持不变</h3>
      <p>
        已上架过的版本只允许上下架。内容变更用“复制新版本”，新版本以独立条目上架；检查后可手动下架旧版本。用户会看到模板名称和版本。下架禁止新任务选用，已有文案与视频保留当时的模板快照并可继续生成。
      </p>
    </>
  );
}
