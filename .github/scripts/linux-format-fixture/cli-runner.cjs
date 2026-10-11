const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { appImageSupervisorLaunch } = require("./appimage-supervisor.js");

if (process.argv[2] === "stable-link-probe") {
  assert.equal(process.env.PASEO_APPIMAGE_SUPERVISOR, undefined);
  console.log(JSON.stringify({ cli: process.env.PASEO_CLI, args: process.argv.slice(2) }));
} else {
  const launch = appImageSupervisorLaunch({
    platform: process.platform,
    electron: process.versions.electron,
    execPath: process.execPath,
    entry: path.join(
      process.env.APPDIR,
      "resources/app.asar/node_modules/@getpaseo/server/dist/scripts/supervisor-entrypoint.js",
    ),
    env: process.env,
  });
  assert.ok(launch);
  const stderr = fs.openSync(`${process.env.FIXTURE_CLI_RECEIPT}.stderr`, "wx");
  let child;
  try {
    child = spawn(launch.command, launch.args, {
      detached: true,
      stdio: ["ignore", "ignore", stderr],
      env: { ...launch.env, FIXTURE_CLI_PARENT: String(process.pid) },
    });
  } finally {
    fs.closeSync(stderr);
  }
  child.unref();
  child.on("error", (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  void (async () => {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(`${process.env.FIXTURE_CLI_RECEIPT}.ready`) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(
      fs.existsSync(`${process.env.FIXTURE_CLI_RECEIPT}.ready`),
      `Supervisor never became ready (exit=${child.exitCode}, signal=${child.signalCode})`,
    );
    const ready = JSON.parse(fs.readFileSync(`${process.env.FIXTURE_CLI_RECEIPT}.ready`));
    assert.equal(ready.pid, child.pid, "AppImage must preserve the supervisor spawn PID");
    console.log(
      JSON.stringify({
        args: process.argv.slice(2),
        argv0: process.env.ARGV0,
        cli: process.env.PASEO_CLI,
        appdir: process.env.APPDIR,
        runAsNode: process.env.ELECTRON_RUN_AS_NODE,
        display: process.env.DISPLAY,
        architecture: process.arch,
        supervisorPid: child.pid,
      }),
    );
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
