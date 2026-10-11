---
name: paseo
description: Paseo reference for managing projects, workspaces, workspace scripts, agents, schedules, and heartbeats.
---

Paseo manages coding agents, workspaces, terminals, and recurring work. Use provider-native Paseo tools when available; otherwise use the CLI. Paseo no longer serves its own MCP endpoint. Third-party MCP configuration remains supported.

## Caller and host

Inside a managed agent, invoke `"$PASEO_CLI"` when supplied. It is an absolute executable path. Preserve `PASEO_AGENT_ID`, `PASEO_AGENT_CWD`, and `PASEO_HOME` so the CLI resolves your caller and daemon. Do not invent caller IDs. Examples below use `paseo` for a human shell; substitute `"$PASEO_CLI"` in managed sessions.

`--home <path>` selects a local daemon; `--host <target>` selects an explicit endpoint. Either flag overrides environment selection; combining them is an error. A caller missing on the selected daemon has no parent relationship there. Do not restart a live daemon to resolve command failures.

## Discover settings before delegation

```bash
paseo profile ls --json
paseo provider ls --full --json
paseo provider models <provider> --full --json
paseo provider inspect <provider> --cwd /absolute/repo --json
```

Read every profile's `notes`. Choose the profile the user requested or the one whose notes fit the work. Materialize its `provider`, `model`, `modeId`, `thinkingOptionId`, and `featureValues` with `run --provider`, `--model`, `--mode`, `--thinking`, and `--features-json`. There is no profile selection flag. Omit absent settings. If none fit, discover providers and tell the user about the fallback. `provider diagnostic` checks installation; `provider inspect` reports capabilities and accepts draft runtime settings.

Only use feature IDs returned by provider inspection. `--feature` is repeatable and accepts comma-separated assignments. Preserve JSON quotes inside shell quotes for string values containing commas:

```bash
paseo run --provider codex --feature fast_mode=true --no-wait "Review this branch"
paseo agent update <id> --feature 'choice="a,b",enabled=true'
paseo agent update <id> --features-json '{"choice":"a,b","custom":{"level":2}}'
```

The last two examples illustrate syntax; substitute supported feature IDs and values. Unquoted `true`, `false`, and `null` are typed; other flag values are strings. Use JSON for numbers, arrays, objects, or empty strings. Duplicate IDs, including across both inputs, fail.

## Agents and waiting

```bash
paseo run --provider <provider> --title "Review" --no-wait "Review this branch"
paseo send <id> --no-wait "Check the revised patch"
paseo agent query --include-archived --include-background --json
paseo agent status <exact-id> --json
paseo agent activity <exact-id> --limit 20 --json
paseo agent update <id> --model <model> --thinking <thinking> --name "Review"
paseo agent update <id> --clear-model --clear-thinking
paseo agent close <id>
```

Agent-scoped creation defaults to a subagent in your workspace. `--workspace <id>` changes placement, preserving parentage. Use `--relationship detached` only when independent work is intended. `--no-wait` changes waiting only. Create/send notify a resolved caller on finish, error, or permission by default; `--no-notify-on-finish` opts out. Human shells have no parent callback. With notifications enabled, continue independent work instead of repeatedly polling. Otherwise use `wait`, `agent status`, or `agent activity`.

`stop` cancels the current run. `agent close` closes the runtime while preserving history. `archive` removes the agent from active use and needs `--force` if it is running. `delete` hard-deletes history. Never substitute delete for close. Runtime and metadata updates apply sequentially; failures can leave earlier changes applied. Inspect state before retrying. `send --mode <id>` changes mode before dispatch.

## Projects and workspaces

```bash
paseo project create /absolute/repo
paseo project ls
paseo workspace create --isolation worktree --mode branch-off --new-branch fix-x --base origin/main
paseo workspace create --isolation worktree --mode checkout-branch --branch existing-work
paseo workspace create --isolation worktree --mode checkout-pr --pr-number 42
paseo workspace ls --background
paseo workspace rename <workspace-id> "Review"
paseo run --workspace <workspace-id> --provider <provider> --no-wait "Review the change"
paseo workspace archive <workspace-id>
```

Create a workspace before delegation when isolation is needed. Choose the base explicitly: `origin/main` uses the remote-tracking branch, `refs/heads/main` local main; bare `main` prefers local main. `--background` hides a new workspace from default discovery; omission inherits the caller workspace's setting and defaults false without a caller. Override only when asked. Use `workspace create --notifications on|off` before launching or `workspace update <id> --notifications on|off` for an existing workspace.

Workspace archive archives its agents and terminals. Ordinary directories remain; an owned worktree is removed after its final active workspace reference is archived. Project deletion archives its active workspaces and removes the registry entry, preserving the project directory.

## Scripts and terminals

```bash
paseo script ls --workspace <workspace-id> --json
paseo script start <name> --workspace <workspace-id>
paseo script stop <name> --workspace <workspace-id>
paseo terminal create --workspace <workspace-id> --name Development
paseo terminal ls --workspace <workspace-id> --json
paseo terminal send-keys <terminal-id> -l "echo ready"
paseo terminal send-keys <terminal-id> Enter
paseo terminal capture <terminal-id>
paseo terminal kill <terminal-id>
```

Scripts use the supervised lifecycle from `paseo.json`. Prefer explicit workspace IDs when directories are shared.

## Schedules and heartbeats

```bash
paseo schedule create --cron "*/15 * * * *" --name build-watch "Check the build"
paseo schedule ls
paseo schedule update <id> --clear-model --clear-mode
paseo heartbeat create --cron "*/15 * * * *" --name build-watch "Check this task"
paseo heartbeat update <id> --cron "*/30 * * * *"
paseo heartbeat delete <id>
```

Schedules start fresh agents; in a managed caller they inherit runtime settings unless overridden. Outside an agent, supply `--provider` and an appropriate `--cwd`. `--isolation worktree` isolates each schedule run. Heartbeats prompt the current conversation and require caller context. Updating a heartbeat changes cadence/timezone only. To change its prompt, explicitly use `heartbeat create --replace --name <same-name> ...` or delete and recreate it. Named creation does not imply replacement: both schedule and heartbeat creation require `--replace` to replace a matching named target. Schedule list/inspect/update/pause/resume/run-once/logs/delete do not manage heartbeats.

## Browser, speech, and permissions

```bash
paseo browser list-tabs --workspace <workspace-id> --json
paseo browser snapshot <browser-id> --json
paseo browser click <browser-id> @e3
paseo browser screenshot <browser-id> --output ./review.png
paseo speech speak "The review is complete"
paseo permit ls --json
paseo permit allow <agent-id> <request-id> --selected-action-id <action-id>
```

Use fresh snapshot refs and resnapshot after stale-ref errors. Screenshots require `--output` on the CLI machine and an existing parent directory. Browser commands need browser tools enabled and a connected desktop browser host. Speech routes to the caller's active voice session, waits for playback, and supports cancellation; `--agent <id>` selects the voice agent explicitly. Permission action IDs and updated permission arrays target a single request, not bulk approval.

Discover exact syntax with `paseo <command> --help`. For product setup and troubleshooting, use the **paseo-help** skill.
