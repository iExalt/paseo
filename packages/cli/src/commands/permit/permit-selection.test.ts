import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { describe, expect, it } from "vitest";
import { resolvePermissionRequest, selectPermissionRequests } from "./allow.js";

const requests: AgentPermissionRequest[] = [
  { id: "permission-first", provider: "claude", name: "Read", kind: "tool" },
  { id: "permission-second", provider: "claude", name: "Write", kind: "tool" },
];

describe("permission response target selection", () => {
  it("preserves allow-all when the request ID is omitted and when --all is explicit", () => {
    expect(selectPermissionRequests({ pendingPermissions: requests })).toEqual(requests);
    expect(selectPermissionRequests({ pendingPermissions: requests, all: true })).toEqual(requests);
  });

  it("requires an unambiguous request when a response action is selected", () => {
    expect(() =>
      selectPermissionRequests({
        pendingPermissions: [
          { ...requests[0]!, id: "permission-a" },
          { ...requests[1]!, id: "permission-ab" },
        ],
        requestId: "permission-",
        requireUnambiguousPrefix: true,
      }),
    ).toThrow("Permission request ID prefix is ambiguous");
  });

  it("preserves legacy first-prefix matching while preferring exact IDs for richer responses", () => {
    const pendingPermissions = [
      { ...requests[0]!, id: "permission-exact-extra" },
      { ...requests[1]!, id: "permission-exact" },
    ];

    expect(resolvePermissionRequest({ pendingPermissions, requestId: "permission-exact" }).id).toBe(
      "permission-exact-extra",
    );
    expect(
      resolvePermissionRequest({
        pendingPermissions,
        requestId: "permission-exact",
        requireUnambiguousPrefix: true,
      }).id,
    ).toBe("permission-exact");
    expect(
      resolvePermissionRequest({
        pendingPermissions: requests,
        requestId: "permission-f",
        requireUnambiguousPrefix: true,
      }).id,
    ).toBe("permission-first");
  });
});
