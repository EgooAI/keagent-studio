import type { SocialPlatform } from "@keagent/shared-types";

export interface LeadScope {
  accountId: string;
  platform: SocialPlatform;
}

export function leadUrl(
  area: "works" | "review" | "queue" | "todo",
  scope: LeadScope,
  filters: Record<string, string> = {},
) {
  const params = new URLSearchParams({
    accountId: scope.accountId,
    platform: scope.platform,
    ...filters,
  });
  return (area === "todo" ? "/leads" : "/leads/" + area) + "?" + params;
}

export function localTime(value?: string | number | null) {
  return value
    ? new Date(value).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
}
