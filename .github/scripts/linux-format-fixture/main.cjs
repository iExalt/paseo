const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { app, BrowserWindow, ipcMain } = require("electron");

const fail = (error) => {
  console.error(error);
  app.exit(1);
};
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);
const deadline = setTimeout(() => fail(new Error("Renderer did not complete within 30s")), 30000);
app.on("window-all-closed", () => app.quit());
app
  .whenReady()
  .then(async () => {
    assert.notEqual(process.getuid(), 0, "Fixture must run as nonroot");
    assert.equal(process.arch, process.env.FIXTURE_ARCH);
    assert.ok(["deb", "rpm", "appimage"].includes(process.env.FIXTURE_FORMAT));
    const window = new BrowserWindow({
      width: 640,
      height: 480,
      webPreferences: {
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, "preload.cjs"),
      },
    });
    ipcMain.once("fixture-ready", (event, renderer) => {
      try {
        assert.equal(event.sender, window.webContents);
        assert.equal(renderer.pid, window.webContents.getOSProcessId());
        const reason = process.env.PASEO_DESKTOP_SANDBOX_REASON;
        let appRun;
        if (process.env.FIXTURE_FORMAT === "appimage") {
          const content = fs.readFileSync(path.join(process.env.APPDIR, "AppRun"));
          const sha256 = createHash("sha256").update(content).digest("hex");
          assert.equal(
            sha256,
            fs.readFileSync(path.join(process.resourcesPath, "app-run.sha256"), "utf8"),
          );
          const probe = spawnSync("unshare", ["-Ur", "true"], { encoding: "utf8", timeout: 5000 });
          assert.equal(probe.error, undefined, "Namespace probe must execute");
          assert.equal(probe.signal, null, "Namespace probe must exit normally");
          assert.ok(Number.isInteger(probe.status));
          appRun = { sha256, namespaceProbe: { status: probe.status, stderr: probe.stderr } };
        }
        const enabled = ["user namespaces available", "root-owned SUID helper available"].includes(
          reason,
        );
        assert.ok(
          enabled ||
            reason?.startsWith("user namespaces unavailable") ||
            (reason === "requested by --no-sandbox" && appRun?.namespaceProbe.status > 0),
          "Unexpected policy override",
        );
        assert.equal(
          renderer.sandboxed,
          enabled,
          "Renderer must match the shipped launch chain's decision",
        );
        const processes = app.getAppMetrics().flatMap(({ pid, type }) => {
          try {
            const observed = {
              pid,
              type,
              stat: fs.readFileSync(`/proc/${pid}/stat`, "utf8"),
              status: fs.readFileSync(`/proc/${pid}/status`, "utf8"),
            };
            try {
              observed.executable = fs.readlinkSync(`/proc/${pid}/exe`);
            } catch (error) {
              if (!["EACCES", "EPERM", "ENOENT", "ESRCH"].includes(error.code)) throw error;
              observed.executableUnavailable = error.code;
            }
            return [observed];
          } catch (error) {
            if (
              pid === renderer.pid ||
              pid === process.pid ||
              !["ENOENT", "ESRCH"].includes(error.code)
            )
              throw error;
            console.error(`Optional ${type} process ${pid} exited during observation`);
            return [];
          }
        });
        assert.ok(processes.some(({ pid }) => pid === renderer.pid));
        assert.ok(processes.some(({ pid }) => pid === process.pid));
        let mount;
        if (process.env.FIXTURE_FORMAT === "appimage") {
          assert.equal(
            fs.realpathSync(process.env.APPIMAGE),
            fs.realpathSync(process.env.FIXTURE_APPIMAGE),
          );
          assert.ok(
            process.env.APPDIR?.startsWith(`${process.env.TMPDIR}/.mount_`),
            "AppImage must mount, not extract",
          );
          mount = JSON.parse(
            execFileSync("findmnt", ["-J", "-T", process.env.APPDIR], { encoding: "utf8" }),
          ).filesystems[0];
          assert.match(mount.fstype, /^fuse/);
          assert.equal(mount.target, process.env.APPDIR);
          assert.ok(fs.realpathSync(process.execPath).startsWith(`${mount.target}/`));
        }
        fs.writeFileSync(
          process.env.FIXTURE_RECEIPT,
          JSON.stringify(
            {
              architecture: process.arch,
              format: process.env.FIXTURE_FORMAT,
              token: process.env.FIXTURE_TOKEN,
              uid: process.getuid(),
              reason,
              appRun,
              renderer,
              processes,
              mount,
              appImage: process.env.APPIMAGE,
              executable: process.execPath,
            },
            null,
            2,
          ),
        );
        clearTimeout(deadline);
        window.close();
      } catch (error) {
        fail(error);
      }
    });
    return window.loadURL(
      "data:text/html,<title>Linux format fixture</title><h1>Renderer ready</h1>",
    );
  })
  .catch(fail);
