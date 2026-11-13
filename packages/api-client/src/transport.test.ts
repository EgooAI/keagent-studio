import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { authRequest, clearAccessToken, serviceRequest } from "./index";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  clearAccessToken();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("queries own credit usage with an authenticated GET and preserves IPC errors", async () => {
  const range = { from: "2026-11-01", to: "2026-11-13" };
  const usage = { items: [{ op: "script", spent: 5 }], total: 5 };
  fetchMock
    .mockResolvedValueOnce(json({ token: "jwt" }))
    .mockResolvedValueOnce(json(usage));
  await expect(authRequest("credits.usage", [range])).resolves.toEqual(usage);
  expect(String(fetchMock.mock.calls[1][0])).toBe(
    "http://127.0.0.1:18081/v1/credits/usage?from=2026-11-01&to=2026-11-13",
  );
  expect(fetchMock.mock.calls[1][1]).toMatchObject({
    method: "GET",
    body: undefined,
  });
  const request = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, data: usage })
    .mockResolvedValueOnce({
      ok: false,
      error: { message: "日期无效", status: 422 },
    });
  vi.stubGlobal("window", { desktop: { request }, dispatchEvent: vi.fn() });
  await expect(authRequest("credits.usage", [range])).resolves.toEqual(usage);
  expect(request).toHaveBeenCalledWith("credits.usage", [range]);
  await expect(authRequest("credits.usage", [range])).rejects.toMatchObject({
    message: "日期无效",
    status: 422,
  });
});

it("routes voice uploads through authenticated business transport without replaying service failures", async () => {
  fetchMock
    .mockResolvedValueOnce(json({ token: "jwt" }))
    .mockResolvedValueOnce(json({ error: { message: "声音服务未配置" } }, 503));
  await expect(
    authRequest("voice.create", [
      { requestKey: "stable-key", audio: "sample" },
    ]),
  ).rejects.toThrow("声音服务未配置");
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(String(fetchMock.mock.calls[1][0])).toBe(
    "http://127.0.0.1:18081/v1/voices/create",
  );
  expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({
    requestKey: "stable-key",
  });
});

it("rejects public plaintext service URLs", async () => {
  vi.resetModules();
  vi.stubEnv("VITE_GO_API_URL", "http://public.invalid");
  await expect(import("./transport")).rejects.toThrow("HTTPS");
  vi.resetModules();
});

it("rejects malformed tokens and successful non-JSON responses", async () => {
  fetchMock.mockResolvedValueOnce(json({ token: 123 }));
  await expect(serviceRequest("/v1/workspace")).rejects.toThrow("Access Token");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  fetchMock
    .mockResolvedValueOnce(json({ token: "jwt" }))
    .mockResolvedValueOnce(new Response("not JSON"));
  await expect(serviceRequest("/v1/workspace")).rejects.toThrow("无效数据");
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it("shares token exchange and sends JWT directly to Go without cookies", async () => {
  fetchMock.mockImplementation(async (url) =>
    String(url).endsWith("/api/auth/token")
      ? json({ token: "jwt-one" })
      : json({ ok: true }),
  );
  await Promise.all([
    serviceRequest("/v1/workspace"),
    serviceRequest("/v1/session"),
  ]);
  expect(
    fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/token")),
  ).toHaveLength(1);
  for (const [url, options] of fetchMock.mock.calls.slice(1)) {
    expect(String(url)).toMatch(/^http:\/\/127\.0\.0\.1:18081\/v1\//);
    expect(options?.credentials).toBe("omit");
    expect(options?.headers).toMatchObject({ Authorization: "Bearer jwt-one" });
  }
  expect(fetchMock.mock.calls[0][1]?.credentials).toBe("include");
});

it("renews before the five-minute token expires", async () => {
  let clock = 1000;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  fetchMock.mockImplementation(async (url) =>
    String(url).endsWith("/token") ? json({ token: "jwt" }) : json({}),
  );
  await serviceRequest("/v1/session");
  clock += 269000;
  await serviceRequest("/v1/session");
  expect(fetchMock).toHaveBeenCalledTimes(3);
  clock += 2000;
  await serviceRequest("/v1/session");
  expect(fetchMock).toHaveBeenCalledTimes(5);
});

it("refreshes and retries a 401 once, then clears identity", async () => {
  fetchMock
    .mockResolvedValueOnce(json({ token: "old" }))
    .mockResolvedValueOnce(json({}, 401))
    .mockResolvedValueOnce(json({ token: "new" }))
    .mockResolvedValueOnce(json({ error: { message: "revoked" } }, 401));
  await expect(
    serviceRequest("/v1/commands/createProperty", [{}]),
  ).rejects.toThrow("revoked");
  expect(fetchMock).toHaveBeenCalledTimes(4);
  expect(fetchMock.mock.calls[3][1]?.headers).toMatchObject({
    Authorization: "Bearer new",
  });
  expect(window.dispatchEvent).toHaveBeenCalledTimes(1);
});

it("does not replay writes after forbidden, server, or network errors", async () => {
  for (const status of [403, 500, 503]) {
    clearAccessToken();
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(json({ token: "jwt" }))
      .mockResolvedValueOnce(json({}, status));
    await expect(
      serviceRequest("/v1/commands/createProperty", [{}]),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }
  clearAccessToken();
  fetchMock.mockReset();
  fetchMock
    .mockResolvedValueOnce(json({ token: "jwt" }))
    .mockRejectedValueOnce(new Error("offline"));
  await expect(
    serviceRequest("/v1/commands/createProperty", [{}]),
  ).rejects.toThrow("offline");
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("does not restore a token when logout overtakes an exchange", async () => {
  let finish!: (value: Response) => void;
  fetchMock
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce(json({ success: true }));
  const pending = serviceRequest("/v1/workspace");
  const rejected = expect(pending).rejects.toThrow("重新登录");
  await authRequest("logout");
  finish(json({ token: "stale" }));
  await rejected;
  expect(fetchMock).toHaveBeenCalledTimes(2);
  fetchMock
    .mockResolvedValueOnce(json({ token: "fresh" }))
    .mockResolvedValueOnce(json({}));
  await serviceRequest("/v1/workspace");
  expect(fetchMock.mock.calls[3][1]?.headers).toMatchObject({
    Authorization: "Bearer fresh",
  });
});

it("discards an old identity response after account change", async () => {
  let finish!: (value: Response) => void;
  fetchMock
    .mockResolvedValueOnce(json({ token: "old" }))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  const pending = serviceRequest("/v1/workspace");
  const rejected = expect(pending).rejects.toThrow("重新登录");
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  clearAccessToken();
  finish(json({ owner: "previous-user" }));
  await rejected;
});

it("also clears tokens obtained while sign-out is still in flight", async () => {
  let finish!: (value: Response) => void;
  fetchMock
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce(json({ token: "during-logout" }))
    .mockResolvedValueOnce(json({}));
  const logout = authRequest("logout");
  await serviceRequest("/v1/session");
  finish(json({ success: true }));
  await logout;
  fetchMock
    .mockResolvedValueOnce(json({ token: "after-logout" }))
    .mockResolvedValueOnce(json({}));
  await serviceRequest("/v1/session");
  expect(fetchMock).toHaveBeenCalledTimes(5);
  expect(fetchMock.mock.calls[4][1]?.headers).toMatchObject({
    Authorization: "Bearer after-logout",
  });
});
