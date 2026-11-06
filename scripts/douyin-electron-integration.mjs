import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);
const testRoot = mkdtempSync(
  path.join(os.tmpdir(), "keagent-douyin-electron-"),
);
const environment = { ...process.env, DOUYIN_TEST_ROOT: testRoot };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(
  require("electron"),
  ["scripts/douyin-electron-fixture.cjs", "--built"],
  { stdio: "inherit", windowsHide: true, env: environment },
);
const timeout = setTimeout(() => {
  child.kill();
  process.exitCode = 1;
}, 60000);
child.on("exit", (code) => {
  clearTimeout(timeout);
  process.exitCode = code ?? 1;
  try {
    rmSync(testRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  } catch {
    /* Windows can retain Chromium locks briefly after exit. */
  }
});
