import { Command, Option } from "commander";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { withOutput } from "../../output/index.js";
import { runFileCommand, type FileOptions } from "./run.js";

export function createFileCommand(): Command {
  const file = new Command("file").description("Manage files through the selected host");
  function action(name: string, description: string): Command {
    const command = addJsonAndDaemonHostOptions(file.command(name).description(description))
      .allowExcessArguments(false)
      .option("--workspace <id>", "Target workspace ID")
      .option("--cwd <path>", "Root directory on the selected host");
    command.action(
      withOutput(async (...args: unknown[]) =>
        runFileCommand(
          name.split(" ")[0]!,
          args.slice(0, -2) as string[],
          args.at(-2) as FileOptions,
        ),
      ),
    );
    return command;
  }
  action("ls [path]", "List a host directory (default: workspace root)");
  action("cat <path>", "Read a host file; structured output contains base64 bytes");
  action(
    "write <path>",
    "Overwrite an existing host file, with concurrent-edit detection",
  ).requiredOption("--input <file>", "Local input file, or - for stdin");
  action("create <path>", "Create an empty file or directory").addOption(
    new Option("--kind <kind>", "Entry kind").choices(["file", "directory"]).default("file"),
  );
  action("rename <path> <name>", "Rename an entry within its parent directory");
  action("duplicate <path>", "Copy an entry beside itself with a host-generated name");
  action("rm <path>", "Delete an entry, including directory contents");
  action(
    "upload <local-file>",
    "Upload a local file to the host attachment store; returns its stored path",
  );
  action("download <path> <local-file>", "Save host file bytes to a new local file");
  action("suggest <query>", "Suggest host files and directories within the selected root");
  return file;
}
