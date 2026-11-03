import assert from "node:assert/strict";
import { test } from "node:test";
import { GET } from "../app/v1/[...path]/route.js";

test("legacy gateway can close without requiring auth or a shared secret", async () => {
  const previousMode = process.env.ALLOW_LEGACY_GATEWAY;
  const previousSecret = process.env.INTERNAL_API_SECRET;
  try {
    process.env.ALLOW_LEGACY_GATEWAY = "false";
    delete process.env.INTERNAL_API_SECRET;
    const request = new Request("http://127.0.0.1:18080/v1/workspace");
    assert.equal((await GET(request)).status, 410);
    process.env.ALLOW_LEGACY_GATEWAY = "true";
    assert.equal((await GET(request)).status, 503);
  } finally {
    if (previousMode === undefined) delete process.env.ALLOW_LEGACY_GATEWAY;
    else process.env.ALLOW_LEGACY_GATEWAY = previousMode;
    if (previousSecret === undefined) delete process.env.INTERNAL_API_SECRET;
    else process.env.INTERNAL_API_SECRET = previousSecret;
  }
});
