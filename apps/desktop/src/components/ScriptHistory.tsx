import { useState } from "react";
import { App, Button, Collapse, Input, Select } from "antd";
import { Copy } from "lucide-react";
import type { ProductionTask } from "@keagent/shared-types";

export function ScriptHistory({
  history,
}: {
  history: NonNullable<ProductionTask["history"]>;
}) {
  const { message } = App.useApp();
  const [revision, setRevision] = useState<number>();
  const versions = history.filter((item) => item.script.trim());
  const selected =
    versions.find((item) => item.revision === revision) ?? versions.at(-1);
  if (!selected) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(selected.script);
      void message.success("历史文案已复制，当前文案未改变");
    } catch {
      void message.error("复制失败，请选中文案手动复制");
    }
  };

  return (
    <Collapse
      ghost
      style={{ marginTop: 16 }}
      items={[
        {
          key: "history",
          label: `历史文案（${versions.length}）`,
          children: (
            <>
              <div className="button-row" style={{ marginBottom: 12 }}>
                <Select
                  aria-label="选择历史文案修订"
                  value={selected.revision}
                  onChange={setRevision}
                  style={{ minWidth: 240 }}
                  options={versions.map((item) => ({
                    value: item.revision,
                    label: `文案修订 ${item.scriptRevision ?? item.revision} · 产物修订 ${item.revision}`,
                  }))}
                />
                <Button icon={<Copy size={15} />} onClick={() => void copy()}>
                  复制历史文案
                </Button>
              </div>
              <Input.TextArea
                aria-label="历史口播文案"
                value={selected.script}
                readOnly
                autoSize={{ minRows: 4, maxRows: 10 }}
              />
              <p className="form-hint">
                历史文案只读，不会覆盖当前编辑或推进任务。
              </p>
            </>
          ),
        },
      ]}
    />
  );
}
