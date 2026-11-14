import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

vi.mock("./commands/daemon/local-daemon.js", async (original) => ({
  ...(await original<typeof import("./commands/daemon/local-daemon.js")>()),
  launchLocalDaemon: vi.fn(),
}));

import { launchLocalDaemon } from "./commands/daemon/local-daemon.js";
import { createCli } from "./cli.js";
import { resolveCliVersion } from "./version.js";

describe("canonical CLI surface", () => {
  it.each([{ options: [] }, { options: ["--json"] }, { options: ["--format", "yaml"] }])(
    "prints offline prime conventions with global options %j",
    async ({ options }) => {
      const cli = createCli();
      const output: string[] = [];
      const prime = cli.commands.find((command) => command.name() === "prime");
      expect(prime).toBeDefined();
      prime!.configureOutput({ writeOut: (text) => output.push(text) });
      await cli.parseAsync(["--host", "not-a-daemon", ...options, "prime"], {
        from: "user",
      });

      const text = output.join("");
      expect(text).toContain(`Paseo CLI ${resolveCliVersion()} conventions`);
      expect(text).toContain('quoted executable "$PASEO_CLI"');
      expect(text).toContain("provider session IDs");
      expect(text).toContain("run requires --provider");
      expect(text).toContain("--prompt-file -");
      expect(text).toContain("7d");
      expect(text).toContain("parse stdout only");
      expect(text).toContain("agent query --json");
      expect(text).toContain("details under snapshot");
      expect(text).toContain("Reconcile existing agents");
      expect(text).toContain('Request --cwd "$PWD"');
      expect(text).toContain("running agents still require --force");
      expect(text).toContain("Send the handoff first");
      expect(text).toContain("prime always prints text, even with --json");
    },
  );

  it.each(["send", "agent send"])("%s accepts an explicit behavior override", async (path) => {
    const cli = createCli();
    const owner =
      path === "send" ? cli : cli.commands.find((command) => command.name() === "agent")!;
    const send = owner.commands.find((command) => command.name() === "send")!;
    send.action(() => {});
    await send.parseAsync(["target", "message", "--behavior", "interrupt"], { from: "user" });
    expect(send.opts().behavior).toBe("interrupt");
    await send.parseAsync(["target", "message", "--behavior", "steer"], { from: "user" });
    expect(send.opts().behavior).toBe("steer");
    send.exitOverride().configureOutput({ writeErr: () => {} });
    await expect(
      send.parseAsync(["target", "message", "--behavior", "queue"], { from: "user" }),
    ).rejects.toThrow();
  });

  it("offers daemon host selection as a global option", () => {
    expect(createCli().helpInformation()).toContain("--host <host>");
  });

  it("offers saved agent profile discovery", () => {
    const profile = createCli().commands.find((command) => command.name() === "profile");
    const list = profile?.commands.find((command) => command.name() === "ls");

    expect(list?.helpInformation()).toContain("--json");
    expect(list?.helpInformation()).toContain("--host <host>");
  });

  it("offers provider inspection with cwd and draft settings", () => {
    const provider = createCli().commands.find((command) => command.name() === "provider");
    const inspect = provider?.commands.find((command) => command.name() === "inspect");

    expect(inspect?.helpInformation()).toContain("--cwd <path>");
    expect(inspect?.helpInformation()).toContain("--caller-agent <id>");
    expect(inspect?.helpInformation()).toContain("--feature <id=value>");
    expect(inspect?.helpInformation()).toContain("--features-json <object>");
  });

  it("offers dedicated agent query, status, and curated activity commands", () => {
    const agent = createCli().commands.find((command) => command.name() === "agent");
    const query = agent?.commands.find((command) => command.name() === "query");
    const status = agent?.commands.find((command) => command.name() === "status");
    const activity = agent?.commands.find((command) => command.name() === "activity");

    expect(query?.helpInformation()).toContain("--include-archived");
    expect(query?.helpInformation()).toContain("--include-background");
    expect(query?.helpInformation()).toContain("--since-hours <hours>");
    expect(query?.helpInformation()).toContain("--status <status>");
    expect(status?.helpInformation()).toContain("<agent-id>");
    expect(activity?.helpInformation()).toContain("--limit <number>");
  });

  it("explains managed terminal directories and self-archive handoff", () => {
    const cli = createCli();
    const terminal = cli.commands.find((command) => command.name() === "terminal");
    const create = terminal?.commands.find((command) => command.name() === "create");
    const workspace = cli.commands.find((command) => command.name() === "workspace");
    const archiveWorkspace = workspace?.commands.find((command) => command.name() === "archive");
    const agent = cli.commands.find((command) => command.name() === "agent");
    const archiveAgent = agent?.commands.find((command) => command.name() === "archive");

    expect(create?.helpInformation()).toContain("caller's scoped directory");
    expect(create?.helpInformation()).toContain('--cwd "$PWD"');
    const archiveHelp = [archiveWorkspace, archiveAgent].map((command) => {
      const output: string[] = [];
      command!.configureOutput({ writeOut: (text) => output.push(text) });
      command!.outputHelp();
      return output.join("");
    });
    expect(archiveHelp[0]).toContain("terminate the invoking shell");
    expect(archiveHelp[1]).toContain("Self-archive with --force");
    expect(archiveHelp[1]).toContain("Send the handoff first");
  });

  it("explains workspace classification, archive ownership, and foreground output", () => {
    const cli = createCli();
    const workspace = cli.commands.find((command) => command.name() === "workspace")!;
    const daemon = cli.commands.find((command) => command.name() === "daemon")!;
    const help = (owner: typeof cli, name: string) => {
      const output: string[] = [];
      const command = owner.commands.find((entry) => entry.name() === name)!;
      command.configureOutput({ writeOut: (text) => output.push(text) });
      command.outputHelp();
      return output.join("");
    };
    expect(help(workspace, "create")).toContain("actual Git classification");
    expect(help(workspace, "create")).toContain(
      "Classification does not establish Paseo ownership",
    );
    expect(help(workspace, "archive")).toContain("dirty, untracked, and ignored files");
    expect(help(workspace, "archive")).toContain(
      "External directories not owned by Paseo are preserved",
    );
    expect(help(daemon, "run")).toContain("Foreground output streams text logs");
    expect(help(daemon, "run")).toContain("daemon start or daemon status with --json");
  });

  it("shows project, workspace, and heartbeat commands while hiding worktree compatibility", () => {
    const cli = createCli();
    const help = cli.helpInformation();
    expect(help).toContain("project");
    expect(help).toContain("workspace");
    expect(help).toContain("heartbeat");
    expect(help).not.toContain("worktree");
  });

  it("offers identical top-level and daemon config reload commands", () => {
    const cli = createCli();
    const reload = cli.commands.find((command) => command.name() === "reload");
    const daemon = cli.commands.find((command) => command.name() === "daemon");
    const nestedReload = daemon?.commands.find((command) => command.name() === "reload");

    expect(reload?.helpInformation()).toContain("--host <host>");
    expect(reload?.helpInformation()).toContain("--json");
    expect(nestedReload?.helpInformation()).toContain("--host <host>");
    expect(nestedReload?.helpInformation()).toContain("--json");
  });

  it("names explicit workspace creation without exposing older syntax", () => {
    const run = createCli().commands.find((command) => command.name() === "run");
    const help = run?.helpInformation();
    expect(help).toContain("--new-workspace <local|worktree>");
    expect(help).not.toContain("--isolation");
    expect(help).not.toContain("--worktree <name>");
  });

  it("offers the worktree creation options on run", () => {
    const run = createCli().commands.find((command) => command.name() === "run");
    const help = run?.helpInformation();
    expect(help).toContain("--worktree-mode <mode>");
    expect(help).toContain("--worktree-slug <slug>");
    expect(help).toContain("--new-branch <name>");
    expect(help).toContain("--branch <name>");
    expect(help).toContain("--pr-number <n>");
    expect(help).toContain("--forge <forge>");
  });

  it("uses --no-wait for execution, --internal for visibility, and reserves detach for ownership", () => {
    const run = createCli().commands.find((command) => command.name() === "run");
    const help = run?.helpInformation();
    expect(help).toContain("--no-wait");
    expect(help).not.toContain("--background");
    expect(help).not.toContain("--background");
    expect(help).not.toContain("--detach");
  });

  it("hides internal agents and workspaces from listings unless --internal is passed", () => {
    const cli = createCli();
    const ls = cli.commands.find((command) => command.name() === "ls");
    const workspace = cli.commands.find((command) => command.name() === "workspace");
    const workspaceLs = workspace?.commands.find((command) => command.name() === "ls");
    const workspaceCreate = workspace?.commands.find((command) => command.name() === "create");

    expect(ls?.helpInformation()).toContain("--background");
    expect(workspaceLs?.helpInformation()).toContain("--background");
    expect(workspaceCreate?.helpInformation()).toContain("--background");
  });

  it("offers runtime settings when running, updating, and scheduling agents", () => {
    const cli = createCli();
    const run = cli.commands.find((command) => command.name() === "run");
    const agent = cli.commands.find((command) => command.name() === "agent");
    const agentRun = agent?.commands.find((command) => command.name() === "run");
    const agentClose = agent?.commands.find((command) => command.name() === "close");
    const update = agent?.commands.find((command) => command.name() === "update");
    const schedule = cli.commands.find((command) => command.name() === "schedule");
    const scheduleCreate = schedule?.commands.find((command) => command.name() === "create");

    expect(run?.helpInformation()).toContain("--thinking <id>");
    expect(run?.helpInformation()).toContain("--feature <id=value>");
    expect(run?.helpInformation()).toContain("comma-separated");
    expect(agentRun?.helpInformation()).toContain("--feature <id=value>");
    expect(agentClose?.helpInformation()).toContain(
      "Agent ID, unambiguous ID prefix, or full session ID",
    );
    expect(agentClose?.helpInformation()).toContain("preserving its history");
    expect(update?.helpInformation()).toContain("--mode <id>");
    expect(update?.helpInformation()).toContain("--model <id>");
    expect(update?.helpInformation()).toContain("--clear-model");
    expect(update?.helpInformation()).toContain("--thinking <id>");
    expect(update?.helpInformation()).toContain("--clear-thinking");
    expect(update?.helpInformation()).toContain("--feature <id=value>");
    expect(update?.helpInformation()).toContain("comma-separated");
    expect(scheduleCreate?.helpInformation()).toContain("--thinking <id>");
  });

  it("offers opening an existing agent in the desktop app", () => {
    const agent = createCli().commands.find((command) => command.name() === "agent");
    const open = agent?.commands.find((command) => command.name() === "open");

    expect(open?.helpInformation()).toContain("<agent-id>");
    expect(open?.helpInformation()).toContain("--server <server-id>");
  });

  it("offers the complete local plugin lifecycle", () => {
    const plugin = createCli().commands.find((command) => command.name() === "plugin");

    expect(plugin?.commands.map((command) => command.name())).toEqual([
      "init",
      "ls",
      "status",
      "logs",
      "install",
      "update",
      "reload",
      "enable",
      "disable",
      "remove",
    ]);
    expect(
      plugin?.commands.find((command) => command.name() === "init")?.helpInformation(),
    ).toContain("--id <id>");
    expect(
      plugin?.commands.find((command) => command.name() === "install")?.helpInformation(),
    ).toContain("--id <id>");
  });
});

