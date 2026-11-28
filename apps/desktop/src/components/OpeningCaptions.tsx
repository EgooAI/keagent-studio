import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { Alert, App, Button, Input, Popconfirm, Space } from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { OpeningCaption } from "@keagent/shared-types";
import type { FactoryOpeningClip } from "./factoryClient";
import { request } from "./panoramaClient";
import { Play } from "lucide-react";
import { openingCaptionLines } from "../../electron/production/opening-caption-lines.mjs";
import style from "../../electron/production/opening-caption-style.json";
import "./opening-captions.css";

export const openingCaptionQuery = (clip: FactoryOpeningClip) => ({
  queryKey: ["opening-captions", clip.id],
  queryFn: () => request<OpeningCaption[]>("opening-captions", { id: clip.id }),
  initialData: clip.captions,
  retry: false as const,
  staleTime: Infinity,
});

export function OpeningPreview({
  url,
  name,
  captions = [],
  landscape = false,
  player,
  onActive,
}: {
  url?: string;
  name: string;
  captions?: OpeningCaption[];
  landscape?: boolean;
  player?: RefObject<HTMLVideoElement | null>;
  onActive?: (index: number) => void;
}) {
  const local = useRef<HTMLVideoElement>(null);
  const ref = player ?? local;
  const [time, setTime] = useState(0);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    let frame = 0;
    function update(_: number, meta: VideoFrameCallbackMetadata) {
      setTime(meta.mediaTime);
      frame = video!.requestVideoFrameCallback(update);
    }
    frame = video.requestVideoFrameCallback(update);
    return () => video.cancelVideoFrameCallback(frame);
  }, [url, ref]);
  const index = captions.findIndex((c) => time >= c.start && time < c.end);
  useEffect(() => {
    onActive?.(index);
  }, [index, onActive]);
  const cue = captions[index];
  return (
    <div className={"opening-preview" + (landscape ? " is-landscape" : "")}>
      <video
        src={url}
        aria-label={name}
        ref={ref}
        controls
        controlsList="nofullscreen"
        disablePictureInPicture
        preload="metadata"
        onSeeked={(e) => setTime(e.currentTarget.currentTime)}
      />
      {cue && (
        <span
          className="opening-subtitle"
          style={{
            bottom: style.bottom * 100 + "%",
            fontSize: (style.fontSize / style.reference) * 100 + "cqmin",
            WebkitTextStrokeWidth:
              ((style.outline * 2) / style.reference) * 100 + "cqmin",
          }}
        >
          {openingCaptionLines(cue.text, landscape ? 16 / 9 : 9 / 16)}
        </span>
      )}
    </div>
  );
}

