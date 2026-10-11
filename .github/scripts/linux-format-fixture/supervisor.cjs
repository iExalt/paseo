const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const receipt = process.env.FIXTURE_CLI_RECEIPT;
assert.equal(process.env.PASEO_APPIMAGE_SUPERVISOR, undefined);
const input = path.join(process.env.APPDIR, "resources/worker-input.txt");
fs.writeFileSync(
  `${receipt}.ready`,
  JSON.stringify({
    pid: process.pid,
    start: fs.readFileSync("/proc/self/stat", "utf8").split(") ").at(-1).split(" ")[19],
    execPath: process.execPath,
    appdir: process.env.APPDIR,
    inputExists: fs.existsSync(input),
  }),
);
const deadline = Date.now() + 15000;
const timer = setInterval(() => {
  try {
    if (Date.now() > deadline) throw new Error("Supervisor stop deadline exceeded");
    if (fs.existsSync(`${receipt}.read`) && !fs.existsSync(receipt)) {
      let parentExited = false;
      try {
        process.kill(Number(process.env.FIXTURE_CLI_PARENT), 0);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
        parentExited = true;
      }
      const cli = JSON.parse(
        execFileSync(process.env.PASEO_CLI, ["stable-link-probe", "argument with spaces"], {
          encoding: "utf8",
          timeout: 5000,
        }),
      );
      fs.writeFileSync(
        receipt,
        JSON.stringify({ content: fs.readFileSync(input, "utf8"), parentExited, cli }),
      );
    }
    if (fs.existsSync(`${receipt}.stop`)) {
      clearInterval(timer);
      fs.writeFileSync(`${receipt}.stopped`, JSON.stringify({ stopAcknowledged: true }));
    }
  } catch (error) {
    clearInterval(timer);
    console.error(error);
    process.exitCode = 1;
  }
}, 50);
