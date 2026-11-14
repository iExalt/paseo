import { describe, expect, it } from "vitest";
import { codeBlockLanguageName } from "./code-block-language";

describe("codeBlockLanguageName", () => {
  it("names known languages the way the native header does", () => {
    expect(codeBlockLanguageName("ts")).toBe("TypeScript");
    expect(codeBlockLanguageName("SH")).toBe("Shell");
  });

  it("capitalizes unknown languages and ignores fence attributes", () => {
    expect(codeBlockLanguageName("KOTLIN {1,3}")).toBe("Kotlin");
  });

  it("is empty without a language", () => {
    expect(codeBlockLanguageName(null)).toBe("");
    expect(codeBlockLanguageName("  ")).toBe("");
  });
});
