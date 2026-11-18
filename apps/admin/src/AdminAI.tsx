import { Alert, App, Button, Empty, Skeleton, Tabs, Tag } from "antd";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { serviceRequest } from "@keagent/api-client";
import type {
  AdminAIConfig,
  AdminAIManagement,
  AdminAIProbe,
  AdminAIService,
} from "@keagent/shared-types";
import { dateTime, useAdminParams } from "./admin-api";
import AdminPublicVoices from "./AdminPublicVoices";
import AIConfigDialog, {
  AIProbeState,
  probeModeLabel,
  probeRunning,
} from "./AIConfigDialog";

const configLabels: Record<string, string> = {
  AI_API_KEY: "文案服务密钥",
  AI_MODEL: "文案模型名称",
  AI_BASE_URL: "文案服务地址",
  AI_ALLOWED_HOSTS: "文案服务域名白名单",
  DASHSCOPE_API_KEY: "百炼 API Key",
  DASHSCOPE_WORKSPACE_ID: "百炼业务空间 ID",
  DASHSCOPE_VOICE_CLONE_ENABLED: "声音复刻启用开关",
  BEIKE_ACCESS_TOKEN: "贝壳 Access Token",
  BEIKE_MCP_API_KEY: "贝壳找房 MCP Key",
  BEIKE_CLI_PATH: "贝壳 CLI 可执行文件路径",
};

export function configLabel(key: string) {
  return configLabels[key] || key;
}

export function AIState({ state }: { state: AdminAIService["state"] }) {
  return (
    <Tag
      color={
        state === "configured"
          ? "green"
          : state === "incomplete"
            ? "orange"
            : "default"
      }
    >
      {state === "configured"
        ? "配置齐全"
        : state === "incomplete"
          ? "配置不完整"
          : "尚未配置"}
    </Tag>
  );
}

const serviceOrder: AdminAIService["id"][] = [
  "script",
  "tts",
  "opening",
  "beike",
  "beike-cli",
];

export const speechUpgradeTitle = "云端语音服务需要更新";
export const bailianSpeechLabel = "百炼语音";
export const speechUpgradeMessage =
  "当前连接的云端版本尚未支持百炼配音和声音复刻。请更新云端服务后刷新。";

export function isSpeechService(service: AdminAIService) {
  return service.id === "tts" || service.id === "voice-clone";
}

export function isBailianSpeech(service: AdminAIService) {
  return (
    service.provider === "阿里云百炼" &&
    service.model === "qwen-audio-3.1-tts-plus"
  );
}

function needsSpeechUpgrade(config: AdminAIConfig) {
  return (
    !config.services?.some(
      (service) => service.id === "tts" && isBailianSpeech(service),
    ) ||
    (config.management ?? []).some(
      ({ group, summary }) =>
        isSpeechService(summary) &&
        (group !== "bailian-speech" || !isBailianSpeech(summary)),
    )
  );
}

function ConfigState({ row }: { row: AdminAIManagement }) {
  if (row.active.locked) return <Tag color="red">配置无法解密</Tag>;
  return row.summary.state === "configured" ? (
    <Tag color="green">已启用</Tag>
  ) : (
    <AIState state={row.summary.state} />
  );
}

