import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = path.resolve(root, "output", "desktop-app");
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
for (const file of files) {
  const target = path.join(stage, file);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(path.join(root, file), target, { recursive: true });
}
const source = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
// Main uses only Electron and Node built-ins; renderer libraries are already in Vite bundles.
await writeFile(
  path.join(stage, "package.json"),
  JSON.stringify(
    {
      name: source.name,
      productName: source.build.productName,
      description: "KeAgent Studio 桌面客户端",
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
