const { ipcRenderer } = require("electron");
window.addEventListener("DOMContentLoaded", () => {
  ipcRenderer.send("fixture-ready", { sandboxed: process.sandboxed, pid: process.pid });
});
