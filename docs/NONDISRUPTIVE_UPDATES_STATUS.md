# Non-disruptive desktop updates: status

Goal: a Paseo desktop update (Nix-managed macOS, and the Nix Linux relaunch) never
interrupts a running agent. The app restarts on its own; the daemon keeps running on
its old version and upgrades itself to the app's version the next time every agent is
idle. Approved scope (user, 2026-11-04: "Approve as proposed"): chunks 1–3 below in one
PR to `dev`; a release and the live Mac check need separate approval.

## Design decisions

- The daemon decides idleness and stops in one step (`shutdown_server_request` with
  `onlyIfIdle`). A desktop-side poll-then-stop would race a turn sent from the phone or a
  schedule.
- Idle reuses the idle-runtime-cleanup eligibility (`AgentManager.runtimeHasNoPendingWork`
  plus each provider's `canStopRuntime` veto), so a Claude background task or a running
  subagent keeps the daemon up.
- The desktop drives the upgrade while it runs. A daemon that arms itself and stops when
  idle would stay down if the app had quit, which breaks phone-only use.
- On a version mismatch in either direction the app tries stop-if-idle; an idle daemon at
  startup upgrades at once, as before.
- On Nix-managed macOS the daemon runs from the release's immutable `/nix/store` bundle,
  so replacing `/Applications/Paseo.app` neither waits for it nor swaps files under it.
  Nix keeps a running process's store paths alive, so pruning needs no change.
  `PASEO_CLI` keeps its `/Applications` path: terminals hold it for life, and a store path
  in an environment is no GC root. Terminal workers no longer count as running from the
  copy. Only the active release replaces a daemon of another version, so a stale copy
  cannot downgrade it; an app running from its store bundle retries the copy.
- The first update into this version still stops the daemon: that restart runs the old
  app's code. A daemon older than 0.21.0 cannot stop only when idle, so the new app keeps
  it. The `update-nix-paseo` skill stages and activates safely, then requires explicit
  approval before a disruptive legacy-daemon stop. App-only restarts use the dedicated
  relaunch path, or ordinary quit only with `keepRunningAfterQuit` enabled.
- While the daemon is busy the app retries every 60 s; any unknown stop outcome re-reads
  the daemon before deciding. Windows keeps the old behaviour.

## Chunks

| Chunk | Outcome                                                                       | State                                                |
| ----- | ----------------------------------------------------------------------------- | ---------------------------------------------------- |
| 1     | Daemon stop-if-idle RPC, client gate, `paseo daemon stop --if-idle`           | complete: accepted 358608a50; nit d952c69d8 reviewed |
| 2     | Update restart and quit leave the daemon running; mismatch upgrades when idle | complete: accepted 232a01e4d; nit in 483247c2b       |
| 3     | Daemon launched from the Nix store bundle on macOS                            | complete: accepted 483247c2b; fix 15724e957 accepted |
| D     | Live check on the Mac after a release (gate)                                  | deferred: needs a release and a user restart         |

## Deferred gate D

Run after the user approves a release and restarts into it: update with an agent mid-turn;
the turn finishes; the daemon upgrades once idle; `/Applications/Paseo.app` holds the new
version; agents spawned by a store-launched daemon keep their macOS file-access (TCC)
permissions; launching the `/Applications` copy while the store copy runs focuses the
existing window (single-instance lock shared across both copies).
Also check: the daemon's executable is under `/nix/store`; `/Applications/Paseo.app` updates
while terminals stay open; after the restart, `ps` shows nothing but an ignored terminal
worker running from `/Applications` (lingering Electron helpers would hold the copy).

## By the way

- No CI job runs `scripts/*.test.mjs` (`node --test`), so the updater script tests, including
  `bundleProcesses`, run only locally. Adding a CI step changes CI; leave it to its own PR.

## App and host update status (2026-11-06)

User approval: “SGTM. Working in a worktree on dev-station, implement the plan with
$iExalt:keep-me-in-the-loop.” Scope: app-only update controls in About; automatic
local daemon upgrade progress in Host Overview; links from About's connected hosts.
Medium autonomy. Worktree: `/home/ubuntu/Projects/paseo-update-ui`, baseline
`388d619f2047d911bd444035118c4f6c741ea3b4`. No release or live laptop rollout authorized.

- [x] A: app-update facts independent of daemon version; authoritative idle-upgrader
      state through the desktop status/event bridge, with identity and cancellation guards.
- [ ] B: Host Overview owns daemon progress; About app controls clear when current;
      connected-host links open Overview. Remote/manual hosts retain their own capability
      checks and are never assigned this desktop's pending target.
- [ ] C: isolated browser journeys for waiting, failure, completion, app updates and
      host navigation; integration review, required CI, PR merge and cleanup.

Acceptance requires current scoped tests and browser evidence. A must be accepted
before B consumes its state. A normal busy wait is informational; manual disruptive
restart stays in Danger zone. The installed Mac acceptance gate above remains
separate; renderer fixtures do not prove a signed-release installation.

Review ledger: A1 round 1, 0 material / 0 total findings, reviewer accepted the
frozen A1 source snapshot for B dependency. Ran five scoped Vitest files covering
the idle upgrader, real manager event/status bridge, renderer parser, shared query
subscription and app-update resolver: 44 passed in 1.19 s on dev-station (warm
outputs, one runner). Desktop typecheck passed. The initial baseline setup lacked
workspace outputs; `node scripts/ensure-workspace-builds.mjs` built them once.
Rendered live refresh/navigation and integration checks remain C gates.
