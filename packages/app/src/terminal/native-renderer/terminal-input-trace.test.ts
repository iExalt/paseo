import { afterEach, describe, expect, it, vi } from "vitest";
import { redactTerminalTraceKey, redactTerminalTraceText } from "./terminal-input-trace";

describe("terminal input trace redaction", () => {
  it("keeps the input's shape without its characters", () => {
    expect(redactTerminalTraceText("pw: Hunter2!\x7f\r한")).toBe("aap aaaaaa0p\x7f\ra");
    expect(redactTerminalTraceText("é€")).toBe("au");
  });

  it("keeps key names but redacts short commits reported as keys", () => {
    expect(redactTerminalTraceKey("Backspace")).toBe("Backspace");
    expect(redactTerminalTraceKey("ArrowUp")).toBe("ArrowUp");
    expect(redactTerminalTraceKey("Hi")).toBe("aa");
    expect(redactTerminalTraceKey(". ")).toBe("p ");
    expect(redactTerminalTraceKey("C-c")).toBe("C-c");
    expect(redactTerminalTraceKey("C-ArrowUp")).toBe("C-ArrowUp");
    expect(redactTerminalTraceKey("C-ab")).toBe("apaa");
    expect(redactTerminalTraceKey("C-")).toBe("ap");
  });
});

describe("terminal input reset trace", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("marks whether the change after a clear still holds the cleared text", async () => {
    vi.stubEnv("EXPO_PUBLIC_PASEO_TERMINAL_INPUT_TRACE", "1");
    vi.resetModules();
    const trace = await import("./terminal-input-trace");
    const lines: Record<string, unknown>[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => {
      lines.push(JSON.parse(line.replace("[paseo-terminal-trace] ", "")));
    });

    trace.traceTerminalReset("show-keyboard");
    trace.traceTerminalInput("change", "ls\n", "ls\r");
    trace.traceTerminalReset("enter");
    trace.traceTerminalInput("change", "ls\nx", "x");
    trace.traceTerminalReset("key-enter");
    trace.traceTerminalInput("change", "y", "y");
    trace.traceTerminalInput("change", "yz", "z");

    expect(lines.map(({ t: _t, ...line }) => line)).toEqual([
      { reset: "show-keyboard", fieldChars: 0 },
      {
        kind: "change",
        raw: "aa\n",
        sent: "aa\r",
        afterReset: "show-keyboard",
        changeChars: 3,
        stale: null,
      },
      { reset: "enter", fieldChars: 3 },
      { kind: "change", raw: "aa\na", sent: "a", afterReset: "enter", changeChars: 4, stale: true },
      { reset: "key-enter", fieldChars: 4 },
      {
        kind: "change",
        raw: "a",
        sent: "a",
        afterReset: "key-enter",
        changeChars: 1,
        stale: false,
      },
      { kind: "change", raw: "aa", sent: "a" },
    ]);
  });
});
