import { describe, expect, it } from "vitest";
import { stripLegacyInternalPaseoMcpServer } from "./runtime-mcp-config.js";

describe("legacy internal Paseo MCP config cleanup", () => {
  it("removes only stored HTTP or SSE configs targeting the retired endpoint", () => {
    const input = {
      provider: "codex",
      cwd: "/workspace/project",
      mcpServers: {
        paseo: {
          type: "http",
          url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=stale-agent",
        },
        issueTracker: { type: "stdio", command: "tracker-mcp" },
      },
    } as const;

    expect(stripLegacyInternalPaseoMcpServer(input)).toEqual({
      provider: "codex",
      cwd: "/workspace/project",
      mcpServers: { issueTracker: { type: "stdio", command: "tracker-mcp" } },
    });
    expect(
      stripLegacyInternalPaseoMcpServer({
        provider: "codex",
        cwd: "/workspace/project",
        mcpServers: {
          paseo: { type: "sse", url: "https://localhost/mcp/agents" },
          issueTracker: { type: "stdio", command: "tracker-mcp" },
        },
      }),
    ).toEqual({
      provider: "codex",
      cwd: "/workspace/project",
      mcpServers: { issueTracker: { type: "stdio", command: "tracker-mcp" } },
    });
  });

  it("preserves unrelated user Paseo and third-party MCP server configs", () => {
    const config = {
      provider: "codex",
      cwd: "/workspace/project",
      mcpServers: {
        paseo: { type: "stdio", command: "paseo-tools" },
        issueTracker: { type: "http", url: "https://example.test/mcp" },
      },
    } as const;

    expect(stripLegacyInternalPaseoMcpServer(config)).toBe(config);
  });
});
