import { Command } from "commander";
import { createCli } from "../../cli.js";
import { runImportDiscovery } from "./import.js";
import { describe, expect, it, vi } from "vitest";
import { resolveImportCwd, runImportCommand } from "./import.js";

const importAgent = vi.fn();
const close = vi.fn();

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(async () => ({
    importAgent,
    close,
  })),
  getDaemonHost: vi.fn(() => "ws://127.0.0.1:6767"),
}));

describe("resolveImportCwd", () => {
  it("uses the invoking process cwd when --cwd is omitted", () => {
    expect(resolveImportCwd(undefined, "/Volumes/data/dev/rolepai")).toBe(
      "/Volumes/data/dev/rolepai",
    );
  });

  it("uses explicit --cwd when provided", () => {
    expect(resolveImportCwd(" /tmp/project ", "/Volumes/data/dev/rolepai")).toBe("/tmp/project");
  });

  it("rejects an empty explicit --cwd", () => {
    expect(() => resolveImportCwd("  ", "/Volumes/data/dev/rolepai")).toThrow(
      expect.objectContaining({
        code: "INVALID_CWD",
      }),
    );
  });

  it("accepts pi as an import provider", async () => {
    importAgent.mockResolvedValueOnce({
      id: "agent-1",
      status: "idle",
      provider: "pi",
      cwd: "/tmp/project",
      title: "Imported Pi session",
    });

    const result = await runImportCommand(
      "pi-session-1",
      {
        daemonTarget: { kind: "endpoint", host: "example.test:12345" },
        provider: "pi",
        cwd: "/tmp/project",
      },
      {} as never,
    );

    expect(importAgent).toHaveBeenCalledWith({
      provider: "pi",
      sessionId: "pi-session-1",
      cwd: "/tmp/project",
    });
    expect(result.data.provider).toBe("pi");
  });
});

it("import discovery forwards explicit daemon paths and preserves partial provider errors", async () => {
  const target = { kind: "endpoint" as const, host: "import-host:1234" };
  const payload = {
    requestId: "recent",
    entries: [],
    filteredAlreadyImportedCount: 2,
    providerErrors: [{ provider: "codex", message: "Unavailable" }],
  };
  let closed = 0;
  for (const cwd of [undefined, "/remote/project"]) {
    const result = await runImportDiscovery(
      { daemonTarget: target, provider: "codex", cwd },
      new Command(),
      async (connectionOptions) => {
        expect(connectionOptions.target).toEqual(target);
        return {
          fetchRecentProviderSessions: async (request) => {
            expect(request).toEqual({ cwd, providers: ["codex"] });
            return payload;
          },
          close: async () => {
            closed++;
          },
        };
      },
    );
    expect(result.data).toBe(payload);
  }
  expect(closed).toBe(2);
});

it("import listing rejects IDs and labels while regular import still requires an ID", async () => {
  const target = { kind: "endpoint" as const, host: "import-host:1234" };
  await expect(
    runImportCommand("session", { daemonTarget: target, list: true }, new Command()),
  ).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
  await expect(
    runImportCommand(
      undefined,
      { daemonTarget: target, list: true, label: ["x=y"] },
      new Command(),
    ),
  ).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
  await expect(
    runImportCommand(undefined, { daemonTarget: target }, new Command()),
  ).rejects.toMatchObject({ code: "MISSING_SESSION_ID" });
});

it("parses agent import --list without a provider or session ID", async () => {
  const program = createCli().exitOverride();
  const agent = program.commands.find((command) => command.name() === "agent")!;
  const command = agent.commands.find((child) => child.name() === "import")!;
  let parsedId: string | undefined;
  let parsedOptions: unknown;
  command.action((id: string | undefined, _options, parsed: Command) => {
    parsedId = id;
    parsedOptions = parsed.optsWithGlobals();
  });
  await program.parseAsync(["agent", "import", "--list", "--json", "--host", "import-host:1234"], {
    from: "user",
  });
  expect(parsedId).toBeUndefined();
  expect(parsedOptions).toMatchObject({ list: true, json: true, host: "import-host:1234" });
});
