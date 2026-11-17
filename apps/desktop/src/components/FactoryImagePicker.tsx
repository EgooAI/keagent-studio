import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Checkbox,
  Empty,
  Image,
  Modal,
  Select,
  Space,
  Spin,
} from "antd";
import { Link } from "react-router-dom";
import { factoryRequest } from "./factoryClient";

export function FactoryImagePicker({
  properties,
  value,
  onConfirm,
  onClose,
}: {
  properties: { id: string; title: string }[];
  value: Record<string, string[]>;
  onConfirm: (value: Record<string, string[]>) => void;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [selection, setSelection] = useState(value);
  const property = properties[index];
  const materials = useQuery({
    queryKey: ["factory-materials", property.id],
    queryFn: () =>
      factoryRequest<{ scenes: { id: string; room: string; url: string }[] }>(
        "materials",
        { propertyId: property.id },
      ),
    retry: false,
  });
  const scenes = materials.data?.scenes || [];
  const selected = selection[property.id] || [];
  useEffect(() => {
    if (!materials.data) return;
    const ids = new Set(materials.data.scenes.map((scene) => scene.id));
    setSelection((current) => ({
      ...current,
      [property.id]: (current[property.id] || []).filter((id) => ids.has(id)),
    }));
  }, [materials.data, property.id]);
  const ready = properties.filter(
    ({ id }) => selection[id]?.length >= 2 && selection[id].length <= 7,
  ).length;
  const update = (ids: string[]) =>
    setSelection((current) => ({ ...current, [property.id]: ids }));
  return (
    <Modal
      open
      centered
      title="选择视频图片"
      width={920}
      onCancel={onClose}
      className="factory-image-modal"
      classNames={{ body: "factory-image-picker" }}
      footer={
        <div className="factory-picker-footer">
          <span role="status">
            已完成 {ready} / {properties.length} 套房源选图
          </span>
          <Space wrap>
            <Button onClick={onClose}>取消</Button>
            <Button
              type="primary"
              disabled={
                ready !== properties.length ||
                materials.isFetching ||
                !!materials.error
              }
              onClick={() =>
                onConfirm(
                  Object.fromEntries(
                    properties.map(({ id }) => [id, selection[id]]),
                  ),
                )
              }
            >
              确认选图
            </Button>
          </Space>
        </div>
      }
    >
      <p className="factory-image-intro">
        每套房源选择 2–7 张 VR
        全景图，按素材原顺序生成文案和视频。同一房源的不同模板共用所选图片。
      </p>
      <Select
        aria-label="选图房源"
        className="factory-image-property"
        value={index}
        onChange={setIndex}
        options={properties.map((p, i) => ({
          value: i,
          label: `${p.title} · 已选 ${selection[p.id]?.length || 0} 张`,
        }))}
      />
      <div className="factory-image-toolbar">
        <strong aria-live="polite">当前已选 {selected.length} / 7 张</strong>
        <Space wrap>
          <Button
            disabled={
              materials.isFetching ||
              !!materials.error ||
              scenes.length < 2 ||
              scenes.length > 7
            }
            onClick={() => update(scenes.map((s) => s.id))}
          >
            选择全部
          </Button>
          <Button disabled={!selected.length} onClick={() => update([])}>
            清空选择
          </Button>
          <Link
            to={`/properties/${encodeURIComponent(property.id)}`}
            onClick={onClose}
          >
            补充全景素材
          </Link>
        </Space>
      </div>
      {materials.isPending ? (
        <Spin description="正在读取全景素材">
          <div className="factory-image-loading" />
        </Spin>
      ) : materials.error ? (
        <Alert
          type="error"
          title="素材读取失败"
          description={materials.error.message}
          action={
            <Button onClick={() => void materials.refetch()}>重试</Button>
          }
        />
      ) : (
        <>
          {scenes.length < 2 && (
            <Alert type="warning" title="至少需要 2 张全景图，请先补充素材。" />
          )}
          {selected.length === 7 && (
            <p className="muted">已选满 7 张，如需更换请先取消一张。</p>
          )}
          {!scenes.length ? (
            <Empty description="暂无 VR 全景图" />
          ) : (
            <Image.PreviewGroup
              classNames={{
                popup: {
                  root: "factory-scene-preview",
                  mask: "factory-scene-preview-mask",
                },
              }}
              preview={{
                countRender: (current, total) => (
                  <span className="factory-scene-caption">
                    <span>{scenes[current - 1]?.room}</span>
                    <bdi>
                      {current} / {total}
                    </bdi>
                  </span>
                ),
              }}
            >
              <div className="factory-image-grid">
                {scenes.map((scene, i) => (
                  <div
                    key={scene.id}
                    className={`factory-image-option ${selected.includes(scene.id) ? "is-selected" : ""}`}
                  >
                    <Image src={scene.url} alt={scene.room} loading="lazy" />
                    <Checkbox
                      checked={selected.includes(scene.id)}
                      disabled={
                        materials.isFetching ||
                        (selected.length >= 7 && !selected.includes(scene.id))
                      }
                      onChange={(e) =>
                        update(
                          e.target.checked
                            ? [...selected, scene.id]
                            : selected.filter((id) => id !== scene.id),
                        )
                      }
                    >
                      {i + 1}. {scene.room}
                    </Checkbox>
                  </div>
                ))}
              </div>
            </Image.PreviewGroup>
          )}
        </>
      )}
      {properties.length > 1 && (
        <div className="factory-template-pager">
          <Button disabled={index === 0} onClick={() => setIndex(index - 1)}>
            上一套房源
          </Button>
          <span>
            {index + 1} / {properties.length}
          </span>
          <Button
            disabled={index === properties.length - 1}
            onClick={() => setIndex(index + 1)}
          >
            下一套房源
          </Button>
        </div>
      )}
    </Modal>
  );
}
