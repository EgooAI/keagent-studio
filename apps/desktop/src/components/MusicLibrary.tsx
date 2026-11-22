import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, App, Button, Input, Modal, Popconfirm, Space } from "antd";
import { request } from "./panoramaClient";

type MusicTrack = {
  id: string;
  name: string;
  duration: number;
  builtin?: boolean;
  url: string;
};

export function useMusicTracks(enabled: boolean) {
  return useQuery({
    queryKey: ["background-music"],
    queryFn: () => request<MusicTrack[]>("music-tracks"),
    enabled,
  });
}

export function MusicPreview({
  track,
  volume = 100,
}: {
  track: MusicTrack;
  volume?: number;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (audio.current) audio.current.volume = volume / 100;
  }, [volume]);
  return (
    <>
      <audio
        ref={audio}
        style={{ width: 260, maxWidth: "100%" }}
        src={track.url}
        controls
        preload="none"
        aria-label={`试听 ${track.name}`}
        onError={() => setFailed(true)}
        onCanPlay={() => setFailed(false)}
      />
      {failed && (
        <small role="status">无法播放此曲目。请检查本机音乐文件。</small>
      )}
    </>
  );
}

export function MusicLibrary() {
  const { message } = App.useApp();
  const desktop = !!window.desktop;
  const tracks = useMusicTracks(desktop);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; name: string }>();

  async function change(
    method: "music-import" | "music-rename" | "music-remove",
    input?: unknown,
  ) {
    setBusy(true);
    try {
      await request(method, input);
      if (method === "music-rename") setEditing(undefined);
      await tracks.refetch();
    } catch (error) {
      void message.error(
        error instanceof Error ? error.message : "操作失败，请重试",
      );
    } finally {
      setBusy(false);
    }
  }

  const userTracks = tracks.data?.filter((track) => !track.builtin) ?? [];
  return (
    <>
      <h2>背景音乐库</h2>
      <p className="muted">
        添加 MP3 或 WAV（50 MB 以内）。上传的音乐仅保存在本机，按登录账号隔离。
      </p>
      {desktop ? (
        <Button
          type="primary"
          loading={busy}
          onClick={() => void change("music-import")}
        >
          上传音乐
        </Button>
      ) : (
        <Alert type="info" showIcon title="请在桌面客户端管理背景音乐" />
      )}
      {tracks.isLoading && <p role="status">正在读取背景音乐库…</p>}
      {tracks.isError && (
        <Alert
          type="error"
          showIcon
          title="背景音乐库读取失败"
          action={<Button onClick={() => void tracks.refetch()}>重试</Button>}
        />
      )}
      {tracks.isSuccess && (
        <>
          <h3 className="settings-music-heading">内置音乐</h3>
          <div className="settings-music-list">
            {tracks.data
              .filter((track) => track.builtin)
              .map((track) => (
                <div className="settings-music-row" key={track.id}>
                  <div>
                    <strong>{track.name}</strong>
                    <small>{track.duration.toFixed(1)} 秒</small>
                  </div>
                  <MusicPreview track={track} />
                </div>
              ))}
          </div>
          <h3 className="settings-music-heading">我的音乐</h3>
          {userTracks.length === 0 && (
            <p className="muted">上传自己的音乐后，即可在新建视频时选择。</p>
          )}
          <div className="settings-music-list">
            {userTracks.map((track) => (
              <div className="settings-music-row" key={track.id}>
                <div>
                  <strong>{track.name}</strong>
                  <small>{track.duration.toFixed(1)} 秒</small>
                </div>
                <MusicPreview track={track} />
                <Space wrap>
                  <Button
                    disabled={busy}
                    autoInsertSpace={false}
                    onClick={() =>
                      setEditing({ id: track.id, name: track.name })
                    }
                  >
                    改名
                  </Button>
                  <Popconfirm
                    title="从音乐库移除这首音乐？"
                    description="已创建的任务仍可使用这首音乐。"
                    okText="移除"
                    cancelText="取消"
                    onConfirm={() => change("music-remove", { id: track.id })}
                  >
                    <Button disabled={busy} autoInsertSpace={false}>
                      移除
                    </Button>
                  </Popconfirm>
                </Space>
              </div>
            ))}
          </div>
        </>
      )}
      <Modal
        title="修改曲目名称"
        open={!!editing}
        onCancel={() => setEditing(undefined)}
        okText="保存"
        cancelText="取消"
        confirmLoading={busy}
        okButtonProps={{
          disabled: !editing?.name.trim(),
          autoInsertSpace: false,
        }}
        onOk={() => void change("music-rename", editing)}
      >
        <label htmlFor="settings-music-name">曲目名称</label>
        <Input
          id="settings-music-name"
          value={editing?.name ?? ""}
          maxLength={80}
          onChange={(event) =>
            setEditing(
              (current) => current && { ...current, name: event.target.value },
            )
          }
        />
      </Modal>
    </>
  );
}
