import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runChannelsChrome } from "./channels";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("electron", () => ({ app: { isPackaged: false } }));
vi.mock("node:child_process", () => ({ spawn }));
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "keagent-chrome-"));
  dirs.push(root);
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    kill: vi.fn(),
  });
  child.stdin.once("finish", () => {
    child.stdout.end();
    child.emit("close", 0);
  });
  spawn.mockReturnValue(child);
  return { root, profileDir: path.join(root, "chrome-profile"), child };
}
it("提交前校验失败不确认、退出保留 Chrome profile 和清理临时文件", async () => {
  const { root, profileDir, child } = await setup();
  const running = runChannelsChrome(
    { action: "publish", profileDir, expectedAccountId: "expected" },
    new AbortController().signal,
    {
      beforeSubmit: async () => {
        throw new Error("账号与已保存账号不一致");
      },
    },
  );
  child.stdout.write('{"event":"beforeSubmit"}\n');
  await expect(running).rejects.toThrow("账号与已保存账号不一致");
  const stdin = child.stdin.read().toString();
  expect(stdin).not.toContain('{"ok":true}');
  expect(JSON.parse(stdin)).toMatchObject({
    action: "publish",
    profileDir,
    expectedAccountId: "expected",
  });
  expect((await stat(profileDir)).isDirectory()).toBe(true);
  expect(await readdir(path.join(root, "debug"))).toEqual([]);
});
it("实名等待只提供固定二维码路径，取消用 EOF 关闭自己的进程", async () => {
  const { profileDir, child } = await setup();
  const controller = new AbortController(),
    verification = vi.fn();
  const running = runChannelsChrome(
    { action: "publish", profileDir, expectedAccountId: "expected" },
    controller.signal,
    { verification },
  );
  child.stdout.write(
    '{"event":"verification","qrFile":"../unrelated.png"}\n{"event":"verification","qrFile":"wechat_verification_qr.png"}\n',
  );
  await vi.waitFor(() => expect(verification).toHaveBeenCalledTimes(1));
  expect(path.basename(verification.mock.calls[0][0])).toBe(
    "wechat_verification_qr.png",
  );
  controller.abort(new Error("账号工作区关闭"));
  await expect(running).rejects.toThrow("账号工作区关闭");
  expect(verification).toHaveBeenLastCalledWith(undefined);
  expect(child.kill).not.toHaveBeenCalled();
});
