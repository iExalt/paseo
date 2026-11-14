import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { describe, expect, it } from "vitest";
import { resolvePermissionRequest, selectPermissionRequests, shortPermissionId } from "./allow.js";

const requests: AgentPermissionRequest[] = [
  { id: "permission-first", provider: "claude", name: "Read", kind: "tool" },
  { id: "permission-second", provider: "claude", name: "Write", kind: "tool" },
];

describe("permission response target selection", () => {
  it("preserves allow-all when the request ID is omitted and when --all is explicit", () => {
    expect(selectPermissionRequests({ pendingPermissions: requests })).toEqual(requests);
    expect(selectPermissionRequests({ pendingPermissions: requests, all: true })).toEqual(requests);
  });

  it("rejects an ambiguous prefix, prefers an exact ID, and resolves the short ID ls shows", () => {
    const pendingPermissions = [
      { ...requests[0]!, id: "permission-3fa2b1c4-aaaa" },
      { ...requests[1]!, id: "permission-3fa2b1c4" },
    ];

    expect(() =>
      selectPermissionRequests({ pendingPermissions, requestId: "permission-" }),
    ).toThrow("Permission request ID prefix is ambiguous");
    expect(
      resolvePermissionRequest({ pendingPermissions, requestId: "permission-3fa2b1c4" }).id,
    ).toBe("permission-3fa2b1c4");
    expect(resolvePermissionRequest({ pendingPermissions: requests, requestId: "sec" }).id).toBe(
      "permission-second",
    );
    expect(shortPermissionId("permission-3fa2b1c4-aaaa")).toBe("3fa2b1c4");
  });
});
