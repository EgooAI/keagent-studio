import type { Property } from "@keagent/shared-types";

export type PropertyFilters = {
  mode: "number" | "conditions";
  propertyNumber?: string;
  search?: string;
  district?: string;
  community?: string;
  material?: string;
  rooms?: string[];
  minPrice?: number;
  maxPrice?: number;
  minArea?: number;
  maxArea?: number;
};

export const initialPropertyFilters: PropertyFilters = { mode: "conditions" };

export function roomType(layout = "") {
  const count = layout.match(
    /([0-9]+|[一二两三四五六七八九十]+)\s*[室房居]/,
  )?.[1];
  if (!count || Number(count) === 0) return layout.trim();
  const names = ["", "一居", "二居", "三居", "四居"];
  const n = /^\d+$/.test(count)
    ? Number(count)
    : "一二三四".indexOf(count === "两" ? "二" : count) + 1;
  return names[n] || "五居及以上";
}

export function invalidPropertyRange(f: PropertyFilters) {
  if (f.mode === "number") return "";
  if (f.minPrice != null && f.maxPrice != null && f.minPrice > f.maxPrice)
    return "最低总价不能高于最高总价";
  if (f.minArea != null && f.maxArea != null && f.minArea > f.maxArea)
    return "最小面积不能大于最大面积";
  return "";
}

export function matchesProperty(p: Property, f: PropertyFilters) {
  if (f.mode === "number")
    return (
      !!f.propertyNumber?.trim() &&
      p.propertyNumber?.trim() === f.propertyNumber.trim()
    );
  const price = p.priceCents / 1_000_000;
  return (
    (!f.search?.trim() ||
      [p.title, p.community, p.propertyNumber, p.city, p.district]
        .join(" ")
        .toLowerCase()
        .includes(f.search.trim().toLowerCase())) &&
    (!f.district || p.district === f.district) &&
    (!f.community || p.community === f.community) &&
    (!f.rooms?.length || f.rooms.includes(roomType(p.layout))) &&
    (f.minPrice == null || price >= f.minPrice) &&
    (f.maxPrice == null || price <= f.maxPrice) &&
    (f.minArea == null || p.areaSqm >= f.minArea) &&
    (f.maxArea == null || p.areaSqm <= f.maxArea)
  );
}
