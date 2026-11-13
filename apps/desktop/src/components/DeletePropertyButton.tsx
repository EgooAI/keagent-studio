import { useState } from "react";
import { App, Button, Modal } from "antd";
import { useQueryClient } from "@tanstack/react-query";
import { demoApi } from "@keagent/api-client";
import type { Property } from "@keagent/shared-types";

export function DeletePropertyButton({
  property,
  compact = false,
  onDeleted,
}: {
  property: Property;
  compact?: boolean;
  onDeleted?: () => void;
}) {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  async function remove() {
    setDeleting(true);
    try {
      await demoApi.deleteProperty(property.id);
      setOpen(false);
      onDeleted?.();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["workspace"] }),
        queryClient.invalidateQueries({ queryKey: ["factory-properties"] }),
      ]);
      void message.success("房源已删除");
    } catch (error) {
      void message.error(
        error instanceof Error ? error.message : "删除房源失败，请重试",
      );
    } finally {
      setDeleting(false);
    }
  }
  return (
    <>
      <Button
        danger
        type={compact ? "text" : "default"}
        size={compact ? "small" : "middle"}
        onClick={() => setOpen(true)}
      >
        删除房源
      </Button>
      <Modal
        title="删除房源？"
        open={open}
        okText="确认删除"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        cancelButtonProps={{ disabled: deleting }}
        confirmLoading={deleting}
        onOk={remove}
        onCancel={() => {
          if (!deleting) setOpen(false);
        }}
      >
        <p>
          {property.title}（房源号 {property.propertyNumber}）
        </p>
        <p>删除后无法撤销，需重新录入。已有视频、历史任务及本机素材会保留。</p>
      </Modal>
    </>
  );
}
