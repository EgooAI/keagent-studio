import {
  Alert,
  Collapse,
  Form,
  Input,
  InputNumber,
  Select,
  Switch,
} from "antd";
import type {
  PanoramaCapabilities,
  PanoramaConfig,
} from "@keagent/shared-types";
import { Link } from "react-router-dom";
import { useVoiceLibrary } from "../lib/voiceLibrary";
export function PanoramaSettings({
  caps,
  config,
  patch,
  changeTemplate,
  changeLanguage,
  invalidate,
}: {
  caps: PanoramaCapabilities;
  config: PanoramaConfig;
  patch: (value: Partial<PanoramaConfig>) => void;
  changeTemplate: (id: string) => void;
  changeLanguage: (language: PanoramaConfig["language"]) => void;
  invalidate: () => void;
}) {
  const library = useVoiceLibrary();
  const personalVoices =
    library.data?.voices.filter((v) => v.status === "ready") || [];
  return (
    <>
      {" "}
      <h2>模板与声音</h2>
      <div className="panorama-form-grid">
        <Form.Item label="文案套路">
          <Select
            value={config.templateId}
            options={caps.templates.map((t) => ({
              value: t.id,
              label: `${t.name} · v${t.version}`,
            }))}
            onChange={changeTemplate}
          />
        </Form.Item>
        <Form.Item label="文案生成">
          <Select
            value={config.scriptProvider}
            options={[
              { value: "template", label: "按模板填稿" },
              {
                value: "ai",
                label: caps.ai ? "AI 改写" : "AI 改写（待配置）",
                disabled: !caps.ai,
              },
            ]}
            onChange={(scriptProvider) => {
              patch({ scriptProvider });
              invalidate();
            }}
          />
        </Form.Item>
        <Form.Item label="视频模板">
          <Select
            value={config.videoMode}
            options={[
              {
                value: "voiceover",
                label: "全程不露脸 · 全景讲解",
              },
              {
                value: "avatar",
                label: "经纪人露脸 · 数字人开场",
              },
            ]}
            onChange={(videoMode) => patch({ videoMode })}
          />
        </Form.Item>
        <Form.Item label="讲解语言">
          <Select
            value={config.language}
            options={[
              { value: "zh-CN", label: "普通话" },
              { value: "en-US", label: "英语" },
            ]}
            onChange={changeLanguage}
          />
        </Form.Item>
        <Form.Item label="配音服务">
          <Select
            value={config.ttsProvider}
            options={[
              { value: "system", label: "Windows 本机配音" },
              {
                value: "volcengine",
                label: caps.volcTts ? "云端系统音色" : "云端系统音色（待配置）",
                disabled: !caps.volcTts,
              },
              {
                value: "personal",
                label: "我的专属音色",
                disabled:
                  !library.data?.cloneEnabled || personalVoices.length === 0,
              },
            ]}
            onChange={(ttsProvider) =>
              patch({
                ttsProvider,
                voice:
                  ttsProvider === "system"
                    ? caps.voices.find((v) => v.language === config.language)
                        ?.name || ""
                    : ttsProvider === "personal"
                      ? personalVoices[0]?.id || ""
                      : caps.volcSpeaker,
              })
            }
          />
        </Form.Item>
        <Form.Item
          label={config.ttsProvider === "personal" ? "本人音色" : "系统音色"}
        >
          {config.ttsProvider === "system" ? (
            <Select
              value={config.voice || undefined}
              placeholder="没有可用音色"
              options={caps.voices
                .filter((v) => v.language === config.language)
                .map((v) => ({ value: v.name, label: v.name }))}
              onChange={(voice) => patch({ voice })}
            />
          ) : config.ttsProvider === "personal" ? (
            <Select
              value={config.voice || undefined}
              placeholder="请选择已就绪的本人音色"
              options={personalVoices.map((v) => ({
                value: v.id,
                label: v.name,
              }))}
              onChange={(voice) => patch({ voice })}
            />
          ) : (
            <Select
              value={config.voice || undefined}
              options={
                caps.volcSpeaker
                  ? [{ value: caps.volcSpeaker, label: "云端预设系统音色" }]
                  : []
              }
              onChange={(voice) => patch({ voice })}
            />
          )}
        </Form.Item>
        <Form.Item label="语速">
          <InputNumber
            aria-label="配音语速"
            min={0.5}
            max={2}
            step={0.1}
            value={config.rate}
            onChange={(rate) => patch({ rate: rate ?? 1 })}
            addonAfter="倍"
          />
        </Form.Item>
        {config.videoMode === "avatar" && (
          <Form.Item label="火山克隆数字人形象 ID">
            <Input
              value={config.avatarId}
              maxLength={150}
              placeholder="控制台中的 resource_id"
              onChange={(e) => patch({ avatarId: e.target.value })}
            />
          </Form.Item>
        )}
      </div>
      <p>
        <Link to="/settings/voices">管理或上传我的声音</Link>
        。本人音色首次用于合成可能启用供应商付费音色槽位。
      </p>
      {library.isError && (
        <Alert
          type="warning"
          title="无法加载本人音色"
          description={library.error.message}
        />
      )}
      {config.videoMode === "avatar" && !caps.volcAvatar && (
        <Alert
          type="warning"
          showIcon
          title="数字人等待火山配置"
          description="需要 AK / SK、已开通的克隆数字人形象及 TOS 私有桶。开场配音会上传至私有桶，再以限时链接驱动口型。"
        />
      )}
      <Collapse
        items={[
          {
            key: "templates",
            label: "编辑文案模板",
            children: (
              <>
                <p>
                  可用变量：
                  {"{title} {facts} {sellingPoints} {room} {description}"}
                  。修改后需重新生成文案。
                </p>
                {(
                  [
                    "openingTemplate",
                    "sceneTemplate",
                    "closingTemplate",
                  ] as const
                ).map((key, i) => (
                  <Form.Item key={key} label={["开场", "空间讲解", "结尾"][i]}>
                    <Input.TextArea
                      value={config[key]}
                      maxLength={1500}
                      autoSize={{ minRows: 2 }}
                      onChange={(e) => {
                        patch({ [key]: e.target.value });
                        invalidate();
                      }}
                    />
                  </Form.Item>
                ))}
              </>
            ),
          },
          {
            key: "motion",
            label: "镜头、字幕与输出",
            children: (
              <div className="panorama-form-grid">
                <Form.Item label="旋转速度">
                  <InputNumber
                    min={0.5}
                    max={12}
                    step={0.5}
                    value={config.speed}
                    onChange={(speed) => patch({ speed: speed ?? 4 })}
                    addonAfter="°/秒"
                  />
                </Form.Item>
                <Form.Item label="旋转方向">
                  <Select
                    value={config.direction}
                    options={[
                      { value: 1, label: "向右" },
                      { value: -1, label: "向左" },
                    ]}
                    onChange={(direction) => patch({ direction })}
                  />
                </Form.Item>
                <Form.Item label="单段最大转角">
                  <InputNumber
                    min={1}
                    max={180}
                    value={config.maxSweep}
                    onChange={(maxSweep) =>
                      patch({ maxSweep: maxSweep ?? 100 })
                    }
                    addonAfter="°"
                  />
                </Form.Item>
                <Form.Item label="画幅">
                  <Select
                    value={config.aspectRatio}
                    options={[
                      { value: "9:16", label: "竖屏 9:16" },
                      { value: "16:9", label: "横屏 16:9" },
                    ]}
                    onChange={(aspectRatio) => patch({ aspectRatio })}
                  />
                </Form.Item>
                <Form.Item label="分辨率">
                  <Select
                    value={config.resolution}
                    options={[
                      { value: "720p", label: "720p" },
                      { value: "1080p", label: "1080p" },
                    ]}
                    onChange={(resolution) => patch({ resolution })}
                  />
                </Form.Item>
                <Form.Item label="句级字幕">
                  <Switch
                    checked={config.subtitles}
                    onChange={(subtitles) => patch({ subtitles })}
                  />
                </Form.Item>
                <p className="muted panorama-span">
                  配音决定镜头时长。达到最大转角后镜头停留，讲解继续完整播放。
                </p>
              </div>
            ),
          },
        ]}
      />
    </>
  );
}
