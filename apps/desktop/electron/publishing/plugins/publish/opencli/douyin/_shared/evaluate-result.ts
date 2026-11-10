// @ts-nocheck
/*
 * Adapted from jackwener/opencli commit 0e73c3c2c2b45c91e050e1618b20e2aba22f1a23.
 * Licensed under Apache-2.0. Modified for AutoUp module imports and TypeScript compilation.
 */
// @ts-nocheck
export function unwrapEvaluateResult(payload) {
  if (
    payload &&
    !Array.isArray(payload) &&
    typeof payload === "object" &&
    "session" in payload &&
    "data" in payload
  ) {
    return payload.data;
  }
  return payload;
}
