import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

it("forwards authenticated credit usage and property deletion through Electron", async () => {
  const require = createRequire(import.meta.url);
  const handle = vi.fn();
  const usage = { items: [{ op: "script", spent: 5 }], total: 5 };
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ token: "access-token" }))
    .mockResolvedValueOnce(Response.json(usage))
    .mockResolvedValueOnce(
      Response.json({ error: { message: "日期无效" } }, { status: 422 }),
    );
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
          };
        if (name === "./panorama/workflow.cjs")
          return { PanoramaWorkflow: class {} };
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
  ])
    await expect(
      handler(event, "collection.cloud", [operation]),
    ).rejects.toThrow("接口未开放");
  expect(fetch).toHaveBeenCalledTimes(5);
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
