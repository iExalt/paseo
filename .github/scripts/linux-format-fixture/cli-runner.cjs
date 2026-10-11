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
  setTimeout(() => {
    let parentExited = false;
    try { process.kill(Number(process.env.FIXTURE_CLI_PARENT), 0); }
    catch (error) { if (error.code !== 'ESRCH') throw error; parentExited = true; }
    const content = fs.readFileSync(process.env.FIXTURE_CLI_INPUT, 'utf8');
    fs.writeFileSync(process.env.FIXTURE_CLI_RECEIPT, JSON.stringify({content, parentExited}));
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
