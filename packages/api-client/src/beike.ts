import { serviceRequest } from "./transport";
import type {
  BeikeDetailResult,
  BeikeSearchResult,
} from "@keagent/shared-types";

function callBeike<T>(method: string, body: unknown): Promise<T> {
  if (window.desktop?.request) {
    return window.desktop.request(method, [body]) as Promise<T>;
  }
  const path =
    method === "beikeCli.search"
      ? "/v1/beike-cli/search"
      : method === "beikeCli.detail"
        ? "/v1/beike-cli/detail"
        : "/v1/beike-cli/status";
  return serviceRequest<T>(path, body);
}

export function searchBeikeHouses(city: string, query: string) {
  return callBeike<BeikeSearchResult>("beikeCli.search", { city, query });
}

export function getBeikeHouseDetail(city: string, ids: string[]) {
  return callBeike<BeikeDetailResult>("beikeCli.detail", { city, ids });
}
