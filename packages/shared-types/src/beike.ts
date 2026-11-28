export interface BeikeCondition {
  查询条件: string;
  检索条件: string;
  match_type: string;
}

export interface BeikeHouse {
  id: string;
  title: string;
  totalPriceWan: number;
  unitPrice?: number;
  areaSqm: number;
  layout: string;
  orientation: string;
  community: string;
  district: string;
  metro?: string;
  floor?: string;
  school?: string;
  transaction?: string;
  highlights?: string;
  score?: number;
  status?: string;
  scarcity?: string;
}

export interface BeikeSearchResult {
  city: string;
  query: string;
  totalRecalled: number;
  returned: number;
  conditions: BeikeCondition[];
  strictBudgetWan: number | null;
  houses: BeikeHouse[];
  overBudget: BeikeHouse[];
}

export interface BeikeCommunityInfo {
  name: string;
  communityId: string;
  propertyFee?: string;
  plotRatio?: string;
  greeningRate?: string;
  rentRatio?: string;
  totalUnits?: number;
  buildingCount?: number;
  buildingType?: string;
  builtYears?: string;
}

export interface BeikeHouseDetail extends BeikeHouse {
  description?: string;
  sellingPoints?: string[];
  elevator?: "有" | "无";
  listingUrl?: string;
  vrUrl?: string;
  totalFloors?: string;
  buildingAge?: string;
  builtYear?: string;
  listedAt?: string;
  communityId?: string;
  tags?: string;
  propertyYears?: string;
  listingAge?: string;
  usage?: string;
  heating?: string;
  gas?: string;
  water?: string;
  electricity?: string;
  communityInfo?: BeikeCommunityInfo;
}

export interface BeikeDetailResult {
  city: string;
  returned: number;
  houses: BeikeHouseDetail[];
}
