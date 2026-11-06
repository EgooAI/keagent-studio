import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
const root = mkdtempSync(path.join(os.tmpdir(), "keagent-package-smoke-"));
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(
  path.resolve("release/win-unpacked/KeAgent Studio.exe"),
  ["--smoke-test", "--hidden", `--user-data-dir=${root}`],
  { windowsHide: true, env: environment, stdio: ["ignore", "pipe", "pipe"] },
);
let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk;
});
child.stderr.on("data", (chunk) => {
  output += chunk;
});
const timeout = setTimeout(() => {
  child.kill();
  process.exitCode = 1;
}, 45000);
child.on("error", (error) => {
  clearTimeout(timeout);
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  clearTimeout(timeout);
  if (code !== 0 || !output.includes("Electron renderer verified:")) {
    console.error(
      output || "Packaged application did not reach the login screen",
    );
    process.exitCode = 1;
  } else
    console.log(
      "Packaged Windows client verified: isolated user data, bundled publishing runtime and login renderer.",
    );
  try {
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  } catch {
    /* Chromium may retain temporary locks briefly. */
  }
});
