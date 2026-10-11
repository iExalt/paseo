import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = process.env.FORMAT_ROOT;
const link = join(root, "paseo");
symlinkSync(process.env.FIXTURE_APPIMAGE, link);
for (const mode of ["injected", "trailing"]) {
  const arguments_ = ["path with spaces", "literal'quote", "$(touch never)", "--class=keep"];
  if (mode === "trailing") arguments_.push("--no-sandbox");
  const lateReceipt = join(root, `evidence/appimage-cli-${mode}-worker.json`);
  const result = execFileSync(link, arguments_, {
    encoding: "utf8",
    timeout: 15000,
    env: { ...process.env, DISPLAY: "", FIXTURE_CLI_RECEIPT: lateReceipt },
  });
  const receipt = JSON.parse(result);
  assert.deepEqual(receipt.args, arguments_);
  assert.equal(receipt.argv0, link);
  assert.equal(receipt.runAsNode, "1");
  assert.equal(receipt.display, "");
  assert.equal(receipt.architecture, process.env.EXPECTED_ARCHITECTURE);
  assert.ok(receipt.appdir.startsWith(`${process.env.TMPDIR}/.mount_`));
  const ready = JSON.parse(readFileSync(`${lateReceipt}.ready`));
  assert.equal(ready.pid, receipt.supervisorPid);
  assert.equal(receipt.cli, link);
  assert.notEqual(ready.appdir, receipt.appdir);
  assert.ok(ready.appdir.startsWith(`${process.env.TMPDIR}/.mount_`));
  assert.equal(ready.inputExists, true);
  const mounted = (directory) =>
    readFileSync("/proc/self/mountinfo", "utf8")
      .split("\n")
      .some((line) => line.split(" ")[4] === directory);
  const unmountDeadline = Date.now() + 5000;
  while (mounted(receipt.appdir) && Date.now() < unmountDeadline) await delay(50);
  const afterCliExit = {
    mounted: mounted(receipt.appdir),
    supervisorMounted: mounted(ready.appdir),
  };
  assert.equal(afterCliExit.mounted, false);
  assert.equal(afterCliExit.supervisorMounted, true);
  writeFileSync(`${lateReceipt}.read`, "read after original mount is gone");
  const deadline = Date.now() + 10000;
  while (!existsSync(lateReceipt) && Date.now() < deadline) await delay(100);
  writeFileSync(
    `${lateReceipt}.observation`,
    JSON.stringify({
      receipt,
      ready,
      afterCliExit,
      afterWait: { mounted: mounted(receipt.appdir), supervisorMounted: mounted(ready.appdir) },
    }),
  );
  const worker = JSON.parse(readFileSync(lateReceipt));
  assert.equal(worker.content, "mounted worker input\n");
  assert.equal(worker.parentExited, true);
  assert.deepEqual(worker.cli, { cli: link, args: ["stable-link-probe", "argument with spaces"] });
  writeFileSync(`${lateReceipt}.stop`, "stop");
  const sameProcess = () => {
    try {
      const fields = readFileSync(`/proc/${ready.pid}/stat`, "utf8").split(") ").at(-1).split(" ");
      return fields[19] === ready.start && fields[0] !== "Z";
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ESRCH") return false;
      throw error;
    }
  };
  const stopDeadline = Date.now() + 5000;
  while ((mounted(ready.appdir) || sameProcess()) && Date.now() < stopDeadline) await delay(50);
  assert.equal(mounted(ready.appdir), false);
  assert.equal(sameProcess(), false);
  assert.deepEqual(JSON.parse(readFileSync(`${lateReceipt}.stopped`)), { stopAcknowledged: true });
  writeFileSync(
    `${lateReceipt}.termination`,
    JSON.stringify({
      pid: ready.pid,
      start: ready.start,
      sameProcess: false,
      mounted: false,
      stopAcknowledged: true,
    }),
  );
  console.log(
    "PASS: headless AppImage CLI, separate supervisor mount, stable link reuse and normal stop",
    receipt,
  );
}
