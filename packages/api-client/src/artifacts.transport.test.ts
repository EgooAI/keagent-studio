import { afterEach, expect, it, vi } from "vitest";
import { artifactExchange } from "./artifacts";
import {
  authRequest,
  clearAccessToken,
  ServiceRequestError,
} from "./transport";

afterEach(() => {
  clearAccessToken();
  vi.unstubAllGlobals();
});

it("routes browser exchange operations through authenticated fixed endpoints", async () => {
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
  const sent: { url: string; body?: string; authorization: string | null }[] =
    [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (url.endsWith("/api/auth/token"))
      return Response.json({ token: "fixture-access-token" });
    sent.push({
      url,
      body: init.body as string,
      authorization: new Headers(init.headers).get("Authorization"),
    });
    return Response.json({ items: [], total: 0, limit: 20, offset: 0 });
  });
  await artifactExchange.listArtifacts({ review: "approved" });
  expect(sent).toEqual([
    {
      url: "http://127.0.0.1:18081/v1/artifacts/list",
      body: '{"review":"approved"}',
      authorization: "Bearer fixture-access-token",
    },
  ]);
});

it("preserves conflict codes from the browser response", async () => {
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
  vi.stubGlobal("fetch", async (url: string) =>
    url.endsWith("/api/auth/token")
      ? Response.json({ token: "fixture-access-token" })
      : Response.json(
          { error: { message: "请恢复文件", code: "ASSET_UNAVAILABLE" } },
          { status: 409 },
        ),
  );
  await expect(
    artifactExchange.createHandoff({
      requestKey: "fixture-request-0001",
      artifactId: "b".repeat(32),
      expectedReviewRevision: 2,
    }),
  ).rejects.toMatchObject({
    name: "ServiceRequestError",
    status: 409,
    code: "ASSET_UNAVAILABLE",
  });
});

it("unwraps desktop exchange envelopes and preserves HTTP status/code", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, data: { id: "fixture-id" } })
    .mockResolvedValueOnce({
      ok: false,
      error: {
        message: "需要刷新验收状态",
        status: 409,
        code: "REVISION_CONFLICT",
      },
    });
  vi.stubGlobal("window", { desktop: { request } });
  expect(await artifactExchange.getArtifact("b".repeat(32))).toEqual({
    id: "fixture-id",
  });
  const error = await artifactExchange
    .reviewArtifact({
      id: "b".repeat(32),
      expectedRevision: 1,
      state: "approved",
    })
    .catch((error: unknown) => error);
  expect(error).toBeInstanceOf(ServiceRequestError);
  expect(error).toMatchObject({ status: 409, code: "REVISION_CONFLICT" });
  expect(request.mock.calls[0]).toEqual([
    "artifact.get",
    [{ id: "b".repeat(32) }],
  ]);
});

it("retains the existing raw IPC format for non-exchange operations", async () => {
  vi.stubGlobal("window", {
    desktop: { request: async () => ({ userId: "fixture-owner" }) },
  });
  expect(await authRequest("session")).toEqual({ userId: "fixture-owner" });
});
