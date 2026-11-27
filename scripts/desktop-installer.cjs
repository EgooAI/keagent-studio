const { build } = require("../package.json");
const origin = new URL(process.env.KEAGENT_PUBLIC_ORIGIN);
if (origin.protocol !== "https:" || origin.href !== origin.origin + "/")
  throw new Error("Expected an HTTPS release origin");
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
      origin.origin +
      "/desktop-updates/" +
      process.platform +
      "-" +
      process.arch +
      "/",
    useMultipleRangeRequest: false,
  },
};
