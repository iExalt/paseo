import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { runCaptureCommand } from "./capture.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const malformedValues = ["", "1x", "1.5", "9007199254740992", "Infinity"];
const malformedRanges = ["--start", "--end"].flatMap((flag) =>
  malformedValues.map((value) => ({ flag, value })),
);

it.each(malformedRanges)(
  "rejects malformed $flag value '$value' before connecting",
  async ({ flag, value }) => {
    let errorOutput = "";
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      errorOutput += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    });
    vi.spyOn(process, "exit").mockImplementation(function mockProcessExit(): never {
      throw new Error("CAPTURE_EXIT");
    });

    await expect(
      runCaptureCommand(
        "terminal-id",
        {
          daemonTarget: { kind: "endpoint", host: "127.0.0.1:1" },
          json: true,
          ...(flag === "--start" ? { start: value } : { end: value }),
        },
        new Command(),
      ),
    ).rejects.toThrow("CAPTURE_EXIT");

    expect(JSON.parse(errorOutput)).toMatchObject({
      error: { code: "INVALID_LINE_NUMBER", message: `Invalid ${flag} value: ${value}` },
    });
  },
);
