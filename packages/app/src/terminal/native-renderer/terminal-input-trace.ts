import { nativeTerminalPerformanceNow } from "./terminal-performance";

// Dev-only trace of native terminal input order and echo latency, written to
// logcat (ReactNativeJS) as one `[paseo-terminal-trace]` JSON line per event.
// EXPO_PUBLIC_* is inlined at bundle time, so a normal build carries only the
// disabled branch. "1" logs character classes; "full" logs the typed text,
// including anything typed at a password prompt.
const TRACE_MODE = process.env.EXPO_PUBLIC_PASEO_TERMINAL_INPUT_TRACE;

export const TERMINAL_TRACE_ENABLED = TRACE_MODE === "1" || TRACE_MODE === "full";
const TRACE_FULL_TEXT = TRACE_MODE === "full";

/**
 * Letters become `a`, digits `0`, other printable ASCII `p`, other non-ASCII
 * `u`. Spaces and control characters stay, since they carry no secret and
 * show the input order.
 */
export function redactTerminalTraceText(text: string): string {
  let result = "";
  for (const character of text) {
    if (/\p{L}/u.test(character)) {
      result += "a";
    } else if (/\p{N}/u.test(character)) {
      result += "0";
    } else if (character <= " " || character === "\x7f") {
      result += character;
    } else if (character <= "~") {
      result += "p";
    } else {
      result += "u";
    }
  }
  return result;
}

// React Native reports a commit of up to two characters as a key, so only
// these names are logged as they are.
const TERMINAL_KEY_NAMES =
  "Backspace|Enter|Tab|Escape|Delete|Home|End|PageUp|PageDown|Insert|Arrow(?:Up|Down|Left|Right)|F\\d{1,2}";
const TERMINAL_KEY_NAME_PATTERN = new RegExp(`^(?:${TERMINAL_KEY_NAMES})$`);

// A chord such as `C-c` is kept: chords are commands, not typed text.
const TERMINAL_CHORD_PATTERN = new RegExp(`^(?:[CAM]-)+(?:.|${TERMINAL_KEY_NAMES})$`, "u");

export function redactTerminalTraceKey(key: string): string {
  if (TERMINAL_KEY_NAME_PATTERN.test(key) || TERMINAL_CHORD_PATTERN.test(key)) {
    return key;
  }
  return traceText(key);
}

function traceText(text: string): string {
  return TRACE_FULL_TEXT ? text : redactTerminalTraceText(text);
}

// JSON leaves DEL unescaped, which hides a sent Backspace in a log viewer.
function writeTraceLine(json: string): void {
  console.log(`[paseo-terminal-trace] ${json.replaceAll("\x7f", "\\u007f")}`);
}

export type TerminalInputTraceKind = "key" | "change" | "hwkey";

export function traceTerminalInput(kind: TerminalInputTraceKind, raw: string, sent: string): void {
  if (!TERMINAL_TRACE_ENABLED) {
    return;
  }
  writeTraceLine(
    JSON.stringify({
      t: nativeTerminalPerformanceNow(),
      kind,
      raw: kind === "change" ? traceText(raw) : redactTerminalTraceKey(raw),
      sent: traceText(sent),
    }),
  );
}

export type TerminalLatencyStage = "send" | "recv" | "parsed" | "paint";

export function traceTerminalLatency(stage: TerminalLatencyStage, chars: number): void {
  if (!TERMINAL_TRACE_ENABLED) {
    return;
  }
  writeTraceLine(JSON.stringify({ t: nativeTerminalPerformanceNow(), stage, chars }));
}
