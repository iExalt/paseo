import { describe, expect, it } from "vitest";
import { createCli } from "./cli.js";

describe("canonical CLI surface", () => {
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
    expect(agentClose?.helpInformation()).toContain("Agent ID or unambiguous ID prefix");
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
