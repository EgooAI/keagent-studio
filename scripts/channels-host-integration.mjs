import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const root = await mkdtemp(path.join(os.tmpdir(), "keagent-channels-"));
try {
  const env = { ...process.env, CHANNELS_TEST_ROOT: root };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    createRequire(import.meta.url)("electron"),
    ["scripts/channels-host-fixture.cjs"],
    { env, stdio: "inherit", windowsHide: true },
  );
  const timeout = setTimeout(() => child.kill(), 60000);
  try {
    const [code] = await once(child, "exit");
    if (code !== 0) throw new Error("视频号 Electron 连接测试失败");
  } finally {
    clearTimeout(timeout);
  }
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
}
