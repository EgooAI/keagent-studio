import { Alert, Button, Input, Space } from "antd";
import type { PanoramaConfig } from "@keagent/shared-types";

export const renderKeys = ["speed", "rate", "maxSweep"] as const;
export type RenderSettings = Pick<PanoramaConfig, (typeof renderKeys)[number]>;
export type RenderEdits = Partial<Record<keyof RenderSettings, string>>;
const fields = {
  speed: { label: "镜头速度", unit: "°/秒", min: 0.5, max: 45, step: 0.5 },
  rate: { label: "配音语速", unit: "倍", min: 0.5, max: 2, step: 0.1 },
  maxSweep: { label: "最大转角", unit: "°", min: 1, max: 180, step: 1 },
};

export function renderSettingsError(edits: RenderEdits, spatial = false) {
  for (const key of renderKeys) {
    if ((spatial && key !== "rate") || edits[key] === undefined) continue;
    const field = fields[key];
    const value = Number(edits[key]);
    if (
      !edits[key]?.trim() ||
      !Number.isFinite(value) ||
      value < field.min ||
      value > field.max
    )
      return `请填写${field.min}–${field.max}${field.unit}的${field.label}，或恢复模板值。`;
  }
  return "";
}

export function renderOverrides(
  edits: RenderEdits,
  spatial = false,
): Partial<RenderSettings> {
  const error = renderSettingsError(edits, spatial);
  if (error) throw new Error(error);
  return Object.fromEntries(
    renderKeys
      .filter((key) => edits[key] !== undefined && (!spatial || key === "rate"))
      .map((key) => [key, Number(edits[key])]),
  );
}

export function FactoryRenderSettings({
  scope,
  defaults,
  edits,
  spatial = false,
  disabled,
  resetDisabled,
  onChange,
  onReset,
}: {
  scope: "批次" | "任务";
  defaults: Partial<RenderSettings>;
  edits: RenderEdits;
  spatial?: boolean;
  disabled?: boolean;
  resetDisabled?: boolean;
  onChange: (edits: RenderEdits) => void;
  onReset?: () => void;
}) {
  const error = renderSettingsError(edits, spatial);
  return (
    <div aria-label={`${scope}制作参数`} style={{ marginBlock: 12 }}>
      <Space className="factory-render-fields" wrap align="end" size={16}>
        {renderKeys
          .filter((key) => !spatial || key === "rate")
          .map((key) => {
            const field = fields[key];
            const invalid = !!renderSettingsError({ [key]: edits[key] });
            return (
              <label key={key} style={{ display: "grid", gap: 6 }}>
                <span>
                  {field.label}（{field.unit}）
                </span>
                <Input
                  type="number"
                  aria-label={`${scope}${field.label}`}
                  aria-invalid={invalid}
                  status={invalid ? "error" : undefined}
                  style={{ width: "var(--factory-render-input-width, 160px)" }}
                  min={field.min}
                  max={field.max}
                  step={field.step}
                  value={edits[key] ?? defaults[key] ?? ""}
                  placeholder="各模板默认值"
                  disabled={disabled}
                  onChange={(event) =>
                    onChange({ ...edits, [key]: event.target.value })
                  }
                />
              </label>
            );
          })}
        {onReset && (
          <Button
            size="small"
            disabled={disabled || resetDisabled}
            onClick={onReset}
          >
            恢复模板值
          </Button>
        )}
      </Space>
      <p className="muted" style={{ marginTop: 8 }}>
        {scope === "批次"
          ? "语速会影响配音和镜头时长。"
          : "语速影响配音和镜头时长；调整语速后重新制作可能需要重新生成配音和人物开场。"}
      </p>
      {error && (
        <Alert showIcon type="error" title={error} style={{ marginTop: 8 }} />
      )}
    </div>
  );
}
