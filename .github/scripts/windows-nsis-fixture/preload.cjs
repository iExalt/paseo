const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("fixture", {
  identity: () => ipcRenderer.invoke("fixture-identity"),
  close: () => ipcRenderer.invoke("fixture-close"),
});
