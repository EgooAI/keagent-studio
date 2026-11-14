import type { BeikeHouse, Property } from "@keagent/shared-types";

export type BeikePropertyInput = Pick<
  Property,
  "title" | "community" | "propertyNumber"
> &
  Partial<Property>;

// 把贝壳 search 返回的房源摘要映射成 createProperty 的入参。
// 总价单位是「万元」，Property.priceCents 是「分」：1 万 = 1,000,000 分。
export function beikeHouseToPropertyInput(
  house: BeikeHouse,
  city: string,
): BeikePropertyInput {
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
      transactionAttributes: house.transaction,
      listingStatus: house.status === "在售" ? "在售" : undefined,
    },
    image: "",
    images: [],
  };
}
