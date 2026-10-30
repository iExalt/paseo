# Agent testing status

Last updated: 2026-10-30

## Purpose

This links the [agent testing plan](AGENT_TESTING_PLAN.md), which holds the phase checklist,
to current evidence. The agent-facing result is [agent-testing.md](agent-testing.md).

## Current snapshot

| Field             | Status                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------- |
| Baseline          | `8388477dd` (`feat(app): update the fork Android app without the system installer screens`) |
| Current phase     | Phase I (plan Phase 0 and Phase 1): A, D and the `?open=` fix merged; B and C in review     |
| Overall state     | Every Phase I item implemented; B and C passed the combined tablet pass                     |
| Immediate focus   | Publish B and C, then propose Phase II                                                      |
| Routine CI budget | Under 5 min per lane (`docs/GITHUB_WORKFLOWS_STATUS.md`); baseline below                    |

### Routine CI baseline

Dev push run `41105948216` at `8388477dd`, hosted runners:

| Lane        | Wall time |
| ----------- | --------- |
| app-1       | 136 s     |
| app-2       | 115 s     |
| quality     | 123 s     |
| workspaces  | 175 s     |
| server-1    | 181 s     |
| server-2    | 171 s     |
| server-3    | 167 s     |
| integration | 171 s     |

## Chunks

