import { queryOptions } from "@tanstack/react-query";
import { authRequest } from "@keagent/api-client";

export interface CreditSummary {
  purchased?: { available?: number; held?: number };
  granted?: { available?: number; held?: number; nextExpiry?: string };
  ledger?: {
    kind: string;
    amount: number;
    op: string;
    refId: string;
    metadata?: { note?: string; spent?: number };
    createdAt: string;
  }[];
}

export const creditSummaryQuery = queryOptions({
  queryKey: ["credits-summary"],
  queryFn: () => authRequest<CreditSummary>("credits.summary"),
  retry: false,
  staleTime: 15_000,
});
