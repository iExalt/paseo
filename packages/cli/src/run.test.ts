import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createCli } from "./cli";
import { createCliParseArgv } from "./run";

const runModuleUrl = new URL("./run.ts", import.meta.url).href;

// Runs the CLI in a child process whose stdout pipe has no reader, as when the
// program that launched it has already closed its end.
async function runCliWithClosedStdout(
  argv: string[],
): Promise<{ code: number | null; stderr: string }> {
  const script = `
    const { runCli } = await import(${JSON.stringify(runModuleUrl)});
    process.exitCode = await runCli(${JSON.stringify(argv)});
    await new Promise((resolve) => setTimeout(resolve, 100));
    process.stderr.write("still running\\n");
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.destroy();
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  return { code, stderr };
}

async function runCliInChild(
  argv: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const script = `const { runCli } = await import(${JSON.stringify(runModuleUrl)}); process.exitCode = await runCli(${JSON.stringify(argv)});`;
  const home = mkdtempSync(path.join(tmpdir(), "paseo-cli-errors-"));
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    env: { ...process.env, PASEO_HOME: home, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  try {
    expect(readdirSync(home)).toEqual([]);
    return { code, stdout, stderr };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("runCli", () => {
  it.each([
    { argv: ["ls", "--json", "--invalid-option"], error: "commander.unknownOption" },
    { argv: ["agent", "inspect", "--json"], error: "commander.missingArgument" },
    {
      argv: ["clone", "owner/repo", "--format=json"],
      error: "INVALID_ARGUMENT",
    },
    { argv: ["clone", "--search", "paseo", "--dir", "/repo", "--json"], error: "INVALID_ARGUMENT" },
    { argv: ["clone", "--search", " ", "--json"], error: "INVALID_ARGUMENT" },
    { argv: ["plugin", "add", "-o", "json"], error: "commander.missingArgument" },
    { argv: ["--json", "agent", "inspect"], error: "commander.missingArgument" },
    { argv: ["ls", "--invalid-option", "--format", "JSON"], error: "commander.unknownOption" },
    {
      argv: ["stop", "--home", "/a", "--home", "/b", "--format", "json"],
      error: "TARGET_AMBIGUOUS",
    },
    {
      argv: ["--format", "json", "stop", "--home", "/a", "--home", "/b"],
      error: "TARGET_AMBIGUOUS",
    },
    {
      argv: ["agent", "stop", "--home", "/a", "--home", "/b", "-ojson"],
      error: "TARGET_AMBIGUOUS",
    },
    { argv: ["stop", "--home", "/a", "--home", "/b", "-qo", "json"], error: "TARGET_AMBIGUOUS" },
    {
      argv: ["--home", "/a", "agent", "stop", "--home", "/b", "--json"],
      error: "TARGET_AMBIGUOUS",
    },
  ])("renders structured errors without mutation for $argv", async ({ argv, error }) => {
    const result = await runCliInChild(argv);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: error } });
  });

  it.each([
    ["ls", "--invalid-option", "--", "--json"],
    ["ls", "--invalid-option", "--home", "--json"],
    ["stop", "--home", "--json", "--home", "/b"],
    ["ls", "--invalid-option", "--home", "--format", "json"],
  ])("does not treat operands as output flags: %j", async (...argv) => {
    const result = await runCliInChild(argv);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^Error: /);
  });

  it.each([
    ["--json", "--help"],
    ["agent", "inspect", "--json", "--help"],
    ["--format", "json", "--version"],
    ["agent", "--format", "json", "--version"],
  ])("preserves successful text help and version output: %j", async (...argv) => {
    const result = await runCliInChild(argv);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/^(Usage:|[0-9]+\.)/);
  });

  it("lets plugin update own --version while preserving global output options", async () => {
    const cli = createCli()
      .exitOverride()
      .configureOutput({ writeOut: () => {} });
    const update = cli.commands
      .find((command) => command.name() === "plugin")!
      .commands.find((command) => command.name() === "update")!;
    let received: Record<string, unknown> | undefined;
    update.action((_id, options) => {
      received = options;
    });
    await cli.parseAsync(
      ["plugin", "update", "example", "--version", "1.2.0", "--format", "json", "--no-color"],
      { from: "user" },
    );
    expect(received).toMatchObject({ version: "1.2.0" });
    expect(update.optsWithGlobals()).toMatchObject({ format: "json", color: false });
  });

  it("defaults an empty CLI invocation to onboard", () => {
    expect(
      createCliParseArgv({
        argv: [],
        cwd: process.cwd(),
        nodeArgv: ["node", "paseo"],
      }),
    ).toEqual(["node", "paseo", "onboard"]);
  });

  it("routes explicit root relay flags to onboard", () => {
    expect(
      createCliParseArgv({
        argv: ["--relay"],
        cwd: process.cwd(),
        nodeArgv: ["node", "paseo"],
      }),
    ).toEqual(["node", "paseo", "onboard", "--relay"]);
    expect(
      createCliParseArgv({
        argv: ["--no-relay"],
        cwd: process.cwd(),
        nodeArgv: ["node", "paseo"],
      }),
    ).toEqual(["node", "paseo", "onboard", "--no-relay"]);
  });

  it("preserves known CLI command argv", () => {
    expect(
      createCliParseArgv({
        argv: ["daemon", "set-password"],
        cwd: process.cwd(),
        nodeArgv: ["node", "paseo"],
      }),
    ).toEqual(["node", "paseo", "daemon", "set-password"]);
  });

  it.each(["agent", "plugin", "worktree"])(
    "keeps %s command precedence over an existing directory",
    (name) => {
      const root = mkdtempSync(path.join(tmpdir(), "paseo-command-directory-"));
      mkdirSync(path.join(root, name));
      try {
        expect(
          createCliParseArgv({ argv: [name], cwd: root, nodeArgv: ["node", "paseo"] }, createCli()),
        ).toEqual(["node", "paseo", name]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("preserves the hooks command argv", () => {
    expect(
      createCliParseArgv({
        argv: ["hooks", "claude", "UserPromptSubmit"],
        cwd: process.cwd(),
        nodeArgv: ["node", "paseo"],
      }),
    ).toEqual(["node", "paseo", "hooks", "claude", "UserPromptSubmit"]);
  });

  it("finishes the command quietly when stdout is closed before it writes its output", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-cli-closed-stdout-"));

    try {
      const result = await runCliWithClosedStdout(["daemon", "status", "--json", "--home", home]);

      expect(result.stderr).toBe("still running\n");
      expect(result.code).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  it("classifies existing unknown directories as open-project invocations", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paseo-cli-run-"));
    const project = path.join(root, "repository");
    mkdirSync(project);

    try {
      expect(
        createCliParseArgv({
          argv: ["repository"],
          cwd: root,
          nodeArgv: ["node", "paseo"],
        }),
      ).toEqual({
        kind: "open-project",
        resolvedPath: project,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
