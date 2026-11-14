import { Command } from "commander";
import { runLsCommand } from "./ls.js";
import { runAllowCommand } from "./allow.js";
import { runDenyCommand } from "./deny.js";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";

const batchResponseHelp = `
Every selected request reports confirmed, failed (not sent), or unconfirmed.
Any failed or unconfirmed result exits 1 after printing all outcomes.
Batch responses can partially complete. An unconfirmed response may have applied.
Run "paseo permit ls --json" before retrying, then pass each still-pending request ID
explicitly.
`;

export function createPermitCommand(): Command {
  const permit = new Command("permit").description("Manage permission requests");

  addJsonAndDaemonHostOptions(
    permit.command("ls").description("List all pending permissions"),
  ).action(withOutput(runLsCommand));

  addJsonAndDaemonHostOptions(
    permit
      .command("allow")
      .description("Allow a permission request")
      .argument("<agent>", "Agent ID, prefix, or full session ID")
      .argument("[req_id]", "Permission request ID (default: all pending)")
      .option("--all", "Allow all pending permissions for this agent")
      .option("--input <json>", 'Modified input; questions use {"answers":{"<header>":"<answer>"}}')
      .option("--selected-action-id <id>", "Selected permission action ID (requires one request)")
      .option(
        "--updated-permissions <json>",
        "Updated permissions array (JSON; requires one request)",
      )
      .addHelpText(
        "after",
        `
Omitting <req_id> allows every pending request for this agent, even without --all.
Pass <req_id> to allow one request.

Answer a question:
  paseo permit ls --json
  paseo permit allow <agent> <req_id> --input '{"answers":{"Question 1":"chosen label or free text"}}'

Copy the headers from request.input.questions; include a string for every header,
not the question IDs or Codex's raw answer objects. Answers must be nonblank unless
the question explicitly allows an empty answer. For multi-select, join labels with
commas. All selected questions are validated before any responses are sent.
${batchResponseHelp}`,
      ),
  ).action(withOutput(runAllowCommand));

  addJsonAndDaemonHostOptions(
    permit
      .command("deny")
      .description("Deny a permission request")
      .argument("<agent>", "Agent ID, prefix, or full session ID")
      .argument("[req_id]", "Permission request ID (optional if --all)")
      .option("--all", "Deny all pending permissions for this agent")
      .option("--message <msg>", "Denial reason message")
      .option("--interrupt", "Stop agent after denial")
      .option("--selected-action-id <id>", "Selected permission action ID (requires one request)")
      .addHelpText("after", batchResponseHelp),
  ).action(withOutput(runDenyCommand));

  return permit;
}
