const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

async function closeNormally({ requestClose, waitForExit, child }) {
  await requestClose();
  assert.equal(await waitForExit(10000), true, "Normal window close must exit before replacement");
  assert.equal(child.exitCode, 0, "Normal close must exit successfully");
  assert.equal(child.signalCode, null, "Normal close must not terminate by signal");
}

async function closeProfileWindow({
  nixProfile,
  ownedSession,
  page,
  child,
  waitForExit,
  artifactDir,
}) {
  if (!nixProfile) return;
  assert.ok(ownedSession);
  await closeNormally({
    child,
    requestClose: () =>
      page.evaluate(() => {
        const currentWindow = window.paseoDesktop.window.getCurrentWindow();
        if (typeof currentWindow.close !== "function") throw new Error("Missing window close");
        // Acknowledge before IPC destroys this context; failure to exit remains fatal.
        setTimeout(() => {
          void currentWindow.close();
        }, 0);
      }),
    waitForExit,
  });
  fs.writeFileSync(
    path.join(artifactDir, "normal-close.json"),
    JSON.stringify({
      method: "window.close -> app.quit",
      exitCode: child.exitCode,
      signal: child.signalCode,
    }),
  );
}

function observeStorageFiles(id) {
  const paths = [];
  try {
    for (const fd of fs.readdirSync(`/proc/${id}/fd`)) {
      try {
        const target = fs.readlinkSync(`/proc/${id}/fd/${fd}`);
        if (target.includes("/Local Storage/leveldb/")) paths.push(target);
      } catch {
        /* A descriptor may close during observation. */
      }
    }
  } catch {
    /* Sandboxed or exited processes may be inaccessible. */
  }
  return paths;
}

async function recordStoragePaths({ browser, userData, artifactDir }) {
  const session = await browser.newBrowserCDPSession();
  try {
    const { processInfo } = await session.send("SystemInfo.getProcessInfo");
    const paths = new Set(processInfo.flatMap(({ id }) => observeStorageFiles(id)));
    fs.writeFileSync(
      path.join(artifactDir, "storage-paths.json"),
      JSON.stringify({
        requestedUserData: userData,
        observedLocalStorageFiles: [...paths].sort(),
        observation: paths.size
          ? "open file descriptors"
          : "unavailable; not proof of absent storage",
      }),
    );
  } finally {
    await session.detach();
  }
}

module.exports = { closeNormally, closeProfileWindow, recordStoragePaths };
