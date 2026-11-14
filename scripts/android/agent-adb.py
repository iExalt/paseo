#!/usr/bin/env python3
"""Read and drive the Paseo Android app for agents: screen dumps, guarded taps, waits on
resource IDs and turn counts, deep links and debug switches.

The adb command comes from AGENT_ADB (default "adb"; adb itself honours ANDROID_SERIAL), for
example AGENT_ADB="/home/dev/cuttlefish/cf-tablet adb". See docs/agent-testing.md#android-helper.

Exit codes: 0 ok, 1 usage or adb error, 2 refused (focus or package), 3 not found or unknown,
4 the screen could not be dumped, 5 timed out.
"""

import argparse
import hashlib
import json
import os
import re
import shlex
import signal
import struct
import subprocess
import sys
import threading
import time
import xml.etree.ElementTree as ElementTree
import zlib

# The fork package is the user's own app on their phone. Commands that drive, restart or
# reconfigure the app refuse it unless --allow-user-app is passed or AGENT_ADB_ALLOW_PACKAGES
# names it; reading it is fine.
USER_APP_PACKAGES = {"sh.paseo.iexalt"}
# Relative to the package: sh.paseo.MainActivity, sh.paseo.iexalt.MainActivity, ...
MAIN_ACTIVITY = ".MainActivity"
DUMP_PATH = "/sdcard/agent-adb.xml"
MAX_CAPTURE_BYTES = 32 * 1024 * 1024
MAX_CAPTURE_STDERR_BYTES = 8192
MAX_PNG_CHUNKS = 4096
CAPTURE_TIMEOUT_SECONDS = 20
MAX_CAPTURE_TIMEOUT_SECONDS = 120
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
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


def _read_stdout(pipe, output_file, state, exceeded_limit, reader_failed):
    try:
        while chunk := pipe.read(65536):
            state["hash"].update(chunk)
            state["bytes"] += len(chunk)
            remaining = max(0, MAX_CAPTURE_BYTES - state["written"])
            if remaining:
                output_file.write(chunk[:remaining])
                state["written"] += min(remaining, len(chunk))
            if state["written"] < state["bytes"]:
                exceeded_limit.set()
    except Exception as error:
        state["error"] = str(error)
        reader_failed.set()


def _read_stderr(pipe, state):
    try:
        while chunk := pipe.read(4096):
            state["bytes"] += len(chunk)
            remaining = MAX_CAPTURE_STDERR_BYTES - len(state["text"])
            if remaining > 0:
                state["text"].extend(chunk[:remaining])
    except Exception as error:
        state["error"] = str(error)


def _stop_process(process):
    try:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGTERM)
        else:
            process.terminate()
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=1)
    except subprocess.TimeoutExpired:
        if os.name == "posix":
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        else:
            process.kill()
        process.wait()
    if os.name == "posix":
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def validate_png(path):
    """Validate bounded PNG chunk structure and return its dimensions."""
    size = os.path.getsize(path)
    if size > MAX_CAPTURE_BYTES:
        raise Failure("PNG exceeds the capture size limit")
    with open(path, "rb") as png:
        if png.read(len(PNG_SIGNATURE)) != PNG_SIGNATURE:
            raise Failure("Invalid PNG signature")
        dimensions = None
        saw_image_data = False
        for chunk_number in range(MAX_PNG_CHUNKS):
            header = png.read(8)
            if len(header) != 8:
                raise Failure("Truncated PNG before IEND")
            length, chunk_type = struct.unpack(">I4s", header)
            if length > size - png.tell() - 4:
                raise Failure("Truncated PNG chunk")
            if chunk_number == 0 and (chunk_type != b"IHDR" or length != 13):
                raise Failure("PNG must start with a 13-byte IHDR")
            if chunk_number > 0 and chunk_type == b"IHDR":
                raise Failure("PNG contains a second IHDR")
            if chunk_type == b"IEND" and length != 0:
                raise Failure("PNG IEND must be empty")

            crc = zlib.crc32(chunk_type)
            chunk_data = bytearray() if chunk_type == b"IHDR" else None
            remaining = length
            while remaining:
                part = png.read(min(65536, remaining))
                if not part:
                    raise Failure("Truncated PNG chunk data")
                crc = zlib.crc32(part, crc)
                if chunk_data is not None:
                    chunk_data.extend(part)
                remaining -= len(part)
            crc_bytes = png.read(4)
            if len(crc_bytes) != 4:
                raise Failure("Truncated PNG CRC")
            if int.from_bytes(crc_bytes, "big") != crc:
                raise Failure(f"Invalid PNG CRC for {chunk_type.decode('ascii', 'replace')}")

            if chunk_type == b"IHDR":
                width, height = struct.unpack(">II", chunk_data[:8])
                if width == 0 or height == 0:
                    raise Failure("PNG dimensions must be nonzero")
                dimensions = (width, height)
            elif chunk_type == b"IDAT" and length:
                saw_image_data = True
            elif chunk_type == b"IEND":
                if not saw_image_data:
                    raise Failure("PNG has no image data")
                if png.read(1):
                    raise Failure("PNG has data after IEND")
                return dimensions
        raise Failure(f"PNG exceeds the {MAX_PNG_CHUNKS}-chunk limit")


def _private_file(path):
    return os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb")


