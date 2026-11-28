import { useEffect } from "react";
import { Alert, Button, Progress, Space } from "antd";
import { useQuery } from "@tanstack/react-query";

declare const __DESKTOP_RELEASE_NOTES__: string;

export function DesktopUpdates() {
  const api = window.desktop?.updates;
  const { data, refetch, isError } = useQuery({
    queryKey: ["desktop-update"],
    queryFn: () => api!.request("state"),
    enabled: !!api,
    refetchInterval: (query) =>
      query.state.data?.phase === "ready" ? 2000 : false,
  });
  useEffect(
    () =>
      api?.subscribe(() => {
        void refetch();
      }),
    [api, refetch],
  );
  if (!api) return <p>请在 AI来客 桌面端检查版本更新。</p>;
  if (!data) return <p>{isError ? "无法读取桌面更新状态" : "正在读取版本…"}</p>;
  const { phase, nextVersion, percent, busy } = data;
  const notes = nextVersion ? data.releaseNotes : __DESKTOP_RELEASE_NOTES__;
  const labels = {
    unavailable: "当前开发版本不接收安装包更新",
    idle: "可检查是否有新版本",
    checking: "正在检查更新…",
    current: "已是最新版本",
    downloading: `正在下载 v${nextVersion}`,
    ready: busy
      ? "任务进行中，完成或暂停队列后可重启更新"
      : `v${nextVersion} 已下载，可以重启安装`,
    closing: "正在重启并安装更新…",
    error: "更新失败，请检查网络后重试",
  };
  return (
    <Space direction="vertical">
      <strong>当前版本 v{data.version}</strong>
      <span role="status">{labels[phase]}</span>
      <section aria-label="版本更新内容">
        <strong>v{nextVersion ?? data.version} 更新内容</strong>
        <p style={{ whiteSpace: "pre-line" }}>
          {notes?.trim() || "此版本未提供更新说明。"}
        </p>
      </section>
      {phase === "downloading" && <Progress percent={percent} />}
      {phase !== "unavailable" && (
        <Button
          disabled={
            busy || ["checking", "downloading", "closing"].includes(phase)
          }
          onClick={() => {
            void api
              .request(phase === "ready" ? "install" : "check")
              .finally(() => refetch())
              .catch(() => {});
          }}
        >
          {phase === "ready" ? "重启并更新" : "检查更新"}
        </Button>
      )}
      {isError && <Alert type="error" title="暂时无法读取更新状态" />}
    </Space>
  );
}
