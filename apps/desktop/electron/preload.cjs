const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld(
  "desktop",
  Object.freeze({
    artifactMedia: Object.freeze({
      request: (method, input = {}) =>
        ipcRenderer.invoke("artifact-media:request", method, input),
    }),
    publishing: Object.freeze({
      request: (method, input = {}) =>
        ipcRenderer.invoke("douyin:request", method, input),
      subscribe: (listener) => {
        const handler = () => listener();
        ipcRenderer.on("douyin:changed", handler);
        return () => ipcRenderer.removeListener("douyin:changed", handler);
      },
    }),
    updates: Object.freeze({
      request: (action) => ipcRenderer.invoke("updates:request", action),
      subscribe: (listener) => {
        const handler = () => listener();
        ipcRenderer.on("updates:changed", handler);
        return () => ipcRenderer.removeListener("updates:changed", handler);
      },
    }),
    platform: process.platform,
    mode: "authenticated",
    request: (method, args) =>
      ipcRenderer.invoke("identity:request", method, args),
  }),
);
