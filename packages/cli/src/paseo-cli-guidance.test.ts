import { expect, it } from "vitest";
import type { Command } from "commander";
import { getPaseoCliCommands } from "../../server/src/server/agent/paseo-cli-guidance.js";
import { createCli } from "./cli.js";

function resolveCommand(cli: Command, tokens: string[]): Command {
  let command = cli;
  while (tokens.length > 0 && !tokens[0]?.startsWith("--")) {
    const name = tokens.shift();
    const child = command.commands.find(
      (candidate) => candidate.name() === name || candidate.aliases().includes(name ?? ""),
    );
    expect(child, `Unknown advertised command ${name} under ${command.name()}`).toBeDefined();
    if (!child) throw new Error(`Unknown advertised command ${name}`);
    command = child;
  }
  return command;
}

function validateOptions(command: Command, tokens: string[]): void {
  while (tokens.length > 0) {
    const flag = tokens.shift();
    const option = command.options.find((candidate) => candidate.long === flag);
    expect(option, `Unknown advertised option ${flag} on ${command.name()}`).toBeDefined();
    if (option?.required) {
      expect(tokens.shift(), `Missing advertised value for ${flag}`).toMatch(/^<.+>$/);
    }
  }
}

it("advertises only registered CLI commands and supported options", () => {
  const cli = createCli();
  const commands = getPaseoCliCommands(undefined);
  expect(commands.length).toBeGreaterThan(0);
  for (const advertisement of commands) {
    for (const alternative of advertisement.split(" / ")) {
      const tokens = alternative.split(/\s+/);
      validateOptions(resolveCommand(cli, tokens), tokens);
    }
  }
});
