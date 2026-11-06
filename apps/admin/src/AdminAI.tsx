import { Alert, Button, Descriptions, Empty, Spin, Tag } from "antd";
import { useQuery } from "@tanstack/react-query";
import { serviceRequest } from "@keagent/api-client";
import type { AdminAIConfig, AdminAIService } from "@keagent/shared-types";
import { dateTime } from "./admin-api";

const configLabels: Record<string, string> = {
  AI_API_KEY: "文案服务密钥",
  AI_MODEL: "文案模型名称",
  AI_BASE_URL: "文案服务地址",
  AI_ALLOWED_HOSTS: "允许访问的文案服务域名",
  VOLC_TTS_API_KEY: "火山配音服务密钥",
  VOLC_TTS_RESOURCE_ID: "配音服务资源编号",
  VOLC_TTS_SPEAKER: "配音音色编号",
  VOLC_VOICE_CLONE_ENABLED: "声音复刻启用开关",
  VOLC_VOICE_CLONE_RESOURCE_ID: "声音复刻合成资源编号",
  VOLC_ACCESS_KEY_ID: "火山访问密钥编号",
  VOLC_SECRET_ACCESS_KEY: "火山访问密钥",
  VOLC_AVATAR_RESOURCE_ID: "数字人资源编号",
  VOLC_TOS_BUCKET: "数字人音频使用的私有存储桶",
  VOLC_TOS_REGION: "私有存储桶所在地域",
};

export function configLabel(key: string) {
  return `${configLabels[key] || "服务端配置项"}（${key}）`;
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
        ? "配置已齐全"
        : state === "incomplete"
          ? "配置不完整"
          : "尚未配置"}
    </Tag>
  );
}

export default function AdminAI() {
  const query = useQuery({
    queryKey: ["admin", "ai-config"],
    queryFn: () => serviceRequest<AdminAIConfig>("/v1/admin/ai-config"),
  });
  return (
    <>
      <div className="admin-toolbar">
        <p className="admin-secondary">
          只读检查服务端配置，不调用付费生成接口。
        </p>
        <Button loading={query.isFetching} onClick={() => void query.refetch()}>
          重新检查配置
        </Button>
      </div>
      <Alert
        type="info"
        showIcon
        title="配置齐全不代表连接正常"
        description="这里检查配置是否填写完整，不探测供应商连接、不验证余额，也不显示密钥。配置调整由部署人员在服务端完成。"
      />
      <p className="admin-secondary admin-block">
        如有缺项，请将下方配置名称交给部署人员，在服务端补充后重启 Go
        业务服务，再点击“重新检查配置”。请勿在此页面或截图中提交密钥。
      </p>
      {query.error && (
        <Alert
          className="admin-block"
          type="error"
          showIcon
          title="无法读取服务配置"
          description={query.error.message}
          action={<Button onClick={() => void query.refetch()}>重试</Button>}
        />
      )}
      {query.isPending ? (
        <div className="admin-loading">
          <Spin tip="正在检查配置…" />
        </div>
      ) : (
        query.data && (
          <>
            <p className="admin-secondary admin-block">
              检查时间：{dateTime(query.data.checkedAt)}
            </p>
            <div className="admin-service-list">
              {query.data.services.map((service) => (
                <section className="admin-panel" key={service.id}>
                  <div className="admin-section-heading">
                    <h2>{service.label}</h2>
                    <AIState state={service.state} />
                  </div>
                  <p className="admin-secondary">{service.purpose}</p>
                  <Descriptions
                    column={1}
                    size="small"
                    className="admin-block"
                    items={[
                      {
                        key: "provider",
                        label: "服务商",
                        children: service.provider || "尚未指定",
                      },
                      {
                        key: "model",
                        label: "模型或资源",
                        children: service.model || "尚未指定",
                      },
                      {
                        key: "endpoint",
                        label: "服务地址",
                        children: (
                          <span className="admin-break">
                            {service.endpoint || "尚未指定"}
                          </span>
                        ),
                      },
                    ]}
                  />
                  {service.missing.length > 0 && (
                    <Alert
                      type="warning"
                      showIcon
                      title="需要补充的配置"
                      description={service.missing.map(configLabel).join("、")}
                    />
                  )}
                  {service.issues.length > 0 && (
                    <Alert
                      className="admin-block"
                      type="warning"
                      showIcon
                      title="需要处理的问题"
                      description={service.issues.join("；")}
                    />
                  )}
                  <p className="admin-secondary admin-block">{service.note}</p>
                </section>
              ))}
            </div>
            {query.data.services.length === 0 && (
              <Empty description="服务端尚未提供能力状态" />
            )}
          </>
        )
      )}
    </>
  );
}
