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
- The first update into this version still stops the daemon: that restart runs the old
  app's code. A daemon older than 0.21.0 cannot stop only when idle, so the new app keeps
  it; the `update-nix-paseo` skill adds `daemon stop` to its restart command only for one.
- While the daemon is busy the app retries every 60 s; any unknown stop outcome re-reads
  the daemon before deciding. Windows keeps the old behaviour.

## Chunks

| Chunk | Outcome                                                                       | State                                        |
| ----- | ----------------------------------------------------------------------------- | -------------------------------------------- |
| 1     | Daemon stop-if-idle RPC, client gate, `paseo daemon stop --if-idle`           | complete: reviewer accepted 358608a50        |
| 2     | Update restart and quit leave the daemon running; mismatch upgrades when idle | active                                       |
| 3     | Daemon launched from the Nix store bundle on macOS                            | planned                                      |
| D     | Live check on the Mac after a release (gate)                                  | deferred: needs a release and a user restart |

## Deferred gate D

Run after the user approves a release and restarts into it: update with an agent mid-turn;
the turn finishes; the daemon upgrades once idle; `/Applications/Paseo.app` holds the new
version; agents spawned by a store-launched daemon keep their macOS file-access (TCC)
permissions; launching the `/Applications` copy while the store copy runs focuses the
existing window (single-instance lock shared across both copies).