def capture_png(output_path, receipt_path, timeout):
    if not 0 < timeout <= MAX_CAPTURE_TIMEOUT_SECONDS:
        raise Failure(f"Capture timeout must be between 0 and {MAX_CAPTURE_TIMEOUT_SECONDS:g}s")
    output_path = os.path.abspath(output_path)
    receipt_path = os.path.abspath(receipt_path)
    if output_path == receipt_path:
        raise Failure("Output and receipt paths must differ")
    output_file = None
    receipt_file = None
    try:
        output_file = _private_file(output_path)
        receipt_file = _private_file(receipt_path)
    except OSError as error:
        if output_file:
            output_file.close()
            os.remove(output_path)
        raise Failure(f"Capture paths must be fresh writable files: {error}") from error

    command = shlex.split(os.environ.get("AGENT_ADB", "adb")) + ["exec-out", "screencap", "-p"]
    stdout_state = {"hash": hashlib.sha256(), "bytes": 0, "written": 0, "error": None}
    stderr_state = {"text": bytearray(), "bytes": 0, "error": None}
    exceeded_limit = threading.Event()
    reader_failed = threading.Event()
    started = time.monotonic()
    process = None
    timed_out = False
    output_limit = False
    launch_error = None
    png_dimensions = None
    status = "launch_error"

    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
            start_new_session=(os.name == "posix"),
        )
        stdout_reader = threading.Thread(
            target=_read_stdout,
            args=(process.stdout, output_file, stdout_state, exceeded_limit, reader_failed),
            daemon=True,
        )
        stderr_reader = threading.Thread(
            target=_read_stderr,
            args=(process.stderr, stderr_state),
            daemon=True,
        )
        stdout_reader.start()
        stderr_reader.start()
        deadline = started + timeout
        while process.poll() is None:
            if exceeded_limit.is_set():
                output_limit = True
                _stop_process(process)
                break
            if reader_failed.is_set():
                _stop_process(process)
                break
            if time.monotonic() >= deadline:
                timed_out = True
                _stop_process(process)
                break
            exceeded_limit.wait(0.02)
        if process.poll() is None:
            process.wait()
        stdout_reader.join(timeout=2)
        stderr_reader.join(timeout=2)
        output_file.flush()
        output_limit = output_limit or exceeded_limit.is_set()
        if stdout_reader.is_alive() or stderr_reader.is_alive():
            status = "reader_timeout"
            _stop_process(process)
            stdout_reader.join(timeout=1)
            stderr_reader.join(timeout=1)
        if status != "reader_timeout":
            if stdout_state["error"] or stderr_state["error"]:
                status = "reader_error"
            elif output_limit:
                status = "output_limit"
            elif timed_out:
                status = "timeout"
            elif process.returncode != 0:
                status = "nonzero_exit"
            else:
                try:
                    png_dimensions = validate_png(output_path)
                    status = "success"
                except Failure as error:
                    status = "invalid_png"
                    launch_error = str(error)
    except OSError as error:
        launch_error = str(error)

    output_file.flush()
    os.fsync(output_file.fileno())
    output_file.close()
    stderr_text = bytes(stderr_state["text"]).decode("utf-8", errors="replace")
    receipt = {
        "status": status,
        "argv": command,
        "process": os.path.basename(command[0]) if command else None,
        "pid": process.pid if process else None,
        "process_status": process.returncode if process else None,
        "timed_out": timed_out,
        "elapsed_ms": round((time.monotonic() - started) * 1000),
        "stdout_bytes": stdout_state["bytes"],
        "stdout_sha256": stdout_state["hash"].hexdigest(),
        "stdout_file_bytes": stdout_state["written"],
        "stdout_truncated": stdout_state["written"] != stdout_state["bytes"],
        "stderr_bytes": stderr_state["bytes"],
        "stderr_truncated": stderr_state["bytes"] > len(stderr_state["text"]),
        "stderr": stderr_text,
        "png_dimensions": list(png_dimensions) if png_dimensions else None,
    }
    if launch_error:
        receipt["error"] = launch_error
    receipt_file.write(json.dumps(receipt, indent=2).encode("utf-8") + b"\n")
    receipt_file.flush()
    os.fsync(receipt_file.fileno())
    receipt_file.close()
    if status != "success":
        reason = launch_error or f"{receipt['process']} exited {receipt['process_status']}"
        if timed_out:
            reason = f"{receipt['process']} timed out after {timeout:g}s"
        if status == "output_limit":
            reason = f"Capture exceeded {MAX_CAPTURE_BYTES} bytes"
        reader_error = stdout_state["error"] or stderr_state["error"]
        if reader_error:
            reason += f": stream reader failed: {reader_error}"
        if stderr_text:
            reason += f": {stderr_text}"
        raise Failure(f"Capture failed ({status}); raw output and receipt retained: {reason}")
    return receipt


def cmd_capture(args):
    capture_png(args.output, args.receipt, args.timeout)


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

    capture = add("capture", cmd_capture, "capture a binary-safe PNG and private receipt")
    capture.add_argument("--output", required=True, help="new private file for raw PNG bytes")
    capture.add_argument("--receipt", required=True, help="new private file for command receipt JSON")
    capture.add_argument("--timeout", type=float, default=CAPTURE_TIMEOUT_SECONDS)
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
