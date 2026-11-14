#!/usr/bin/env python3
"""Read and drive the Paseo Android app for agents: screen dumps, guarded taps, waits on
resource IDs and turn counts, deep links and debug switches.

The adb command comes from AGENT_ADB (default "adb"; adb itself honours ANDROID_SERIAL), for
example AGENT_ADB="/home/dev/cuttlefish/cf-tablet adb". See docs/agent-testing.md#android-helper.

Exit codes: 0 ok, 1 usage or adb error, 2 refused (focus or package), 3 not found or unknown,
4 the screen could not be dumped, 5 timed out.
"""

import argparse
import os
import re
import shlex
import subprocess
import sys
import time
import xml.etree.ElementTree as ElementTree

# The fork package is the user's own app on their phone. Commands that drive, restart or
# reconfigure the app refuse it unless --allow-user-app is passed or AGENT_ADB_ALLOW_PACKAGES
# names it; reading it is fine.
USER_APP_PACKAGES = {"sh.paseo.iexalt"}
# Relative to the package: sh.paseo.MainActivity, sh.paseo.iexalt.MainActivity, ...
MAIN_ACTIVITY = ".MainActivity"
DUMP_PATH = "/sdcard/agent-adb.xml"
FLAGS = ("selected", "focused", "checked")
FOCUS_RE = re.compile(r"mCurrentFocus=(?:Window\{\S+ \S+ ([^}\s]+)\}|(null))")
TIMELINE_RE = re.compile(
    r"\[paseo-agent\] timeline state agentId=(\S+) state=(\w+) turns=(\d+)"
)
IDLE_HINT = (
    "uiautomator could not get an idle screen. Set the animation scales to 0 and relaunch the "
    "app, and in a running chat start the app with --es paseo.clock frozen; see "
    "docs/agent-testing.md#motion-and-screen-dumps."
)


class Failure(Exception):
    def __init__(self, message, code=1):
        super().__init__(message)
        self.code = code


# Parsing, kept free of adb so tests can feed saved output.