export function OpeningCaptions({
  clip,
  auto = false,
  landscape = false,
  disabled = false,
  onStore,
  onDirtyChange,
}: {
  clip: FactoryOpeningClip;
  auto?: boolean;
  landscape?: boolean;
  disabled?: boolean;
  onStore?: () => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const client = useQueryClient();
  const { message } = App.useApp();
  const options = openingCaptionQuery(clip);
  const result = useQuery({ ...options, enabled: auto, retryOnMount: false });
  const [draft, setDraft] = useState<OpeningCaption[]>();
  const [regrouped, setRegrouped] = useState<string>();
  const [busy, setBusy] = useState(false);
  const player = useRef<HTMLVideoElement>(null);
  const cues = result.data;
  const rows = draft ?? cues;
  const baseline = useRef<OpeningCaption[] | undefined>(undefined);
  const [active, setActive] = useState(-1);
  const dirty = !!draft;
  useEffect(() => {
    onDirtyChange?.(dirty || busy);
    return () => onDirtyChange?.(false);
  }, [dirty, busy, onDirtyChange]);
  function changeText(i: number, text: string) {
    if (!rows) return;
    if (!draft) baseline.current = cues;
    setDraft(rows.map((row, index) => (index === i ? { ...row, text } : row)));
  }
  async function action(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      void message.error(e instanceof Error ? e.message : "操作失败，请重试");
    } finally {
      setBusy(false);
    }
  }
  async function save(next: OpeningCaption[]) {
    const saved = await request<OpeningCaption[]>("opening-captions-save", {
      id: clip.id,
      previous: draft ? baseline.current : cues,
      texts: next.map((cue) => cue.text),
    });
    client.setQueryData(options.queryKey, saved);
    setDraft(undefined);
    await client.invalidateQueries({ queryKey: ["opening-videos"] });
  }
  const pending = busy || result.isFetching || disabled;
  return (
    <div className="opening-caption-editor">
      <div className="opening-caption-layout">
        <OpeningPreview
          url={clip.url}
          name={clip.name}
          captions={rows}
          landscape={landscape}
          player={player}
          onActive={setActive}
        />
        <div className="opening-transcript">
          <div className="opening-transcript-heading">
            <strong>转录字幕</strong>
            {dirty && (
              <Space size="small">
                <Button
                  size="small"
                  disabled={pending}
                  onClick={() => setDraft(undefined)}
                >
                  撤销修改
                </Button>
                <Button
                  type="primary"
                  size="small"
                  loading={busy}
                  disabled={pending}
                  onClick={() => void action(() => save(draft!))}
                >
                  保存字幕
                </Button>
              </Space>
            )}
          </div>
          {!!rows?.length && (
            <div className="opening-cue-list">
              {rows.map((cue, i) => (
                <div
                  key={i}
                  className={active === i ? "is-current" : undefined}
                >
                  <div className="opening-cue-time">
                    <Button
                      type="text"
                      size="small"
                      aria-label={`试听第 ${i + 1} 句`}
                      icon={<Play size={13} />}
                      onClick={() => {
                        if (player.current) {
                          player.current.currentTime = cue.start;
                          void player.current.play().catch(() => {});
                        }
                      }}
                    >
                      {cue.start.toFixed(2)} – {cue.end.toFixed(2)} 秒
                    </Button>
                  </div>
                  <Input.TextArea
                    aria-label={`第 ${i + 1} 句字幕`}
                    autoSize={{ minRows: 1, maxRows: 4 }}
                    maxLength={100}
                    disabled={pending}
                    value={cue.text}
                    onChange={(e) => changeText(i, e.target.value)}
                  />
                </div>
              ))}
            </div>
          )}
          {result.isFetching && <span role="status">正在识别开场原声…</span>}
          {result.error && (
            <Alert
              type="warning"
              showIcon
              title="开场字幕识别失败"
              description={result.error.message}
            />
          )}
          {cues && !cues.length && (
            <span className="muted">使用原片，无新增字幕</span>
          )}
          <Space wrap>
            {!cues?.length && (
              <Button
                disabled={pending}
                onClick={() =>
                  void action(async () => {
                    if (!cues) {
                      await result.refetch({ throwOnError: true });
                      return;
                    }
                    const next = await request<OpeningCaption[]>(
                      "opening-captions",
                      { id: clip.id, retry: true },
                    );
                    client.setQueryData(options.queryKey, next);
                    await client.invalidateQueries({
                      queryKey: ["opening-videos"],
                    });
                  })
                }
              >
                {result.error ? "重试识别" : cues ? "启用原声字幕" : "识别字幕"}
              </Button>
            )}
            {clip.needsWordTiming &&
              regrouped !== clip.id &&
              !!cues?.length && (
                <Popconfirm
                  title="重新识别并断句？"
                  description="将根据原声生成新字幕，替换这段视频已校对的文字。"
                  okText="重新识别"
                  cancelText="取消"
                  disabled={pending || dirty}
                  onConfirm={() =>
                    action(async () => {
                      const next = await request<OpeningCaption[]>(
                        "opening-captions",
                        { id: clip.id, regroup: true, previous: cues },
                      );
                      client.setQueryData(options.queryKey, next);
                      setRegrouped(clip.id);
                      await client.invalidateQueries({
                        queryKey: ["opening-videos"],
                      });
                    })
                  }
                >
                  <Button disabled={pending || dirty} loading={busy}>
                    重新识别并断句
                  </Button>
                </Popconfirm>
              )}
            {(!cues || cues.length > 0) && (
              <Button
                disabled={pending || dirty}
                onClick={() => void action(() => save([]))}
              >
                使用原片字幕
              </Button>
            )}
            {onStore && (
              <Button
                disabled={pending || dirty || !cues}
                onClick={() => void action(onStore)}
              >
                存入视频库
              </Button>
            )}
          </Space>
        </div>
      </div>
    </div>
  );
}
