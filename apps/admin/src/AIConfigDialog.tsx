import { encodeOpeningLocation } from "./openingLocationImage";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Descriptions,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Switch,
  Tag,
  type DescriptionsProps,
} from "antd";
import { useEffect, useRef, useState } from "react";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
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

function ProbeDetails({ test }: { test?: AdminAIProbe | null }) {
  if (!test) return null;
  return (
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
  );
}

type Fields = Record<string, string | boolean>;
type Props = {
  row: AdminAIManagement;
  voiceClone?: AdminAIManagement;
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

type TestDialog = {
  mode: "sample" | "training";
  version: number;
};

export default function AIConfigDialog({
  row,
  voiceClone,
  voices,
  writable,
  onDirty,
  onClose,
}: Props) {
  const { modal, message } = App.useApp();
  const client = useQueryClient();
  const [form] = Form.useForm<Fields>();
  const [sampleForm] = Form.useForm<Fields>();
  const [edit, setEdit] = useState<{
    settings: AdminAIManagement;
    useSaved: boolean;
  }>();
  const [verifyClone, setVerifyClone] = useState(false);
  const [testDialog, setTestDialog] = useState<TestDialog>();
  const [dirty, setDirty] = useState(false);
  const [sampleDirty, setSampleDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [file, setFile] = useState<File>();
  const [openingLocation, setOpeningLocation] = useState<File>();
  const [verification, setVerification] = useState<AdminAIProbe>();
  const [verificationRequest, setVerificationRequest] = useState<string>();
  const dialogTitle = useRef<HTMLSpanElement>(null);
  const action = useRef(false);
  const testRequest = useRef<{ key: string; id: string } | undefined>(
    undefined,
  );
  const service = row.summary.id;
  const sharedSpeech = !!voiceClone;
  const settingsRow = voiceClone ?? row;
  const active = settingsRow.active;
  const activeClone = active.fields.DASHSCOPE_VOICE_CLONE_ENABLED === true;
  const title = sharedSpeech ? "百炼语音" : row.summary.label;
  const hasKey = Object.values(active.secrets).some(Boolean);
  const editLabel = hasKey ? "更换密钥" : "设置密钥";
  const editConfig = edit?.useSaved
    ? edit.settings.candidate
    : edit?.settings.active;
  const editMode =
    service === "voice-clone" || (sharedSpeech && verifyClone)
      ? "training"
      : "sample";
  const sampleMode = edit ? editMode : testDialog?.mode;
  const locked = row.active.locked || active.locked;
  const running =
    probeRunning(row.active.test) ||
    probeRunning(voiceClone?.active.test) ||
    probeRunning(row.candidate?.test) ||
    probeRunning(voiceClone?.candidate?.test) ||
    probeRunning(row.verification);
  const submitted =
    verification ??
    (verificationRequest && row.verification?.id === verificationRequest
      ? row.verification
      : undefined);
  const verificationResult = useQuery({
    queryKey: ["admin", "ai-verification", submitted?.id],
    queryFn: submitted
      ? () =>
          serviceRequest<AdminAIProbe>(
            root + "/test?id=" + encodeURIComponent(submitted.id),
          )
      : skipToken,
    enabled: probeRunning(submitted),
    initialData: submitted,
    refetchInterval: ({ state }) => (probeRunning(state.data) ? 2000 : false),
  });
  const checked = probeRunning(submitted)
    ? (verificationResult.data ?? submitted)
    : submitted;
  const checking = probeRunning(checked) || checked?.status === "passed";
  const blocked = busy || checking;
  const lastVerification = edit?.settings.verification;
  const updateStatus =
    checked ??
    (!dirty &&
    !sampleDirty &&
    lastVerification?.version === edit?.settings.revision &&
    (lastVerification?.status === "failed" ||
      lastVerification?.status === "unknown")
      ? lastVerification
      : undefined);

  useEffect(() => {
    dialogTitle.current?.focus({ preventScroll: true });
  }, [!!edit, testDialog?.mode]);

  useEffect(() => {
    if (!editConfig) return;
    form.resetFields();
    form.setFieldsValue(editConfig.fields);
  }, [editConfig, form]);

  useEffect(() => {
    const reserved = submitted?.version;
    if (reserved === undefined) return;
    setEdit((current) => {
      if (!current || current.settings.revision + 1 !== reserved)
        return current;
      return {
        ...current,
        settings: { ...current.settings, revision: reserved },
      };
    });
  }, [submitted?.id, submitted?.version]);

  useEffect(() => {
    if (!submitted || checked?.status !== "passed") return;
    let cancelled = false;
    void client.invalidateQueries({ queryKey: ["admin"] }).then(() => {
      if (cancelled) return;
      form.resetFields();
      setVerification(undefined);
      setVerificationRequest(undefined);
      setEdit(undefined);
      setDirty(false);
      setSampleDirty(false);
      setFile(undefined);
      setOpeningLocation(undefined);
      setError("");
      onDirty(false);
      void message.success("配置已验证并启用");
    });
    return () => {
      cancelled = true;
    };
  }, [submitted?.id, checked?.status, client, form, message, onDirty]);

  function openEditor() {
    const { candidate } = settingsRow;
    setEdit({ settings: settingsRow, useSaved: !!candidate });
    setVerifyClone(
      (candidate ?? active).fields.DASHSCOPE_VOICE_CLONE_ENABLED === true,
    );
    setError("");
  }

  function updateSampleMode(clone: boolean) {
    if (clone === verifyClone) return sampleDirty;
    setVerifyClone(clone);
    sampleForm.resetFields();
    setFile(undefined);
    setOpeningLocation(undefined);
    setSampleDirty(false);
    return false;
  }

  function setSaved(useSaved: boolean) {
    if (!edit) return;
    const config = useSaved ? edit.settings.candidate : edit.settings.active;
    setEdit({ ...edit, useSaved });
    setDirty(false);
    onDirty(
      updateSampleMode(config?.fields.DASHSCOPE_VOICE_CLONE_ENABLED === true),
    );
    setVerification(undefined);
    setVerificationRequest(undefined);
    setError("");
  }

  function editChanged(_: Partial<Fields>, values: Fields) {
    const changed = settingsRow.fields.some(({ key, kind }) => {
      const value = values[key];
      const original = editConfig?.fields[key];
      if (kind === "toggle") return (value === true) !== (original === true);
      const typed = typeof value === "string" ? value.trim() : "";
      return typed !== (typeof original === "string" ? original.trim() : "");
    });
    const editedSample = updateSampleMode(
      values.DASHSCOPE_VOICE_CLONE_ENABLED === true,
    );
    setDirty(changed);
    onDirty(changed || editedSample);
    setVerification(undefined);
    setVerificationRequest(undefined);
    setError("");
  }

  function sampleChanged() {
    setSampleDirty(true);
    onDirty(true);
    setVerification(undefined);
    setVerificationRequest(undefined);
    setError("");
  }

  function returnToStatus() {
    if (edit) form.resetFields();
    setEdit(undefined);
    setTestDialog(undefined);
    setVerification(undefined);
    setDirty(false);
    setSampleDirty(false);
    onDirty(false);
    setFile(undefined);
    setOpeningLocation(undefined);
    setVerificationRequest(undefined);
    setError("");
  }

  function close() {
    if (busy || action.current) return;
    if (!edit && !testDialog) {
      onClose();
      return;
    }
    if (checking || (!dirty && !sampleDirty)) {
      returnToStatus();
      return;
    }
    modal.confirm({
      title: "放弃未提交的修改？",
      okText: "放弃修改",
      cancelText: "继续填写",
      onOk: returnToStatus,
    });
  }

  async function beginRequest(operation: () => Promise<void>) {
    if (action.current || blocked || running) return;
    action.current = true;
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败，请稍后重试");
      void client.invalidateQueries({ queryKey: ["admin", "ai-config"] });
    } finally {
      action.current = false;
      setBusy(false);
    }
  }

  async function prepareSample(mode: "sample" | "training", values: Fields) {
    const sample: Record<string, unknown> = { ...values };
    if (mode === "sample" && service === "script") {
      sample.images = await fixtureImages(2);
    }
    if (mode === "training") {
      const max = 10;
      const format = file?.name.split(".").at(-1)?.toLowerCase();
      if (!file || file.size > max * 1024 * 1024) {
        throw new Error(`请选择不超过 ${max} MB 的测试文件`);
      }
      sample.audio = await encodeFile(file);
      sample.format = format;
    }
    if (mode === "sample" && service === "opening") {
      if (!openingLocation || !file || file.size > 3 * 1024 * 1024) {
        throw new Error("请选择测试地点图和 3 MB 以内的经纪人照片");
      }
      [sample.location, sample.photo] = await Promise.all([
        encodeOpeningLocation(openingLocation),
        encodeFile(file),
      ]);
    }
    return sample;
  }

  async function runTest(mode: AdminAIProbeMode, version: number) {
    await beginRequest(async () => {
      const testService =
        sharedSpeech && mode === "training" ? "voice-clone" : service;
      let values: Fields = {};
      if (mode !== "connection") {
        try {
          values = await sampleForm.validateFields();
        } catch {
          return;
        }
      }
      // Keep the same request ID if a response is lost before the administrator retries.
      const key = JSON.stringify([
        testService,
        version,
        mode,
        values,
        file?.name,
        file?.size,
        file?.lastModified,
        openingLocation?.name,
        openingLocation?.size,
        openingLocation?.lastModified,
      ]);
      if (testRequest.current?.key !== key) {
        testRequest.current = { key, id: crypto.randomUUID() };
      }
      const sample =
        mode === "connection" ? {} : await prepareSample(mode, values);
      await serviceRequest(root + "/test", {
        service: testService,
        version,
        mode,
        confirmed: mode !== "connection",
        requestId: testRequest.current.id,
        sample,
      });
      testRequest.current = undefined;
      await client.invalidateQueries({ queryKey: ["admin"] });
      if (testDialog) returnToStatus();
      void message.success("测试已开始");
    });
  }

  function openTest(mode: "sample" | "training") {
    setError("");
    setTestDialog({ mode, version: row.active.version });
  }

  async function verifyAndEnable() {
    if (!edit || !(dirty || edit.useSaved)) return;
    await beginRequest(async () => {
      let fields: Fields | undefined;
      let sampleValues: Fields;
      try {
        fields = edit.useSaved ? undefined : await form.validateFields();
        sampleValues = await sampleForm.validateFields();
      } catch {
        return;
      }
      const sample = await prepareSample(editMode, sampleValues);
      const requestId = verificationRequest ?? crypto.randomUUID();
      setVerificationRequest(requestId);
      const probe = await serviceRequest<AdminAIProbe>(
        root + "/verify-enable",
        {
          service: settingsRow.summary.id,
          revision: edit.settings.revision,
          requestId,
          confirmed: true,
          ...(edit.useSaved ? { useSaved: true } : { fields }),
          sample,
        },
      );
      setVerification(probe);
      setVerificationRequest(undefined);
      void client.invalidateQueries({ queryKey: ["admin", "ai-config"] });
    });
  }

  const dialogName = edit
    ? editLabel
    : testDialog?.mode === "training"
      ? "确认测试复刻训练"
      : testDialog
        ? sharedSpeech
          ? "测试百炼配音"
          : `测试${title}`
        : title;

  return (
    <Modal
      open
      centered
      width={680}
      classNames={{ body: "workbench-form-body" }}
      title={
        <span ref={dialogTitle} tabIndex={-1}>
          {dialogName}
        </span>
      }
      closable={!busy}
      keyboard={!busy}
      mask={{ closable: false }}
      onCancel={close}
      footer={
        <div className="ai-config-actions">
          <Button disabled={busy} onClick={close}>
            {edit || testDialog ? "返回配置" : "关闭"}
          </Button>
          {edit ? (
            <Button
              aria-label="验证并启用"
              type="primary"
              loading={blocked}
              disabled={
                locked ||
                !writable ||
                blocked ||
                running ||
                !(dirty || edit.useSaved)
              }
              onClick={() => void verifyAndEnable()}
            >
              验证并启用
            </Button>
          ) : testDialog ? (
            <Button
              aria-label="确认运行测试"
              type="primary"
              loading={busy}
              disabled={running || busy}
              onClick={() => void runTest(testDialog.mode, testDialog.version)}
            >
              确认运行测试
            </Button>
          ) : (
            <Button
              type="primary"
              disabled={!writable || locked || running || busy}
              onClick={openEditor}
            >
              {editLabel}
            </Button>
          )}
        </div>
      }
    >
      {!edit && !testDialog && (
        <>
          <section className="ai-config-section">
            <h3>当前配置</h3>
            {sharedSpeech && (
              <p className="admin-secondary">
                配音与声音复刻共用百炼北京地域的 API Key 和业务空间 ID，使用千问
                3.1 Plus。
              </p>
            )}
            <Descriptions
              size="small"
              column={1}
              items={[
                ...settingsRow.fields.flatMap<
                  NonNullable<DescriptionsProps["items"]>[number]
                >(({ key, kind, label }) => {
                  if (kind === "secret") {
                    const enabled = active.secrets[key];
                    return [
                      {
                        key,
                        label,
                        children: (
                          <Tag color={enabled ? "green" : undefined}>
                            {locked
                              ? "无法读取"
                              : enabled
                                ? "已启用"
                                : "未设置"}
                          </Tag>
                        ),
                      },
                    ];
                  }
                  const value = active.fields[key];
                  if (kind === "toggle") {
                    return [
                      {
                        key,
                        label,
                        children: value === true ? "已开启" : "已关闭",
                      },
                    ];
                  }
                  return value ? [{ key, label, children: value }] : [];
                }),
                ...(active.activatedAt
                  ? [
                      {
                        key: "activated",
                        label: "启用时间",
                        children: dateTime(active.activatedAt),
                      },
                    ]
                  : []),
              ]}
            />
            {locked && <Alert type="error" showIcon title="当前配置无法解密" />}
            {row.summary.issues.map((issue) => (
              <Alert key={issue} type="warning" title={issue} showIcon />
            ))}
            {probeRunning(row.verification) && (
              <Alert type="info" showIcon title="正在验证提交的配置" />
            )}
          </section>
          <section className="ai-config-section">
            <div className="admin-section-heading">
              <h3>当前配置测试</h3>
              {!sharedSpeech && <AIProbeState test={row.active.test} />}
            </div>
            {sharedSpeech ? (
              <>
                <div className="admin-section-heading">
                  <strong>配音测试</strong>
                  <AIProbeState test={row.active.test} />
                </div>
                <ProbeDetails test={row.active.test} />
                {activeClone && (
                  <>
                    <div className="admin-section-heading">
                      <strong>声音复刻测试</strong>
                      <AIProbeState test={voiceClone.active.test} />
                    </div>
                    <ProbeDetails test={voiceClone.active.test} />
                  </>
                )}
              </>
            ) : (
              <ProbeDetails test={row.active.test} />
            )}
            <Space wrap>
              <Button
                disabled={
                  busy ||
                  running ||
                  locked ||
                  (service === "beike-cli" && !hasKey)
                }
                onClick={() => void runTest("connection", row.active.version)}
              >
                测试当前连接
              </Button>
              {service !== "voice-clone" && service !== "beike-cli" && (
                <Button
                  disabled={
                    busy ||
                    running ||
                    locked ||
                    row.summary.state !== "configured"
                  }
                  onClick={() => openTest("sample")}
                >
                  {sharedSpeech ? "测试配音样例" : "运行真实样例"}
                </Button>
              )}
              {(sharedSpeech || service === "voice-clone") && activeClone && (
                <Button
                  disabled={busy || running || locked}
                  onClick={() => openTest("training")}
                >
                  测试复刻训练
                </Button>
              )}
            </Space>
          </section>
        </>
      )}
      {edit && (
        <section className="ai-config-section">
          {edit.settings.candidate && (
            <div className="admin-section-heading">
              <Space>
                使用已保存的配置
                <Switch
                  aria-label="使用已保存的配置"
                  checked={edit.useSaved}
                  disabled={blocked}
                  onChange={setSaved}
                />
              </Space>
              {edit.useSaved && <Tag color="blue">已保存，待验证</Tag>}
            </div>
          )}
          <Form
            form={form}
            layout="vertical"
            initialValues={editConfig?.fields}
            disabled={locked || blocked || edit.useSaved}
            onValuesChange={editChanged}
            autoComplete="off"
          >
            {settingsRow.fields.map((field) => (
              <Form.Item
                key={field.key}
                name={field.key}
                label={field.label}
                valuePropName={field.kind === "toggle" ? "checked" : "value"}
                extra={
                  field.kind === "secret"
                    ? editConfig?.secrets[field.key]
                      ? edit.useSaved
                        ? "已设置"
                        : "已设置，留空沿用原密钥"
                      : "未设置"
                    : field.key === "DASHSCOPE_WORKSPACE_ID"
                      ? "填写北京地域以 ws- 或 llm- 开头的业务空间 ID"
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
                    : field.kind === "secret" && !editConfig?.secrets[field.key]
                      ? [
                          {
                            required: true,
                            whitespace: true,
                            message: `请填写${field.label}`,
                          },
                        ]
                      : undefined
                }
              >
                {field.kind === "secret" ? (
                  <Input.Password
                    maxLength={2048}
                    autoComplete="new-password"
                    placeholder={edit.useSaved ? undefined : "输入新密钥"}
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
        </section>
      )}
      {sampleMode && (
        <section className="ai-config-section">
          <p className="admin-secondary">
            {sampleMode === "training"
              ? edit
                ? "本次会将录音提交至阿里云百炼，创建临时音色并验证配音。验证通过后立即启用，合成按字符计费。"
                : "本次会使用当前配置将录音提交至阿里云百炼，创建临时音色并验证配音。合成按字符计费。"
              : edit
                ? "后台会向供应商发起真实调用，验证通过后立即启用。测试可能计费或消耗额度。"
                : "本次会使用当前配置向供应商发起真实调用，可能计费或消耗额度。"}
          </p>
          <Form
            layout="vertical"
            form={sampleForm}
            clearOnDestroy
            disabled={blocked}
            onValuesChange={sampleChanged}
          >
            {service === "tts" && sampleMode === "sample" && (
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
            {sampleMode === "training" && (
              <Form.Item label="测试录音" required>
                <Input
                  type="file"
                  accept=".wav,.mp3,.m4a"
                  onChange={(event) => {
                    setFile(event.target.files?.[0]);
                    sampleChanged();
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
                    disabled={blocked}
                    onChange={(event) => {
                      setOpeningLocation(event.target.files?.[0]);
                      sampleChanged();
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
                    disabled={blocked}
                    onChange={(event) => {
                      setFile(event.target.files?.[0]);
                      sampleChanged();
                    }}
                  />
                </Form.Item>
              </>
            )}
            {(service === "opening" ||
              service === "beike" ||
              sampleMode === "training") && (
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
          {updateStatus && (
            <>
              <AIProbeState test={updateStatus} />
              <ProbeDetails test={updateStatus} />
            </>
          )}
          {submitted && verificationResult.isError && (
            <Alert
              type="warning"
              showIcon
              title="暂时无法读取验证结果，后台仍在核对。"
            />
          )}
        </section>
      )}
      {error && <Alert type="error" title={error} showIcon />}
    </Modal>
  );
}
