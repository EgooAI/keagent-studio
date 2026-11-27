// The installer is started only after the window accepts its normal close (including draft prompts).
function createUpdates({ updater, version, busy, closeWindow, changed }) {
  let phase = updater ? "idle" : "unavailable";
  let nextVersion;
  let percent = 0;
  const state = () => ({
    phase,
    version,
    nextVersion,
    percent,
    busy: phase === "ready" && busy(),
  });
  const set = (value) => {
    phase = value;
    changed();
  };
  if (updater) {
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = false;
    updater.disableDifferentialDownload = false;
    updater.on("update-not-available", () => set("current"));
    updater.on("update-available", (info) => {
      nextVersion = info.version;
      percent = 0;
      set("downloading");
    });
    updater.on("download-progress", (progress) => {
      percent = Math.min(100, Math.max(0, Math.round(progress.percent)));
      set("downloading");
    });
    updater.on("update-downloaded", (info) => {
      nextVersion = info.version;
      set("ready");
    });
    updater.on("error", () => set("error"));
  }
  return {
    state,
    check() {
      if (updater && ["idle", "current", "error"].includes(phase)) {
        nextVersion = undefined;
        set("checking");
        void updater
          .checkForUpdates()
          .then((result) => result?.downloadPromise)
          .catch(() => set("error"));
      }
      return state();
    },
    install() {
      if (phase === "ready" && !busy()) {
        set("closing");
        closeWindow();
      }
      return state();
    },
    cancelClose() {
      if (phase === "closing") set("ready");
    },
    installAfterClose() {
      if (phase !== "closing") return false;
      updater.quitAndInstall(false, true);
      return true;
    },
  };
}
module.exports = { createUpdates };