it("preserves omitted and explicit false workspace background intent", () => {
  const readOptions = (args: string[]) => {
    const workspace = createCli().commands.find((command) => command.name() === "workspace")!;
    const create = workspace.commands.find((command) => command.name() === "create")!;
    create.parseOptions(args);
    return create.opts();
  };
  expect(readOptions([]).background).toBeUndefined();
  expect(readOptions(["--background"]).background).toBe(true);
  expect(readOptions(["--no-background"]).background).toBe(false);
});

describe("foreground daemon output contract", () => {
  const exitCode = process.exitCode;
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(launchLocalDaemon).mockReset();
    process.exitCode = exitCode;
  });

  it.each([
    { args: ["--json"], format: "json" },
    { args: ["--format", "json"], format: "json" },
    { args: ["--format", " JSON "], format: "json" },
    { args: ["--format", "yaml"], format: "yaml" },
    { args: ["--format", " YAML "], format: "yaml" },
  ])("rejects $args before launching", async ({ args }) => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${code}`);
    });

    await expect(
      createCli().parseAsync(["daemon", "run", ...args], { from: "user" }),
    ).rejects.toThrow("exit 1");

    expect(launchLocalDaemon).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledTimes(1);
    const error = String(stderr.mock.calls[0][0]);
    expect(YAML.parse(error).error).toMatchObject({
      code: "INVALID_FORMAT",
      message: expect.stringContaining("streams text logs"),
    });
  });

  it.each([{ args: [] }, { args: ["--format", "table"] }, { args: ["--format", "cli"] }])(
    "retains foreground launch in text mode $args",
    async ({ args }) => {
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      vi.mocked(launchLocalDaemon).mockResolvedValue({
        spawned: true,
        instance: { pid: 123 } as Awaited<ReturnType<typeof launchLocalDaemon>>["instance"],
        exitCode: 7,
      });
      await createCli().parseAsync(["daemon", "run", ...args], { from: "user" });
      expect(launchLocalDaemon).toHaveBeenCalledExactlyOnceWith({
        home: expect.any(String),
        foreground: true,
      });
      expect(process.exitCode).toBe(7);
    },
  );
});

describe("subagent command dispatch", () => {
  it("routes parent listing and provider timeline independently", async () => {
    const cli = createCli();
    const agent = cli.commands.find((command) => command.name() === "agent")!;
    const subagents = agent.commands.find((command) => command.name() === "subagents")!;
    const timeline = subagents.commands.find((command) => command.name() === "timeline")!;
    const seen: string[] = [];
    subagents.action((parent) => {
      seen.push(`list:${parent}`);
    });
    timeline.action((parent, sub) => {
      seen.push(`timeline:${parent}:${sub}`);
    });
    await cli.parseAsync(["agent", "subagents", "parent", "--json"], { from: "user" });
    await cli.parseAsync(["agent", "subagents", "timeline", "parent", "native", "--json"], {
      from: "user",
    });
    expect(seen).toEqual(["list:parent", "timeline:parent:native"]);
  });
  it("requires both timeline identifiers", async () => {
    const cli = createCli();
    const agent = cli.commands.find((command) => command.name() === "agent")!;
    const subagents = agent.commands.find((command) => command.name() === "subagents")!;
    const timeline = subagents.commands.find((command) => command.name() === "timeline")!;
    timeline.exitOverride().configureOutput({ writeErr: () => {} });
    await expect(timeline.parseAsync(["parent"], { from: "user" })).rejects.toMatchObject({
      code: "commander.missingArgument",
    });
  });
});
