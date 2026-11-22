import { expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ProfileManager } from "./profile-manager";

vi.mock("electron", () => ({ session: {} }));
it("解绑只清理对应账号的 Chrome 目录，即使旧 Electron 会话需延期删除", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "keagent-unbind-"));
  try {
    const manager = new ProfileManager(root, async () => {});
    const one = { workspaceId: "workspace", accountId: "one" },
      two = { ...one, accountId: "two" };
    for (const key of [one, two]) {
      for (const name of ["chromium-profile", "chrome-profile"]) {
        const folder = path.join(root, "workspace", key.accountId, name);
        await mkdir(folder, { recursive: true });
        await writeFile(path.join(folder, "Local State"), "{}");
        expect(manager.hasChannelsBrowserState(key)).toBe(true);
      }
      manager.save(key);
    }
    await mkdir(path.join(root, "workspace", "one", "chromium-data"));
    await manager.delete(one);
    await expect(stat(manager.chromePath(one))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(manager.isSaved(one)).toBe(false);
    expect(manager.isSaved(two)).toBe(true);
    expect(manager.hasChannelsBrowserState(one)).toBe(false);
    expect(manager.hasChannelsBrowserState(two)).toBe(true);
    await expect(
      stat(path.join(root, "workspace", "one", "chromium-profile")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await stat(manager.chromePath(two))).isDirectory()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
