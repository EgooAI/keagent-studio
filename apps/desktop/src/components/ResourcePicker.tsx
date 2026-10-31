import { useEffect, useState } from "react";
import { App, Button, Empty, Input, Modal, Progress, Tag } from "antd";
import { Check, Download, Search } from "lucide-react";
import { demoApi } from "@keagent/api-client";
import type {
  ResourceRef,
  ResourceType,
  VideoMode,
} from "@keagent/shared-types";
import { useWorkspace } from "../lib/workspace";

interface ResourcePickerProps {
  open: boolean;
  type: ResourceType;
  value?: ResourceRef;
  videoMode: VideoMode;
  onClose: () => void;
  onConfirm: (resource: ResourceRef) => void;
}

const titles: Record<ResourceType, string> = {
  video: "选择视频模板",
  style: "选择风格模板",
  cover: "选择封面模板",
  subtitle: "选择字幕模板",
  prompt: "选择提示词模板",
};

export function ResourcePicker({
  open,
  type,
  value,
  videoMode,
  onClose,
  onConfirm,
}: ResourcePickerProps) {
  const { data } = useWorkspace();
  const { message } = App.useApp();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("全部模板");
  const [selectedId, setSelectedId] = useState<string>();
  const [pendingId, setPendingId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const resources =
    data?.resources.filter(
      (resource) =>
        resource.type === type &&
        resource.published &&
        resource.compatibleModes.includes(videoMode),
    ) ?? [];
  const selected = resources.find((resource) => resource.id === selectedId);
  const categories = [
    "全部模板",
    ...new Set(resources.map((resource) => resource.category)),
    "已安装",
  ];
  const filtered = resources.filter(
    (resource) =>
      (category === "全部模板" ||
        (category === "已安装"
          ? resource.installed
          : resource.category === category)) &&
      `${resource.name} ${resource.description}`.includes(search.trim()),
  );

  useEffect(() => {
    if (open) {
      setSelectedId(value?.id);
      setSearch("");
      setCategory("全部模板");
      setPendingId(undefined);
    }
  }, [open, type, value?.id]);

  useEffect(() => {
    if (!open || !pendingId) return;
    const resource = data?.resources.find((item) => item.id === pendingId);
    if (resource?.installed) {
      setPendingId(undefined);
      onConfirm({ id: resource.id, version: resource.version });
    } else if (resource?.downloadStatus === "failed") {
      setPendingId(undefined);
      void message.error("模板下载失败，请重试。");
    }
  }, [data, pendingId, open, onConfirm, message]);

  const useSelected = async () => {
    if (!selected) return;
    if (selected.installed) {
      onConfirm({ id: selected.id, version: selected.version });
      return;
    }
    setBusy(true);
    setPendingId(selected.id);
    try {
      await demoApi.downloadResource(selected.id);
    } catch (error) {
      setPendingId(undefined);
      void message.error(
        error instanceof Error ? error.message : "下载失败，请重试",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={titles[type]}
      open={open}
      onCancel={onClose}
      width={1120}
      destroyOnHidden
      styles={{ body: { maxHeight: "66vh", overflowY: "auto" } }}
      footer={
        <div className="picker-footer">
          <span className="muted">
            资源版本会随任务固定，后续更新不影响已有任务
          </span>
          <div className="button-row">
            <Button onClick={onClose}>取消</Button>
            <Button
              type="primary"
              disabled={!selected}
              loading={busy || !!pendingId}
              onClick={() => void useSelected()}
              icon={
                selected?.installed ? (
                  <Check size={16} />
                ) : (
                  <Download size={16} />
                )
              }
            >
              {selected?.installed ? "使用此模板" : "下载后使用"}
            </Button>
          </div>
        </div>
      }
    >
      <Input
        placeholder="搜索模板名称或风格"
        aria-label="搜索模板"
        prefix={<Search size={16} />}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        allowClear
      />
      <div className="resource-picker-layout">
        <nav className="resource-categories" aria-label="模板分类">
          {categories.map((item) => (
            <button
              type="button"
              className={category === item ? "active" : ""}
              key={item}
              onClick={() => setCategory(item)}
            >
              {item}
            </button>
          ))}
        </nav>
        <div className="resource-picker-grid">
          {filtered.length ? (
            filtered.map((resource) => (
              <button
                type="button"
                key={resource.id}
                className={`resource-tile ${selectedId === resource.id ? "is-selected" : ""}`}
                aria-pressed={selectedId === resource.id}
                disabled={!!pendingId}
                onClick={() => setSelectedId(resource.id)}
              >
                <div className="resource-tile-image">
                  <img
                    src={resource.thumbnail}
                    alt={`${resource.name}模板示意`}
                  />
                  {selectedId === resource.id && (
                    <span className="resource-check">
                      <Check size={15} />
                    </span>
                  )}
                  <span className="resource-type-label">
                    {type === "style"
                      ? "视觉风格"
                      : type === "cover"
                        ? "封面排版"
                        : "视频编排"}
                  </span>
                </div>
                <span className="resource-tile-name">{resource.name}</span>
                <span className="resource-tile-description">
                  {resource.description}
                </span>
                <span className="resource-tile-status">
                  {resource.installed
                    ? "已安装"
                    : resource.downloadStatus === "downloading"
                      ? `下载中 ${resource.downloadProgress}%`
                      : `云端 · ${resource.sizeMb} MB`}
                </span>
              </button>
            ))
          ) : (
            <Empty description="没有匹配的模板" />
          )}
        </div>
        <aside className="resource-preview">
          {selected ? (
            <>
              <div className="resource-preview-image">
                <img src={selected.thumbnail} alt={selected.name} />
                <span>模板示意</span>
              </div>
              <h3>{selected.name}</h3>
              <p>{selected.description}</p>
              <div className="tag-row">
                <Tag>{selected.category}</Tag>
                <Tag>v{selected.version}</Tag>
              </div>
              <p className="muted">
                {type === "video"
                  ? "按模板组织房源镜头、信息卡片与片头片尾。"
                  : type === "style"
                    ? "统一字体、配色、字幕与转场表现。"
                    : "根据房源信息填入封面标题和重点信息。"}
              </p>
              <p className="muted">
                支持{" "}
                {selected.compatibleModes
                  .map((mode) =>
                    mode === "voiceover" ? "纯口播" : "经纪人露脸",
                  )
                  .join(" / ")}
              </p>
              {selected.downloadStatus === "downloading" && (
                <Progress percent={selected.downloadProgress} size="small" />
              )}
              <span className="muted">资源下载与安装均为模拟演示。</span>
            </>
          ) : (
            <Empty description="选择模板以查看预览" />
          )}
        </aside>
      </div>
    </Modal>
  );
}
