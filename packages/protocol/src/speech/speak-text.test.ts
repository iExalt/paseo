import { describe, expect, it } from "vitest";
import { MAX_SPEAK_TEXT_LENGTH, normalizeSpeakText } from "./speak-text.js";

describe("normalizeSpeakText", () => {
  it("trims text and accepts the inclusive length limit", () => {
    expect(normalizeSpeakText("  hello  ")).toBe("hello");
    expect(normalizeSpeakText("x".repeat(MAX_SPEAK_TEXT_LENGTH))).toHaveLength(
      MAX_SPEAK_TEXT_LENGTH,
    );
  });

  it("rejects empty and over-limit text with MCP-compatible messages", () => {
    expect(() => normalizeSpeakText("  \n ")).toThrow("text is required");
    expect(() => normalizeSpeakText("x".repeat(MAX_SPEAK_TEXT_LENGTH + 1))).toThrow(
      "text must be 4000 characters or fewer",
    );
  });
});
