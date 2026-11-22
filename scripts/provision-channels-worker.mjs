import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const vendor = path.join(root, "vendor/wechat-channels");
const output = path.join(root, "output");
const build = path.join(output, "channels-build");
const destination = path.join(output, "channels-runtime");
const windows = process.platform === "win32";
const executable = windows ? "channels-worker.exe" : "channels-worker";

function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    stdio: capture ? "pipe" : "inherit",
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(result.stderr || command + " failed");
  }
  return result.stdout?.trim();
}

const source = JSON.parse(
  await readFile(path.join(vendor, "SOURCE.json"), "utf8"),
);
const fingerprint = createHash("sha256").update(
  process.platform + process.arch,
);
for (const [name, hash] of Object.entries(source.sha256)) {
  const bytes = await readFile(path.join(vendor, name));
  if (createHash("sha256").update(bytes).digest("hex") !== hash) {
    throw new Error("Vendored social-auto-upload source changed: " + name);
  }
  fingerprint.update(bytes);
}
for (const file of [
  "worker.py",
  "browser-probe.mp4",
  "utils/log.py",
  "patchright/__init__.py",
  "patchright/async_api.py",
  "conf.py",
  "requirements.txt",
  "SOURCE.json",
]) {
  fingerprint.update(await readFile(path.join(vendor, file)));
}
fingerprint.update(await readFile(fileURLToPath(import.meta.url)));
const signature = fingerprint.digest("hex");
const candidate = path.join(
  output,
  "channels-runtime-ready-" + signature.slice(0, 16),
);
async function matches(directory) {
  return (
    (await readFile(path.join(directory, ".build-id"), "utf8").catch(
      () => "",
    )) === signature && existsSync(path.join(directory, executable))
  );
}
if (await matches(destination)) {
  console.log("Verified pinned WeChat Channels worker.");
} else if (!(await matches(candidate))) {
  await mkdir(build, { recursive: true });
  // Use a clean environment; the previous Electron worker's Patchright package
  // registers its own PyInstaller hook for the official Playwright import.
  const venv = path.join(build, "chrome-venv");
  const python = path.join(venv, windows ? "Scripts/python.exe" : "bin/python");
  const requirements = path.join(vendor, "requirements.txt");
  const uvAvailable =
    spawnSync("uv", ["--version"], { windowsHide: true }).status === 0;
  if (!existsSync(python)) {
    if (uvAvailable) {
      run("uv", ["venv", "--python", "3.12", venv]);
    } else {
      const system = windows ? "python" : "python3";
      run(system, [
        "-c",
        "import sys; assert (3, 10) <= sys.version_info[:2] < (3, 13), 'Use Python 3.10-3.12 or uv to build the Channels worker'",
      ]);
      run(system, ["-m", "venv", venv]);
    }
  }
  if (uvAvailable)
    run("uv", ["pip", "install", "--python", python, "-r", requirements]);
  else run(python, ["-m", "pip", "install", "-r", requirements]);
  run(python, [
    "-m",
    "unittest",
    "discover",
    "-s",
    vendor,
    "-p",
    "test_worker.py",
  ]);
  const dist = path.join(build, "dist");
  run(python, [
    "-m",
    "PyInstaller",
    "--clean",
    "--noconfirm",
    "--onedir",
    "--name",
    "channels-worker",
    "--distpath",
    dist,
    "--workpath",
    path.join(build, "work"),
    "--specpath",
    build,
    "--collect-data",
    "playwright",
    "--add-data",
    path.join(vendor, "browser-probe.mp4") + ":.",
    "--paths",
    vendor,
    path.join(vendor, "worker.py"),
  ]);
  const generated = path.join(dist, "channels-worker");
  if (existsSync(path.join(generated, "_internal", "patchright", "driver")))
    throw new Error("Unexpected second browser driver in the Chrome worker");
  if (
    JSON.parse(run(path.join(generated, executable), ["--self-test"], true))
      .event !== "ready"
  )
    throw new Error("Packaged Channels driver self-test failed");
  for (const file of ["LICENSE", "SOURCE.json"])
    await cp(path.join(vendor, file), path.join(generated, file));
  await writeFile(path.join(generated, ".build-id"), signature);
  await rename(generated, candidate);
}
if (!(await matches(destination))) {
  if (process.argv.includes("--stage-only")) {
    console.log("Verified staged worker:", candidate);
  } else {
    const backup = path.join(build, "previous-runtime");
    if (
      path.dirname(destination) !== output ||
      path.dirname(candidate) !== output ||
      path.dirname(backup) !== build
    )
      throw new Error("Invalid Channels output directory");
    const hasPrevious = existsSync(destination);
    if (hasPrevious) {
      await rm(backup, { recursive: true, force: true });
      // Renaming a locked runtime fails before touching its files.
      await rename(destination, backup);
    }
    try {
      await rename(candidate, destination);
    } catch (error) {
      if (hasPrevious) await rename(backup, destination);
      throw error;
    }
    console.log("Prepared WeChat Channels worker and browser driver.");
  }
}
