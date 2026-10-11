const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

assert.equal(process.argv[2], "node-script");
assert.ok(process.argv[3].endsWith("/resources/app.asar/node_modules/@getpaseo/cli/dist/index.js"));
const stderr = fs.openSync(`${process.env.FIXTURE_CLI_RECEIPT}.stderr`, "wx");
let child;
try {
  child = spawn(
    process.execPath,
    [
      "--eval",
      `
  const fs = require('node:fs');
  process.on('uncaughtException', (error) => { console.error(error); process.exitCode = 1; });
  process.on('unhandledRejection', (error) => { console.error(error); process.exitCode = 1; });
  process.on('exit', (code) => console.error(JSON.stringify({exitCode: code})));
  fs.writeFileSync(process.env.FIXTURE_CLI_RECEIPT + '.ready', JSON.stringify({
    pid: process.pid,
    start: fs.readFileSync('/proc/self/stat', 'utf8').split(') ').at(-1).split(' ')[19],
    execPath: process.execPath,
    appdir: process.env.APPDIR,
    inputExists: fs.existsSync(process.env.FIXTURE_CLI_INPUT),
  }));
  setTimeout(() => {
    let parentExited = false;
    try { process.kill(Number(process.env.FIXTURE_CLI_PARENT), 0); }
    catch (error) { if (error.code !== 'ESRCH') throw error; parentExited = true; }
    let content, error;
    try { content = fs.readFileSync(process.env.FIXTURE_CLI_INPUT, 'utf8'); }
    catch (failure) { error = String(failure); process.exitCode = 1; }
    fs.writeFileSync(process.env.FIXTURE_CLI_RECEIPT, JSON.stringify({content, error, parentExited}));
  }, 1500);
`,
    ],
    {
      detached: true,
      stdio: ["ignore", "ignore", stderr],
      env: {
        ...process.env,
        FIXTURE_CLI_PARENT: String(process.pid),
        FIXTURE_CLI_INPUT: path.join(process.env.APPDIR, "resources/worker-input.txt"),
      },
    },
  );
} finally {
  fs.closeSync(stderr);
}
child.unref();
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
// Establish a running worker before releasing the CLI's runtime mount.
void (async () => {
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(`${process.env.FIXTURE_CLI_RECEIPT}.ready`) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(
    fs.existsSync(`${process.env.FIXTURE_CLI_RECEIPT}.ready`),
    `Worker never became ready (exit=${child.exitCode}, signal=${child.signalCode})`,
  );
  assert.ok(fs.existsSync(process.env.APPDIR));
  console.log(
    JSON.stringify({
      args: process.argv.slice(4),
      argv0: process.env.ARGV0,
      appdir: process.env.APPDIR,
      runAsNode: process.env.ELECTRON_RUN_AS_NODE,
      display: process.env.DISPLAY,
      architecture: process.arch,
    }),
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