def parse_dump(xml_text, include_all=False):
    """Rows of (id, text, desc, (x, y), flags) for each node in a uiautomator dump."""
    start = xml_text.find("<?xml")
    if start < 0:
        start = xml_text.find("<hierarchy")
    if start < 0:
        raise Failure(IDLE_HINT if "idle state" in xml_text else f"No dump: {xml_text.strip()[:200]}", 4)
    root = ElementTree.fromstring(xml_text[start:].strip().encode("utf-8"))
    rows = []
    for node in root.iter("node"):
        node_id = node.get("resource-id", "")
        text = node.get("text", "")
        desc = node.get("content-desc", "")
        if not include_all and not (node_id or text or desc):
            continue
        numbers = [int(n) for n in re.findall(r"-?\d+", node.get("bounds", ""))]
        centre = ((numbers[0] + numbers[2]) // 2, (numbers[1] + numbers[3]) // 2) if len(numbers) == 4 else None
        flags = [flag for flag in FLAGS if node.get(flag) == "true"]
        if node.get("enabled") == "false":
            flags.append("disabled")
        rows.append((node_id, text, desc, centre, flags))
    return rows


def format_row(row):
    node_id, text, desc, centre, flags = row
    where = f"{centre[0]},{centre[1]}" if centre else "-"
    one_line = lambda value: value.replace("\n", "\\n")
    return " | ".join([node_id, one_line(text), one_line(desc), where, ",".join(flags)])


def parse_focus(dumpsys_text):
    """The focused window's package and component, or (None, None) when nothing has focus."""
    for match in FOCUS_RE.finditer(dumpsys_text):
        component = match.group(1)
        if component:
            return (component.split("/", 1)[0] if "/" in component else None, component)
        return (None, None)
    return (None, None)


def parse_turns(logcat_text, agent_id):
    """(state, turns) from the agent's last `timeline state` line, or None if none is left."""
    last = None
    for match in TIMELINE_RE.finditer(logcat_text):
        if match.group(1) == agent_id:
            last = (match.group(2), int(match.group(3)))
    return last


def allowed_packages():
    """Packages named in AGENT_ADB_ALLOW_PACKAGES, for a device where they are test installs."""
    return {name.strip() for name in os.environ.get("AGENT_ADB_ALLOW_PACKAGES", "").split(",") if name.strip()}


def check_package(package, allow_user_app):
    if package in USER_APP_PACKAGES and not allow_user_app and package not in allowed_packages():
        raise Failure(
            f"Refusing to drive {package}: it is the user's own app. "
            "Pass --allow-user-app only with the user's go-ahead.",
            2,
        )


# Device access.


def adb(*args, check=True):
    command = shlex.split(os.environ.get("AGENT_ADB", "adb")) + list(args)
    result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if check and result.returncode != 0:
        raise Failure(f"{' '.join(command)} failed: {(result.stderr or result.stdout).strip()}")
    return result.stdout


def shell(command):
    return adb("shell", command)


def dump_screen(include_all=False):
    last_error = None
    for _ in range(3):
        out = shell(f"uiautomator dump {DUMP_PATH} 2>&1; cat {DUMP_PATH} 2>/dev/null; rm -f {DUMP_PATH}")
        try:
            return parse_dump(out, include_all)
        except Failure as error:
            last_error = error
            time.sleep(0.5)
    raise last_error


def focused():
    """Retries briefly: focus is null while windows change."""
    found = (None, None)
    for _ in range(5):
        found = parse_focus(shell("dumpsys window | grep mCurrentFocus"))
        if found[1]:
            break
        time.sleep(0.2)
    return found


def require_focus(package):
    focus_package, component = focused()
    if focus_package != package:
        raise Failure(f"Refused: {package} does not have focus ({component or 'nothing'} does)", 2)


def find_node(rows, node_id, nth):
    matches = [row for row in rows if row[0] == node_id]
    return matches[nth] if len(matches) > nth else None


def logcat():
    return adb("logcat", "-d", "-s", "ReactNativeJS:V")


# Commands.


def cmd_dump(args):
    for row in dump_screen(args.all):
        print(format_row(row))


def cmd_focus(args):
    focus_package, component = focused()
    print(component or "null")
    if focus_package != args.package:
        raise Failure("", 2)


def cmd_tap(args):
    check_package(args.package, args.allow_user_app)
    require_focus(args.package)
    row = find_node(dump_screen(), args.id, args.nth)
    if not row or not row[3]:
        raise Failure(f"Not found: {args.id}", 3)
    # The dump takes a second or more; a dialog that appeared meanwhile would take the tap.
    require_focus(args.package)
    shell(f"input tap {row[3][0]} {row[3][1]}")
    print(f"tapped {args.id} at {row[3][0]},{row[3][1]}")


def cmd_type(args):
    check_package(args.package, args.allow_user_app)
    require_focus(args.package)
    # `input text` takes %s for spaces and needs shell quoting for the rest.
    shell(f"input text {shlex.quote(args.text.replace(' ', '%s'))}")


def cmd_key(args):
    check_package(args.package, args.allow_user_app)
    require_focus(args.package)
    shell(f"input keyevent {shlex.quote(args.key)}")


def cmd_wait(args):
    deadline = time.monotonic() + args.timeout
    while True:
        present = find_node(dump_screen(), args.id, 0) is not None
        if present != args.gone:
            print(f"{args.id} {'gone' if args.gone else 'present'}")
            return
        if time.monotonic() > deadline:
            raise Failure(f"Timed out waiting for {args.id} to {'go' if args.gone else 'appear'}", 5)
        time.sleep(0.5)


def cmd_open(args):
    check_package(args.package, args.allow_user_app)
    if args.cold:
        shell(f"am force-stop {args.package}")
    out = shell(
        f"am start -W -a android.intent.action.VIEW -d {shlex.quote(args.url)} {args.package}"
    )
    print(out.strip())


def cmd_switch(args):
    check_package(args.package, args.allow_user_app)
    extras = []
    for pair in args.switches:
        key, separator, value = pair.partition("=")
        if not separator or not key or not value:
            raise Failure(f"Switches are key=value, got {pair!r}")
        extras += ["--es", f"paseo.{key}", shlex.quote(value)]
    print(shell(" ".join(["am start -n", f"{args.package}/{MAIN_ACTIVITY}", *extras])).strip())


def cmd_turns(args):
    last = parse_turns(logcat(), args.agent)
    if last is None:
        # Not 0: the line may have rotated out of the buffer, and 0 would match old lines.
        print("unknown")
        raise Failure("", 3)
    print(last[1])


def cmd_wait_turn(args):
    """Waits until the agent's latest line is settled with more turns than --after."""
    deadline = time.monotonic() + args.timeout
    while True:
        last = parse_turns(logcat(), args.agent)
        if last and last[0] == "settled" and last[1] > args.after:
            print(last[1])
            return
        if last and last[0] == "error":
            raise Failure(f"Timeline error for {args.agent}", 1)
        if time.monotonic() > deadline:
            raise Failure(f"Timed out; last line: {last}", 5)
        time.sleep(0.5)


def cmd_lock(args):
    try:
        fd = os.open(args.file, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
    except FileExistsError:
        with open(args.file, encoding="utf-8") as held:
            raise Failure(f"Locked: {held.read().strip()}", 2)
    with os.fdopen(fd, "w", encoding="utf-8") as lock:
        lock.write(f"{args.owner} {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}\n")


def cmd_unlock(args):
    try:
        with open(args.file, encoding="utf-8") as held:
            holder = held.read().split(" ", 1)[0]
    except FileNotFoundError:
        return
    if holder != args.owner:
        raise Failure(f"Not unlocking: {args.file} belongs to {holder}", 2)
    os.remove(args.file)


def cmd_parse_dump(args):
    for row in parse_dump(sys.stdin.read(), args.all):
        print(format_row(row))


def cmd_parse_focus(args):
    print(parse_focus(sys.stdin.read())[1] or "null")


def cmd_parse_turns(args):
    last = parse_turns(sys.stdin.read(), args.agent)
    print(f"{last[0]} {last[1]}" if last else "unknown")


def cmd_check_package(args):
    check_package(args.package, args.allow_user_app)


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--package", default="sh.paseo", help="app package (default sh.paseo)")
    parser.add_argument("--allow-user-app", action="store_true", help="allow driving the user's own app")
    commands = parser.add_subparsers(dest="command", required=True)

    def add(name, handler, help_text):
        sub = commands.add_parser(name, help=help_text)
        sub.set_defaults(handler=handler)
        return sub

    add("dump", cmd_dump, "print id | text | desc | centre | flags").add_argument("--all", action="store_true")
    add("focus", cmd_focus, "print the focused window; exit 2 unless the package has it")
    tap = add("tap", cmd_tap, "tap a resource ID, only while the package has focus")
    tap.add_argument("id")
    tap.add_argument("--nth", type=int, default=0)
    add("type", cmd_type, "type ASCII text (input text drops the rest), only while the package has focus").add_argument("text")
    add("key", cmd_key, "send a key event (ENTER, 66, ...), only while the package has focus").add_argument("key")
    wait = add("wait", cmd_wait, "wait for a resource ID to appear, or with --gone to go")
    wait.add_argument("id")
    wait.add_argument("--gone", action="store_true")
    wait.add_argument("--timeout", type=float, default=20)
    open_link = add("open", cmd_open, "open a deep link, with --cold after a force-stop")
    open_link.add_argument("url")
    open_link.add_argument("--cold", action="store_true")
    add("switch", cmd_switch, "set debug switches: key=value ...").add_argument("switches", nargs="+")
    add("turns", cmd_turns, "print an agent's closed-turn count from the log").add_argument("agent")
    wait_turn = add("wait-turn", cmd_wait_turn, "wait for an agent to settle with more turns")
    wait_turn.add_argument("agent")
    wait_turn.add_argument("--after", type=int, required=True)
    wait_turn.add_argument("--timeout", type=float, default=60)
    for name, handler in (("lock", cmd_lock), ("unlock", cmd_unlock)):
        sub = add(name, handler, f"{name} a device lock file where this helper runs")
        sub.add_argument("file")
        sub.add_argument("owner")
    add("parse-dump", cmd_parse_dump, "parse a dump from stdin").add_argument("--all", action="store_true")
    add("parse-focus", cmd_parse_focus, "parse dumpsys window output from stdin")
    add("parse-turns", cmd_parse_turns, "parse logcat from stdin").add_argument("agent")
    add("check-package", cmd_check_package, "exit 2 for the user's own app")
    return parser


def main(argv):
    args = build_parser().parse_args(argv)
    try:
        args.handler(args)
    except Failure as error:
        if str(error):
            print(error, file=sys.stderr)
        return error.code
    except ElementTree.ParseError as error:
        print(f"Unreadable dump: {error}", file=sys.stderr)
        return 4
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
