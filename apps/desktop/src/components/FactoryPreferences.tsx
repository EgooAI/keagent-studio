import { useEffect, useState } from "react";
import {
  Alert,
  App,
  Button,
  Descriptions,
  Form,
  Select,
  Space,
  Tag,
} from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { demoApi, serviceRequest } from "@keagent/api-client";
import type { PanoramaCapabilities } from "@keagent/shared-types";
import { useWorkspace } from "../lib/workspace";
import { useVoiceLibrary } from "../lib/voiceLibrary";
import { useAvatarLibrary } from "../lib/avatarLibrary";
import { request } from "./panoramaClient";

export function FactoryPreferences() {
  const workspace = useWorkspace();
  const voices = useVoiceLibrary();
  const avatars = useAvatarLibrary();
  const client = useQueryClient();
  const { message } = App.useApp();
  const [form] = Form.useForm<{
    templateId: string;
    voiceId: string;
    avatarId: string;
  }>();
  const templateId = Form.useWatch("templateId", form);
  const [busy, setBusy] = useState(false);
  const catalog = useQuery({
    queryKey: ["panorama-capabilities"],
    queryFn: () =>
      window.desktop
        ? request<PanoramaCapabilities>("capabilities")
        : serviceRequest<PanoramaCapabilities>("/v1/panorama/capabilities", {}),
    retry: false,
    staleTime: 0,
  });
  const templates = catalog.data?.templates || [];
  const template = templates.find((item) => item.id === templateId);
  const language = template?.production?.config.language;
  const voiceOptions = [
    ...(voices.data?.publicVoices || []).map((v) => ({
      ...v,
      label: `${v.name} · 公共音色`,
    })),
    ...(voices.data?.voices || [])
      .filter((v) => v.status === "ready")
      .map((v) => ({ ...v, label: `${v.name} · 本人音色` })),
  ].filter((v) => !language || v.language === language);
  const readyAvatars =
    avatars.data?.avatars.filter((v) => v.status === "ready") || [];
  const defaults = workspace.data?.profile.defaults;
  useEffect(() => {
    if (defaults)
      form.setFieldsValue({
        templateId: defaults.videoTemplate.id || undefined,
        voiceId: defaults.voiceId || undefined,
        avatarId: defaults.avatarId || undefined,
      });
  }, [defaults, form]);
  const staleTemplate =
    defaults?.videoTemplate.id &&
    !templates.some(
      (t) =>
        t.id === defaults.videoTemplate.id &&
        t.version === defaults.videoTemplate.version,
    );
  const staleVoice =
    defaults?.voiceId &&
    voices.data &&
    ![
      ...voices.data.publicVoices,
      ...voices.data.voices.filter((v) => v.status === "ready"),
    ].some((v) => v.id === defaults.voiceId);
  const staleAvatar =
    defaults?.avatarId &&
    avatars.data &&
    !readyAvatars.some((a) => a.id === defaults.avatarId);
  const error = catalog.error || voices.error || avatars.error;
  async function refresh() {
    await Promise.allSettled([
      catalog.refetch(),
      voices.refetch(),
      avatars.refetch(),
      workspace.refetch(),
    ]);
  }
  return (
    <>
      <h2 style={{ fontSize: 18, marginTop: 0 }}>默认生成配置</h2>
      <p className="muted">
        模板、公共音色与管理员后台同步。以下偏好用于新视频，已有文案与任务保留原配置。
      </p>
      <Button
        onClick={() => void refresh()}
        loading={catalog.isFetching || voices.isFetching || avatars.isFetching}
        style={{ marginBottom: 20 }}
      >
        刷新管理员配置
      </Button>
      {error && (
        <Alert
          type="error"
          showIcon
          title="无法读取制作配置"
          description={error.message}
          style={{ marginBottom: 20 }}
        />
      )}
      {!catalog.isPending && (staleTemplate || staleVoice || staleAvatar) && (
        <Alert
          type="warning"
          showIcon
          title="部分旧偏好已失效"
          description="原模板、音色或形象已下架、移除或更新。请重新选择，或清空后使用自动选择。"
          style={{ marginBottom: 20 }}
        />
      )}
      <Form
        form={form}
        layout="vertical"
        style={{ maxWidth: 640 }}
        onFinish={async (values) => {
          if (busy) return;
          setBusy(true);
          try {
            const selected = templates.find((t) => t.id === values.templateId);
            if (values.templateId && !selected)
              throw new Error("默认模板已下架，请重新选择或清空");
            if (
              values.voiceId &&
              !voiceOptions.some((v) => v.id === values.voiceId)
            )
              throw new Error("默认音色不可用或语言不一致，请重新选择或清空");
            if (
              values.avatarId &&
              !readyAvatars.some((a) => a.id === values.avatarId)
            )
              throw new Error("默认形象不可用，请重新选择或清空");
            await demoApi.updateFactoryPreferences({
              templateId: selected?.id || "",
              templateVersion: selected?.version || "",
              voiceId: values.voiceId || "",
              avatarId: values.avatarId || "",
            });
            await client.invalidateQueries({ queryKey: ["workspace"] });
            void message.success("默认制作配置已保存，新视频将使用这些偏好");
          } catch (error) {
            void message.error(
              error instanceof Error ? error.message : "保存失败",
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        <Form.Item
          name="templateId"
          label="默认视频模板"
          extra="仅显示管理员已上架的完整制作模板。留空则每次手动选择。"
        >
          <Select
            allowClear
            placeholder="每次选择模板"
            loading={catalog.isPending}
            options={templates.map((t) => ({
              value: t.id,
              label: `${t.name} · ${t.version}`,
            }))}
            onChange={() => form.setFieldValue("voiceId", undefined)}
          />
        </Form.Item>
        <Form.Item
          name="voiceId"
          label="默认音色"
          extra="显示所选模板语言的公共音色和本人已就绪音色。留空按语言自动选择；切换语言时自动匹配可用音色。"
        >
          <Select
            allowClear
            placeholder="自动选择可用音色"
            loading={voices.isPending}
            options={voiceOptions.map((v) => ({ value: v.id, label: v.label }))}
          />
        </Form.Item>
        <Form.Item
          name="avatarId"
          label="默认本人形象"
          extra="仅露脸模板需要本人形象；配音模板无需配置。"
        >
          <Select
            allowClear
            placeholder="自动选择可用本人形象"
            loading={avatars.isPending}
            options={readyAvatars.map((a) => ({ value: a.id, label: a.name }))}
          />
        </Form.Item>
        <p className="muted">
          视频比例、分辨率、字幕、镜头和封面由模板统一决定。所有视频都会先确认整条文案，再开始制作。
        </p>
        <Space wrap>
          <Button
            type="primary"
            htmlType="submit"
            loading={busy}
            disabled={!!error || catalog.isPending}
          >
            保存默认配置
          </Button>
          <Link to="/settings/voices">管理我的音色</Link>
          <Link to="/settings/avatars">管理本人形象</Link>
        </Space>
      </Form>
      <h3 style={{ marginTop: 32 }}>制作服务状态</h3>
      <p className="muted">
        显示管理员当前的配置状态，实际可用性以服务请求结果为准。密钥与供应商配置由管理员维护。
      </p>
      <Descriptions
        column={2}
        items={(
          [
            ["AI 文案", catalog.data?.ai],
            ["云端配音", catalog.data?.volcTts],
            ["AI 扩图", catalog.data?.imageExpansion],
            ["数字人开场", catalog.data?.volcAvatar],
            ["贝壳房源接入", catalog.data?.beike],
          ] as [string, boolean | undefined][]
        ).map(([name, configured]) => ({
          key: name,
          label: name,
          children: catalog.data ? (
            <Tag color={configured ? "green" : "default"}>
              {configured ? "已配置" : "未配置"}
            </Tag>
          ) : (
            "待读取"
          ),
        }))}
      />
      {window.desktop && (
        <p className="muted">
          本机合成工具：
          {catalog.data
            ? catalog.data.ffmpeg && catalog.data.ffprobe
              ? "已就绪"
              : "未就绪，请联系管理员配置"
            : "正在检查"}
        </p>
      )}
    </>
  );
}
