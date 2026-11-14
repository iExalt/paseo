import { describe, expect, it } from "vitest";
import {
  decodeAndroidAgentTag,
  decodeExpoForeignAgentIdentifier,
  encodeAndroidAgentTag,
} from "./android-notification-tag.js";

const value = {
  serverId: "srv:漢字/%",
  agentId: "agent:1",
  reason: "permission" as const,
  nonce: "12345678-1234-4abc-8def-123456789abc",
};

describe("Android agent notification tags", () => {
  it("round trips a canonical tag through Expo's foreign notification identifier", () => {
    const tag = encodeAndroidAgentTag(value)!;
    expect(decodeAndroidAgentTag(tag)).toEqual(value);
    expect(
      decodeExpoForeignAgentIdentifier(
        `expo-notifications://foreign_notifications?tag=${encodeURIComponent(tag)}&id=0`,
      ),
    ).toEqual(value);
  });

  it("rejects malformed, noncanonical, oversized or unknown tags", () => {
    const tag = encodeAndroidAgentTag(value)!;
    expect(encodeAndroidAgentTag({ ...value, serverId: "" })).toBeNull();
    expect(encodeAndroidAgentTag({ ...value, agentId: "x".repeat(1025) })).toBeNull();
    expect(encodeAndroidAgentTag({ ...value, serverId: "\ud800" })).toBeNull();
    expect(encodeAndroidAgentTag({ ...value, nonce: "bad" })).toBeNull();
    expect(decodeAndroidAgentTag(tag.replace("%3A", "%3a"))).toBeNull();
    expect(decodeAndroidAgentTag(tag + ":extra")).toBeNull();
    expect(decodeAndroidAgentTag(tag.replace("paseo-agent-v1", "paseo-agent-v2"))).toBeNull();
    const id = `expo-notifications://foreign_notifications?tag=${encodeURIComponent(tag)}&id=0`;
    for (const invalid of [
      id + "&id=1",
      id + "#fragment",
      id.replace("&id=0", "&id=-0"),
      id.replace("&id=0", "&id=2147483648"),
      id.replace("foreign_notifications?", "foreign_notifications/path?"),
    ]) {
      expect(decodeExpoForeignAgentIdentifier(invalid)).toBeNull();
    }
  });
});
