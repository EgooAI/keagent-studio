const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld(
  "desktop",
  Object.freeze({
    platform: process.platform,
    mode: "authenticated",
    request: (method, args) =>
      ipcRenderer.invoke("identity:request", method, args),
  }),
);
