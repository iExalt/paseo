import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";

const androidDir = path.join(import.meta.dirname, "android");
const helper = path.join(androidDir, "agent-adb.py");
const fixture = (name) => readFileSync(path.join(androidDir, "fixtures", name), "utf8");

// Runs only the helper's parsing and guards; none of these commands call adb.
function agentAdb(args, input = "", env = {}) {
  const { AGENT_ADB_ALLOW_PACKAGES: _inherited, ...base } = process.env;
  const result = spawnSync("python3", [helper, ...args], {
    input,
    encoding: "utf8",
    env: { ...base, ...env },
  });
  return { code: result.status, out: result.stdout.trimEnd(), err: result.stderr.trim() };
}

test("dump rows keep ids, decoded text, centres and state flags", () => {
  const { code, out } = agentAdb(["parse-dump"], fixture("dump.xml"));
  assert.equal(code, 0);
  assert.deepEqual(out.split("\n"), [
    "workspace-tab-agent-1 |  | Chat | 200,156 | selected",
    "workspace-tab-agent-1 |  | Chat 2 | 400,156 | ",
    'message-text | a > b && "c"\\nnext line |  | 400,230 | ',
    " | Café — 東京 ✓ |  | 200,320 | ",
    "direct-host-input | 127.0.0.1 |  | 310,430 | focused",
    "settings-notifications-toggle |  | Notifications | 2450,520 | checked,disabled",
  ]);
  assert.equal(agentAdb(["parse-dump", "--all"], fixture("dump.xml")).out.split("\n").length, 8);
});

test("a dump that uiautomator could not take points at the motion recipe", () => {
  const { code, err } = agentAdb(["parse-dump"], "ERROR: could not get idle state.\n");
  assert.equal(code, 4);
  assert.match(err, /animation scales.*paseo\.clock frozen/s);
});

test("focus names the focused component, or null", () => {
  const focus = (line) => agentAdb(["parse-focus"], `  mCurrentFocus=${line}\n`).out;
  assert.equal(
    focus("Window{a7f39c8 u0 sh.paseo/sh.paseo.MainActivity}"),
    "sh.paseo/sh.paseo.MainActivity",
  );
  assert.equal(
    focus(
      "Window{4922246 u0 com.android.launcher3/com.android.launcher3.uioverrides.QuickstepLauncher}",
    ),
    "com.android.launcher3/com.android.launcher3.uioverrides.QuickstepLauncher",
  );
  assert.equal(
    focus(
      "Window{1 u0 com.google.android.permissioncontroller/com.android.permissioncontroller.permission.ui.GrantPermissionsActivity}",
    ),
    "com.google.android.permissioncontroller/com.android.permissioncontroller.permission.ui.GrantPermissionsActivity",
  );
  assert.equal(focus("Window{2 u0 NotificationShade}"), "NotificationShade");
  assert.equal(focus("null"), "null");
});

test("turns come from the agent's last timeline line, and unknown when it is gone", () => {
  const log = [
    "10-31 10:00:00.000 I ReactNativeJS: [paseo-agent] timeline state agentId=a1 state=settled turns=7",
    "10-31 10:00:01.000 I ReactNativeJS: [paseo-agent] timeline state agentId=b2 state=running turns=0",
    "10-31 10:00:02.000 I ReactNativeJS: [paseo-agent] timeline state agentId=a1 state=loading turns=0",
    "10-31 10:00:03.000 I ReactNativeJS: [paseo-agent] timeline state agentId=a1 state=settled turns=1",
  ].join("\n");
  assert.equal(agentAdb(["parse-turns", "a1"], log).out, "settled 1");
  assert.equal(agentAdb(["parse-turns", "b2"], log).out, "running 0");
  assert.equal(agentAdb(["parse-turns", "c3"], log).out, "unknown");
});

