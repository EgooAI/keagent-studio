import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = path.resolve(root, "output", "desktop-app");
const mediaTools = path.join(root, "output", "desktop-media-tools");
const installer = process.argv.includes("--installer");
let publicOrigin;
if (installer) {
  const url = URL.parse(process.env.KEAGENT_PUBLIC_ORIGIN ?? "");
  if (!url || url.protocol !== "https:" || url.href !== `${url.origin}/`)
    throw new Error("Set KEAGENT_PUBLIC_ORIGIN to an HTTPS origin");
  if (process.env.VITE_API_MODE !== "live")
    throw new Error("Set VITE_API_MODE=live to build a connected installer");
  publicOrigin = url.origin;
  const executableSuffix = process.platform === "win32" ? ".exe" : "";
  for (const name of ["ffmpeg", "ffprobe"]) {
    await access(path.join(mediaTools, name + executableSuffix));
  }
}
// Only this generated app directory can be replaced; never traverse another worktree or user data.
if (
  path.dirname(stage) !== path.join(root, "output") ||
  !stage.startsWith(root + path.sep)
)
  throw new Error("Invalid packaging directory");
const files = [
  "apps/desktop/dist",
  "apps/desktop/electron/main.cjs",
  "apps/desktop/electron/auth.cjs",
  "apps/desktop/electron/updates.cjs",
  "apps/desktop/electron/preload.cjs",
  "apps/desktop/electron/panorama",
  "apps/desktop/electron/production",
  "apps/desktop/electron/publishing/dist/runtime.cjs",
  "apps/desktop/electron/artifact-media/dist/runtime.cjs",
  "apps/desktop/electron/publishing/plugins/publish/OPENCLI_LICENSE",
  "apps/desktop/electron/publishing/README.md",
];
for (const file of [
  "apps/desktop/dist/index.html",
  "apps/desktop/electron/publishing/dist/runtime.cjs",
  "apps/desktop/electron/artifact-media/dist/runtime.cjs",
])
  await readFile(path.join(root, file));
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
const bundledTools = path.join(stage, "media-tools");
await mkdir(bundledTools);
if (installer) {
  await cp(mediaTools, bundledTools, { recursive: true });
  await writeFile(
    path.join(stage, "desktop-release.json"),
    JSON.stringify({ publicOrigin }) + "\n",
  );
}
for (const file of files) {
  const target = path.join(stage, file);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(path.join(root, file), target, { recursive: true });
}
await cp(
  path.join(root, "output/desktop-updater/runtime.cjs"),
  path.join(stage, "apps/desktop/electron/updater-runtime.cjs"),
);
const source = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
// Main uses only Electron and Node built-ins; renderer libraries are already in Vite bundles.
await writeFile(
  path.join(stage, "package.json"),
  JSON.stringify(
    {
      name: source.name,
      // Electron uses this internal name for the existing profile and macOS Keychain.
      productName: "KeAgent Studio",
      description: `${source.build.productName}桌面客户端`,
      version: source.version,
      private: true,
      type: "module",
      main: source.build.extraMetadata.main,
      dependencies: {},
    },
    null,
    2,
  ) + "\n",
);
console.log("Prepared isolated desktop package: output/desktop-app");
