import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

it("forwards credit usage through Electron with the date range and error envelope", async () => {
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
  const exports = { exports: {} as { registerAuth: () => unknown } };
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
  exports.exports.registerAuth();
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
});
