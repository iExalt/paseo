import { Command, Option, InvalidArgumentError } from "commander";
import { withOutput } from "../../output/index.js";
import {
  addDaemonHostOption,
  addJsonAndDaemonHostOptions,
  withGlobalOptions,
} from "../../utils/command-options.js";
import { runCaptureCommand } from "./capture.js";
import { runCreateCommand } from "./create.js";
import { runRenameCommand } from "./rename.js";
import { runKillCommand } from "./kill.js";
import { runLsCommand } from "./ls.js";
import { runSendKeysCommand } from "./send-keys.js";

function parseSize(value: string): number {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size <= 0)
    throw new InvalidArgumentError("Size must be a positive integer");
  return size;
}

export function createTerminalCommand(): Command {
  const terminal = new Command("terminal").description("Manage workspace terminals");

  addJsonAndDaemonHostOptions(
    terminal
      .command("ls")
      .description("List terminals")
      .addOption(
        new Option("--all", "List terminals across all workspaces").conflicts(["cwd", "workspace"]),
      )
      .option("--workspace <id>", "Workspace ID")
      .option("--cwd <path>", "Working directory"),
  ).action(withOutput(runLsCommand));

  addJsonAndDaemonHostOptions(
    terminal
      .command("create")
      .description("Create a terminal (managed sessions default to the caller's scoped directory)")
      .option("--workspace <id>", "Workspace ID")
      .option("--cwd <path>", 'Working directory; use --cwd "$PWD" for the shell directory')
      .option("--name <name>", "Terminal name")
      .addOption(new Option("--command <command>", "Executable to launch").conflicts("profile"))
      .addOption(
        new Option("--arg <value>", "Process argument (repeat; use --arg=-x for flags)")
          .argParser((value: string, previous: string[]) => [...previous, value])
          .default([])
          .conflicts("profile"),
      )
      .addOption(
        new Option("--profile <id>", "Host terminal profile ID").conflicts(["command", "arg"]),
      )
      .option("--rows <n>", "Initial terminal rows (default 24)", parseSize)
      .option("--cols <n>", "Initial terminal columns (default 80)", parseSize),
  ).action(withOutput(runCreateCommand));

  addJsonAndDaemonHostOptions(
    terminal
      .command("kill")
      .description("Kill a terminal")
      .argument("<terminal-id>", "Terminal ID, ID prefix, or name"),
  ).action(withOutput(runKillCommand));

  addDaemonHostOption(
    terminal
      .command("capture")
      .description("Capture terminal output")
      .argument("<terminal-id>", "Terminal ID, ID prefix, or name")
      .option("--start <n>", "Capture start line")
      .option("--end <n>", "Capture end line")
      .option("-S, --scrollback", "Capture from the beginning of scrollback")
      .option("--ansi", "Preserve ANSI escape codes")
      .option("--json", "Output in JSON format"),
  ).action(withGlobalOptions(runCaptureCommand));

  addDaemonHostOption(
    terminal
      .command("send-keys")
      .description("Send keys to a terminal")
      .argument("<terminal-id>", "Terminal ID, ID prefix, or name")
      .argument(
        "<keys...>",
        "Text or key tokens: Enter, Tab, Escape, Space, BSpace, Up, Down, Left, Right, Home, End, Insert, Delete, PageUp, PageDown, F1-F12, with C- (Ctrl), M- (Alt) and S- (Shift) prefixes, e.g. C-r or C-M-Left",
      )
      .option("-l, --literal", "Send raw keys without interpreting special tokens")
      .option("--json", "Output in JSON format"),
  ).action(withGlobalOptions(runSendKeysCommand));

  addJsonAndDaemonHostOptions(
    terminal
      .command("rename")
      .description("Rename a terminal")
      .argument("<terminal-id>", "Terminal ID, ID prefix, or name")
      .argument("<name>", "New terminal title"),
  ).action(withOutput(runRenameCommand));

  return terminal;
}
