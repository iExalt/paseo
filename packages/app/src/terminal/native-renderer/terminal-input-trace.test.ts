import { describe, expect, it } from "vitest";
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
    expect(redactTerminalTraceKey("C-")).toBe("ap");
  });
});
