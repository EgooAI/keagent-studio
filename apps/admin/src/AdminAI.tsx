import { Alert, App, Button, Empty, Skeleton, Tabs, Tag } from "antd";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { serviceRequest } from "@keagent/api-client";
import type {
  AdminAIConfig,
  AdminAIManagement,
  AdminAIService,
} from "@keagent/shared-types";
import { dateTime, useAdminParams } from "./admin-api";
import AdminPublicVoices from "./AdminPublicVoices";
import AIConfigDrawer, {
  AIProbeState,
  probeModeLabel,
  probeRunning,
} from "./AIConfigDrawer";

const configLabels: Record<string, string> = {
  AI_API_KEY: "文案服务密钥",
  AI_MODEL: "文案模型名称",
  AI_BASE_URL: "文案服务地址",
  AI_ALLOWED_HOSTS: "文案服务域名白名单",
  VOLC_TTS_API_KEY: "火山语音服务密钥",
  VOLC_VOICE_CLONE_ENABLED: "声音复刻启用开关",
  VOLC_VOICE_CLONE_RESOURCE_ID: "声音复刻资源编号",
  VOLC_ACCESS_KEY_ID: "火山访问密钥编号",
  VOLC_SECRET_ACCESS_KEY: "火山访问密钥",
  VOLC_TOS_BUCKET: "数字人私有存储桶",
  VOLC_TOS_REGION: "私有存储桶地域",
  DASHSCOPE_API_KEY: "百炼 API Key",
  DASHSCOPE_BASE_URL: "百炼服务地址",
  BEIKE_ACCESS_TOKEN: "贝壳 Access Token",
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
  "voice-clone",
  "avatar",
  "expansion",
  "beike",
];

function ConfigState({ row }: { row: AdminAIManagement }) {
  if (row.active.locked) return <Tag color="red">配置无法解密</Tag>;
  if (row.candidate)
    return row.canActivate ? (
      <Tag color="blue">待启用</Tag>
    ) : (
      <Tag color="orange">待测试</Tag>
    );
  if (
    row.summary.id === "voice-clone" &&
    !row.active.fields.VOLC_VOICE_CLONE_ENABLED
  )
    return <Tag>已关闭</Tag>;
  return row.summary.state === "configured" ? (
    <Tag color="green">已启用</Tag>
  ) : (
    <AIState state={row.summary.state} />
  );
}

export default function AdminAI() {
  const { params, setParams } = useAdminParams();
  const { modal } = App.useApp();
  const [dirty, setDirty] = useState(false);
  const [drawerId, setDrawerId] = useState(params.get("service"));
  const serviceButtons = useRef(new Map<string, HTMLButtonElement>());
  const lastService = useRef<string | null>(null);
  const prompted = useRef(false);
  const requested = params.get("service");
  const activeTab = params.get("tab") === "voices" ? "voices" : "services";
  const query = useQuery({
    queryKey: ["admin", "ai-config"],
    queryFn: () => serviceRequest<AdminAIConfig>("/v1/admin/ai-config"),
    enabled: activeTab === "services",
    refetchInterval: (state) =>
      state.state.data?.management?.some((row) =>
        probeRunning(row.candidate?.test),
      )
        ? 2000
        : false,
  });
  const rows = (query.data?.management ?? [])
    .slice()
    .sort(
      (a, b) =>
        serviceOrder.indexOf(a.summary.id) - serviceOrder.indexOf(b.summary.id),
    );
  const selected = rows.find((row) => row.summary.id === drawerId);

  useEffect(() => {
    if (drawerId) lastService.current = drawerId;
    else if (lastService.current)
      serviceButtons.current.get(lastService.current)?.focus();
  }, [drawerId]);

  useEffect(() => {
    if (requested === drawerId || prompted.current) return;
    if (!dirty) {
      setDrawerId(requested);
      return;
    }
    prompted.current = true;
    modal.confirm({
      title: "放弃未保存的修改？",
      okText: "放弃修改",
      cancelText: "继续编辑",
      onOk: () => {
        setDirty(false);
        setDrawerId(requested);
        prompted.current = false;
      },
      onCancel: () => {
        setParams({ service: drawerId || undefined }, false);
        prompted.current = false;
      },
    });
  }, [requested, drawerId, dirty, modal, setParams]);

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
      setDrawerId(null);
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
                    保存修改后运行真实测试，通过后点击启用。
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
                {query.data && !query.data.writable && (
                  <Alert
                    className="admin-block"
                    type="warning"
                    showIcon
                    title="配置管理暂不可写"
                    description="请部署人员设置服务端加密密钥。当前仍可查看状态。"
                  />
                )}
                {query.data && rows.length === 0 && (
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
                          const test = row.candidate
                            ? row.candidate.test
                            : row.active.test;
                          return (
                            <tr key={row.summary.id}>
                              <th scope="row">
                                <strong>{row.summary.label}</strong>
                                <span className="admin-secondary ai-provider">
                                  {row.summary.provider}
                                </span>
                              </th>
                              <td>
                                <ConfigState row={row} />
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
                                  aria-label={"管理" + row.summary.label}
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
                <AIConfigDrawer
                  key={selected.summary.id}
                  row={selected}
                  voices={query.data.voices}
                  writable={query.data.writable}
                  onDirty={setDirty}
                  onClose={() => setParams({ service: undefined }, false)}
                />
              )}
            </>
          ),
        },
        { key: "voices", label: "公共音色", children: <AdminPublicVoices /> },
      ]}
    />
  );
}
