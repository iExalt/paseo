---
title: Schedules from the CLI
description: Create and manage Paseo schedules with paseo schedule.
nav: CLI
order: 27
category: Schedules
---

# Schedules from the CLI

`paseo schedule` creates and manages new-agent [schedules](/docs/schedules) from your terminal, useful for headless boxes and scripts. Every run starts a fresh agent.

## Create

Overnight refactor on Codex:

```bash
paseo schedule create \
  --every 30m \
  --name overnight-refactor \
  --provider codex/gpt-5.5 \
  --cwd ~/dev/my-app \
  --max-runs 16 \
  --expires-in 10h \
  "Continue the refactor. Run the focused checks. Leave a short status note."
```

Long build babysitter on Claude:

```bash
paseo schedule create \
  --every 5m \
  --name build-watch \
  --provider claude/opus-4.7 \
  --cwd ~/dev/my-app \
  --max-runs 24 \
  "Check the release build. If it failed, inspect logs, fix the cause, and rerun."
```

Daily GitHub triage on GLM through OpenCode:

```bash
paseo schedule create \
  --cron "0 14 * * 1-5" \
  --timezone UTC \
  --run-now \
  --name github-triage \
  --provider opencode/openrouter/glm-5.1 \
  --cwd ~/dev/my-app \
  "Triage GitHub issues, PRs, and failing checks. Summarize what needs attention."
```

Morning triage at 9 AM in New York, including daylight saving time changes:

```bash
paseo schedule create \
  --cron "0 9 * * 1-5" \
  --timezone America/New_York \
  --name morning-triage \
  --provider codex/gpt-5.5 \
  --cwd ~/dev/my-app \
  "Review overnight CI failures and summarize anything urgent."
```

### Caller inheritance and isolation

Inside a managed agent, omitted schedule settings inherit the caller's runtime. Provider and cwd default to the caller; model inherits only when provider is not explicitly supplied. Mode and provider options inherit only for the same provider. Thinking, feature values, system prompt, and third-party MCP configuration are copied from the caller unless an exposed override changes the setting. This is a creation-time snapshot, not a link to future caller changes.

Use `--provider <provider/model>`, `--mode`, `--thinking`, and `--cwd` for explicit overrides. `--isolation worktree` gives each run an isolated worktree; `local` uses the configured directory. Outside an agent, supply a provider; explicit endpoint targets also need `--cwd`.

### Explicit replacement

Creation always creates a new record unless you pass `--replace`. For named schedules, replacement matches the name and the entire new-agent target configuration. Changing that configuration creates another schedule; use `schedule update <id>` to change an existing target. Heartbeat replacement matches name and current agent ID. Without a matching name/target it creates a record. Unnamed creation never replaces another record.

Replacement keeps the matching record's ID and history, replaces its prompt and cadence, reactivates it, and recomputes its next run. Omitted limits and expiration are cleared. Use `schedule update <id>` to patch a schedule without resetting omitted fields. To clear overrides explicitly:

```bash
paseo schedule update <id> --clear-model --clear-mode --no-max-runs --no-expires-in
paseo schedule create --replace --name build-watch --provider codex --cwd /absolute/repo --every 5m "Check the build"
```

## Heartbeats

Inside a running Paseo agent, create a heartbeat for that same conversation:

```bash
paseo heartbeat create \
  --cron "*/20 * * * *" \
  --name heartbeat \
  "Check the current task state and continue with the next useful step."
```

The heartbeat interface is deliberately small:

```bash
paseo heartbeat update <id> --cron "*/10 * * * *"
paseo heartbeat delete <id>
```

Updating a heartbeat changes only its cron cadence and optional time zone. Its target and prompt stay fixed. Heartbeat commands require `PASEO_AGENT_ID`, which Paseo sets inside agent sessions.

To replace the prompt or limits of a named heartbeat, explicitly recreate it with `--replace`:

```bash
paseo heartbeat create --replace --name heartbeat --cron "*/10 * * * *" --max-runs 12 "Check this task and report actionable changes"
```

Heartbeat update accepts only cadence and time zone; schedule commands do not manage heartbeat records.

Heartbeats require a raw `--cron` expression. The `--every` presets below are available only for new-agent schedules.

## Manage

```bash
paseo schedule ls
paseo schedule inspect <id>
paseo schedule logs <id>
paseo schedule pause <id>
paseo schedule resume <id>
paseo schedule run-once <id>
paseo schedule update <id> --every 10m --max-runs 6
paseo schedule delete <id>
```

## Cadence

Use `--cron "<expr>"` for a 5-field cron expression. For common cron-compatible cadences, `--every <duration>` accepts presets such as `5m` or `1h` and compiles them to cron. It does not create a rolling interval anchored to creation time.

Schedules default to UTC. Pass `--timezone <IANA>` to interpret cron fields in a local wall-clock time zone, for example `--timezone America/New_York`. The persisted `nextRunAt` is still a UTC instant, but it is computed from that local time zone so recurring jobs stay at the same local time across daylight saving time changes.

Schedules wait for the next matching cron time by default. Pass `--run-now` to start one immediate run on creation.

Start the command with `paseo --host <target> schedule create ...` when targeting a remote daemon. Pass `--cwd`; your local working directory may not exist on the remote machine.