export default function AdminAI() {
  const { params, setParams } = useAdminParams();
  const { modal } = App.useApp();
  const serviceParam = params.get("service");
  const requested = serviceParam === "voice-clone" ? "tts" : serviceParam;
  const [dirty, setDirty] = useState(false);
  const [dialogId, setDialogId] = useState(requested);
  const serviceButtons = useRef(new Map<string, HTMLButtonElement>());
  const lastService = useRef<string | null>(null);
  const prompted = useRef(false);
  const activeTab = params.get("tab") === "voices" ? "voices" : "services";
  const query = useQuery({
    queryKey: ["admin", "ai-config"],
    queryFn: () => serviceRequest<AdminAIConfig>("/v1/admin/ai-config"),
    refetchInterval: ({ state: { data } }) => {
      if (activeTab !== "services" || !data) return false;
      const needsUpgrade = needsSpeechUpgrade(data);
      return data.management?.some(
        (row) =>
          (!needsUpgrade || !isSpeechService(row.summary)) &&
          (probeRunning(row.verification) ||
            probeRunning(row.active.test) ||
            probeRunning(row.candidate?.test)),
      )
        ? 2000
        : false;
    },
  });
  const management = query.data?.management ?? [];
  const speechUpgradeRequired = !!query.data && needsSpeechUpgrade(query.data);
  const voiceClone = management.find((row) => row.summary.id === "voice-clone");
  const rows = management
    .filter(
      ({ summary }) =>
        summary.id !== "voice-clone" &&
        (!speechUpgradeRequired || !isSpeechService(summary)),
    )
    .sort(
      (a, b) =>
        serviceOrder.indexOf(a.summary.id) - serviceOrder.indexOf(b.summary.id),
    );
  const selected = rows.find((row) => row.summary.id === dialogId);

  useEffect(() => {
    if (dialogId) lastService.current = dialogId;
    else if (lastService.current)
      serviceButtons.current.get(lastService.current)?.focus();
  }, [dialogId]);

  useEffect(() => {
    if (requested === dialogId || prompted.current) return;
    if (!dirty) {
      setDialogId(requested);
      return;
    }
    prompted.current = true;
    modal.confirm({
      title: "放弃未保存的修改？",
      okText: "放弃修改",
      cancelText: "继续编辑",
      onOk: () => {
        setDirty(false);
        setDialogId(requested);
        prompted.current = false;
      },
      onCancel: () => {
        setParams({ service: dialogId || undefined }, false);
        prompted.current = false;
      },
    });
  }, [requested, dialogId, dirty, modal, setParams]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function changeTab(tab: string) {
    const apply = () => {
      setDirty(false);
      setDialogId(null);
      setParams({ tab, service: undefined }, false);
    };
    if (dirty)
      modal.confirm({
        title: "放弃未保存的修改？",
        okText: "放弃修改",
        cancelText: "继续编辑",
        onOk: apply,
      });
    else apply();
  }

  return (
    <Tabs
      activeKey={activeTab}
      onChange={changeTab}
      destroyOnHidden
      items={[
        {
          key: "services",
          label: "服务配置",
          children: (
            <>
              <section
                className="admin-panel ai-service-panel"
                aria-label="AI 服务配置"
              >
                <div className="admin-toolbar">
                  <p className="admin-secondary">
                    查看当前服务状态。更新配置时，验证通过后自动启用。
                  </p>
                  <Button
                    loading={query.isFetching}
                    onClick={() => void query.refetch()}
                  >
                    刷新状态
                  </Button>
                </div>
                {query.error && (
                  <Alert
                    type="error"
                    showIcon
                    title="无法读取服务状态"
                    description={query.error.message}
                  />
                )}
                {speechUpgradeRequired && (
                  <Alert
                    className="admin-block"
                    type="warning"
                    showIcon
                    title={speechUpgradeTitle}
                    description={speechUpgradeMessage}
                  />
                )}
                {query.data && !query.data.writable && (
                  <Alert
                    className="admin-block"
                    type="warning"
                    showIcon
                    title="配置管理暂不可写"
                    description="请部署人员设置服务端加密密钥，以保存配置和提交需要素材的测试。"
                  />
                )}
                {query.data && management.length === 0 && (
                  <Empty description="当前服务端未返回配置管理数据" />
                )}
                {query.isPending ? (
                  <Skeleton active paragraph={{ rows: 6 }} />
                ) : (
                  rows.length > 0 && (
                    <table className="ai-service-table">
                      <thead>
                        <tr>
                          <th scope="col">服务</th>
                          <th scope="col">配置状态</th>
                          <th scope="col" className="ai-detail-column">
                            最近测试
                          </th>
                          <th scope="col">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row) => {
                          const speech = row.summary.id === "tts";
                          const label = speech
                            ? bailianSpeechLabel
                            : row.summary.label;
                          const test = [
                            row.active.test,
                            speech ? voiceClone?.active.test : undefined,
                          ]
                            .filter((item): item is AdminAIProbe => !!item)
                            .sort(
                              (a, b) =>
                                Date.parse(b.createdAt) -
                                Date.parse(a.createdAt),
                            )[0];
                          return (
                            <tr key={row.summary.id}>
                              <th scope="row">
                                <strong>{label}</strong>
                                <span className="admin-secondary ai-provider">
                                  {speech
                                    ? "配音与声音复刻"
                                    : row.summary.provider}
                                </span>
                              </th>
                              <td>
                                <ConfigState row={row} />
                                {speech && voiceClone && !row.active.locked && (
                                  <span className="admin-secondary ai-test-meta">
                                    {voiceClone.summary.state === "configured"
                                      ? "声音复刻已启用"
                                      : "声音复刻尚未启用"}
                                  </span>
                                )}
                                {row.active.activatedAt && (
                                  <span className="admin-secondary ai-test-meta">
                                    更新于 {dateTime(row.active.activatedAt)}
                                  </span>
                                )}
                              </td>
                              <td className="ai-detail-column">
                                <AIProbeState test={test} />
                                {test && (
                                  <span className="admin-secondary ai-test-meta">
                                    {probeModeLabel(test.mode)} ·{" "}
                                    {dateTime(
                                      test.finishedAt ?? test.createdAt,
                                    )}
                                  </span>
                                )}
                              </td>
                              <td>
                                <Button
                                  type="link"
                                  aria-label={"管理" + label}
                                  ref={(button) => {
                                    if (button instanceof HTMLButtonElement)
                                      serviceButtons.current.set(
                                        row.summary.id,
                                        button,
                                      );
                                    else
                                      serviceButtons.current.delete(
                                        row.summary.id,
                                      );
                                  }}
                                  onClick={() => {
                                    setParams(
                                      { service: row.summary.id },
                                      false,
                                    );
                                  }}
                                >
                                  管理
                                </Button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )
                )}
              </section>
              {selected && query.data && (
                <AIConfigDialog
                  key={selected.summary.id}
                  row={selected}
                  voiceClone={
                    selected.summary.id === "tts" ? voiceClone : undefined
                  }
                  voices={query.data.voices}
                  writable={query.data.writable}
                  onDirty={setDirty}
                  onClose={() => setParams({ service: undefined }, false)}
                />
              )}
            </>
          ),
        },
        {
          key: "voices",
          label: "公共音色",
          children: query.isPending ? (
            <Skeleton active paragraph={{ rows: 4 }} />
          ) : query.error || speechUpgradeRequired ? (
            <Alert
              type={query.error ? "error" : "warning"}
              showIcon
              title={query.error ? "无法读取云端语音状态" : speechUpgradeTitle}
              description={query.error?.message ?? speechUpgradeMessage}
              action={
                <Button
                  loading={query.isFetching}
                  onClick={() => void query.refetch()}
                >
                  刷新状态
                </Button>
              }
            />
          ) : (
            <AdminPublicVoices />
          ),
        },
      ]}
    />
  );
}
