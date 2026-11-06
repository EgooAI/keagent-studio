const fs = require("node:fs/promises");
const path = require("node:path");
module.exports = async ({ appDir }) => {
  const expected = path.resolve(__dirname, "../output/desktop-app");
  if (path.resolve(appDir) !== expected)
    throw new Error("Use the isolated desktop staging directory");
  const manifest = JSON.parse(
    await fs.readFile(path.join(appDir, "package.json"), "utf8"),
  );
  if (Object.keys(manifest.dependencies || {}).length)
    throw new Error(
      "Desktop runtime dependencies need an explicit packaging update",
    );
  await fs.access(
    path.join(appDir, "apps/desktop/electron/publishing/dist/runtime.cjs"),
  );
  await fs.access(
    path.join(appDir, "apps/desktop/electron/artifact-media/dist/runtime.cjs"),
  );
  // The staged Main bundle uses Electron/Node built-ins only. This supported hook
  // avoids collecting unrelated pnpm workspace server dependencies into the app.
  return false;
};
