import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
const { desktopConfig } = require("./desktop-config.cjs");

it("keeps a validated revision across restarts, rejected revisions and network failures", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "laike-config-"));
  const request = vi.fn();
  const read = () =>
    desktopConfig("https://updates.example", directory, request)();
  const config = {
    revision: 2,
    catalogRefreshSeconds: 40,
    renderDefaults: { rate: 1.3 },
  };
  try {
    request.mockResolvedValueOnce(Response.json(config));
    expect(await read()).toEqual(config);
    for (const invalid of [
      { ...config, revision: 1, renderDefaults: {} },
      { ...config, revision: 3, renderDefaults: { rate: 99 } },
      { ...config, revision: 3, renderDefaults: { script: "invalid" } },
    ]) {
      request.mockResolvedValueOnce(Response.json(invalid));
      expect(await read()).toEqual(config);
    }
    request.mockRejectedValueOnce(new Error("offline"));
    expect(await read()).toEqual(config);
  } finally {
    fs.rmSync(path.join(directory, "desktop-config-v1.json"), { force: true });
    fs.rmdirSync(directory);
  }
});
