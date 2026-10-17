import { describe, expect, it } from "vitest";
import { mapNativePermission } from "./native-permission-status";

const details = {
  granted: "granted",
  prompt: "prompt",
  notGranted: "not granted",
  blocked: "blocked",
  unavailable: "unavailable",
};

describe("mapNativePermission", () => {
  it.each([
    [{ status: "granted", canAskAgain: true }, "granted", "none"],
    [{ status: "undetermined", canAskAgain: true }, "prompt", "request"],
    [{ status: "denied", canAskAgain: true }, "not-granted", "request"],
    [{ status: "denied", canAskAgain: false }, "denied", "open-settings"],
    // iOS provisional and ephemeral authorizations deliver notifications.
    [{ status: "denied", canAskAgain: false, ios: { status: 3 } }, "granted", "none"],
    [{ status: "undetermined", canAskAgain: true, ios: { status: 4 } }, "granted", "none"],
  ] as const)("maps %o to %s with action %s", (response, state, action) => {
    expect(mapNativePermission(response, details)).toMatchObject({ state, action });
  });

  it("reports a failed query or a build without the capability as unavailable", () => {
    expect(mapNativePermission(null, details)).toEqual({
      state: "unavailable",
      detail: "unavailable",
      action: "none",
    });
  });
});
