const { build } = require("../package.json");
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
