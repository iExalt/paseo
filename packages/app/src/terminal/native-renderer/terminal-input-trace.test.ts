import { describe, expect, it } from "vitest";
import { redactTerminalTraceText } from "./terminal-input-trace";

describe("terminal input trace redaction", () => {
  it("keeps the input's shape without its characters", () => {
    expect(redactTerminalTraceText("pw: Hunter2!\x7f\r한")).toBe("aap aaaaaa0p\x7f\ra");
    expect(redactTerminalTraceText("é€")).toBe("au");
  });
});
