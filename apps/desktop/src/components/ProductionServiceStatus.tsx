import { Alert, Button, Descriptions, Tag } from "antd";
import { useQuery } from "@tanstack/react-query";
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
      <p className="muted">
        显示管理员当前的配置状态，实际可用性以服务请求结果为准。密钥与供应商配置由管理员维护。
      </p>
      <Button
        onClick={() => void catalog.refetch()}
        loading={catalog.isFetching}
        style={{ marginBottom: 20 }}
      >
        刷新状态
      </Button>
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
        column={{ xs: 1, sm: 2 }}
        items={(
          [
            ["AI 文案", catalog.data?.ai],
            ["云端配音", catalog.data?.volcTts],
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
