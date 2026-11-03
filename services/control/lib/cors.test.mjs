import assert from "node:assert/strict";
import { test } from "node:test";
import { authResponse } from "./cors.mjs";

test("auth CORS preserves cookies and rejects untrusted origins and headers", async () => {
  const handler = () =>
    Response.json(
      { ok: true },
      { headers: { "Set-Cookie": "session=protected; HttpOnly" } },
    );
  const origin = "http://127.0.0.1:5174";
  const response = await authResponse(
    new Request("http://127.0.0.1:18080/api/auth/token", {
      headers: { Origin: origin },
    }),
    handler,
  );
  assert.equal(response.headers.get("access-control-allow-origin"), origin);
  assert.equal(
    response.headers.get("access-control-allow-credentials"),
    "true",
  );
  assert.match(response.headers.get("set-cookie"), /HttpOnly/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  for (const [source, headers, status] of [
    [origin, "content-type", 204],
    ["http://evil.invalid", "content-type", 403],
    [origin, "x-keagent-context", 403],
  ]) {
    const result = await authResponse(
      new Request("http://127.0.0.1:18080/api/auth/token", {
        method: "OPTIONS",
        headers: {
          Origin: source,
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": headers,
        },
      }),
      () => {
        throw new Error("preflight reached auth handler");
      },
    );
    assert.equal(result.status, status);
  }
});
