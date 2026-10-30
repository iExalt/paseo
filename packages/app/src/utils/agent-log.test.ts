import { describe, expect, it } from "vitest";
import { describeError, formatAgentLog } from "./agent-log";

describe("formatAgentLog", () => {
  it("writes one grep-able line with quoted values", () => {
    expect(
      formatAgentLog("connection", "status", {
        serverId: "srv_1",
        status: "online",
        error: null,
        transport: undefined,
        lastError: "connect ECONNREFUSED 127.0.0.1:6767",
      }),
    ).toBe(
      '[paseo-agent] connection status serverId=srv_1 status=online error=null lastError="connect ECONNREFUSED 127.0.0.1:6767"',
    );
  });

  it("keeps pairing links, relay URIs and push tokens out of error reasons", () => {
    const error = new TypeError(
      "Decoder error in paseo://pair#offer=eyJzZWNyZXQiOiJrZXkifQ from relay://relay.paseo.sh/abc?k=secret for ExponentPushToken[abcdef123]",
    );

    const line = formatAgentLog("link", "import", { reason: describeError(error) });

    expect(line).toContain("reason=");
    expect(line).not.toContain("eyJzZWNyZXQiOiJrZXkifQ");
    expect(line).not.toContain("relay.paseo.sh/abc");
    expect(line).not.toContain("abcdef123");
  });
});
