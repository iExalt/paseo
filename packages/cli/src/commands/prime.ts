import { Command } from "commander";
import { resolveCliVersion } from "../version.js";

export function createPrimeCommand(): Command {
  return new Command("prime")
    .description("Print offline, version-matched CLI conventions (plain text)")
    .addHelpText(
      "after",
      "\nAlways prints a text document; global output-format flags do not change it.",
    )
    .action((_options, command: Command) => {
      command.configureOutput().writeOut!(`Paseo CLI ${resolveCliVersion()} conventions

Managed sessions: invoke the quoted executable "$PASEO_CLI", even if paseo is
not on PATH. Preserve PASEO_AGENT_ID, PASEO_AGENT_CWD, and PASEO_HOME. Provider
policy still controls which operations are available. Use <command> --help for flags.

Identity: Paseo agent IDs and provider session IDs are different namespaces.
Use an exact agent ID or an unambiguous agent-ID prefix; provider session IDs
must be complete. Ambiguous matches require choosing an agent ID. An unknown
provider session is not imported automatically.

Launch: run requires --provider <provider-or-provider/model>; discover with
provider ls, provider models, and provider inspect (alias: provider modes).
run/send accept exactly one prompt source: positional text, --prompt <text>, or
--prompt-file <path>. --prompt-file - explicitly reads UTF-8 stdin.
Durations accept s, m, h, and d, including 2h30m and 7d.

JSON: parse stdout only; keep stderr separate, never merge 2>&1 into a parser.
run --no-wait --json returns agentId/title. agent ls --json returns display
summaries with id/name, possibly shortened cwd and relative created text.
Usage: ls JSON includes lastUsage (raw provider fields) and contextWindowPercent.
Inspect LastUsage includes nullable token counts, CostUsd, ContextWindowUsedTokens,
ContextWindowMaxTokens and ContextWindowPercent. Null means unreported; zero is measured.
agent status --json exposes raw lastUsage under snapshot.
agent inspect --json uses capitalized Id/Name/Cwd. For rich metadata, use
agent query --json: id/title, separate provider/model, absolute cwd, createdAt,
and optional attention fields. agent status --json nests details under snapshot.
workspace ls/inspect --json retain workspaceId and expose the full host payload
under descriptor. workspace inspect requires an exact ID and includes background
workspaces. workspace setup <id> --status reads setup without running it.
prime always prints text, even with --json.

Timeline: agent logs <id> --json returns complete projected entries and page metadata.
Use --limit N and --before epoch:seq from startCursor to read older pages (0 means all).
--full prints complete entries; --search query [--cursor nextCursor] returns locations.
agent prompts <id> --json returns prompt previews and positions. JSON/full logs do not follow.

Questions: inspect request.input.questions in permit ls --json, then answer with
permit allow <agent> <req_id> --input '{"answers":{"Question 1":"chosen label or free text"}}'.
Use every question's header as the key, not its id; values are strings, not Codex
answer objects. Use comma-separated labels for multi-select. Answers must be
nonblank unless the question allows empty answers. Invalid question answers are
rejected before any selected response is sent. If a request disappeared, inspect
the agent state: another client may have answered it concurrently.

Retries: a lost response, parse error, or later failure may follow successful
creation. Reconcile existing agents (use a unique --label task=<key> with
agent ls -a -g --label task=<key> --json) before retrying a launch. If a heartbeat
fails after launch, confirm the agent and retry only the heartbeat.

Delegation: --no-wait changes waiting, not parentage. An agent-launched run
without --relationship detached becomes the caller's subagent, even in a new
workspace or project; pass --relationship detached for independent work. Use
agent detach <id> to make an existing subagent independent; never edit labels.
Caller completion notifications are enabled by default; use
--no-notify-on-finish when appropriate.

Placement: for a visible worker, create its workspace first with
workspace create --project <id> --no-background --json, then
run --workspace <workspaceId>. run --new-workspace takes its project from the
path and inherits the caller's background setting. Pass mode, model and
thinking IDs from provider inspect and provider models, not labels. After
launch, confirm with agent status --json: snapshot.workspaceId, model,
thinkingOptionId, currentModeId, and no labels["paseo.parent-agent-id"].

Directories: managed terminal create defaults to the caller's scoped directory
and workspace, even after shell cd. Request --cwd "$PWD" for the shell directory;
caller restrictions still apply.

Cleanup: archive closes runtimes; running agents still require --force.
Self-archive or archiving your workspace can terminate the invoking shell before
it prints a result. Send the handoff first; have an external session perform
cleanup and verify agent status or workspace ls before retrying.
`);
    });
}
