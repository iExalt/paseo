---
name: update-nix-paseo
description: Update or roll back the Nix-managed Paseo desktop app on this Mac, including an app-only restart and verification that running agents stay alive. Use for "update Paseo", "upgrade the Nix Paseo app", "install the latest Paseo release", "roll back Paseo", or "/update-nix-paseo".
user-invocable: true
---

# Update Nix-managed Paseo (macOS)

An update request authorizes staging, activation and an app-only restart. Complete
those steps yourself when the preconditions below hold. A check-only request is
read-only. Never stop or restart the daemon to finish an app update while agents
have pending work. A daemon that stays on its old version can be the expected result.

## 1. Preflight and baseline

Require macOS arm64 (`uname -sm`). Record these separately:

- **Running desktop app:** version and executable/store path from the live app or
  its startup log. The `/Applications/Paseo.app/Contents/Resources/paseo-nix-managed.json`
  marker describes the installed copy; it alone does not prove the running version.
- **Running daemon:** `/Applications/Paseo.app/Contents/Resources/bin/paseo daemon status --json`.
  Retain `daemonVersion`, `pid`, `workerPid`, `startedAt` and `desktopManaged`.
- **Agents:** `paseo ls --global --all --json` using that bundled CLI. Retain IDs and
  states. An idle agent may still have provider background work, so this list is
  evidence, never permission to stop the daemon. Only the daemon's atomic idle check
  decides whether it can stop.

From daemon 0.21.0 onward, the new desktop can ask it to stop only when idle.
While it is busy the app keeps using it and retries every 60 seconds. The new app
must remain open to drive that upgrade. Check capability/version on the running
process, not just the installed package. Older daemons require the legacy path below.

Use the updater from `origin/dev` without changing the checkout's branch:

```zsh
set -e
set -o pipefail
repo=$(git rev-parse --show-toplevel)
git -C "$repo" fetch -q origin dev
updater_dir=$(mktemp -d /tmp/paseo-updater.XXXXXX)
git -C "$repo" archive origin/dev 'scripts/paseo-nix-update*.mjs' packages/protocol/src |
  tar -x -C "$updater_dir"
upd() { (cd "$updater_dir" && mise exec -C "$repo" -- node scripts/paseo-nix-update.mjs "$@") }
```

Run network commands with the environment's supported network permissions. Clean up
this exact temporary directory on success or failure with
`python3 -c 'import shutil,sys; shutil.rmtree(sys.argv[1])' "$updater_dir"`.

## 2. Check, stage and activate

Run `upd status --json` and `upd check --json`. Report active, staged, latest and
high-water versions. Stop on a missing latest release or `latestError`. If the latest
release is already active, skip staging/activation and inspect whether the desktop
itself needs a restart. Otherwise require `canStage: true`, then run:

```zsh
upd stage --json
upd activate --json
```

`stage` verifies the signed closure. `activate` switches the profile; copying to
`/Applications/Paseo.app` is deferred while the app runs. Neither restarts processes.
Stop on a failure and report its output; do not substitute manual `nix-env` switching.

An updater lock collision should leave the daemon alone. Avoid concurrent updater
commands during app startup; its next automatic retry can recover. Never remove
`operation.lock` merely because a command failed. Check for a live lock owner before
considering stale-lock recovery.

## 3. Restart only the desktop app

Restart only when the **running app** differs from the active release. When they
already match and only the daemon is older, skip the restart: leave the app open for
its automatic idle upgrade. A lingering update icon or About → Restart button is not
proof that the app needs restarting; the current UI can conflate daemon lag with an
app update.

Prefer the app's dedicated update-relaunch operation when available: it preserves
the daemon regardless of the ordinary quit preference. For the shell route below,
first verify all of these:

- The running daemon is at least 0.21.0 and desktop-managed, and its executable is
  under the immutable `/nix/store` bundle.
- The running desktop supports the non-disruptive update lifecycle. Updating an
  older desktop for the first time does not retroactively change its quit behavior.
- `~/Library/Application Support/Paseo/desktop-settings.json` has
  `settings.daemon.keepRunningAfterQuit: true`. **SIGTERM uses ordinary quit**, which
  otherwise stops the daemon. Do not use this recipe when the setting is false or
  unreadable. Use the dedicated relaunch operation, or explain the constraint and
  obtain approval before changing the quit preference. Restore any temporary change.

Select the exact app executable, require one PID, and signal only that PID. This
needs no macOS Automation permission. Never use broad process-name matching or
`paseo daemon stop` here.

```zsh
app_pid=$(ps -axo pid=,args= | awk '$2 == "/Applications/Paseo.app/Contents/MacOS/Paseo" && NF == 2 { print $1 }')
[[ "$app_pid" == <-> ]] || { print -u2 'Expected exactly one desktop app PID'; return 1; }
kill -TERM "$app_pid"
"$HOME/Library/Application Support/Paseo/nix-update/profile/bin/paseo-nix-update" install-app --after-exit "$app_pid"
```

The helper bounds its exit/install waits, replaces the app copy and opens the active
release. Observe its exit code and installed marker; if relaunch fails, diagnose it
without stopping the daemon. When no app is running, use `install-app` without
`--after-exit`, then `open /Applications/Paseo.app`.

### Legacy daemon or unsafe quit path

A daemon older than 0.21.0 cannot honor idle-only stop. Stage and activate safely,
then explain that completing the daemon upgrade requires a disruptive stop. Obtain
explicit approval naming the affected sessions before doing that, and use an
external terminal if the stop would terminate the current session. Never silently
insert a daemon stop into an app restart command. Without approval, leave the
existing daemon running and report the incomplete daemon upgrade.

## 4. Verify and report the two outcomes

- **Desktop updated:** verify the installed marker and new app process/startup
  version match the active release, and `staged` is null. A changed marker alone is
  insufficient. Confirm that the app reconnects to the daemon.
- **Daemon retained or upgraded:** compare baseline PIDs/start time and agent IDs
  and states. For a busy daemon, expect the old process and version to survive; a
  `daemon busy; upgrade waits for its agents` log is evidence of the idle guard.
  Observe one automatic retry (60 seconds, with a bounded deadline) when testing
  this behavior. Do not repeatedly call updater status while that retry starts.
- **Limits:** distinguish an agent mid-turn at restart from agents becoming busy
  afterward. Report absent evidence rather than claiming interruption-free turns
  from unchanged session IDs alone. If idle upgrade was not observed, say it remains
  pending; do not wait indefinitely or force it to complete.

Report app before/after, daemon before/after, active/staged/latest releases, process
continuity, material errors and any remaining work. Save relevant evidence and remove
only temporary files/directories created for this run. No user restart handoff is
needed when the safe app-only restart succeeded.

## Recovery

Use the active release's packaged helper at
`~/Library/Application Support/Paseo/nix-update/profile/bin/paseo-nix-update`.
Resolve it to its absolute `/nix/store/...` path before switching generations and
keep using that path: older helpers lack `reactivate-high-water`.

- `rollback` selects the previous retained release; it does not restore app data.
- `reactivate-high-water` returns to the highest activated release.

Both leave processes untouched. Apply the same app-only restart safeguards and
separate app/daemon verification to recovery.