test("driving the user's own app is refused unless explicitly allowed", () => {
  const refused = agentAdb(["--package", "sh.paseo.iexalt", "check-package"]);
  assert.equal(refused.code, 2);
  assert.match(refused.err, /user's own app/);
  assert.equal(
    agentAdb(["--package", "sh.paseo.iexalt", "--allow-user-app", "check-package"]).code,
    0,
  );
  assert.equal(agentAdb(["--package", "sh.paseo", "check-package"]).code, 0);
  // A device where the fork is a test install opts in through the environment instead.
  const optIn = (packages) =>
    agentAdb(["--package", "sh.paseo.iexalt", "check-package"], "", {
      AGENT_ADB_ALLOW_PACKAGES: packages,
    }).code;
  assert.equal(optIn("sh.paseo.debug, sh.paseo.iexalt"), 0);
  assert.equal(optIn("sh.paseo.iexalt.other"), 2);
  // Driving commands check the package before touching adb, so no device is needed here.
  const tap = agentAdb(["--package", "sh.paseo.iexalt", "tap", "menu-button"]);
  assert.equal(tap.code, 2);
  assert.match(tap.err, /user's own app/);
});

test("a lock is exclusive and only its owner can release it", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agent-adb-"));
  try {
    const lock = path.join(dir, "LOCK-test");
    assert.equal(agentAdb(["lock", lock, "first"]).code, 0);
    const held = agentAdb(["lock", lock, "second"]);
    assert.equal(held.code, 2);
    assert.match(held.err, /Locked: first /);
    assert.equal(agentAdb(["unlock", lock, "second"]).code, 2);
    assert.equal(agentAdb(["unlock", lock, "first"]).code, 0);
    assert.equal(agentAdb(["lock", lock, "second"]).code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([header, name, data, checksum]);
}

function onePixelPng() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function captureRunner(dir) {
  const inner = path.join(dir, "inner-adb-stub.py");
  writeFileSync(
    inner,
    `#!/usr/bin/env python3
import base64, os, sys, time
mode = os.environ["STUB_MODE"]
data = base64.b64decode(os.environ["STUB_PNG"])
if mode == "text":
    sys.stdout.write("mCurrentFocus=Window{abc u0 sh.paseo/sh.paseo.MainActivity}\\n")
elif mode == "invalid":
    sys.stdout.buffer.write(b"not a PNG")
elif mode == "truncated":
    sys.stdout.buffer.write(data[:-12])
elif mode == "nonzero":
    sys.stdout.buffer.write(data)
    sys.stderr.buffer.write(b"e" * 65536)
    sys.exit(23)
elif mode == "timeout":
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()
    time.sleep(10)
elif mode == "large":
    for _ in range(1024):
        sys.stdout.buffer.write(b"x" * 65536)
        sys.stdout.buffer.flush()
else:
    sys.stdout.buffer.write(data)
`,
  );
  chmodSync(inner, 0o700);
  const runner = path.join(dir, "capture-wrapper.py");
  writeFileSync(
    runner,
    `#!/usr/bin/env python3
import json, os, subprocess, sys
args = sys.argv[1:]
with open(os.environ["STUB_ARGV_RECORD"], "w", encoding="utf-8") as record:
    json.dump(args, record)
if args[:2] != ["--prefix", "two words"]:
    sys.exit(92)
result = subprocess.run(
    [sys.executable, os.environ["STUB_INNER"], *args[2:]],
    stdout=sys.stdout.buffer,
    stderr=sys.stderr.buffer,
    env=os.environ,
)
with open(os.environ["STUB_INNER_RESULT"], "w", encoding="utf-8") as record:
    record.write(str(result.returncode))
sys.exit(result.returncode)
`,
  );
  chmodSync(runner, 0o700);
  return { runner, inner };
}
function withCapture(t, mode, { timeout = "1" } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "agent-adb-capture-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { runner, inner } = captureRunner(dir);
  const output = path.join(dir, "screen.png");
  const receipt = path.join(dir, "receipt.json");
  const args = ["capture", "--output", output, "--receipt", receipt, "--timeout", timeout];
  const result = agentAdb(args, "", {
    AGENT_ADB: `${runner} --prefix 'two words'`,
    STUB_ARGV_RECORD: path.join(dir, "argv.json"),
    STUB_MODE: mode,
    STUB_INNER: inner,
    STUB_INNER_RESULT: path.join(dir, "inner-status.txt"),
    STUB_PNG: onePixelPng().toString("base64"),
  });
  return {
    ...result,
    dir,
    output,
    receipt,
    argvRecord: path.join(dir, "argv.json"),
    innerStatus: path.join(dir, "inner-status.txt"),
  };
}

test("capture preserves binary PNG bytes, validates dimensions, and keeps argv boundaries", (t) => {
  const result = withCapture(t, "success");
  const bytes = readFileSync(result.output);
  const receipt = JSON.parse(readFileSync(result.receipt, "utf8"));
  assert.equal(result.code, 0);
  assert.deepEqual(bytes, onePixelPng());
  assert.deepEqual(JSON.parse(readFileSync(result.argvRecord, "utf8")), [
    "--prefix",
    "two words",
    "exec-out",
    "screencap",
    "-p",
  ]);
  assert.equal(receipt.status, "success");
  assert.deepEqual(receipt.png_dimensions, [1, 1]);
  assert.equal(receipt.stdout_bytes, bytes.length);
  assert.equal(receipt.stdout_sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(statSync(result.output).mode & 0o777, 0o600);
  assert.equal(statSync(result.receipt).mode & 0o777, 0o600);
});

test("capture records wrapper failure, bounds stderr, and hashes retained stdout", (t) => {
  const result = withCapture(t, "nonzero");
  const bytes = readFileSync(result.output);
  const receipt = JSON.parse(readFileSync(result.receipt, "utf8"));
  assert.equal(result.code, 1);
  assert.match(result.err, /nonzero_exit/);
  assert.equal(receipt.status, "nonzero_exit");
  assert.equal(receipt.process, "capture-wrapper.py");
  assert.equal(receipt.process_status, 23);
  assert.equal("inner_process_status" in receipt, false);
  assert.equal(readFileSync(result.innerStatus, "utf8"), "23");
  assert.equal(receipt.stderr_bytes, 65536);
  assert.equal(receipt.stderr_truncated, true);
  assert.equal(Buffer.byteLength(receipt.stderr), 8192);
  assert.equal(receipt.stdout_bytes, bytes.length);
  assert.equal(receipt.stdout_sha256, createHash("sha256").update(bytes).digest("hex"));
});

test("capture times out, terminates the wrapper, and retains partial bytes", (t) => {
  const result = withCapture(t, "timeout", { timeout: "0.1" });
  const bytes = readFileSync(result.output);
  const receipt = JSON.parse(readFileSync(result.receipt, "utf8"));
  assert.equal(result.code, 1);
  assert.equal(receipt.status, "timeout");
  assert.equal(receipt.timed_out, true);
  assert.ok(receipt.process_status !== null);
  const expected = onePixelPng();
  assert.ok(bytes.length <= expected.length);
  assert.deepEqual(bytes, expected.subarray(0, bytes.length));
  assert.equal(receipt.stdout_bytes, bytes.length);
  assert.equal(receipt.stdout_file_bytes, bytes.length);
  assert.equal(receipt.stdout_truncated, false);
  assert.equal(receipt.stdout_sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.ok(receipt.elapsed_ms < 3000);
});

test("capture rejects an invalid PNG and retains its hash and raw bytes", (t) => {
  const result = withCapture(t, "invalid");
  const bytes = readFileSync(result.output);
  const receipt = JSON.parse(readFileSync(result.receipt, "utf8"));
  assert.equal(result.code, 1);
  assert.equal(receipt.status, "invalid_png");
  assert.match(receipt.error, /signature/);
  assert.equal(receipt.stdout_bytes, bytes.length);
  assert.equal(receipt.stdout_sha256, createHash("sha256").update(bytes).digest("hex"));
});

test("capture rejects a truncated PNG distinctly", (t) => {
  const result = withCapture(t, "truncated");
  const receipt = JSON.parse(readFileSync(result.receipt, "utf8"));
  assert.equal(result.code, 1);
  assert.equal(receipt.status, "invalid_png");
  assert.match(receipt.error, /Truncated PNG/);
  assert.equal(receipt.stdout_file_bytes, readFileSync(result.output).length);
});

test("capture caps streamed stdout and records the full observed length", (t) => {
  const result = withCapture(t, "large", { timeout: "5" });
  const receipt = JSON.parse(readFileSync(result.receipt, "utf8"));
  const bytes = readFileSync(result.output);
  assert.equal(result.code, 1);
  assert.equal(receipt.status, "output_limit");
  assert.equal(receipt.stdout_truncated, true);
  assert.ok(receipt.stdout_bytes > bytes.length);
  assert.equal(bytes.length, 32 * 1024 * 1024);
});

test("text adb remains a separate decoded-output path", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agent-adb-text-"));
  try {
    const { runner, inner } = captureRunner(dir);
    const result = agentAdb(["focus"], "", {
      AGENT_ADB: `${runner} --prefix 'two words'`,
      STUB_ARGV_RECORD: path.join(dir, "argv.json"),
      STUB_MODE: "text",
      STUB_INNER: inner,
      STUB_INNER_RESULT: path.join(dir, "inner-status.txt"),
      STUB_PNG: onePixelPng().toString("base64"),
    });
    assert.equal(result.code, 0);
    assert.equal(result.out, "sh.paseo/sh.paseo.MainActivity");
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "argv.json"), "utf8")), [
      "--prefix",
      "two words",
      "shell",
      "dumpsys window | grep mCurrentFocus",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
