"""Real ADB controls for a disposable signed-APK upgrade; no app-data reset."""
import json
import pathlib
import re
import shlex
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

previous, candidate, output, endpoint, version_code = sys.argv[1:]
output = pathlib.Path(output)
output.mkdir(parents=True, exist_ok=True)
app = "sh.paseo.iexalt"


def adb(*args, binary=False, timeout=30):
    return subprocess.check_output(["adb", "-s", "127.0.0.1:5555", *args], timeout=timeout,
                                   text=not binary)


def nodes():
    adb("shell", "uiautomator", "dump", "/sdcard/paseo-candidate-ui.xml")
    raw = adb("shell", "cat", "/sdcard/paseo-candidate-ui.xml")
    (output / "last-ui.xml").write_text(raw)
    return list(ET.fromstring(raw).iter("node"))


def matches(node, selector):
    return any(node.get(key) == selector for key in ("text", "content-desc", "resource-id")) or node.get("resource-id", "").endswith(":id/" + selector)


def wait(selector, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        found = [node for node in nodes() if matches(node, selector)]
        if found:
            return found[0]
        time.sleep(0.5)
    raise RuntimeError("Missing real UI control: " + selector)


def tap(selector):
    node = wait(selector)
    bounds = re.fullmatch(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", node.get("bounds", ""))
    if not bounds:
        raise RuntimeError("Missing tappable bounds: " + selector)
    x1, y1, x2, y2 = map(int, bounds.groups())
    adb("shell", "input", "tap", str((x1 + x2) // 2), str((y1 + y2) // 2))


def text(value):
    terminal_commands = {"printf PASEO_NATIVE_;echo PREVIOUS", "printf PASEO_NATIVE_;echo CANDIDATE"}
    if value not in terminal_commands and not re.fullmatch(r"[A-Za-z0-9_ .:/-]+", value):
        raise ValueError("Fixture input must not contain shell metacharacters")
    adb("shell", "input", "text", shlex.quote(value.replace(" ", "%s")))


def screenshot(name):
    (output / (name + ".png")).write_bytes(adb("exec-out", "screencap", "-p", binary=True))


try:
    adb("reverse", "tcp:18767", "tcp:18767")
    for stage, apk in [("previous", previous), ("candidate", candidate)]:
        if stage == "candidate":
            adb("shell", "am", "force-stop", app)
            stopped = subprocess.run(["adb", "-s", "127.0.0.1:5555", "shell", "pidof", app], capture_output=True, text=True, timeout=30)
            if stopped.returncode != 1 or stopped.stdout.strip():
                raise RuntimeError("Predecessor process remained alive")
            adb("install", "-r", apk, timeout=90)
        else:
            adb("install", apk, timeout=90)
        package = adb("shell", "dumpsys", "package", app)
        expected_code = "200008" if stage == "previous" else version_code
        if not re.search(r"versionCode=" + expected_code + r"\b", package) or "primaryCpuAbi=arm64-v8a" not in package:
            raise RuntimeError("Installed package identity differs from verified APK")
        (output / (stage + "-package.txt")).write_text(package)
        activity = adb("shell", "cmd", "package", "resolve-activity", "--brief", app).strip().splitlines()[-1]
        if not activity.startswith(app + "/"):
            raise RuntimeError("Unexpected activity")
        adb("logcat", "-c")
        adb("shell", "am", "start", "-W", "-n", activity)
        if stage == "previous":
            tap("welcome-direct-connection")
            tap("direct-host-input")
            text(endpoint)
            tap("direct-host-submit")
        else:
            # Reaching the saved host without entering its address proves app data survived.
            if any(matches(node, "welcome-screen") for node in nodes()):
                raise RuntimeError("Upgrade lost its saved connection")
        tap("menu-button")
        tap("Persisted Android workspace")
        wait("workspace-header-menu-trigger")
        screenshot(stage + "-workspace")
        tap("workspace-header-menu-trigger")
        tap("New terminal")
        tap("terminal-keyboard-toggle")
        marker = "PASEO_NATIVE_" + stage.upper()
        # Neither typed string contains the complete output marker.
        text("printf PASEO_NATIVE_;echo " + stage.upper())
        tap("terminal-key-enter")
        wait(marker)
        screenshot(stage + "-terminal")
        adb("shell", "input", "keyevent", "4")
        tap("menu-button")
        tap("Settings")
        tap("Appearance")
        if stage == "previous":
            tap("Theme: System")
            tap("Pure black")
        wait("Theme: Pure black")
        screenshot(stage + "-theme")
        crashes = adb("logcat", "-d", "-b", "crash")
        (output / (stage + "-crash.log")).write_text(crashes)
        if app in crashes:
            raise RuntimeError("App crash during native journey")
        (output / (stage + "-state.json")).write_text(json.dumps({"versionCode": expected_code,
            "connection": endpoint, "workspaceTitle": "Persisted Android workspace",
            "workspaceIdentityProof": "visible unique fixture title; native UI does not expose its ID",
            "theme": "Pure black", "terminalMarker": marker}))
finally:
    try:
        screenshot("final")
        (output / "final-crash.log").write_text(adb("logcat", "-d", "-b", "crash"))
    finally:
        adb("shell", "am", "force-stop", app)
        adb("reverse", "--remove", "tcp:18767")
