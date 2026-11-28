import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
const { createUpdates } = require("./updates.cjs");

function setup() {
  const updater = Object.assign(new EventEmitter(), {
    checkForUpdates: vi.fn(async () => ({})),
    quitAndInstall: vi.fn(),
    autoInstallOnAppQuit: true,
    disableDifferentialDownload: true,
  });
  const busy = vi.fn(() => false);
  const closeWindow = vi.fn();
  const updates = createUpdates({
    updater,
    busy,
    closeWindow,
    version: "1.0.0",
    changed: vi.fn(),
  });
  return { updates, updater, busy, closeWindow };
}

it("downloads while busy and installs only after an accepted idle close", () => {
  const { updates, updater, busy, closeWindow } = setup();
  expect(updater.autoInstallOnAppQuit).toBe(false);
  expect(updater.disableDifferentialDownload).toBe(false);
  busy.mockReturnValue(true);
  updates.check();
  updates.check();
  expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  updater.emit("update-available", { version: "1.1.0" });
  updater.emit("download-progress", { percent: 41.8 });
  expect(updates.state()).toMatchObject({ phase: "downloading", percent: 42 });
  updater.emit("update-downloaded", { version: "1.1.0" });
  expect(updates.install()).toMatchObject({ phase: "ready", busy: true });
  expect(closeWindow).not.toHaveBeenCalled();
  busy.mockReturnValue(false);
  updates.install();
  updates.cancelClose();
  expect(updates.installAfterClose()).toBe(false);
  updates.install();
  expect(closeWindow).toHaveBeenCalledTimes(2);
  expect(updater.quitAndInstall).not.toHaveBeenCalled();
  expect(updates.installAfterClose()).toBe(true);
  expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
});
it("can check again after a failed download", () => {
  const { updates, updater } = setup();
  updates.check();
  updater.emit("error", new Error("offline"));
  expect(updates.state().phase).toBe("error");
  expect(updates.check().phase).toBe("checking");
  updater.emit("update-not-available");
  expect(updates.state().phase).toBe("current");
});

it("keeps notes for the target version through download and discards stale notes on retry", () => {
  const { updates, updater } = setup();
  const releaseNotes = "- 房源账号支持手动检查。";
  updater.emit("update-available", { version: "1.1.0", releaseNotes });
  updater.emit("download-progress", { percent: 50 });
  expect(updates.state()).toMatchObject({ nextVersion: "1.1.0", releaseNotes });
  updater.emit("update-downloaded", { version: "1.1.0" });
  expect(updates.state()).toMatchObject({ phase: "ready", releaseNotes });
  updater.emit("error", new Error("offline"));
  expect(updates.check().releaseNotes).toBeUndefined();
  updater.emit("update-available", { version: "1.2.0" });
  expect(updates.state().releaseNotes).toBeUndefined();
  updater.emit("update-downloaded", {
    version: "1.2.0",
    releaseNotes: [{ version: "1.2.0", note: "新版说明" }],
  });
  expect(updates.state().releaseNotes).toBe("新版说明");
});
