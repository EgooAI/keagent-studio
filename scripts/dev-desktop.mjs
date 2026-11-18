import concurrently from "concurrently";

// A second worktree can opt into its own Vite port and Electron profile.
const port = Number(process.env.KEAGENT_DESKTOP_DEV_PORT || 5173);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Invalid desktop development port");
const alternate = port !== 5173;
const { result } = concurrently(
  [
    alternate
      ? `pnpm --filter @keagent/desktop exec vite --host 127.0.0.1 --port ${port} --strictPort`
      : "pnpm dev:web",
    `wait-on http://127.0.0.1:${port} && electron apps/desktop/electron/main.cjs${alternate ? " --keagent-dev-port=" + port : ""}`,
  ],
  { killOthersOn: ["failure", "success"] },
);
try {
  await result;
} catch {
  process.exitCode = 1;
}
