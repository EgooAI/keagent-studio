import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { loadEnvFile } from "node:process";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, rm } from "node:fs/promises";

loadEnvFile(".env.local");
assert.equal(
  new URL(process.env.BETTER_AUTH_URL).origin,
  "http://127.0.0.1:18080",
  "Local integration only",
);
assert.equal(
  new URL(process.env.GO_API_URL || "http://127.0.0.1:18081").origin,
  "http://127.0.0.1:18081",
  "Local Go integration only",
);
assert.equal(
  new URL(process.env.CONTROL_API_URL || process.env.BETTER_AUTH_URL).origin,
  "http://127.0.0.1:18080",
  "Local auth integration only",
);
const require = createRequire(import.meta.url);
const { _electron } = require(
  require.resolve("playwright", {
    paths: [dirname(require.resolve("@playwright/test"))],
  }),
);
const fixture = JSON.parse(
  await readFile(
    "packages/shared-types/fixtures/artifact-handoff.v1.json",
    "utf8",
  ),
);
const profile = await mkdtemp(resolve(tmpdir(), "keagent-exchange-check-"));
const desktop = await _electron.launch({
  executablePath: require("electron"),
  args: [
    resolve("apps/desktop/electron/main.cjs"),
    "--built",
    "--hidden",
    `--user-data-dir=${profile}`,
  ],
  env: { ...process.env },
});
try {
  const page = await desktop.firstWindow();
  await page
    .getByLabel("邮箱", { exact: true })
    .fill(process.env.DEV_USER_EMAIL);
  await page
    .getByLabel("密码", { exact: true })
    .fill(process.env.DEV_USER_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.getByRole("button", { name: "退出登录", exact: true }).waitFor();
  const results = await page.evaluate(async (fixture) => {
    const missing = crypto.randomUUID().replaceAll("-", "");
    const asset = fixture.assets[0];
    const calls = [
      ["artifact.list", {}],
      [
        "asset.register",
        {
          requestKey: crypto.randomUUID(),
          fileToken: "../forbidden-path.mp4",
          kind: asset.kind,
          mimeType: asset.mimeType,
          byteSize: asset.byteSize,
          sha256: asset.sha256,
          width: asset.width,
          height: asset.height,
          durationMs: asset.durationMs,
        },
      ],
      ["asset.get", { id: missing }],
      [
        "asset.availability",
        { id: missing, expectedRevision: 1, state: "missing" },
      ],
      [
        "artifact.create",
        {
          requestKey: crypto.randomUUID(),
          source: fixture.artifact.source,
          content: fixture.artifact.content,
          assets: {
            video: missing,
            cover: crypto.randomUUID().replaceAll("-", ""),
          },
        },
      ],
      ["artifact.get", { id: missing }],
      [
        "artifact.review",
        { id: missing, expectedRevision: 1, state: "approved" },
      ],
      [
        "artifactHandoff.create",
        {
          requestKey: crypto.randomUUID(),
          artifactId: missing,
          expectedReviewRevision: 2,
        },
      ],
      ["artifactHandoff.get", { id: missing }],
    ];
    const results = [];
    for (const [operation, input] of calls)
      results.push(await window.desktop.request(operation, [input]));
    return results;
  }, fixture);
  assert.equal(results[0].ok, true);
  assert.ok(Array.isArray(results[0].data.items));
  for (const [index, result] of results.slice(1).entries()) {
    assert.equal(result.ok, false);
    assert.equal(result.error.status, index === 0 ? 422 : 404);
    assert.equal(
      result.error.code,
      index === 0 ? "INVALID_INPUT" : "NOT_FOUND",
    );
  }
  console.log(
    "PASS: real Electron login, all 9 exchange IPC routes and structured errors; no asset writes, generation or platform calls",
  );
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
} finally {
  const page = await desktop.firstWindow().catch(() => null);
  await page?.evaluate(() => window.desktop.request("logout")).catch(() => {});
  await desktop.close();
  assert.ok(profile.startsWith(resolve(tmpdir(), "keagent-exchange-check-")));
  await rm(profile, { recursive: true, force: true, maxRetries: 5 });
}
