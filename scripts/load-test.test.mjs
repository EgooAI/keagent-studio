import assert from "node:assert/strict";
import { test } from "node:test";
import { runPhase, summarize } from "./load-test.mjs";

test("latency percentiles and rate limits stay separate from unexpected errors", () => {
  const result = summarize(
    [
      { ms: 10, status: 200, ok: true },
      { ms: 20, status: 200, ok: true },
      { ms: 30, status: 429, ok: false },
      { ms: 40, status: 500, ok: false },
    ],
    1000,
  );
  assert.equal(result.p50, 20);
  assert.equal(result.p95, 40);
  assert.equal(result.p99, 40);
  assert.equal(result.rps, 4);
  assert.equal(result.successRps, 2);
  assert.equal(result.rateLimited, 1);
  assert.equal(result.unexpected, 1);
});

test("workers respect concurrency and the request cap, and drain before reporting", async () => {
  let active = 0;
  let peak = 0;
  const result = await runPhase({
    name: "test",
    concurrency: 3,
    durationMs: 1000,
    maxRequests: 9,
    operation: async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((accept) => setTimeout(accept, 5));
      active--;
      return { status: 200, ok: true };
    },
  });
  assert.equal(peak, 3);
  assert.equal(active, 0);
  assert.equal(result.requests, 9);
  assert.equal(result.successful, 9);
});
