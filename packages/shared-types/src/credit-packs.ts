export type CreditPackId = "starter" | "regular";

export interface CreditPack {
  id: CreditPackId;
  enabled: boolean;
  credits: number;
  priceFen?: number;
}

export interface CreditPackPilot {
  instructions: string;
  typicalVideoCredits: number;
  packs: CreditPack[];
}

export interface CreditPackStats {
  id: CreditPackId;
  issued: number;
  redeemed: number;
  firstRedeemers: number;
  returningRedeemers: number;
}

export interface CreditPilotQuoteStats {
  sample: number;
  aboveEstimate: number;
  averageEstimate: number;
  averageSettled: number;
  meanAbsoluteDifference: number;
}
