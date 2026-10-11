import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";

const receipt = JSON.parse(readFileSync(process.argv[2], "utf8"));
assert.equal(receipt.token, process.env.FIXTURE_TOKEN);
assert.equal(receipt.architecture, process.env.FIXTURE_ARCH);
assert.equal(receipt.format, process.env.FIXTURE_FORMAT);
assert.notEqual(receipt.uid, 0);
const identity = (stat) => stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
function alive() {
  return receipt.processes.filter(({ pid, stat }) => {
    try {
      return identity(readFileSync(`/proc/${pid}/stat`, "utf8")) === identity(stat);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ESRCH") return false;
      throw error;
    }
  });
}
const deadline = Date.now() + 10000;
while (
  (alive().length || (receipt.mount && existsSync(receipt.mount.target))) &&
  Date.now() < deadline
) {
  await setTimeout(100);
}
assert.deepEqual(
  alive().map(({ pid }) => pid),
  [],
  "Owned Electron processes must exit normally",
);
if (receipt.mount)
  assert.equal(existsSync(receipt.mount.target), false, "Owned FUSE mount must disappear");
console.log(
  `${receipt.format}: normal exit, renderer sandbox=${receipt.renderer.sandboxed}; ${receipt.reason}`,
);
