import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

function desktopIdentity() {
  const require = createRequire(import.meta.url);
  const handle = vi.fn();
  const fetch = vi.fn();
  const unlinkSync = vi.fn();
  const targetStopped = vi.fn();
  const exports = {
    exports: {} as { registerAuth: (onStop: typeof targetStopped) => unknown },
  };
  runInNewContext(
    readFileSync(new URL("./auth.cjs", import.meta.url), "utf8"),
    {
      module: exports,
      __dirname: "/test/electron",
      process: { env: {}, argv: [] },
      URL,
      URLSearchParams,
      AbortSignal,
      fetch,
      require: (name: string) => {
        if (name === "electron")
          return {
            ipcMain: { handle },
            app: { getPath: () => "/test", isPackaged: false, on: vi.fn() },
            safeStorage: {
              isEncryptionAvailable: () => true,
              decryptString: () =>
                JSON.stringify({
                  token: "session-token",
                  deviceId: "test-device",
                }),
            },
            dialog: {},
          };
        if (name === "node:fs")
          return {
            existsSync: (file: string) => file.endsWith("identity.enc"),
            readFileSync: () => "encrypted-test-identity",
            writeFileSync: vi.fn(),
            unlinkSync,
          };
        if (name === "./panorama/workflow.cjs")
          return {
            PanoramaWorkflow: class {
              stop() {}
            },
          };
        return require(name);
      },
    },
  );
  exports.exports.registerAuth(targetStopped);
  const handler = handle.mock.calls.find(
    ([channel]) => channel === "identity:request",
  )![1];
  const frame = { url: "http://127.0.0.1:5173" };
  const event = { senderFrame: frame, sender: { mainFrame: frame } };
  return { handler, event, fetch, targetStopped, unlinkSync };
}

it("keeps desktop credentials on a transient session error and reports confirmed rejection across IPC", async () => {
  const { handler, event, fetch, unlinkSync } = desktopIdentity();
  const session = () => handler(event, "session");
  fetch
    .mockResolvedValueOnce(Response.json({ token: "access-token" }))
    .mockRejectedValueOnce(new TypeError("fetch failed"));
  await expect(session()).resolves.toMatchObject({ error: { status: 0 } });
  fetch
    .mockResolvedValueOnce(Response.json({ id: "test-device" }))
    .mockResolvedValueOnce(Response.json({}, { status: 503 }));
  await expect(session()).resolves.toMatchObject({ error: { status: 503 } });
  fetch
    .mockResolvedValueOnce(Response.json({ id: "test-device" }))
    .mockResolvedValueOnce(Response.json({ userId: "user" }));
  await expect(session()).resolves.toEqual({ userId: "user" });
  expect(unlinkSync).not.toHaveBeenCalled();
  fetch
    .mockResolvedValueOnce(Response.json({}, { status: 401 }))
    .mockResolvedValueOnce(Response.json({}, { status: 401 }));
  await expect(session()).resolves.toMatchObject({ error: { status: 401 } });
  expect(unlinkSync).toHaveBeenCalledTimes(1);
  const calls = fetch.mock.calls.length;
  await expect(session()).resolves.toMatchObject({ error: { status: 401 } });
  expect(fetch).toHaveBeenCalledTimes(calls);
});

