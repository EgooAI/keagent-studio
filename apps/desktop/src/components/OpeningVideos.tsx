import { useState } from "react";
import { Alert, App, Button, Empty, Popconfirm } from "antd";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { FactoryOpeningClip } from "./factoryClient";
import { OpeningCaptions } from "./OpeningCaptions";
import { request } from "./panoramaClient";

export function OpeningVideos() {
  const { message } = App.useApp();
  const [uploaded, setUploaded] = useState<string>();
  const [expanded, setExpanded] = useState<string>();
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const videos = useQuery({
    queryKey: ["opening-videos"],
    queryFn: () => request<FactoryOpeningClip[]>("opening-videos"),
    enabled: !!window.desktop,
  });

  async function update(id?: string) {
    setBusy(true);
    try {
      if (id) {
        await request("opening-video-remove", { id });
        if (expanded === id) setExpanded(undefined);
      } else {
        const clip = await request<FactoryOpeningClip | null>(
          "opening-clip-import",
          { saveToLibrary: true },
        );
        if (!clip) return;
        setUploaded(clip.id);
        setExpanded(clip.id);
      }
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
        MP4。视频保存在本机，自动识别仅将原声音轨发送至阿里云百炼。
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
        disabled={!window.desktop || busy || dirty}
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
        <div className="opening-library">
          {videos.data
            .slice()
            .reverse()
            .map((clip) => (
              <section
                key={clip.id}
                className="opening-library-item"
                aria-label={clip.name}
              >
                <header>
                  <h3>
                    <button
                      type="button"
                      className="opening-library-toggle"
                      aria-expanded={expanded === clip.id}
                      aria-controls={
                        expanded === clip.id
                          ? "opening-panel-" + clip.id
                          : undefined
                      }
                      disabled={busy || dirty}
                      onClick={() =>
                        setExpanded(expanded === clip.id ? undefined : clip.id)
                      }
                    >
                      {expanded === clip.id ? (
                        <ChevronDown size={16} aria-hidden />
                      ) : (
                        <ChevronRight size={16} aria-hidden />
                      )}
                      <span title={clip.name}>{clip.name}</span>
                    </button>
                  </h3>
                  <p>{clip.duration.toFixed(1)} 秒</p>
                  <Popconfirm
                    title="从视频库移除这段视频？"
                    okText="移除"
                    cancelText="取消"
                    onConfirm={() => update(clip.id)}
                    disabled={busy || (dirty && expanded === clip.id)}
                  >
                    <Button
                      type="text"
                      size="small"
                      aria-label={"移除 " + clip.name}
                      disabled={busy || (dirty && expanded === clip.id)}
                    >
                      移除
                    </Button>
                  </Popconfirm>
                </header>
                {expanded === clip.id && (
                  <div
                    className="opening-library-panel"
                    id={"opening-panel-" + clip.id}
                  >
                    <OpeningCaptions
                      clip={clip}
                      auto={uploaded === clip.id}
                      onDirtyChange={setDirty}
                    />
                  </div>
                )}
              </section>
            ))}
        </div>
      )}
    </>
  );
}
