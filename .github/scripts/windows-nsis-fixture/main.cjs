const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
if (!process.env.PASEO_WINDOWS_FIXTURE_PROFILE) throw new Error("Owned profile required");
app.setPath("userData", process.env.PASEO_WINDOWS_FIXTURE_PROFILE);
app.whenReady().then(() => {
  ipcMain.handle("fixture-identity", () => ({
    version: app.getVersion(),
    architecture: process.arch,
    executable: process.execPath,
  }));
  ipcMain.handle("fixture-close", () => {
    setTimeout(() => app.quit(), 0);
  });
  const window = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  return window.loadURL(
    `data:text/html,${encodeURIComponent(`<h1>Windows installer fixture ${app.getVersion()}</h1>`)}`,
  );
});
app.on("window-all-closed", () => app.quit());
