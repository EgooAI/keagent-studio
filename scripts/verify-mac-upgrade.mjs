import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  stat,
} from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { _electron } from "@playwright/test";

assert.equal(process.platform, "darwin");
assert.equal(process.arch, "arm64");
const [oldDir, nextDir] = process.argv.slice(2);
async function zip(dir) {
  const files = (await readdir(dir)).filter((f) => f.endsWith("-arm64.zip"));
  assert.equal(files.length, 1);
  return files[0];
}
const oldZip = await zip(oldDir),
  newZip = await zip(nextDir);
const targetVersion = JSON.parse(await readFile("package.json")).version;
const allowed = new Map([
  ["latest-mac.yml", path.join(nextDir, "latest-mac.yml")],
  [newZip, path.join(nextDir, newZip)],
  [newZip + ".blockmap", path.join(nextDir, newZip + ".blockmap")],
  [oldZip + ".blockmap", path.join(oldDir, oldZip + ".blockmap")],
]);
const requests = [];
const server = createServer(async (req, res) => {
  const name = new URL(req.url, "http://localhost").pathname.slice(1);
  const file = allowed.get(name);
  if (!file) return res.writeHead(404).end();
  try {
    const { size } = await stat(file);
    const range = req.headers.range?.match(/^bytes=(\d+)-(\d+)$/);
    const start = range ? Number(range[1]) : 0;
    const end = range ? Number(range[2]) : size - 1;
    if (name === newZip)
      requests.push({ range: !!range, bytes: end - start + 1 });
    res.writeHead(range ? 206 : 200, {
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
    });
    createReadStream(file, { start, end })
      .on("error", (e) => res.destroy(e))
      .pipe(res);
  } catch (e) {
    res.destroy(e);
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const feed = "http://127.0.0.1:" + server.address().port;
const apps = path.join(homedir(), "Applications");
await mkdir(apps, { recursive: true });
const root = await mkdtemp(path.join(apps, "Laike-upgrade-"));
const bundle = path.join(root, "AI来客.app");
const exe = path.join(bundle, "Contents/MacOS/AI来客");
const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }).trim();
const appVersion = () =>
  run("/usr/libexec/PlistBuddy", [
    "-c",
    "Print CFBundleShortVersionString",
    path.join(bundle, "Contents/Info.plist"),
  ]);
try {
  run("ditto", ["-x", "-k", path.join(oldDir, oldZip), root]);
  const initial = appVersion();
  assert.notEqual(initial, targetVersion);
  const updateConfig = await readFile(
    path.join(bundle, "Contents/Resources/app-update.yml"),
    "utf8",
  );
  const cacheName = updateConfig.match(/^updaterCacheDirName: ([\w-]+)$/m)?.[1];
  assert.ok(cacheName);
  const cache = path.join(homedir(), "Library/Caches", cacheName);
  for (const mode of ["full", "delta"]) {
    requests.length = 0;
    if (mode === "delta") {
      await rename(cache, cache + "-" + path.basename(root));
      await mkdir(cache);
      await cp(path.join(oldDir, oldZip), path.join(cache, "update.zip"));
    }
    const proc = await _electron.launch({
      executablePath: exe,
      args: ["--user-data-dir=" + path.join(root, "profile-" + mode)],
      timeout: 60000,
    });
    const oldPid = proc.process().pid;
    try {
      const page = await proc.firstWindow();
      await proc.evaluate(({ app }, url) => {
        const req = process
          .getBuiltinModule("node:module")
          .createRequire(app.getAppPath() + "/package.json");
        const updater = req("./apps/desktop/electron/updater-runtime.cjs");
        updater.setFeedURL({
          provider: "generic",
          url,
          useMultipleRangeRequest: false,
        });
      }, feed);
      const deadline = Date.now() + 240000;
      let ready = false;
      while (Date.now() < deadline) {
        const state = await page.evaluate(() =>
          window.desktop.updates.request("check"),
        );
        if (state.phase === "ready") {
          assert.equal(state.nextVersion, targetVersion);
          ready = true;
          break;
        }
        await delay(1000);
      }
      assert.ok(ready, "Update did not reach ready state: " + mode);
      assert.ok(
        requests.length &&
          requests.every((r) => r.range === (mode === "delta")),
        JSON.stringify(requests),
      );
      console.log(
        mode,
        initial,
        "->",
        targetVersion,
        "requests",
        requests.length,
        "ZIP bytes",
        requests.reduce((n, r) => n + r.bytes, 0),
      );
      if (mode === "full") continue;
      await page.evaluate(() => {
        void window.desktop.updates.request("install");
      });
      const end = Date.now() + 120000;
      let pid;
      while (Date.now() < end) {
        await delay(1000);
        const rows = run("ps", ["-axo", "pid=,comm="]).split("\n");
        pid = rows
          .map((r) => r.trim().match(/^(\d+)\s+(.+)$/))
          .find((m) => m && Number(m[1]) !== oldPid && m[2] === exe)?.[1];
        if (pid && appVersion() === targetVersion) break;
      }
      assert.ok(
        pid && appVersion() === targetVersion,
        "Updated app did not relaunch",
      );
      run("codesign", ["--verify", "--deep", "--strict", bundle]);
      run("xcrun", ["stapler", "validate", bundle]);
      console.log("Relaunched signed, stapled", appVersion(), "pid", pid);
      process.kill(Number(pid), "SIGTERM");
    } finally {
      if (!proc.process().exitCode && proc.process().signalCode == null)
        await proc.close().catch(() => {});
    }
  }
} finally {
  server.close();
}
