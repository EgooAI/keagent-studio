import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, createReadStream, openSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const output = fileURLToPath(new URL("../output/", import.meta.url));
const downloads = path.join(output, "desktop-media-downloads");
const tools = path.join(output, "desktop-media-tools");
const version = "9.0.2";
const windows = process.platform === "win32";
const gyanBuild = `ffmpeg-${version}-essentials_build`;
const macBuilds = {
  arm64: {
    directory: "arm64/1789931890_9.0.2",
    ffmpeg: "c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924",
    ffprobe: "fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6",
  },
  x64: {
    directory: "amd64/1789931006_9.0.2",
    ffmpeg: "7c6b4125b191cbf773832dc51f424cf2b6bb7da43007d1e066f95909e47cacd4",
    ffprobe: "2322438ed2f6319a691291b247d09c69dcaa3a982460d1f269a7e1af335cfdfd",
  },
};
const macBuild = process.platform === "darwin" && macBuilds[process.arch];
if (!(windows && process.arch === "x64") && !macBuild)
  throw new Error(
    `Unsupported media tool platform: ${process.platform}/${process.arch}`,
  );

function exec(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
}

async function sha256(file) {
  const hash = createHash("sha256");
  try {
    for await (const bytes of createReadStream(file)) hash.update(bytes);
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
  return hash.digest("hex");
}

async function download(filename, url, expected) {
  const destination = path.join(downloads, filename);
  if ((await sha256(destination)) === expected) return destination;
  const temporary = `${destination}.partial`;
  try {
    exec(windows ? "curl.exe" : "curl", [
      "-fsSL",
      "--proto",
      "=https",
      "--proto-redir",
      "=https",
      "--retry",
      "2",
      "--connect-timeout",
      "15",
      "--max-time",
      "240",
      "-o",
      temporary,
      url,
    ]);
    if ((await sha256(temporary)) !== expected)
      throw new Error(`SHA-256 mismatch for ${url}`);
    await rename(temporary, destination);
    return destination;
  } finally {
    await rm(temporary, { force: true });
  }
}

async function extract(archive, member, filename) {
  const destination = path.join(tools, filename);
  const temporary = `${destination}.partial`;
  try {
    const descriptor = openSync(temporary, "w");
    try {
      exec("tar", ["-xOf", archive, "--", member], {
        stdio: ["ignore", descriptor, "inherit"],
      });
    } finally {
      closeSync(descriptor);
    }
    await chmod(temporary, 0o755);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

await mkdir(downloads, { recursive: true });
await mkdir(tools, { recursive: true });
const license = await download(
  `ffmpeg-${version}-COPYING.GPLv3`,
  `https://raw.githubusercontent.com/FFmpeg/FFmpeg/n${version}/COPYING.GPLv3`,
  "8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903",
);
await copyFile(license, path.join(tools, "FFMPEG-LICENSE.txt"));

const source = [
  `FFmpeg and FFprobe ${version}`,
  "License: GNU GPL version 3 or later",
  `FFmpeg source: https://ffmpeg.org/releases/ffmpeg-${version}.tar.xz`,
];
if (windows) {
  const url = `https://github.com/GyanD/codexffmpeg/releases/download/${version}/${gyanBuild}.zip`;
  const hash =
    "60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba";
  const archive = await download(`${gyanBuild}.zip`, url, hash);
  for (const tool of ["ffmpeg.exe", "ffprobe.exe"])
    await extract(archive, `${gyanBuild}/bin/${tool}`, tool);
  await extract(archive, `${gyanBuild}/README.txt`, "FFMPEG-BUILD.txt");
  source.push(
    "Windows build: https://www.gyan.dev/ffmpeg/builds/",
    `${url} (SHA-256 ${hash})`,
  );
} else {
  const base = `https://ffmpeg.martin-riedl.de/download/macos/${macBuild.directory}`;
  for (const tool of ["ffmpeg", "ffprobe"]) {
    const url = `${base}/${tool}.zip`;
    const hash = macBuild[tool];
    const archive = await download(
      `macos-${process.arch}-${version}-${tool}.zip`,
      url,
      hash,
    );
    const members = exec("tar", ["-tf", archive]).split(/\r?\n/);
    const matching = members.filter(
      (member) => path.posix.basename(member) === tool,
    );
    if (matching.length !== 1)
      throw new Error(`Missing unique ${tool} in ${url}`);
    await extract(archive, matching[0], tool);
    source.push(`${url} (SHA-256 ${hash})`);
  }
  source.push(
    `macOS library versions: ${base}/versions.txt`,
    "macOS build script: https://git.martin-riedl.de/ffmpeg/build-script",
  );
}

const suffix = windows ? ".exe" : "";
const ffmpeg = path.join(tools, `ffmpeg${suffix}`);
const ffprobe = path.join(tools, `ffprobe${suffix}`);
const configuration = exec(ffmpeg, ["-hide_banner", "-buildconf"]);
if (configuration.includes("--enable-nonfree"))
  throw new Error("FFmpeg build has nonfree components");
const filters = exec(ffmpeg, ["-hide_banner", "-filters"]);
const encoders = exec(ffmpeg, ["-hide_banner", "-encoders"]);
if (
  !/\bass\s+V->V/.test(filters) ||
  !/\bv360\s+V->V/.test(filters) ||
  !/\blibx264\s/.test(encoders)
)
  throw new Error(
    "FFmpeg must provide ASS subtitles, v360 projection and libx264 encoding",
  );
if (!exec(ffprobe, ["-version"]).startsWith(`ffprobe version ${version}`))
  throw new Error("Unexpected FFprobe version");
if (!windows)
  await writeFile(path.join(tools, "FFMPEG-BUILD.txt"), configuration);
await writeFile(
  path.join(tools, "FFMPEG-SOURCE.txt"),
  `${source.join("\n")}\n`,
);
console.log(
  `Verified FFmpeg / FFprobe ${version} for ${process.platform}/${process.arch}`,
);
