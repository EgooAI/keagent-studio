import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "output");
const destination = path.join(output, "channels-browser");
const cache = path.join(output, "channels-browser-downloads");
const licenses = path.join(root, "vendor", "channels-browser-licenses");
const version = "157.0.8103.78";
const release = version + "-1.1";
// Published checksums from the platform maintainers' tagged GitHub releases.
const platforms = {
  "win32-x64": [
    "windows",
    "windows_x64.zip",
    "2b1d113b055f827b573cd1fa2bc46511691c0aa427802397cfc05e52350ef212",
  ],
  "darwin-arm64": [
    "macos",
    "arm64-macos.dmg",
    "bdfe0ee51e47b7ff49c94778c6d9adb08a626dfbd6089570bbbb455410f1a41a",
  ],
  "darwin-x64": [
    "macos",
    "x86_64-macos.dmg",
    "8a7306ac6218f8b0f3c38b570922115b9545749ae4c0b2c29bbd1ebb5c00459f",
  ],
};
const platform = platforms[process.platform + "-" + process.arch];
if (!platform)
  throw new Error(
    "Unsupported Channels browser platform: " +
      process.platform +
      "/" +
      process.arch,
  );
const [system, suffix, archiveSha256] = platform;
const windows = system === "windows";
const executable = windows
  ? "chrome.exe"
  : "Chromium.app/Contents/MacOS/Chromium";
const repo =
  "https://github.com/ungoogled-software/ungoogled-chromium-" + system;
const filename = "ungoogled-chromium_" + release + "_" + suffix;
const url = repo + "/releases/download/" + release + "/" + filename;
const archive = path.join(cache, filename);

function run(program, args, options = {}) {
  return execFileSync(program, args, {
    windowsHide: true,
    stdio: "inherit",
    ...options,
  });
}

async function sha256(file) {
  const digest = createHash("sha256");
  for await (const bytes of createReadStream(file)) digest.update(bytes);
  return digest.digest("hex");
}

async function unpack(staging, work) {
  await mkdir(staging);
  if (!windows) {
    const mount = path.join(work, "mount");
    await mkdir(mount);
    run("hdiutil", [
      "attach",
      "-readonly",
      "-nobrowse",
      "-mountpoint",
      mount,
      archive,
    ]);
    try {
      run("ditto", [
        path.join(mount, "Chromium.app"),
        path.join(staging, "Chromium.app"),
      ]);
    } finally {
      run("hdiutil", ["detach", mount]);
    }
    return;
  }
  const files = path.join(work, "unpacked");
  await mkdir(files);
  run("tar", ["-xf", archive, "-C", files]);
  const entries = await readdir(files, { withFileTypes: true });
  const candidates = [
    files,
    ...entries
      .filter((e) => e.isDirectory())
      .map((e) => path.join(files, e.name)),
  ];
  const layouts = candidates.filter((p) =>
    existsSync(path.join(p, executable)),
  );
  if (layouts.length !== 1) throw new Error("Unexpected Chromium ZIP layout");
  for (const entry of await readdir(layouts[0])) {
    await rename(path.join(layouts[0], entry), path.join(staging, entry));
  }
}

async function prepare() {
  await mkdir(cache, { recursive: true });
  const manifest = await readFile(
    path.join(destination, "browser.json"),
    "utf8",
  )
    .then(JSON.parse)
    .catch(() => null);
  if (
    manifest?.archiveSha256 === archiveSha256 &&
    manifest.executable === executable &&
    existsSync(path.join(destination, "THIRD-PARTY-CREDITS.html")) &&
    existsSync(path.join(destination, executable)) &&
    (await sha256(path.join(destination, executable))) === manifest.sha256
  ) {
    console.log("Verified bundled Chromium " + version);
    return;
  }
  const work = await mkdtemp(path.join(output, "channels-browser-build-"));
  try {
    if (!existsSync(archive) || (await sha256(archive)) !== archiveSha256) {
      const download = path.join(work, filename);
      run(windows ? "curl.exe" : "curl", [
        "-fsSL",
        "--proto",
        "=https",
        "--proto-redir",
        "=https",
        "--retry",
        "2",
        "--connect-timeout",
        "20",
        "--max-time",
        "600",
        "-o",
        download,
        url,
      ]);
      if ((await sha256(download)) !== archiveSha256)
        throw new Error("Incorrect Chromium archive SHA-256");
      await rename(download, archive);
    }
    const staging = path.join(work, "browser");
    await unpack(staging, work);
    const binary = path.join(staging, executable);
    const credits = run(
      binary,
      [
        "--headless",
        "--allow-chrome-scheme-url",
        "--disable-background-networking",
        "--no-first-run",
        "--user-data-dir=" + path.join(work, "credits-profile"),
        "--dump-dom",
        "chrome://credits/",
      ],
      {
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
        maxBuffer: 96 * 1024 * 1024,
        timeout: 60000,
      },
    );
    if (!credits.includes("Redistribution") || !credits.includes("FFmpeg"))
      throw new Error("Could not extract Chromium third-party licenses");
    await writeFile(path.join(staging, "THIRD-PARTY-CREDITS.html"), credits);
    await cp(licenses, path.join(staging, "licenses"), { recursive: true });
    await writeFile(
      path.join(staging, "browser.json"),
      JSON.stringify(
        {
          product: "ungoogled-chromium",
          version,
          executable,
          sha256: await sha256(binary),
          archiveSha256,
          url,
          chromiumSource:
            "https://chromium.googlesource.com/chromium/src/+/refs/tags/" +
            version +
            "/",
          buildSource: repo + "/tree/" + release,
        },
        null,
        2,
      ) + "\n",
    );
    if (path.dirname(destination) !== output)
      throw new Error("Invalid browser staging path");
    const backup = path.join(output, "channels-build", "previous-browser");
    const hasPrevious = existsSync(destination);
    if (hasPrevious) {
      await mkdir(path.dirname(backup), { recursive: true });
      await rm(backup, { recursive: true, force: true });
      await rename(destination, backup);
    }
    try {
      await rename(staging, destination);
    } catch (error) {
      if (hasPrevious) await rename(backup, destination);
      throw error;
    }
    console.log(
      "Prepared bundled Chromium " + version + " and license notices.",
    );
  } finally {
    if (
      path.dirname(work) === output &&
      path.basename(work).startsWith("channels-browser-build-")
    )
      await rm(work, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
  }
}

await prepare();
