import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, symlinkSync } from "node:fs";
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
  const deadline = Date.now() + 10000;
  while (!existsSync(lateReceipt) && Date.now() < deadline) await delay(100);
  const worker = JSON.parse(readFileSync(lateReceipt));
  assert.equal(worker.content, "mounted worker input\n");
  assert.equal(worker.parentExited, true);
  console.log(
    "PASS: headless installed AppImage link, exact argv and delayed mounted-file access",
    receipt,
  );
}
