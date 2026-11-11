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
  const estimate = estimateBatchCost(pricing, { tasks: 3, withOpening: false });
  expect(estimate).toBeDefined();
  // 文案 5 + 配音 10（600 字按 1 个千字计）
  expect(estimate?.perTask).toBe(15);
  expect(estimate?.total).toBe(45);
  expect(estimate?.items.map((item) => item.label)).toEqual(["文案", "配音"]);
});

it("adds the opening charge when the batch uses MiniMax openings", () => {
  const estimate = estimateBatchCost(pricing, { tasks: 2, withOpening: true });
  expect(estimate?.perTask).toBe(115);
  expect(estimate?.total).toBe(230);
  expect(estimate?.items.map((item) => item.label)).toEqual([
    "文案",
    "配音",
    "开场",
  ]);
});

it("rounds the narration estimate up to whole kilo-char units", () => {
  const estimate = estimateBatchCost(
    pricing,
    { tasks: 1, withOpening: false },
    1001,
  );
  expect(estimate?.perTask).toBe(25);
});

it("returns no estimate without pricing, tasks or chargeable items", () => {
  expect(estimateBatchCost(undefined, { tasks: 3, withOpening: true })).toBeUndefined();
  expect(estimateBatchCost(pricing, { tasks: 0, withOpening: true })).toBeUndefined();
  const free: CreditPricing = { version: "v0", prices: {} };
  expect(estimateBatchCost(free, { tasks: 3, withOpening: true })).toBeUndefined();
});

it("renders a summary line with the breakdown", () => {
  const estimate = estimateBatchCost(pricing, { tasks: 2, withOpening: true });
  expect(estimate && estimateSummaryText(estimate)).toBe(
    "预计消耗约 230 积分（每条 115：文案 5 + 配音 10 + 开场 100）",
  );
});
