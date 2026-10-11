const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const [mode, ready, ...args] = process.argv.slice(2);
assert.equal(process.platform, "win32");
if (mode === "normal") {
  assert.deepEqual(args, ["space value", 'quote"value', "tail with space\\", ""]);
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},100)"], { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code === 0 ? 0 : 1));
} else {
  assert.ok(["negative", "alive"].includes(mode));
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  fs.writeFileSync(ready, JSON.stringify({ primary: process.pid, detached: child.pid }));
  if (mode === "negative") process.exit(7);
  setInterval(() => {}, 1000);
}
