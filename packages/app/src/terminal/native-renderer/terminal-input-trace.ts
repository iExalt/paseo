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

function traceText(text: string): string {
  return TRACE_FULL_TEXT ? text : redactTerminalTraceText(text);
}

export type TerminalInputTraceKind = "key" | "change" | "hwkey";

export function traceTerminalInput(kind: TerminalInputTraceKind, raw: string, sent: string): void {
  if (!TERMINAL_TRACE_ENABLED) {
    return;
  }
  console.log(
    `[paseo-terminal-trace] ${JSON.stringify({
      t: nativeTerminalPerformanceNow(),
      kind,
      // Named keys such as `Backspace` are kept; a typed character is not.
      raw: kind === "change" || raw.length === 1 ? traceText(raw) : raw,
      sent: traceText(sent),
    })}`,
  );
}

export type TerminalLatencyStage = "send" | "recv" | "parsed" | "paint";

export function traceTerminalLatency(stage: TerminalLatencyStage, chars: number): void {
  if (!TERMINAL_TRACE_ENABLED) {
    return;
  }
  console.log(
    `[paseo-terminal-trace] ${JSON.stringify({ t: nativeTerminalPerformanceNow(), stage, chars })}`,
  );
}
