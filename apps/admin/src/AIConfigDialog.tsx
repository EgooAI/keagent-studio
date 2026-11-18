import { encodeOpeningLocation } from "./openingLocationImage";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Form,
  Input,
  Modal,
  Radio,
  Select,
  Space,
  Switch,
  Tag,
} from "antd";
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { serviceRequest } from "@keagent/api-client";
import type {
  AdminAIConfig,
  AdminAIManagement,
  AdminAIProbe,
  AdminAIProbeMode,
} from "@keagent/shared-types";
import { dateTime } from "./admin-api";

export const probeRunning = (test?: AdminAIProbe | null) =>
  test?.status === "queued" || test?.status === "running";
export const probeModeLabel = (mode: AdminAIProbeMode) =>
  ({ connection: "仅连通性", sample: "真实样例", training: "复刻训练" })[mode];
export function AIProbeState({ test }: { test?: AdminAIProbe | null }) {
  if (!test) return <span className="admin-secondary">未测试</span>;
  const label = {
    queued: "等待测试",
    running: "测试中",
    passed: "已通过",
    failed: "测试失败",
    unknown: "结果待核对",
  }[test.status];
  const pass =
    test.mode === "connection"
      ? "连通性通过"
      : test.mode === "training"
        ? "复刻训练通过"
        : test.service === "voice-clone"
          ? "测试音色可用"
          : "样例通过";
  return (
    <Tag
      color={
        test.status === "passed"
          ? "green"
          : test.status === "failed"
            ? "red"
            : test.status === "unknown"
              ? "orange"
              : probeRunning(test)
                ? "processing"
                : "default"
      }
    >
      {test.status === "passed" ? pass : label}
    </Tag>
  );
}

type Fields = Record<string, string | boolean>;
type Props = {
  row: AdminAIManagement;
  cloneTrainingRequired: boolean;
  voices: AdminAIConfig["voices"];
  writable: boolean;
  onDirty: (dirty: boolean) => void;
  onClose: () => void;
};
const root = "/v1/admin/ai-config";

function encodeFile(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const encoded = String(reader.result).split(",")[1];
      if (encoded) resolve(encoded);
      else reject(new Error("文件无法读取"));
    };
    reader.onerror = () => reject(new Error("文件无法读取"));
    reader.readAsDataURL(blob);
  });
}

async function fixtureImages(count: number) {
  return Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const response = await fetch(`/media/interior-${i + 1}.jpg`);
      if (!response.ok) throw new Error("无法读取后台示例图片");
      return encodeFile(await response.blob());
    }),
  );
}