it("forwards authenticated credit usage and property deletion through Electron", async () => {
  const { handler, event, fetch, targetStopped } = desktopIdentity();
  const usage = { items: [{ op: "script", spent: 5 }], total: 5 };
  fetch
    .mockResolvedValueOnce(Response.json({ token: "access-token" }))
    .mockResolvedValueOnce(Response.json(usage))
    .mockResolvedValueOnce(
      Response.json({ error: { message: "日期无效" } }, { status: 422 }),
    );
  const args = [{ from: "2026-11-01", to: "2026-11-13" }];
  await expect(handler(event, "credits.usage", args)).resolves.toEqual({
    ok: true,
    data: usage,
  });
  expect(fetch.mock.calls[1]).toEqual([
    "http://127.0.0.1:18081/v1/credits/usage?from=2026-11-01&to=2026-11-13",
    expect.objectContaining({
      method: "GET",
      body: undefined,
      headers: expect.objectContaining({
        Authorization: "Bearer access-token",
      }),
    }),
  ]);
  await expect(handler(event, "credits.usage", args)).resolves.toMatchObject({
    ok: false,
    error: { message: "日期无效", status: 422 },
  });
  fetch.mockResolvedValueOnce(Response.json({ id: "property-1" }));
  await expect(
    handler(event, "deleteProperty", ["property-1"]),
  ).resolves.toEqual({ id: "property-1" });
  expect(fetch.mock.calls[3]).toEqual([
    "http://127.0.0.1:18081/v1/commands/deleteProperty",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify(["property-1"]),
    }),
  ]);
  fetch.mockResolvedValueOnce(Response.json({ items: [] }));
  await expect(
    handler(event, "collection.cloud", ["runs/list", {}]),
  ).resolves.toEqual({
    ok: true,
    data: { items: [] },
  });
  expect(fetch.mock.calls[4]).toEqual([
    "http://127.0.0.1:18081/v1/collection/runs/list",
    expect.objectContaining({
      headers: expect.objectContaining({ "X-Keagent-Device": "test-device" }),
    }),
  ]);
  for (const operation of [
    "runs/claim",
    "runs/finish",
    "../douyin/accounts/list",
    "comments/import",
    "comments/contact",
    "comments/grant",
    "outreach/result",
  ])
    await expect(
      handler(event, "collection.cloud", [operation]),
    ).rejects.toThrow("接口未开放");
  expect(fetch).toHaveBeenCalledTimes(5);
  fetch.mockResolvedValueOnce(
    Response.json({ criteria: "默认", defaultCriteria: "默认" }),
  );
  await expect(
    handler(event, "collection.cloud", ["lead/settings/get", {}]),
  ).resolves.toEqual({
    ok: true,
    data: { criteria: "默认", defaultCriteria: "默认" },
  });
  expect(fetch.mock.calls[5]).toEqual([
    "http://127.0.0.1:18081/v1/collection/lead/settings/get",
    expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ "X-Keagent-Device": "test-device" }),
    }),
  ]);
  const analysisInput = {
    accountId: "4".repeat(32),
    workId: "1234567890",
    criteria: "默认",
    maxComments: 10,
    requestKey: "8".repeat(32),
  };
  fetch.mockResolvedValueOnce(
    Response.json({ id: "analysis-job" }, { status: 202 }),
  );
  await expect(
    handler(event, "collection.cloud", [
      "comments/analyze-batch",
      analysisInput,
    ]),
  ).resolves.toEqual({ ok: true, data: { id: "analysis-job" } });
  expect(fetch.mock.calls[6]).toEqual([
    "http://127.0.0.1:18081/v1/collection/comments/analyze-batch",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify(analysisInput),
      headers: expect.objectContaining({ "X-Keagent-Device": "test-device" }),
    }),
  ]);
  const analysisJobInput = { jobId: "9".repeat(32) };
  fetch.mockResolvedValueOnce(
    Response.json({ id: analysisJobInput.jobId, status: "done" }),
  );
  await expect(
    handler(event, "collection.cloud", [
      "comments/analysis/job",
      analysisJobInput,
    ]),
  ).resolves.toEqual({
    ok: true,
    data: { id: analysisJobInput.jobId, status: "done" },
  });
  expect(fetch.mock.calls[7]).toEqual([
    "http://127.0.0.1:18081/v1/collection/comments/analysis/job",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify(analysisJobInput),
      headers: expect.objectContaining({ "X-Keagent-Device": "test-device" }),
    }),
  ]);
  const analysisListInput = { jobId: analysisJobInput.jobId, limit: 10 };
  fetch.mockResolvedValueOnce(Response.json({ items: [], hasMore: false }));
  await expect(
    handler(event, "collection.cloud", [
      "comments/analysis/list",
      analysisListInput,
    ]),
  ).resolves.toEqual({ ok: true, data: { items: [], hasMore: false } });
  expect(fetch.mock.calls[8]).toEqual([
    "http://127.0.0.1:18081/v1/collection/comments/analysis/list",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify(analysisListInput),
      headers: expect.objectContaining({ "X-Keagent-Device": "test-device" }),
    }),
  ]);
  const outreachListInput = { accountId: "4".repeat(32), limit: 10 };
  fetch.mockResolvedValueOnce(Response.json({ items: [] }));
  await expect(
    handler(event, "collection.cloud", ["outreach/list", outreachListInput]),
  ).resolves.toEqual({ ok: true, data: { items: [] } });
  expect(fetch.mock.calls[9]).toEqual([
    "http://127.0.0.1:18081/v1/collection/outreach/list",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify(outreachListInput),
      headers: expect.objectContaining({ "X-Keagent-Device": "test-device" }),
    }),
  ]);
  const retryDraftInput = { analysisId: "6".repeat(32) };
  fetch.mockResolvedValueOnce(Response.json({ draft: "新的草稿" }));
  await expect(
    handler(event, "collection.cloud", [
      "comments/analysis/retry-draft",
      retryDraftInput,
    ]),
  ).resolves.toEqual({ ok: true, data: { draft: "新的草稿" } });
  expect(fetch).toHaveBeenLastCalledWith(
    "http://127.0.0.1:18081/v1/collection/comments/analysis/retry-draft",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify(retryDraftInput),
      headers: expect.objectContaining({ "X-Keagent-Device": "test-device" }),
    }),
  );
  const scope = { workId: "12345", accountId: "4".repeat(32) };
  for (const [operation, extra] of [
    ["comments/list", { limit: 10 }],
    ["comments/get", { id: "6".repeat(32) }],
    ["comments/sync", { requestKey: "7".repeat(32) }],
    ["comments/analyze", { id: "6".repeat(32) }],
  ] as const) {
    const input = { ...scope, ...extra };
    fetch.mockResolvedValueOnce(Response.json({}));
    await expect(
      handler(event, "collection.cloud", [operation, input]),
    ).resolves.toEqual({ ok: true, data: {} });
    expect(fetch).toHaveBeenLastCalledWith(
      "http://127.0.0.1:18081/v1/collection/" + operation,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(input),
        headers: expect.objectContaining({ "X-Keagent-Device": "test-device" }),
      }),
    );
  }
  const target = { id: "5".repeat(32), expectedVersion: 1 };
  const canceledRunId = "7".repeat(32);
  for (const operation of ["targets/pause", "targets/archive"]) {
    fetch.mockResolvedValueOnce(
      Response.json({ id: target.id, canceledRunId }),
    );
    await expect(
      handler(event, "collection.cloud", [operation, target]),
    ).resolves.toEqual({ ok: true, data: { id: target.id } });
    expect(targetStopped).toHaveBeenLastCalledWith(canceledRunId, 0);
  }
  fetch.mockResolvedValueOnce(Response.json({ id: target.id }));
  await handler(event, "collection.cloud", ["targets/archive", target]);
  fetch.mockResolvedValueOnce(
    Response.json({ message: "目标已更新" }, { status: 409 }),
  );
  await expect(
    handler(event, "collection.cloud", ["targets/pause", target]),
  ).resolves.toMatchObject({ ok: false });
  expect(targetStopped).toHaveBeenCalledTimes(2);
});
