// @ts-nocheck
/*
 * Adapted from jackwener/opencli commit 0e73c3c2c2b45c91e050e1618b20e2aba22f1a23.
 * Licensed under Apache-2.0. Modified for AutoUp module imports and TypeScript compilation.
 */
// @ts-nocheck
const CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
export function generateCreationId() {
  const random = Array.from(
    { length: 4 },
    () => CHARS[Math.floor(Math.random() * CHARS.length)],
  ).join("");
  return "pin" + random + Date.now();
}
