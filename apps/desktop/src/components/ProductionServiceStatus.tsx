import { Alert, Button, Descriptions, Tag } from "antd";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { serviceRequest } from "@keagent/api-client";
import type { PanoramaCapabilities } from "@keagent/shared-types";
import { request } from "./panoramaClient";

export function ProductionServiceStatus() {
  const catalog = useQuery({
    queryKey: ["panorama-capabilities"],
    queryFn: () =>
      window.desktop
        ? request<PanoramaCapabilities>("capabilities")
        : serviceRequest<PanoramaCapabilities>("/v1/panorama/capabilities", {}),
    retry: false,
  });
  return (
    <>
      <header className="settings-section-head">
        <h2>制作服务状态</h2>
        <Button
          icon={<RefreshCw size={16} />}
          onClick={() => void catalog.refetch()}
          loading={catalog.isFetching}
        >
          刷新状态
        </Button>
      </header>
      <p className="muted">
        显示管理员当前的配置状态，实际可用性以服务请求结果为准。密钥与供应商配置由管理员维护。
      </p>
      {catalog.error && (
        <Alert
          type="error"
          showIcon
          title="无法读取制作服务状态"
          description={catalog.error.message}
          style={{ marginBottom: 20 }}
        />
      )}
      <Descriptions
        column={1}
        className="settings-status-grid"
        items={(
          [
            ["AI 文案", catalog.data?.ai],
            ["百炼配音", catalog.data?.bailianTts],
            ["MiniMax 开场", catalog.data?.minimaxOpening],
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
        <Alert
          showIcon
          type={
            !catalog.data
              ? "info"
              : catalog.data.ffmpeg && catalog.data.ffprobe
                ? "success"
                : "warning"
          }
          title={
            catalog.data
              ? catalog.data.ffmpeg && catalog.data.ffprobe
                ? "本机合成工具：已就绪"
                : "本机合成工具：未就绪，请联系管理员配置"
              : catalog.error
                ? "未能读取本机合成工具状态"
                : "正在检查本机合成工具"
          }
        />
      )}
    </>
  );
}
