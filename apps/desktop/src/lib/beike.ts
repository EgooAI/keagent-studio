import type { BeikeHouseDetail, Property } from "@keagent/shared-types";

export type BeikePropertyInput = Pick<
  Property,
  "title" | "community" | "propertyNumber"
> &
  Partial<Property>;

export function supplementBeikeProperty(
  current: Property,
  input: BeikePropertyInput,
): Partial<Property> {
  const details = {
    ...input.details,
    ...current.details,
    listingUrl: input.details?.listingUrl || current.details?.listingUrl,
    vrUrl: current.details?.vrUrl || input.details?.vrUrl,
  };
  return {
    city: input.city,
    district: input.district || current.district,
    details,
    ...(!current.layout || input.layout?.startsWith(current.layout)
      ? { layout: input.layout || current.layout }
      : {}),
    ...(input.description &&
    (!current.description || current.description === current.title)
      ? { description: input.description }
      : {}),
    sellingPoints: [
      ...new Set([...current.sellingPoints, ...(input.sellingPoints ?? [])]),
    ],
  };
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
    description: house.description ?? (house.transaction || house.title),
    sellingPoints:
      house.sellingPoints ??
      (house.highlights || "").split("/").filter(Boolean),
    details: {
      listingUrl: house.listingUrl,
      vrUrl: house.vrUrl,
      floor: house.floor,
      elevator: house.elevator,
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
