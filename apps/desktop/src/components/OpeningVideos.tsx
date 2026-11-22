import { useState } from "react";
import { Alert, App, Button, Empty, Popconfirm } from "antd";
import { useQuery } from "@tanstack/react-query";
import type { FactoryOpeningClip } from "./factoryClient";
import { request } from "./panoramaClient";

export function OpeningVideos() {
  const { message } = App.useApp();
  const [busy, setBusy] = useState(false);
  const videos = useQuery({
    queryKey: ["opening-videos"],
    queryFn: () => request<FactoryOpeningClip[]>("opening-videos"),
    enabled: !!window.desktop,
  });

  async function update(id?: string) {
    setBusy(true);
    try {
      if (id) await request("opening-video-remove", { id });
      else if (!(await request("opening-clip-import", { saveToLibrary: true })))
        return;
      await videos.refetch();
    } catch (error) {
      void message.error(
        error instanceof Error ? error.message : "操作失败，请重试",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h2>开场视频库</h2>
      <p className="muted">
        可在本机保存多段开场视频，制作时手动选择。支持 2–30 秒、50 MB 以内的
        MP4。
      </p>
      {!window.desktop && (
        <Alert type="info" showIcon title="请在桌面客户端管理开场视频" />
      )}
      {videos.error && (
        <Alert
          type="error"
          showIcon
          title="视频库读取失败"
          description={videos.error.message}
          action={<Button onClick={() => void videos.refetch()}>重试</Button>}
        />
      )}
      <Button
        type="primary"
        disabled={!window.desktop || busy}
        onClick={() => void update()}
      >
        上传并保存视频
      </Button>
      {videos.isSuccess && !videos.data.length && (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="暂无开场视频"
        />
      )}
      {!!videos.data?.length && (
        <div className="settings-materials">
          {videos.data.map((clip) => (
            <section
              key={clip.id}
              className="settings-material"
              aria-label={clip.name}
            >
              <video
                className="settings-opening-video"
                src={clip.url}
                controls
                preload="metadata"
                aria-label={clip.name}
              />
              <h3 className="settings-material-name">{clip.name}</h3>
              <p>{clip.duration.toFixed(1)} 秒</p>
              <Popconfirm
                title="从视频库移除这段视频？"
                okText="移除"
                cancelText="取消"
                onConfirm={() => update(clip.id)}
                disabled={busy}
              >
                <Button disabled={busy}>移除</Button>
              </Popconfirm>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