export default function AIConfigDialog({
  row,
  cloneTrainingRequired,
  voices,
  writable,
  onDirty,
  onClose,
}: Props) {
  const { modal, message } = App.useApp();
  const client = useQueryClient();
  const [form] = Form.useForm<Fields>();
  const [sampleForm] = Form.useForm<Fields>();
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [testDialog, setTestDialog] = useState<{
    mode: AdminAIProbeMode;
    version: number;
    label: string;
  }>();
  const [testSource, setTestSource] = useState<"active" | "candidate">(
    "candidate",
  );
  const [sampleDirty, setSampleDirty] = useState(false);
  const dialogTitle = useRef<HTMLSpanElement>(null);
  const testing = useRef(false);
  const [file, setFile] = useState<File>();
  const [openingLocation, setOpeningLocation] = useState<File>();
  const revision = useRef(row.revision);
  const action = useRef(false);
  const request = useRef<{ key: string; id: string } | null>(null);
  const service = row.summary.id;
  const candidate = row.candidate;
  const testingCandidate = testSource === "candidate" && !!candidate;
  const testConfig = testingCandidate ? candidate : row.active;
  const test = testConfig.test;
  const testMode = testDialog?.mode;
  const running =
    probeRunning(candidate?.test) || probeRunning(row.active.test);
  const locked = !writable || row.active.locked;

  useEffect(() => {
    if (!dirty) {
      revision.current = row.revision;
      form.resetFields();
      form.setFieldsValue(row.candidate?.fields ?? row.active.fields);
    }
  }, [row, dirty, form]);

  useEffect(() => {
    dialogTitle.current?.focus({ preventScroll: true });
  }, [testMode]);

  function markDirty(value: boolean) {
    setDirty(value);
    onDirty(value);
  }

  async function submit(
    path: string,
    body: Record<string, unknown>,
    success: string | ((changed: boolean) => string),
  ) {
    if (action.current) return false;
    action.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await serviceRequest<{ changed?: boolean }>(root + path, {
        service,
        ...body,
      });
      await client.invalidateQueries({ queryKey: ["admin"] });
      void message.success(
        typeof success === "string"
          ? success
          : success(result?.changed !== false),
      );
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败，请稍后重试");
      await client.invalidateQueries({ queryKey: ["admin", "ai-config"] });
      return false;
    } finally {
      action.current = false;
      setBusy(false);
    }
  }
  async function save() {
    let fields;
    try {
      fields = await form.validateFields();
    } catch {
      return;
    }
    if (
      await submit(
        "/save",
        { revision: revision.current, fields },
        (changed) => (changed ? "配置已保存，请完成可用性测试" : "配置未改动"),
      )
    ) {
      markDirty(false);
    }
  }
  function activate() {
    if (!candidate) return;
    modal.confirm({
      title: "启用当前配置？",
      content:
        row.group === "speech"
          ? "配音与声音复刻的新请求将使用这份共享配置。"
          : "新请求将使用这份配置，已提交的异步任务会继续使用提交时的配置。",
      okText: "确认启用",
      cancelText: "取消",
      onOk: () =>
        submit(
          "/activate",
          { revision: row.revision, version: candidate.version },
          "新配置已启用",
        ),
    });
  }
  function markSampleDirty(value: boolean) {
    setSampleDirty(value);
    onDirty(value || dirty);
  }
  function returnToConfiguration() {
    setTestDialog(undefined);
    setFile(undefined);
    setOpeningLocation(undefined);
    setError("");
    markSampleDirty(false);
  }
  function close() {
    if (action.current || testing.current) return;
    if (!testMode) {
      onClose();
      return;
    }
    if (sampleDirty) {
      modal.confirm({
        title: "放弃未提交的样例？",
        okText: "放弃修改",
        cancelText: "继续填写",
        onOk: returnToConfiguration,
      });
    } else returnToConfiguration();
  }

  function openTest(mode: AdminAIProbeMode) {
    if (mode === "connection") {
      void runTest(mode, testConfig.version);
      return;
    }
    setError("");
    setFile(undefined);
    setOpeningLocation(undefined);
    setTestDialog({
      mode,
      version: testConfig.version,
      label: testingCandidate ? "待启用配置" : "生效配置",
    });
  }
  async function runTest(mode: AdminAIProbeMode, version: number) {
    if (running || action.current || testing.current) return;
    testing.current = true;
    setBusy(true);
    const sample: Record<string, unknown> = {};
    if (mode !== "connection") {
      try {
        Object.assign(sample, await sampleForm.validateFields());
      } catch {
        testing.current = false;
        setBusy(false);
        return;
      }
    }
    // Keep the same request ID when a response is lost and the administrator retries.
    const key = JSON.stringify([
      service,
      version,
      mode,
      sample,
      file?.name,
      file?.size,
      file?.lastModified,
      openingLocation?.name,
      openingLocation?.size,
      openingLocation?.lastModified,
    ]);
    if (request.current?.key !== key)
      request.current = { key, id: crypto.randomUUID() };
    const requestId = request.current.id;
    try {
      if (mode !== "connection" && service === "script") {
        sample.images = await fixtureImages(2);
      }
      if (mode === "training") {
        const max = 10;
        if (!file || file.size > max * 1024 * 1024)
          throw new Error(`请选择不超过 ${max} MB 的测试文件`);
        sample.audio = await encodeFile(file);
        sample.format = file.name.split(".").at(-1)?.toLowerCase();
      }
      if (mode === "sample" && service === "opening") {
        if (!openingLocation || !file || file.size > 3 * 1024 * 1024)
          throw new Error("请选择测试地点图和 3 MB 以内的经纪人照片");
        [sample.location, sample.photo] = await Promise.all([
          encodeOpeningLocation(openingLocation),
          encodeFile(file),
        ]);
      }
      if (
        await submit(
          "/test",
          {
            version,
            mode,
            requestId,
            confirmed: mode !== "connection",
            sample,
          },
          "测试已开始",
        )
      ) {
        request.current = null;
        if (testMode) returnToConfiguration();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法准备测试素材");
    } finally {
      testing.current = false;
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      centered
      width={680}
      classNames={{ body: "workbench-form-body" }}
      title={
        <span ref={dialogTitle} tabIndex={-1}>
          {testMode === "training"
            ? "确认测试复刻训练"
            : testMode
              ? `测试${row.summary.label}`
              : row.summary.label}
        </span>
      }
      closable={!busy}
      keyboard={!busy}
      mask={{ closable: false }}
      onCancel={close}
      footer={
        testDialog ? (
          <div className="ai-config-actions">
            <Button disabled={busy} onClick={close}>
              返回配置
            </Button>
            <Button
              type="primary"
              loading={busy}
              disabled={running}
              onClick={() => void runTest(testDialog.mode, testDialog.version)}
            >
              确认运行测试
            </Button>
          </div>
        ) : (
          <div className="ai-config-actions">
            <Button disabled={busy} onClick={close}>
              关闭
            </Button>
            <Button
              type={!row.canActivate || dirty ? "primary" : "default"}
              loading={busy}
              disabled={locked}
              onClick={() => void save()}
            >
              保存配置
            </Button>
            {candidate && (
              <Button
                type="primary"
                loading={busy}
                disabled={
                  !row.canActivate ||
                  locked ||
                  probeRunning(candidate.test) ||
                  dirty
                }
                onClick={activate}
              >
                {row.group === "speech" ? "启用共享配置" : "启用配置"}
              </Button>
            )}
          </div>
        )
      }
    >
      <div hidden={!!testMode}>
        <section className="ai-config-section">
          <h3>服务配置</h3>
          {row.group === "speech" && (
            <p className="admin-secondary">
              配音与声音复刻共用 API Key。启用共享配置会同时应用两项服务的设置。
            </p>
          )}
          {service === "tts" &&
            candidate &&
            row.summary.state === "configured" &&
            !row.active.locked && (
              <p className="admin-secondary">
                当前火山配音已启用，可以继续使用公共音色。
              </p>
            )}
          <Form
            form={form}
            layout="vertical"
            disabled={locked || busy}
            onValuesChange={() => markDirty(true)}
            autoComplete="off"
          >
            {row.fields.map((field) => (
              <Form.Item
                key={field.key}
                name={field.key}
                label={field.label}
                valuePropName={field.kind === "toggle" ? "checked" : "value"}
                extra={
                  field.kind === "secret"
                    ? (candidate?.secrets ?? row.active.secrets)[field.key]
                      ? "已设置，留空沿用原密钥"
                      : "未设置"
                    : undefined
                }
                help={
                  !dirty &&
                  (candidate ?? row.summary).missing.includes(field.key)
                    ? "请补充该字段后测试"
                    : undefined
                }
                validateStatus={
                  !dirty &&
                  (candidate ?? row.summary).missing.includes(field.key)
                    ? "warning"
                    : undefined
                }
                rules={
                  field.kind === "url"
                    ? [
                        {
                          validator: (_, value) => {
                            if (!value) return Promise.resolve();
                            try {
                              const url = new URL(value);
                              if (
                                url.protocol === "https:" &&
                                !url.username &&
                                !url.password &&
                                !url.search &&
                                !url.hash
                              )
                                return Promise.resolve();
                            } catch {
                              /* Let the form show the same error for malformed addresses. */
                            }
                            return Promise.reject(
                              new Error(
                                "请输入不含凭证、查询参数或片段的 HTTPS 地址",
                              ),
                            );
                          },
                        },
                      ]
                    : undefined
                }
              >
                {field.kind === "secret" ? (
                  <Input.Password
                    maxLength={2048}
                    autoComplete="new-password"
                    placeholder="输入新密钥"
                  />
                ) : field.kind === "toggle" ? (
                  <Switch aria-label={field.label} />
                ) : (
                  <Input
                    maxLength={2048}
                    placeholder={field.kind === "url" ? "https://" : undefined}
                  />
                )}
              </Form.Item>
            ))}
          </Form>
          {(candidate ?? row.summary).issues.map((issue) => (
            <Alert key={issue} type="warning" title={issue} showIcon />
          ))}
          {error && !testMode && (
            <Alert
              type="error"
              title={error}
              showIcon
              action={
                dirty ? (
                  <Button
                    size="small"
                    onClick={() => {
                      setError("");
                      markDirty(false);
                    }}
                  >
                    放弃编辑并刷新
                  </Button>
                ) : undefined
              }
            />
          )}
        </section>
        <section className="ai-config-section">
          <div className="admin-section-heading">
            <h3>可用性测试</h3>
            {testingCandidate &&
            service === "tts" &&
            !test &&
            row.reusedTtsTestAt ? (
              <Tag color="green">配音样例已复用</Tag>
            ) : (
              <AIProbeState test={test} />
            )}
          </div>
          {candidate ? (
            <Radio.Group
              aria-label="测试配置"
              value={testSource}
              onChange={(event) => setTestSource(event.target.value)}
              options={[
                { value: "active", label: "生效配置" },
                { value: "candidate", label: "待启用配置" },
              ]}
            />
          ) : (
            <p className="admin-secondary">测试对象：生效配置</p>
          )}
          {dirty && (
            <p className="admin-secondary">
              当前测试使用已保存的配置。保存修改后即可测试新配置。
            </p>
          )}
          {running && !probeRunning(test) && (
            <p className="admin-secondary">此服务的另一个配置正在测试。</p>
          )}
          {test && (
            <>
              <p className="admin-secondary">
                {probeModeLabel(test.mode)} ·{" "}
                {dateTime(test.finishedAt ?? test.createdAt)}
              </p>
              {test.steps.length > 0 && (
                <ol className="ai-probe-steps" aria-live="polite">
                  {test.steps.map((step) => (
                    <li key={step.name}>
                      <span>{step.name}</span>
                      <Tag
                        color={
                          step.state === "passed"
                            ? "green"
                            : step.state === "failed"
                              ? "red"
                              : step.state === "unknown"
                                ? "orange"
                                : "processing"
                        }
                      >
                        {
                          {
                            passed: "通过",
                            failed: "失败",
                            unknown: "待核对",
                            running: "进行中",
                            queued: "等待中",
                          }[step.state]
                        }
                      </Tag>
                    </li>
                  ))}
                </ol>
              )}
              {test.message && (
                <Alert
                  type={test.status === "passed" ? "info" : "warning"}
                  showIcon
                  title={test.message}
                />
              )}
            </>
          )}
          {candidate && service === "tts" && row.reusedTtsTestAt && (
            <p className="admin-secondary">
              待启用配置已复用生效配置的火山配音样例（
              {dateTime(row.reusedTtsTestAt)}）。
            </p>
          )}
          {candidate && !row.canActivate && !running && (
            <p className="admin-secondary">
              {row.group === "speech"
                ? cloneTrainingRequired
                  ? "待启用配置在「声音复刻」中通过最近 24 小时内的复刻训练后即可启用。"
                  : "仅启用配音的配置需要最近 24 小时内通过配音样例。"
                : "启用需要此配置最近 24 小时内通过真实样例测试。"}
            </p>
          )}
          <Space wrap>
            <Button
              disabled={busy || running}
              onClick={() => openTest("connection")}
            >
              检查连通性
            </Button>
            {service !== "voice-clone" && (
              <Button
                disabled={busy || running}
                onClick={() => openTest("sample")}
              >
                运行真实样例
              </Button>
            )}
            {service === "voice-clone" && (
              <Button
                disabled={busy || running}
                onClick={() => openTest("training")}
              >
                测试复刻训练
              </Button>
            )}
          </Space>
        </section>
      </div>
      {testDialog && (
        <div>
          <p className="admin-secondary">
            {testMode === "training"
              ? `本次会使用${testDialog.label}提交训练并查询音色状态。生成试听音频时可能收取试听字符费。`
              : `本次会使用${testDialog.label}向供应商发起真实调用，可能计费或消耗额度。`}
          </p>
          <Form
            layout="vertical"
            form={sampleForm}
            clearOnDestroy
            disabled={busy}
            onValuesChange={() => markSampleDirty(true)}
          >
            {service === "tts" && (
              <Form.Item
                name="voiceId"
                label="测试用公共音色"
                rules={[{ required: true, message: "请选择已上架的公共音色" }]}
              >
                <Select
                  options={voices.map((voice) => ({
                    label: voice.name,
                    value: voice.id,
                  }))}
                  placeholder="选择已上架的音色"
                />
              </Form.Item>
            )}
            {service === "beike" &&
              [
                ["cityName", "城市"],
                ["district", "区县"],
                ["address", "详细地址"],
              ].map(([key, label]) => (
                <Form.Item
                  key={key}
                  name={key}
                  label={label}
                  rules={[
                    {
                      required: true,
                      whitespace: true,
                      message: `请填写${label}`,
                    },
                  ]}
                >
                  <Input maxLength={300} />
                </Form.Item>
              ))}
            {testMode === "training" && (
              <Form.Item label="测试录音" required>
                <Input
                  type="file"
                  accept=".wav,.mp3,.m4a"
                  onChange={(event) => {
                    setFile(event.target.files?.[0]);
                    markSampleDirty(true);
                  }}
                />
              </Form.Item>
            )}
            {service === "opening" && (
              <>
                <Form.Item
                  label="测试地点图"
                  htmlFor="opening-test-location"
                  required
                >
                  <input
                    id="opening-test-location"
                    type="file"
                    accept=".jpg,.jpeg,.png"
                    disabled={busy}
                    onChange={(event) => {
                      setOpeningLocation(event.target.files?.[0]);
                      markSampleDirty(true);
                    }}
                  />
                </Form.Item>
                <Form.Item
                  label="测试人物照片"
                  htmlFor="opening-test-photo"
                  required
                >
                  <input
                    id="opening-test-photo"
                    type="file"
                    accept=".jpg,.jpeg,.png"
                    disabled={busy}
                    onChange={(event) => {
                      setFile(event.target.files?.[0]);
                      markSampleDirty(true);
                    }}
                  />
                </Form.Item>
              </>
            )}
            {(service === "opening" ||
              service === "beike" ||
              testMode === "training") && (
              <Form.Item
                name="authorized"
                valuePropName="checked"
                rules={[
                  {
                    validator: (_, value) =>
                      value
                        ? Promise.resolve()
                        : Promise.reject(new Error("请确认测试资料已授权")),
                  },
                ]}
              >
                <Checkbox>我确认已获得这份测试资料的使用授权</Checkbox>
              </Form.Item>
            )}
          </Form>
          {error && testMode && <Alert type="error" title={error} showIcon />}
        </div>
      )}
    </Modal>
  );
}
