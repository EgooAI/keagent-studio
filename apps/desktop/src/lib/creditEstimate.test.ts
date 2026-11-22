import { expect, it } from "vitest";
import {
  estimateBatchCost,
  estimateSummaryText,
  type CreditPricing,
} from "./creditEstimate";
const pricing: CreditPricing = {
  version: "default",
  prices: {
    opening: 100,
    voice_clone: 200,
    script: 5,
    tts_per_kilo_char: 10,
    image_expand: 0,
  },
};

it("estimates per-task cost from current prices", () => {
  const estimate = estimateBatchCost(pricing, 3);
  expect(estimate).toBeDefined();
  // 文案 5 + 配音 10（600 字按 1 个千字计）
  expect(estimate?.perTask).toBe(15);
  expect(estimate?.total).toBe(45);
  expect(estimate?.items.map((item) => item.label)).toEqual(["文案", "配音"]);
});

it("rounds the narration estimate up to whole kilo-char units", () => {
  const estimate = estimateBatchCost(pricing, 1, 1001);
  expect(estimate?.perTask).toBe(25);
});

it("returns no estimate without pricing, tasks or chargeable items", () => {
  expect(estimateBatchCost(undefined, 3)).toBeUndefined();
  expect(estimateBatchCost(pricing, 0)).toBeUndefined();
  const free: CreditPricing = { version: "v0", prices: {} };
  expect(estimateBatchCost(free, 3)).toBeUndefined();
});

it("renders a summary line with the breakdown", () => {
  const estimate = estimateBatchCost(pricing, 2);
  expect(estimate && estimateSummaryText(estimate)).toBe(
    "预计消耗约 30 积分（每条 15：文案 5 + 配音 10）",
  );
});
