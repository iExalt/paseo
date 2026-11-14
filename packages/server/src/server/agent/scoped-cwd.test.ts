import { describe, expect, it } from "vitest";
import { resolveScopedAgentCwd } from "./scoped-cwd.js";

describe("resolveScopedAgentCwd", () => {
  it("uses a locked caller directory over a requested directory", () => {
    expect(
      resolveScopedAgentCwd({
        callerAgent: { cwd: "/workspace/parent" },
        callerContext: { lockedCwd: "/workspace/locked", allowCustomCwd: true },
        requestedCwd: "../other",
      }),
    ).toBe("/workspace/locked");
  });

  it("resolves allowed custom caller directories relative to the caller", () => {
    expect(
      resolveScopedAgentCwd({
        callerAgent: { cwd: "/workspace/parent" },
        callerContext: { allowCustomCwd: true },
        requestedCwd: "../sibling",
      }),
    ).toBe("/workspace/sibling");
  });

  it("keeps callers in their own directory when custom directories are forbidden", () => {
    expect(
      resolveScopedAgentCwd({
        callerAgent: { cwd: "/workspace/parent" },
        callerContext: { allowCustomCwd: false },
        requestedCwd: "/elsewhere",
      }),
    ).toBe("/workspace/parent");
  });

  it("requires a directory for an unscoped caller", () => {
    expect(() => resolveScopedAgentCwd({ callerAgent: null, required: true })).toThrow(
      "cwd is required",
    );
  });
});
