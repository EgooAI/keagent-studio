const { signAsync } = require("@electron/osx-sign");
const { createHash } = require("node:crypto");
const { readFile, writeFile } = require("node:fs/promises");
const path = require("node:path");

module.exports = async (options) => {
  const directory = path.join(
    options.app,
    "Contents/Resources/channels-browser",
  );
  const manifestPath = path.join(directory, "browser.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const executable = path.join(
    directory,
    "Chromium.app/Contents/MacOS/Chromium",
  );
  const checksum = async () =>
    createHash("sha256")
      .update(await readFile(executable))
      .digest("hex");
  if ((await checksum()) !== manifest.sha256)
    throw new Error("Chromium checksum mismatch before signing");
  await signAsync({
    ...options,
    app: path.join(directory, "Chromium.app"),
    ignore: undefined,
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
  });
  // Signing changes the executable bytes checked by the local publishing worker.
  manifest.sha256 = await checksum();
  await writeFile(manifestPath, JSON.stringify(manifest) + "\n");
  await signAsync(options);
};
