import type { BeikeHouseDetail, Property } from "@keagent/shared-types";
import beikeCityPaths from "./beike-city-paths.json";

export type BeikePropertyInput = Pick<
  Property,
  "title" | "community" | "propertyNumber"
> &
  Partial<Property>;

export function propertyListingUrl(property: Property) {
  const savedUrl = property.details?.listingUrl?.trim();
  if (savedUrl) return savedUrl;

  // 城市路径取自贝壳移动站城市目录 https://m.ke.com/city/
  const city = property.city.trim().replace(/市$/, "");
  const path = (beikeCityPaths as Record<string, string>)[city];
  const number = property.propertyNumber.trim();
  if (typeof path === "string" && /^\d+$/.test(number)) {
    return `https://m.ke.com/${path}/ershoufang/${number}.html`;
  }
}

// 总价单位是「万元」，Property.priceCents 是「分」：1 万 = 1,000,000 分。
export function beikeHouseToPropertyInput(
  house: BeikeHouseDetail,
  city: string,
): BeikePropertyInput {
  const { status } = house;
  return {
    title: house.title,
    community: house.community,
    propertyNumber: house.id,
    city,
    district: house.district,
    priceCents: Math.round(house.totalPriceWan * 1_000_000),
    areaSqm: house.areaSqm,
    layout: house.layout,
    description: house.transaction || house.title,
    sellingPoints: (house.highlights || "").split("/").filter(Boolean),
    details: {
      floor: house.floor,
      orientation: house.orientation,
      buildingAge: house.builtYear || house.buildingAge,
      transactionAttributes: house.transaction,
      listingStatus:
        status === "在售" || status === "已成交" || status === "已下架"
          ? status
          : undefined,
    },
    image: "",
    images: [],
  };
}
