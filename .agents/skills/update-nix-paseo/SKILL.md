---
name: update-nix-paseo
description: Update the Nix-managed Paseo desktop app on this Mac to the latest signed fork release (stage and activate), then hand the restart to the user. Use when the user says "update Paseo", "upgrade the Nix Paseo app", "install the latest Paseo release", "roll back Paseo", or "/update-nix-paseo".
user-invocable: true
---

# Update Nix-managed Paseo (macOS)

Invoking this skill is permission to stage **and** activate the latest release.
Neither touches running processes. Never quit the app, stop the daemon or restart
anything yourself: this session runs inside Paseo and would die with it. The user
restarts Paseo with the command printed in step 4.

Background and the recovery runbook: the README fork note and "Installation contract
and managed CLI" in `docs/complete-campaigns/PASEO_FORK_AUTO_UPDATE_PLAN.md`.

## 1. Preflight

Require macOS arm64 (`uname -sm` prints `Darwin arm64`). Older updaters may reject
newer release manifests, so run the updater from `origin/dev` regardless of the
checkout's branch. It needs only Node built-ins, so export it rather than switching
branches or creating a worktree:

```zsh
repo=$(git rev-parse --show-toplevel)
git -C "$repo" fetch -q origin dev
updater_dir=$(mktemp -d /tmp/paseo-updater.XXXXXX)
git -C "$repo" archive origin/dev 'scripts/paseo-nix-update*.mjs' packages/protocol/src |
  tar -x -C "$updater_dir"
upd() { (cd "$updater_dir" && mise exec -C "$repo" -- node scripts/paseo-nix-update.mjs "$@") }
```

Network commands (`fetch`, `check`, `stage`) need to run outside the sandbox.

## 2. Check

Run `upd status --json` and `upd check --json`. Report active, staged, latest and
high-water versions. If `check` reports `canStage` false, or `latest` is missing (`latestError`),
report why and stop.

## 3. Stage and activate

```zsh
upd stage --json
upd activate --json
```

`stage` downloads and verifies the signed closure. `activate` switches the profile and
copies the release to `/Applications/Paseo.app`. While Paseo is running the copy is
deferred until the app exits. Stop on any failure and report the full output. Do not
retry with manual `nix-env` switching, and do not remove `operation.lock` unless
`ps -axo pid,args | grep '[p]aseo-nix-update'` shows no updater running.

Clean up with `rm -rf "$updater_dir"`.

## 4. Hand the restart to the user

If `active.version` now differs from the running app's version
(`packageVersion` in `/Applications/Paseo.app/Contents/Resources/paseo-nix-managed.json`),
print this command and tell the user to run it **from a terminal outside Paseo**
(Terminal.app, Ghostty, a zellij session not started by Paseo). Paseo's own terminals
die with its daemon partway through:

```zsh
pid=$(ps -axo pid=,args= | awk '$2 == "/Applications/Paseo.app/Contents/MacOS/Paseo" && NF == 2 { print $1 }') &&
[ -n "$pid" ] &&
/Applications/Paseo.app/Contents/Resources/bin/paseo daemon stop &&
kill -TERM "$pid" &&
"$HOME/Library/Application Support/Paseo/nix-update/profile/bin/paseo-nix-update" install-app --after-exit "$pid"
```

`pgrep` cannot see the app's main process, hence `ps`. The app quits cleanly on
`SIGTERM`. Unlike `osascript`, this needs no Automation permission, which nobody
can grant over SSH, so the command also works from a remote shell.
This mirrors the in-app restart: stop the daemon, quit the app, then the active
release's updater waits for the app to exit, replaces `/Applications/Paseo.app` and
opens it. The new app starts a matching daemon. If Paseo is not running, the user only
needs the last line without `--after-exit "$pid"`, then `open /Applications/Paseo.app`.

The in-app equivalent is the restart button in Settings → About after activation.

## 5. Report

Before/after versions, the `status`/`stage`/`activate` JSON results, and that the
restart is waiting on the user. When the user returns after restarting, confirm with
`upd status --json` (from a fresh export) that `active` is the new version and
`staged` is `null`, and that the marker's `packageVersion` matches.

## Recovery

Use the active release's packaged helper,
`~/Library/Application Support/Paseo/nix-update/profile/bin/paseo-nix-update`. Before
rolling back, resolve it to its absolute `/nix/store/...` path and use that one path
for the whole cycle, since older releases' helpers lack `reactivate-high-water`.

- `rollback` selects the previous retained release. It does not restore app data.
- `reactivate-high-water` returns to the highest activated release.

Both leave processes untouched; hand off the step 4 restart afterwards.
