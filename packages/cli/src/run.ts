import { renderError, toCommandError, defaultOutputOptions } from "./output/render.js";
import { createCli } from "./cli.js";
import { classifyInvocation } from "./classify.js";
import { CommanderError, type Command, type Option } from "commander";

export interface RunCliOptions {
  cwd?: string;
  nodeArgv?: [string, string];
}

export function createCliParseArgv(
  input: {
    argv: string[];
    cwd: string;
    nodeArgv?: [string, string];
  },
  program: Command = createCli(),
): string[] | { kind: "open-project"; resolvedPath: string } {
  const knownCommands = new Set(program.commands.map((command) => command.name()));
  const invocation = classifyInvocation({
    argv: input.argv,
    knownCommands,
    cwd: input.cwd,
  });

  if (invocation.kind === "open-project") {
    return invocation;
  }

  const nodeArgv = input.nodeArgv ?? ["paseo", "paseo"];
  const isOnboardRootFlag = invocation.argv[0] === "--relay" || invocation.argv[0] === "--no-relay";
  let cliArgv = invocation.argv;
  if (invocation.argv.length === 0) {
    cliArgv = ["onboard"];
  } else if (isOnboardRootFlag) {
    cliArgv = ["onboard", ...invocation.argv];
  }
  return [...nodeArgv, ...cliArgv];
}

// The program that started the CLI can close its end of stdout before the output
// is written, as `paseo ls | head -1` or a launcher that discards output does.
// Drop the output nobody reads and let the command finish, instead of surfacing
// the failed write as an uncaught error.
function ignoreClosedStdout(error: NodeJS.ErrnoException): void {
  if (error.code !== "EPIPE") {
    throw error;
  }
}

function findOption(command: Command, flag: string) {
  for (let current: Command | null = command; current; current = current.parent) {
    const option = current.options.find(
      (candidate) => candidate.short === flag || candidate.long === flag,
    );
    if (option) return option;
  }
  return undefined;
}

function optionArgument(option: Option, arg: string, next: string | undefined) {
  if (/^-[^-]./.test(arg)) return { value: arg.slice(2), consumed: 0 };
  if (arg.includes("=")) return { value: arg.slice(arg.indexOf("=") + 1), consumed: 0 };
  if (option.required || !next?.startsWith("-")) return { value: next, consumed: 1 };
  return { value: undefined, consumed: 0 };
}

// Resolve output before parsing: a selector parser can throw before a later format flag.
function errorOutputOptions(program: Command, argv: string[]) {
  const output = { ...defaultOutputOptions };
  let json = false;
  let command = program;
  let canSelectCommand = true;
  const args = [...argv];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") break;
    const shortGroup = /^-[^-]./.test(arg);
    const flag = shortGroup ? arg.slice(0, 2) : arg.split("=", 1)[0]!;
    const option = findOption(command, flag);
    if (!option) {
      if (canSelectCommand && !arg.startsWith("-")) {
        const child = command.commands.find(
          (candidate) => candidate.name() === arg || candidate.aliases().includes(arg),
        );
        if (child) command = child;
        else canSelectCommand = false;
      }
      continue;
    }
    let value: string | undefined;
    if (option.required || option.optional) {
      const argument = optionArgument(option, arg, args[i + 1]);
      value = argument.value;
      i += argument.consumed;
    } else if (shortGroup) {
      args.splice(i + 1, 0, `-${arg.slice(2)}`);
    } else if (arg.includes("=")) {
      continue;
    }
    if (option.long === "--json") json = true;
    if (option.long === "--no-color") output.noColor = true;
    if (option.long === "--format") {
      const format = value?.trim().toLowerCase();
      if (format === "json" || format === "yaml") output.format = format;
      else output.format = "table";
    }
  }
  if (json) output.format = "json";
  return output;
}

export async function runCli(argv: string[], options: RunCliOptions = {}): Promise<number> {
  if (!process.stdout.listeners("error").includes(ignoreClosedStdout)) {
    process.stdout.on("error", ignoreClosedStdout);
  }

  const program = createCli();
  const configureErrors = (command: Command) => {
    command.exitOverride().configureOutput({ writeErr: () => {} });
    command.commands.forEach(configureErrors);
  };
  configureErrors(program);
  const outputOptions = errorOutputOptions(program, argv);
  const parseArgv = createCliParseArgv(
    {
      argv,
      cwd: options.cwd ?? process.cwd(),
      nodeArgv: options.nodeArgv,
    },
    program,
  );

  try {
    if (!Array.isArray(parseArgv)) {
      const { openDesktopWithProject } = await import("./commands/open.js");
      await openDesktopWithProject(parseArgv.resolvedPath);
      return typeof process.exitCode === "number" ? process.exitCode : 0;
    }
    await program.parseAsync(parseArgv, { from: "node" });
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return 0;
    process.stderr.write(renderError(toCommandError(error), outputOptions) + "\n");
    return 1;
  }
  return typeof process.exitCode === "number" ? process.exitCode : 0;
}
