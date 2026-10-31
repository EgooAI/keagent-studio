import { useEffect, useMemo, useState } from "react";
import {
  App,
  Button,
  Checkbox,
  Empty,
  Input,
  Modal,
  Pagination,
  Tabs,
  Tag,
} from "antd";
import { Search } from "lucide-react";
import type { Property } from "@keagent/shared-types";
import { useWorkspace } from "../lib/workspace";
import { formatPrice } from "./common";

interface PropertyPickerProps {
  open: boolean;
  value: string[];
  onClose: () => void;
  onConfirm: (ids: string[]) => void;
}

export function PropertyPicker({
  open,
  value,
  onClose,
  onConfirm,
}: PropertyPickerProps) {
  const { data } = useWorkspace();
  const { message } = App.useApp();
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState("all");
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState<Property>();

  useEffect(() => {
    if (open) {
      setSelected([...value]);
      setSearch("");
      setTab("all");
      setPage(1);
    }
  }, [open, value]);

  const published = useMemo(() => {
    const taskIds = new Set(
      data?.publishTasks
        .filter((task) => task.status === "published")
        .map((task) => task.productionTaskId),
    );
    return new Set(
      data?.tasks
        .filter((task) => taskIds.has(task.id))
        .map((task) => task.propertyId),
    );
  }, [data]);
  const properties = data?.properties ?? [];
  const matched = properties.filter((property) =>
    `${property.title} ${property.community} ${property.propertyNumber} ${property.district}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );
  const filtered = matched.filter(
    (property) =>
      tab === "all" ||
      (tab === "published"
        ? published.has(property.id)
        : !published.has(property.id)),
  );
  const shown = filtered.slice((page - 1) * 6, page * 6);
  const toggle = (id: string) =>
    setSelected((previous) =>
      previous.includes(id)
        ? previous.filter((item) => item !== id)
        : [...previous, id],
    );
  const confirm = () => {
    const unavailable = selected.filter(
      (id) =>
        !properties.some(
          (property) => property.id === id && property.importStatus === "ready",
        ),
    );
    if (unavailable.length) {
      void message.warning(
        "所选房源中有素材不完整或已失效的房源，请取消选择或先补充素材。",
      );
      return;
    }
    onConfirm(selected);
  };

  return (
    <>
      <Modal
        title="选择房源"
        open={open}
        onCancel={onClose}
        width={1100}
        destroyOnHidden
        styles={{ body: { maxHeight: "64vh", overflowY: "auto" } }}
        footer={
          <div className="picker-footer">
            <span>
              已选择 <strong>{selected.length}</strong> 套房源
            </span>
            <div className="button-row">
              <Button type="text" onClick={() => setSelected([])}>
                清空选择
              </Button>
              <Button onClick={onClose}>取消</Button>
              <Button type="primary" onClick={confirm}>
                确认选择{selected.length ? `（${selected.length}）` : ""}
              </Button>
            </div>
          </div>
        }
      >
        <Input
          aria-label="搜索房源"
          placeholder="搜索房源号、小区、标题或区域"
          prefix={<Search size={16} />}
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }}
          allowClear
        />
        <Tabs
          activeKey={tab}
          onChange={(next) => {
            setTab(next);
            setPage(1);
          }}
          items={[
            { key: "all", label: `全部（${matched.length}）` },
            {
              key: "published",
              label: `已发布过（${matched.filter((property) => published.has(property.id)).length}）`,
            },
            {
              key: "unpublished",
              label: `未发布过（${matched.filter((property) => !published.has(property.id)).length}）`,
            },
          ]}
        />
        <div className="picker-toolbar">
          <Checkbox
            checked={
              filtered.length > 0 &&
              filtered.every((property) => selected.includes(property.id))
            }
            indeterminate={
              filtered.some((property) => selected.includes(property.id)) &&
              !filtered.every((property) => selected.includes(property.id))
            }
            onChange={(event) =>
              setSelected((previous) =>
                event.target.checked
                  ? [
                      ...new Set([
                        ...previous,
                        ...filtered.map((property) => property.id),
                      ]),
                    ]
                  : previous.filter(
                      (id) => !filtered.some((property) => property.id === id),
                    ),
              )
            }
          >
            全选当前筛选结果
          </Checkbox>
          <span className="muted">
            共 {filtered.length} 套 · 跨分类保留选择
          </span>
        </div>
        {shown.length ? (
          <div className="property-picker-grid">
            {shown.map((property) => (
              <article
                className={`property-choice ${selected.includes(property.id) ? "is-selected" : ""}`}
                key={property.id}
              >
                <button
                  type="button"
                  className="property-choice-image"
                  onClick={() => toggle(property.id)}
                  aria-label={`选择${property.title}`}
                  aria-pressed={selected.includes(property.id)}
                >
                  <img src={property.image} alt={property.title} />
                  <span className="property-choice-badge">
                    {published.has(property.id) ? "已发布过" : "未发布过"}
                  </span>
                </button>
                <div className="property-choice-body">
                  <Checkbox
                    checked={selected.includes(property.id)}
                    onChange={() => toggle(property.id)}
                  >
                    {property.community}
                  </Checkbox>
                  <p>
                    {property.layout} · {property.areaSqm} ㎡ ·{" "}
                    {property.district}
                  </p>
                  <div className="property-choice-meta">
                    <strong>{formatPrice(property.priceCents)}</strong>
                    <Button
                      type="link"
                      size="small"
                      onClick={() => setDetail(property)}
                    >
                      查看详情
                    </Button>
                  </div>
                  <div className="muted">
                    房源号 {property.propertyNumber}{" "}
                    {property.importStatus !== "ready" && (
                      <Tag color="orange">素材不足</Tag>
                    )}
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <Empty description="没有符合条件的房源，试试其他关键词" />
        )}
        <Pagination
          className="picker-pagination"
          current={page}
          pageSize={6}
          total={filtered.length}
          showSizeChanger={false}
          onChange={setPage}
          hideOnSinglePage
        />
      </Modal>
      <Modal
        open={!!detail}
        title="房源资料"
        footer={<Button onClick={() => setDetail(undefined)}>返回选择</Button>}
        onCancel={() => setDetail(undefined)}
      >
        {detail && (
          <div className="property-inline-detail">
            <img
              src={detail.image}
              alt={detail.title}
              style={{ width: "100%", borderRadius: 10 }}
            />
            <h3>{detail.title}</h3>
            <p>
              {detail.layout} · {detail.areaSqm} ㎡ · {detail.district} ·{" "}
              {formatPrice(detail.priceCents)}
            </p>
            <p>{detail.description}</p>
            <p className="muted">
              房源号 {detail.propertyNumber} · {detail.videoCount} 段视频素材
            </p>
          </div>
        )}
      </Modal>
    </>
  );
}
