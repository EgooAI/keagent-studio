import { useMemo, type ReactNode } from "react";
import { Button, Input, InputNumber, Segmented, Select } from "antd";
import type { Property } from "@keagent/shared-types";
import {
  invalidPropertyRange,
  roomType,
  type PropertyFilters,
} from "../lib/propertyFilters";
import "./property-search-filters.css";

function options(values: string[]) {
  return [...new Set(values.filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }))
    .map((value) => ({ label: value, value }));
}

export function PropertySearchFilters({
  value,
  onChange,
  inventory,
  disabled,
  children,
}: {
  value: PropertyFilters;
  onChange: (filters: PropertyFilters) => void;
  inventory: Property[];
  disabled?: boolean;
  children?: ReactNode;
}) {
  const facets = useMemo(
    () => ({
      districts: options(inventory.map((p) => p.district)),
      communities: options(
        inventory
          .filter((p) => !value.district || p.district === value.district)
          .map((p) => p.community),
      ),
      rooms: options(inventory.map((p) => roomType(p.layout))),
    }),
    [inventory, value.district],
  );
  const update = (fields: Partial<PropertyFilters>) =>
    onChange({ ...value, ...fields });
  const rangeError = invalidPropertyRange(value);
  function range(
    label: string,
    from: "minPrice" | "minArea",
    to: "maxPrice" | "maxArea",
    first: string,
    last: string,
  ) {
    return (
      <div role="group" aria-label={label} className="property-filter-field">
        <span>{label}</span>
        <div className="property-filter-range">
          <InputNumber
            aria-label={first}
            placeholder="最低"
            min={0}
            value={value[from] ?? null}
            onChange={(n) => update({ [from]: n ?? undefined })}
            disabled={disabled}
          />
          <span>至</span>
          <InputNumber
            aria-label={last}
            placeholder="最高"
            min={0}
            value={value[to] ?? null}
            onChange={(n) => update({ [to]: n ?? undefined })}
            disabled={disabled}
          />
        </div>
      </div>
    );
  }
  return (
    <div className="property-search-filters">
      <div className="property-filter-modes">
        <Segmented<PropertyFilters["mode"]>
          aria-label="房源查找方式"
          value={value.mode}
          disabled={disabled}
          options={[
            { value: "number", label: "按房源号查找" },
            { value: "conditions", label: "按条件筛选" },
          ]}
          onChange={(mode) => onChange({ mode })}
        />
        {value.mode === "conditions" && (
          <Button
            type="text"
            size="small"
            disabled={disabled}
            onClick={() => onChange({ mode: "conditions" })}
          >
            重置条件
          </Button>
        )}
      </div>
      {value.mode === "number" ? (
        <Input
          className="property-number-input"
          aria-label="完整房源号"
          placeholder="输入完整房源号"
          allowClear
          disabled={disabled}
          value={value.propertyNumber ?? ""}
          onChange={(e) => update({ propertyNumber: e.target.value })}
        />
      ) : (
        <div className="property-condition-grid">
          <label className="property-filter-field">
            <span>关键词</span>
            <Input
              aria-label="搜索房源"
              placeholder="标题、小区、城市或编号"
              allowClear
              disabled={disabled}
              value={value.search ?? ""}
              onChange={(e) => update({ search: e.target.value })}
            />
          </label>
          <label className="property-filter-field">
            <span>区域</span>
            <Select
              aria-label="区域"
              placeholder="全部区域"
              allowClear
              showSearch
              disabled={disabled}
              value={value.district}
              options={facets.districts}
              onChange={(district) =>
                update({ district, community: undefined })
              }
            />
          </label>
          <label className="property-filter-field">
            <span>小区</span>
            <Select
              aria-label="小区"
              placeholder="输入或选择小区"
              allowClear
              showSearch
              disabled={disabled}
              value={value.community}
              options={facets.communities}
              onChange={(community) => update({ community })}
            />
          </label>
          <label className="property-filter-field">
            <span>户型</span>
            <Select
              aria-label="户型"
              mode="multiple"
              placeholder="全部户型"
              allowClear
              disabled={disabled}
              value={value.rooms ?? []}
              options={facets.rooms}
              onChange={(rooms) => update({ rooms })}
            />
          </label>
          {range(
            "总价（万元）",
            "minPrice",
            "maxPrice",
            "最低总价",
            "最高总价",
          )}
          {range("面积（㎡）", "minArea", "maxArea", "最小面积", "最大面积")}
          {children}
        </div>
      )}
      {rangeError && <small role="alert">{rangeError}</small>}
    </div>
  );
}
