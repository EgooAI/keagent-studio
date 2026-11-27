import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
const root = mkdtempSync(path.join(os.tmpdir(), "keagent-package-smoke-"));
const executable = path.resolve(
  process.argv[2] || "release/win-unpacked/AI来客.exe",
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
  const resources =
    process.platform === "darwin"
      ? path.resolve(path.dirname(executable), "../Resources")
      : path.join(path.dirname(executable), "resources");
  if (process.env.KEAGENT_UPDATE_ORIGIN) {
    const updateOrigin = new URL(process.env.KEAGENT_UPDATE_ORIGIN).origin;
    const feed = `${updateOrigin}/desktop-updates/${process.platform}-${process.arch}/`;
    const config = readFileSync(path.join(resources, "app-update.yml"), "utf8");
    if (!config.split(/\r?\n/).includes(`url: ${feed}`))
      throw new Error(`Packaged updater is missing the expected feed: ${feed}`);
  }
  const worker = path.join(
    resources,
    "channels-runtime",
    process.platform === "win32" ? "channels-worker.exe" : "channels-worker",
  );
  const workerResult = spawnSync(worker, ["--bundled-chrome-self-test"], {
    encoding: "utf8",
    timeout: 60000,
    windowsHide: true,
    env: environment,
  });
  const browser =
    workerResult.status === 0 ? JSON.parse(workerResult.stdout) : null;
  if (
    workerResult.error ||
    browser?.event !== "ready" ||
    browser.browser !== "bundled" ||
    browser.h264 !== true
  ) {
    throw (
      workerResult.error ||
      new Error(
        "Installed WeChat Channels browser or H.264 self-test failed: " +
          (workerResult.stderr || workerResult.stdout || workerResult.status),
      )
    );
  }
  console.log("Bundled Chromium H.264 playback:", browser.version, browser.frameProbe);
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
    (origin && (!release || !renderer.endsWith("登录 AI来客")))
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
