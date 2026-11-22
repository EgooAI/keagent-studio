// 建批次时的积分预估：仅展示用途，实际扣费发生在云端各调用点。
// 文案尚未生成，按经验值估算每条视频的口播字数。
export const ESTIMATED_CHARS_PER_VIDEO = 600;

export interface CreditPricing {
  prices: Record<string, number>;
  version: string;
}

export interface BatchCostEstimate {
  perTask: number;
  total: number;
  items: { label: string; amount: number }[];
}

function ceilKilo(chars: number) {
  return Math.ceil(chars / 1000);
}

export function estimateBatchCost(
  pricing: CreditPricing | undefined,
  tasks: number,
  estimatedChars: number = ESTIMATED_CHARS_PER_VIDEO,
): BatchCostEstimate | undefined {
  if (!pricing || tasks <= 0) return undefined;
  const { prices } = pricing;
  const script = prices.script ?? 0;
  const tts = (prices.tts_per_kilo_char ?? 0) * ceilKilo(estimatedChars);
  if (script + tts <= 0) return undefined;
  const items = [
    { label: "文案", amount: script },
    { label: "配音", amount: tts },
  ].filter((item) => item.amount > 0);
  const perTask = script + tts;
  return { perTask, total: perTask * tasks, items };
}

export function estimateBreakdownText(estimate: BatchCostEstimate) {
  return estimate.items
    .map((item) => `${item.label} ${item.amount}`)
    .join(" + ");
}

export function estimateSummaryText(estimate: BatchCostEstimate) {
  return `预计消耗约 ${estimate.total} 积分（每条 ${estimate.perTask}：${estimateBreakdownText(estimate)}）`;
}
