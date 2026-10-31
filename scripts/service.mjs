import { loadEnvFile } from "node:process";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
try {
  loadEnvFile(".env.local");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const target = process.argv[2];
const commands = {
  control: [
    process.execPath,
    [
      require.resolve("next/dist/bin/next"),
      "dev",
      "--hostname",
      "127.0.0.1",
      "--port",
      "18080",
    ],
    "services/control",
  ],
  setup: [process.execPath, ["setup.mjs"], "services/control"],
  cloud: ["go", ["run", "."], "services/cloud"],
};
if (!commands[target]) throw new Error("Unknown service");
const [command, args, cwd] = commands[target];
const child = spawn(command, args, {
  cwd,
  stdio: "inherit",
  env: process.env,
  windowsHide: true,
});
child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
