const { readFileSync } = require("node:fs");
const path = require("node:path");
const { build, version } = require("../package.json");
const notesFile = path.join(
  __dirname,
  "../docs/desktop-releases",
  version + ".md",
);
const releaseNotes = readFileSync(notesFile, "utf8").trim();
if (!releaseNotes) throw new Error(`请补充 v${version} 的桌面更新日志`);
const updateOrigin = new URL(
  process.env.KEAGENT_UPDATE_ORIGIN || process.env.KEAGENT_PUBLIC_ORIGIN,
);
if (
  updateOrigin.protocol !== "https:" ||
  updateOrigin.href !== updateOrigin.origin + "/"
)
  throw new Error("Expected an HTTPS update origin");
if (
  !["darwin-arm64", "win32-x64"].includes(process.platform + "-" + process.arch)
)
  throw new Error("Build desktop releases on Apple Silicon or Windows x64");
module.exports = {
  ...build,
  releaseInfo: { releaseNotes },
  win: { ...build.win, signExts: ["!chrome.exe"] },
  mac: {
    ...build.mac,
    sign: "scripts/sign-desktop-mac.cjs",
    forceCodeSigning: true,
  },
  publish: {
    provider: "generic",
    url:
      updateOrigin.origin +
      "/desktop-updates/" +
      process.platform +
      "-" +
      process.arch +
      "/",
    useMultipleRangeRequest: false,
  },
};
