import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const androidDir = path.join(import.meta.dirname, "android");
const helper = path.join(androidDir, "agent-adb.py");
const fixture = (name) => readFileSync(path.join(androidDir, "fixtures", name), "utf8");

// Runs only the helper's parsing and guards; none of these commands call adb.
function agentAdb(args, input = "") {
  const result = spawnSync("python3", [helper, ...args], { input, encoding: "utf8" });
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

test("the user's own app is refused unless explicitly allowed", () => {
  const refused = agentAdb(["--package", "sh.paseo.iexalt", "check-package"]);
  assert.equal(refused.code, 2);
  assert.match(refused.err, /user's own app/);
  assert.equal(
    agentAdb(["--package", "sh.paseo.iexalt", "--allow-user-app", "check-package"]).code,
    0,
  );
  assert.equal(agentAdb(["--package", "sh.paseo", "check-package"]).code, 0);
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
