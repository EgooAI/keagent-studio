import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
const root = mkdtempSync(path.join(os.tmpdir(), "keagent-package-smoke-"));
const executable = path.resolve(
  process.argv[2] || "release/win-unpacked/KeAgent Studio.exe",
);
const origin = process.env.KEAGENT_PUBLIC_ORIGIN;
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
if (origin) {
  // Exercise the installation defaults on this machine.
  for (const key of [
    "CONTROL_API_URL",
    "GO_API_URL",
    "FFMPEG_PATH",
    "FFPROBE_PATH",
    "KEAGENT_PUBLIC_ORIGIN",
  ])
    delete environment[key];
}

try {
  const result = spawnSync(
    executable,
    ["--smoke-test", "--hidden", `--user-data-dir=${root}`],
    {
      // The tray check explicitly shows the GUI; SW_HIDE overrides its first ShowWindow on Windows.
      windowsHide: false,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 45000,
      killSignal: "SIGKILL",
    },
  );
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  const lines = output.split(/\r?\n/);
  const renderer = lines.find((line) =>
    line.startsWith("Electron renderer verified: "),
  );
  const release = lines.includes(`Desktop release verified: ${origin}`);
  if (
    result.error ||
    result.status !== 0 ||
    !renderer ||
    (origin && (!release || !renderer.includes("登录")))
  ) {
    console.error(result.error?.message || output || "Packaged app failed");
    process.exitCode = 1;
  } else {
    console.log(
      origin
        ? `Packaged desktop verified: login screen, ${origin}, FFmpeg and FFprobe.`
        : "Packaged desktop renderer verified with isolated user data.",
    );
  }
} finally {
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
}