| Chunk                    | Status   | Evidence                                                                                       |
| ------------------------ | -------- | ---------------------------------------------------------------------------------------------- |
| A. Docs and device facts | complete | Merged as `5f851ea50` (#264); tablet results below                                             |
| B. Reach and observe     | active   | `?open=` fix merged as `ef86116fc` (#266); pair route and log lines passed the B/C tablet pass |
| C. Forms and selectors   | active   | Passed the B/C tablet pass                                                                     |
| D. CLI and build         | complete | Merged as `a29b61fa4` (#265); scratch-home runs below                                          |

### A: device facts

Android 17 Cuttlefish tablet, `sh.paseo` 0.16.0 built at `8388477dd`, harness daemon 0.10.0.
State judged by `selected="true"` resource-ids in raw `uiautomator dump` output.

| Check                                                              | Result                                                                                                                                                                       |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `paseo://settings/about`, `/appearance`                            | Correct page, cold and warm                                                                                                                                                  |
| `paseo://h/<srv>/agent/<id>`                                       | Agent tab selected, cold and warm                                                                                                                                            |
| `?open=` before the fix                                            | Cold start kept the previous tab (agent 0 of 2); `file:` tabs never selected (0 of 4). Probe: `hasHydratedWorkspaces` stayed false, so the pending intent was never consumed |
| `?open=` after upstream #7918 (probe build at `5f851ea50` + #7918) | 8 of 8 selected: cold `agent:`, `terminal:`, `file:`; warm `agent:`, `file:` then `agent:`, `terminal:`                                                                      |
| `paseo://pair#offer=…`                                             | "Unmatched Route", cold and warm                                                                                                                                             |
| `paseo:///#offer=…`                                                | No route change                                                                                                                                                              |
| `[OfferLinkListener] Pairing link failed`                          | Logged in 2 of 4 runs with an invalid offer                                                                                                                                  |
| Idle `uiautomator dump`                                            | 15 of 15 on chat, settings and sessions at default animator scale; scale-0 test not run                                                                                      |
| Terminal text in dumps                                             | Present as `terminal-row-<n>` (plan item 16's terminal half is done)                                                                                                         |
| `pm grant sh.paseo …POST_NOTIFICATIONS`                            | Granted                                                                                                                                                                      |
| `daemon status --json` (0.10.0 daemon)                             | Includes `workerPid`                                                                                                                                                         |

### D: CLI and build

Scratch homes on dev-station, port 7811, never the user's daemon.

| Check                                                         | Result                                                                                             |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `daemon start` with `PASEO_LISTEN=…7899 PORT=9999`            | Listened on the config's 7811 at base with no message; now prints `Ignoring PASEO_LISTEN, PORT: …` |
| `daemon status --json`                                        | `workerPid` present at base                                                                        |
| `daemon stop --home`                                          | Supervisor and worker pids both gone 3 s later, at base                                            |
| `daemon pair --home <offline home> --app-url paseo:// --json` | `paseo:///#offer=…` with a QR; without the flag, `https://app.paseo.sh/#offer=…`                   |
| `build:main`, `rm -rf dist`, `build:main`                     | Base: second build emits nothing (331 ms). Fixed: `dist/main.js` emitted, also after `typecheck`   |

### B and C: combined tablet pass

Build `ca053ac5e` (dev `ef86116fc` plus both branches), installed as the harness APK on
2026-10-30. Raw dumps and logcat excerpts: `/tmp/t3/at/pass-2026-10-30/` in the dev pod (emptyDir;
lost on a pod restart).

| Check                                                       | Result                                                                                                                                                                                                       |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pair#offer=invalid` and `///#offer=invalid`, cold and warm | 4 of 4 logged `link import status=failed reason="TypeError: Decoder error"`; no Unmatched Route; each landed on the open workspace                                                                           |
| Cold launch                                                 | One `connection bootstrap-probe … status=failed` line, one `push register status=unavailable reason=firebase-not-configured`, `connection status … status=online transport=directTcp`; no old-style warnings |
| Cold `?open=agent:` and `file:` from a terminal tab         | Agent and README tabs selected                                                                                                                                                                               |
| Direct form                                                 | Enter in host focused the port (`focused="true"`); typing 6790 over 6767 gave 6790 after both the Enter focus and a tap; Enter in the port connected to the 0.10.0 harness daemon and closed the modal       |
| Keyboard after Enter in host                                | `mInputShown=false` with `show_ime_with_hard_keyboard=1`; the tablet's virtio keyboard decides this, so a phone check is still open                                                                          |
| Find, phone-width (`wm size 1080x2400`, density 420)        | Tab switcher → tab menu → Find; `pane-find-input`, `-status` (`1 of 2`), `-next`, `-previous`, `-close` present                                                                                              |
| Compact sidebar                                             | Closed: 0 `sidebar*` nodes; open: 25 (20 clickable); closed again: 0                                                                                                                                         |
| `settings-section-*`                                        | Present in phone-width and wide layouts                                                                                                                                                                      |
| Display restored                                            | `wm size reset`, `wm density reset`: 2560x1600 at 320; navigation mode 0                                                                                                                                     |

## Current boundary

- `?open=` has no automated fork guard. Upstream #7918's hook test covers the hydration demand;
  the route wiring is covered only by the tablet pass, and upstream plans to remove `?open=` after
  2027-01-22.
- The idle-dump failure is not reproduced on the tablet. It was seen only on the phone in
  loading or running states (Phase 2 item 8).
- A real pairing (valid offer, connected host) cannot run on the tablet: the guest has no
  network and the harness daemon has no relay. The pass covers routing and the failure path; the
  redirect after a connected import is unchanged listener code and untested.
- Whether the soft keyboard stays up after Enter moves focus to the port is unchecked on a phone.
- The update row and update stages only run in `fork` builds, so their testIDs and logs get
  unit tests only until Phase 2 item 9.

## Active risks and decisions

| Risk or decision | Evidence or uncertainty                                                      | Mitigation                                                                                  |
| ---------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Shared tablet    | Other sessions drive the same guest and harness APK                          | `/tmp/t3/LOCK-agent-testing` while driving; focus guard on every action; HARNESS.md updated |
| Upstream drift   | 121 upstream commits past the merge-base, some in workspace tab code (#8093) | Check upstream before each app fix                                                          |

## Open questions

- **Linux `sharp` binaries:** whether the lockfile lacks them is inferred from an error message.
- **Theme loss after SIGTERM:** unflushed storage is unproven; the retry passed.
- **Git requirement for the desktop dev runner:** appears fixed; `git branch --show-current` no
  longer appears in `packages/desktop/scripts`.

## Where docs and code disagree

- **Typecheck in fresh worktrees.** `CLAUDE.md` says to run typecheck after every change, but a
  fresh worktree fails typecheck until `npm run build:server` has run. Reproduced on 2026-10-30:
  the chunk A pre-commit typecheck failed in a new dev-station worktree and passed after
  `build:server`.
- **Unpackaged desktop userData.** The `packages/desktop/src/main.ts` comment says the main
  checkout gets "default userData". Without `PASEO_ELECTRON_USER_DATA_DIR` that is Electron's
  default path, which Electron likely derives before `app.setName("Paseo")` runs; whether it is the
  installed app's `Paseo` directory is unverified. `npm run dev:desktop` always sets the variable.

## Progress log

### 2026-10-30

- Plan approved for Phase I. Review moved the `?open=` guard into a fix, narrowed item 6 and
  item 7, and dropped "stop kills workers" for lack of evidence.
- Chunk A: harness APK replaced with a `8388477dd` build; deep links, pairing links and idle
  dumps checked on the tablet; `docs/agent-testing.md` written.
- Chunk A merged as `5f851ea50` (#264); the phone-debug skill points at `docs/agent-testing.md`
  (home-manager config `05ee966`, active after the next switch).
- Chunk D: `daemon start` names ignored overrides, `daemon pair --app-url`, desktop `build:main`
  no longer skips its emit. "Stop kills workers" and the `workerPid` sub-item needed no change.
- `?open=` fixed by cherry-picking upstream #7918 (#266): the workspace route never demanded the
  host directory, so workspaces never hydrated and pending intents waited forever.
- B and C passed one combined tablet pass on build `ca053ac5e`; the harness APK is now that build.
