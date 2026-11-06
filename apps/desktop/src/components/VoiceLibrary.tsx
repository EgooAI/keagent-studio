import { useEffect, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Tag,
  Upload,
} from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { authRequest } from "@keagent/api-client";
import type {
  PanoramaCapabilities,
  PersonalVoice,
} from "@keagent/shared-types";
import {
  audioBlobURL,
  encodeRecording,
  useVoiceLibrary,
  validateRecording,
  voiceFormat,
} from "../lib/voiceLibrary";

const statusLabels = {
  submitting: "提交中 / 待核对",
  processing: "正在复刻",
  ready: "可使用",
  failed: "复刻失败",
  unknown: "结果待核对",
};
export function VoiceLibraryPanel() {
  const { message } = App.useApp();
  const client = useQueryClient();
  const library = useVoiceLibrary();
  const local = useQuery({
    queryKey: ["system-voices"],
    enabled: !!window.desktop,
    queryFn: () => authRequest<PanoramaCapabilities>("panorama.capabilities"),
    retry: false,
  });
  const [browserVoices, setBrowserVoices] = useState<SpeechSynthesisVoice[]>(
    [],
  );
  const [systemVoice, setSystemVoice] = useState<string>();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [language, setLanguage] = useState<PersonalVoice["language"]>("zh-CN");
  const [file, setFile] = useState<File>();
  const [authorized, setAuthorized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [audioURL, setAudioURL] = useState("");
  const requestKey = useRef(crypto.randomUUID());
  const pendingVoices = useRef<PersonalVoice[]>([]);
  pendingVoices.current =
    library.data?.voices.filter((voice) => voice.status === "processing") || [];
  useEffect(() => {
    let refreshing = false;
    const timer = window.setInterval(async () => {
      if (refreshing || pendingVoices.current.length === 0) return;
      refreshing = true;
      try {
        await Promise.allSettled(
          pendingVoices.current.map((voice) =>
            authRequest("voice.refresh", [{ id: voice.id }]),
          ),
        );
        await client.invalidateQueries({ queryKey: ["personal-voices"] });
      } finally {
        refreshing = false;
      }
    }, 10000);
    return () => window.clearInterval(timer);
  }, [client]);
  const voiceChoices = window.desktop
    ? local.data?.voices || []
    : browserVoices.map((v) => ({ name: v.name, language: v.lang }));
  useEffect(() => {
    if (!window.speechSynthesis || window.desktop) return;
    const update = () => setBrowserVoices(window.speechSynthesis.getVoices());
    update();
    window.speechSynthesis.addEventListener("voiceschanged", update);
    return () => {
      window.speechSynthesis.removeEventListener("voiceschanged", update);
      window.speechSynthesis.cancel();
    };
  }, []);
  useEffect(
    () => () => {
      if (audioURL.startsWith("blob:")) URL.revokeObjectURL(audioURL);
    },
    [audioURL],
  );
  async function act(operation: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try {
      await operation();
      await client.invalidateQueries({ queryKey: ["personal-voices"] });
    } catch (error) {
      void message.error(error instanceof Error ? error.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }
  function resetUpload() {
    setName("");
    setFile(undefined);
    setAuthorized(false);
    setLanguage("zh-CN");
    requestKey.current = crypto.randomUUID();
    setOpen(true);
  }
  async function create() {
    if (!file || !authorized || !name.trim()) {
      void message.warning("请填写名称、选择录音并确认授权");
      return;
    }
    await act(async () => {
      const created = await authRequest<PersonalVoice>("voice.create", [
        {
          name: name.trim(),
          language,
          authorized,
          format: voiceFormat(file),
          audio: await encodeRecording(file),
          requestKey: requestKey.current,
        },
      ]);
      setOpen(false);
      setFile(undefined);
      void message.info(
        created.status === "ready"
          ? "音色已创建，可以试听并在全景工厂使用"
          : "提交已记录，请在音色列表中刷新状态；勿重复上传",
      );
    });
  }
  return (
    <>
      <h2>声音与音色</h2>
      <p>使用设备自带的系统音色，或上传录音创建本人的专属声音。</p>
      <section
        style={{
          borderBottom: "1px solid #edf0f4",
          paddingBottom: 24,
          marginBottom: 24,
        }}
      >
        <h3>系统音色</h3>
        <p>
          无需上传录音。桌面端使用 Windows 已安装的声音，制作时在全景工厂选择。
        </p>
        {local.isError && (
          <Alert
            type="error"
            title="无法读取系统音色"
            description={local.error.message}
          />
        )}
        <Space wrap>
          <Select
            aria-label="系统音色"
            style={{ minWidth: 260 }}
            placeholder={
              local.isPending && window.desktop
                ? "正在读取音色…"
                : "请选择系统音色"
            }
            value={systemVoice}
            options={voiceChoices.map((v) => ({
              value: v.name,
              label: `${v.name} · ${v.language}`,
            }))}
            onChange={setSystemVoice}
          />
          <Button
            disabled={!systemVoice || busy}
            onClick={() =>
              void act(async () => {
                setAudioURL("");
                const selected = voiceChoices.find(
                  (v) => v.name === systemVoice,
                )!;
                if (window.desktop) {
                  const result = await authRequest<{ url: string }>(
                    "panorama.preview-system",
                    [{ voice: selected.name, language: selected.language }],
                  );
                  setAudioURL(result.url);
                } else {
                  window.speechSynthesis.cancel();
                  const utterance = new SpeechSynthesisUtterance(
                    selected.language.startsWith("en")
                      ? "Hello, let me introduce this property to you."
                      : "您好，我是您的房产顾问，欢迎一起了解这套房源。",
                  );
                  utterance.voice =
                    browserVoices.find((v) => v.name === selected.name) || null;
                  window.speechSynthesis.speak(utterance);
                }
              })
            }
          >
            试听系统音色
          </Button>
        </Space>
        {!window.desktop && (
          <p>
            浏览器试听使用当前浏览器的声音；实际制作以桌面设备可用音色为准。
          </p>
        )}
      </section>
      <Space
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginBottom: 16,
        }}
      >
        <h3 style={{ margin: 0 }}>我的专属音色</h3>
        <Space>
          <Button onClick={() => void library.refetch()}>刷新列表</Button>
          <Button
            type="primary"
            onClick={resetUpload}
            disabled={!library.data?.cloneEnabled || busy}
          >
            上传本人声音
          </Button>
        </Space>
      </Space>
      {library.isPending ? (
        <Spin />
      ) : library.isError ? (
        <Alert
          type="error"
          title="无法加载音色"
          description={library.error.message}
        />
      ) : (
        <>
          {!library.data?.cloneEnabled && (
            <Alert
              type="info"
              showIcon
              title="声音复刻尚未开通"
              description="管理员配置火山语音服务并开通声音复刻后，可上传本人录音。系统音色仍可直接使用。"
              style={{ marginBottom: 16 }}
            />
          )}
          {library.data?.voices.length === 0 && (
            <Empty description="尚未创建专属音色" />
          )}
          {library.data?.voices.map((voice) => (
            <div
              key={voice.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 16,
                padding: "18px 0",
                borderBottom: "1px solid #edf0f4",
              }}
            >
              <div>
                <strong>{voice.name}</strong>{" "}
                <Tag
                  color={
                    voice.status === "ready"
                      ? "green"
                      : voice.status === "failed"
                        ? "red"
                        : "default"
                  }
                >
                  {statusLabels[voice.status]}
                </Tag>
                <p>
                  {voice.language === "zh-CN" ? "中文录音" : "英文录音"}
                  {voice.error && ` · ${voice.error}`}
                </p>
              </div>
              <Space wrap>
                <Button
                  loading={busy}
                  onClick={() =>
                    void act(async () => {
                      await authRequest("voice.refresh", [{ id: voice.id }]);
                    })
                  }
                >
                  刷新状态
                </Button>
                <Button
                  disabled={voice.status !== "ready" || busy}
                  onClick={() =>
                    void act(async () => {
                      const sample = await authRequest<{
                        audio: string;
                        mime: string;
                      }>("voice.preview", [{ id: voice.id }]);
                      setAudioURL(audioBlobURL(sample.audio, sample.mime));
                    })
                  }
                >
                  试听本人音色
                </Button>
                <Popconfirm
                  title="从本应用移除此音色？"
                  description="以后无法再选择它制作；已有成片保留。供应商音色槽位需要管理员另行释放。"
                  onConfirm={() =>
                    act(async () => {
                      await authRequest("voice.remove", [{ id: voice.id }]);
                    })
                  }
                >
                  <Button
                    danger
                    disabled={busy || voice.status === "submitting"}
                  >
                    移除
                  </Button>
                </Popconfirm>
              </Space>
            </div>
          ))}
        </>
      )}
      {audioURL && (
        <div style={{ marginTop: 20 }}>
          <p>音色试听</p>
          <audio key={audioURL} src={audioURL} controls autoPlay />
        </div>
      )}
      <Modal
        title="上传本人声音"
        open={open}
        onCancel={() => !busy && setOpen(false)}
        onOk={() => void create()}
        confirmLoading={busy}
        okText="提交声音复刻"
        cancelButtonProps={{ disabled: busy }}
        closable={!busy}
        maskClosable={!busy}
      >
        <Alert
          type="info"
          showIcon
          title="准备5–30秒的清晰单人录音"
          description="建议10–15秒，无音乐和明显噪声。录音将发送至火山进行声音复刻，本应用数据库只保留音色信息。复刻及后续使用可能产生供应商音色槽位和合成费用。"
          style={{ marginBottom: 20 }}
        />
        <Form layout="vertical" disabled={busy}>
          <Form.Item label="音色名称" required>
            <Input
              value={name}
              maxLength={40}
              onChange={(e) => {
                setName(e.target.value);
                requestKey.current = crypto.randomUUID();
              }}
            />
          </Form.Item>
          <Form.Item label="录音语言">
            <Select
              value={language}
              options={[
                { value: "zh-CN", label: "中文" },
                { value: "en-US", label: "英语" },
              ]}
              onChange={(value) => {
                setLanguage(value);
                requestKey.current = crypto.randomUUID();
              }}
            />
          </Form.Item>
          <Form.Item label="本人录音" required>
            <Upload
              accept=".wav,.mp3,.m4a"
              showUploadList={false}
              beforeUpload={async (selected) => {
                try {
                  await validateRecording(selected);
                  setFile(selected);
                  requestKey.current = crypto.randomUUID();
                } catch (error) {
                  void message.error(
                    error instanceof Error ? error.message : "录音无效",
                  );
                }
                return false;
              }}
            >
              <Button>
                {file?.name || "选择 WAV / MP3 / M4A（不超过10 MB）"}
              </Button>
            </Upload>
          </Form.Item>
          <Checkbox
            checked={authorized}
            onChange={(event) => setAuthorized(event.target.checked)}
          >
            我确认这是本人声音或已获得明确授权，并同意提交火山进行声音复刻。
          </Checkbox>
        </Form>
      </Modal>
    </>
  );
}
