# Agent testing status

Last updated: 2026-10-31

## Purpose

This links the [agent testing plan](AGENT_TESTING_PLAN.md), which holds the phase checklist,
to current evidence. The agent-facing result is [agent-testing.md](agent-testing.md).

## Current snapshot

| Field             | Status                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------- |
| Baseline          | `89889fa6d`, `dev` after the 2026-10-30 rebase onto upstream                              |
| Current phase     | Phase III (plan Phase 3) approved 2026-10-31: T, H, I, J, K, L                            |
| Overall state     | Phase II merged; T retires the `transfer` switch; open limits under Current boundary      |
| Immediate focus   | J (browser probes) in review, then K (`desktop:sandbox`)                                  |
| Routine CI budget | Critical path under 300 s from the `plan` job's start (`docs/GITHUB_WORKFLOWS_STATUS.md`) |

### Routine CI baseline

Dev push runs on hosted runners. The accepted baseline is the warm-cache rerun at `89889fa6d`.
The first run after the rebase refreshed the dependency cache (111 s) and missed the critical-path
budget at about 340 s with every lane green.

| Lane        | `8388477dd`, run `41105948216` (before the rebase) | `89889fa6d`, run `41127643308`, cold cache | `89889fa6d`, same run, warm rerun |
| ----------- | -------------------------------------------------- | ------------------------------------------ | --------------------------------- |
| app-1       | 136 s                                              | 226 s                                      | 149 s                             |
| app-2       | 115 s                                              | 193 s                                      | 110 s                             |
| quality     | 123 s                                              | 130 s                                      | 129 s                             |
| workspaces  | 175 s                                              | 233 s                                      | 186 s                             |
| server-1    | 181 s                                              | 266 s                                      | 179 s                             |
| server-2    | 171 s                                              | 313 s                                      | 219 s                             |
| server-3    | 167 s                                              | 187 s                                      | 222 s                             |
| integration | 171 s                                              | 235 s                                      | 168 s                             |
| Required    | pass                                               | fail (critical path)                       | pass                              |

## Chunks

`dev` was rebased onto upstream on 2026-10-30, after Phase I merged. SHAs below are the rebased
ones; SHAs in the 2026-10-30 log entries are superseded. The `?open=` fix (#266, a cherry-pick of
upstream #7918) is now upstream's own commit `9abc4f41f`.

| Chunk                    | Status      | Evidence                                                                      |
| ------------------------ | ----------- | ----------------------------------------------------------------------------- |
| A. Docs and device facts | complete    | #264, `416ab4e8c`; tablet results below                                       |
| B. Reach and observe     | complete    | Upstream #7918 (`9abc4f41f`); pair route and log lines #267, `cab4305db`      |
| C. Forms and selectors   | complete    | #268, `058c9ce85`                                                             |
| D. CLI and build         | complete    | #265, `7d58cefc8`; scratch-home runs below                                    |
| E. Motion                | complete    | #272, `5563b2dc8`; no app change needed; [results below](#e-motion-and-dumps) |
| F. Ready markers         | complete    | #274, `ab8dafbe5`; [results below](#f-ready-markers)                          |
| G. Debug switches        | complete    | #275, `489adafe4`; #276, `3b41fbffb`; [results below](#g-debug-switches)      |
| T. Retire `transfer`     | complete    | #278, `e3ad6f5f7`                                                             |
| H. `qa:web`              | complete    | #280, `333551771`; [results below](#h-qaweb)                                  |
| I. Android helper        | complete    | #282, `ddf9a2af5`; [results below](#i-android-helper)                         |
| J. Browser probes        | implemented | [results below](#j-browser-probes)                                            |

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

### Rebased build smoke

Build `89889fa6d` (sha256 `fe043c28…48c20b0`), installed as the harness APK on 2026-10-31. The
B and C pass scripts, rerun unchanged, gave the same results: 4 of 4 invalid offers logged
`link import status=failed` with no Unmatched Route; one bootstrap-probe and one
`firebase-not-configured` line on cold launch; cold `?open=` selected the terminal, agent and
file tabs; Enter in the host field focused the port, 6790 replaced 6767, and Enter in the port
connected.

### E: motion and dumps

Phone-width tablet (`wm size 1080x2400`, density 420), build `89889fa6d`. Each cell: frames
rendered (`dumpsys gfxinfo`) / accessibility events (`uiautomator events`) in 5 s untouched, then
successful dumps out of 3. The keyboard was down in every window. The running agent used an
offline ACP agent that stays mid-turn, on a scratch daemon. The phone was not measured.

| State                                             | Default scales        | Scales at 0                                               |
| ------------------------------------------------- | --------------------- | --------------------------------------------------------- |
| Idle: chat, settings, workspace                   | 0 / 1–2 / 3 of 3      | not run                                                   |
| Cold launch, measured from 1 s                    | 39–50 / 2–12 / 3 of 3 | not run                                                   |
| Agent running, another screen open                | 0 / 1–2 / 3 of 3      | not run                                                   |
| Agent running, compact sidebar open (status ring) | 237 / 40 / 0 of 3     | 0 / 1 / 3 of 3 after a relaunch                           |
| Agent running, its chat open                      | 36 / 49 / 0 of 3      | 37 / 49 / 0 of 3 before a relaunch; 5 / 12 / 0 of 3 after |

With the scales at 0 and a relaunch, the chat's remaining events are a text change on one
TextView every 1.0 s: the turn footer's elapsed time (`LiveElapsed`,
`packages/app/src/components/message.tsx`). Dumps made 1 s after a cold launch succeeded 3 of 3,
so the "while lists load" failures seen on the phone did not reproduce.

Web, headless Chromium at 1280×800 against a daemon-served web UI, 3 s window after 5 s settling:

| Screen                     | `no-preference`                                                                                                                   | `reduce`                        |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Home, settings, idle chat  | No running animations, no app `requestAnimationFrame` calls, no DOM changes                                                       | Same                            |
| Home, agent running        | One infinite 900 ms animation on `workspace-status-indicator-running`                                                             | None                            |
| Chat, agent running        | Two infinite animations (status indicator, agent tab); 61 frame callbacks/s; loader attribute changes; elapsed text once a second | Elapsed text once a second only |
| Switch thumb after a click | Slides over about 60–120 ms                                                                                                       | In place on the first frame     |

### F: ready markers

Web: the daemon-served UI built from the F branch, headless Chromium, prompts sent with
`paseo send` from outside the app. Each wait read `data-turns`, sent, then waited for
`agent-timeline-settled` with a larger `data-turns` (`waitForFunction`, no fixed sleeps).

| Turn                                | Runs | Result                                                  |
| ----------------------------------- | ---- | ------------------------------------------------------- |
| 0 ms (the agent ends at once)       | 4    | 4 of 4 detected as `turns` n+1, 0.8–1.3 s after sending |
| 200 ms                              | 4    | 4 of 4, 0.8–1.5 s                                       |
| 10 min, cancelled with `paseo stop` | 4    | 4 of 4, 1.4–2.5 s                                       |

A 0 ms turn still logs `running`, then `settled` about 120 ms later: the turn's open and close
reach the app as separate store updates. The count comes from a store subscription, so it would
also survive both landing in one update (`timeline-readiness-marker.test.tsx`).

Tablet, wide layout, a build of the F branch from before the turn counter's reference count
(JavaScript only, covered by that test): the logcat wait for `state=settled turns=1` returned
562 ms after a 0 ms prompt; a 10 min turn logged `running`, and cancelling it logged `settled
turns=2`. The dump after `settled` succeeded and did not contain the marker: the 1×1 node is not in
the accessibility tree, so Android waits use the log line.

In a fresh browser profile, opening `/h/<serverId>/agent/<agentId>` on the daemon-served web UI
first lands on `/open-project`; the same URL works once the host is saved.

### G: debug switches

Tablet, build of the G branch with `EXPO_PUBLIC_PASEO_AGENT_SWITCHES=1` (sha256 `674882c1…`),
harness terminal fixture, text typed with `adb shell input text`:

| Check                                             | Result                                                                                               |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Cold start, no extras                             | No `debug` lines, no trace                                                                           |
| Warm `--es paseo.trace terminal-input`            | `debug set key=trace value=terminal-input`; typing `ab3` traced as `aa0` (classes only)              |
| Home, then `am start` with no extras              | No second `debug set`                                                                                |
| Warm `paseo.trace off` and an unknown key         | `debug set key=trace value=off`, `debug rejected key=colour reason=unknown-key`                      |
| Cold start with `--es paseo.trace terminal-input` | `debug set` at launch; typing `Pw9x` traced as classes (`a`, `aa`, `aa0`, …)                         |
| Running chat, phone width, scales at 0            | 5 frames / 12 events / 0 of 3 dumps; with `clock=frozen`, 0 / 2 / 3 of 3                             |
| Cleared app, add the harness host                 | Permission dialog takes focus; with `notifications=skip`, no dialog and `push prompt status=skipped` |

Web, daemon-served UI built with the flag: `/settings/about` showed no Transfer row without
switches, `preferences-import` with `{"transfer":"receiver"}` in `sessionStorage`, and
`preferences-export` with `bridge`. The `transfer` switch was removed in Phase III because the
transfer flow is being retired.

The planned `updater=on` and `updaterBase` switches were dropped. Every updater call first checks
that the installed version code follows the fork's encoding and stops with "migration required"
otherwise, so a non-fork build would only ever show that state.

The first flagged build lost cold-start switches: the activity reaches the foreground before the
JavaScript subscribes, so the native module now holds switches until JavaScript takes them.
`pm revoke` plus clearing the permission flags did not bring the prompt back (Expo remembers that
it asked), so the prompt check used `pm clear`; the harness app was set up again with host
127.0.0.1:6790 and lost its other settings on 2026-10-31.

### H: `qa:web`

Station, `e3ad6f5f7` plus the H change, server built, web UI from the Phase II flagged build:

| Check                                                                                        | Result                                                                                                                      |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `--home` equal to an inherited `PASEO_HOME`                                                  | Refused, exit 1                                                                                                             |
| Fake `HOME` with a sentinel in `.paseo/config.json`, `PASEO_HOME` and `PASEO_HOST` inherited | Default home used; sentinel absent from it; fake home unchanged (paths and mtimes); nothing on 6767; no sockets in the home |
| Providers in `daemon status`                                                                 | Only `mock`; before the built-in plugins' providers were disabled, `antigravity` and `muse` registered too                  |
| `daemon.log` (110 lines, `listening` and web UI lines present)                               | No relay, download or plugin install lines                                                                                  |
| Seeded agents in Chromium                                                                    | All three reach `agent-timeline-settled`; the realistic turn shows an edit and shell commands, the image agent a data image |
| CLI-sent `agent send` on a seeded agent                                                      | `turns` 0 → 1, settled after 10.6 s (`ten-second-stream`)                                                                   |
| `--stop`                                                                                     | Supervisor, worker and port gone; refuses a home without `.qa-web`; a stopped daemon reports `wasRunning:false`             |
| Ready time                                                                                   | 3.4–4.3 s from launch to a reachable daemon; seeding adds 11–12 s                                                           |

`pluginsEnabled: false` only blocks configured plugins; built-in plugins always load. Their
providers are probed like any other: `muse` runs `muse --version` and then reads the account, and
`antigravity` runs `agy --version` and loads its catalog. qa:web therefore disables them in config
too, deriving their IDs from the built-in plugin list (a plugin named `<id>-provider` registers
`<id>`, which a test checks against the plugin sources); disabled providers are never probed.
Usage reads only happen when a client asks, and `UsageSession` refuses them when
`daemon.usage.enabled` is false.
`mock-slow` is a catalog-timeout fixture, not a slow turn; the mock provider's long models
replace Phase II's slow ACP agent.

### I: Android helper

Tablet, flagged harness APK, `scripts/android/agent-adb.py` run inside the pod with
`AGENT_ADB="$C adb"` and no other adb commands except `input` checks and log reads with `-T`:

| Check                                                            | Result                                                                                                                   |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `focus` with Paseo, the launcher and Settings in front           | Exit 0 for Paseo; `tap` refused with exit 2 for the launcher and Settings                                                |
| `--package sh.paseo.iexalt switch` and `open --cold`             | Refused, exit 2                                                                                                          |
| Phase I links, cold and warm (`pair#` and `///#` invalid offers) | Workspace deck reached, `link import status=failed`, no Unmatched Route; matches Phase I                                 |
| Cold `?open=terminal`, `agent`, `file`                           | The matching workspace tab is `selected`; matches Phase I                                                                |
| Direct form through `tap`, `type`, `key ENTER`                   | Host focused, Enter moves focus to the port, the port's text is replaced, the modal closes and the new host comes online |
| `turns`, a CLI-sent 0 ms turn, `wait-turn --after`               | 0 → 1 after 800 ms; a long turn cancelled → 2                                                                            |
| `turns` for an agent with no line                                | `unknown`, exit 3                                                                                                        |

The scratch daemon's host was removed again through the helper (`host-page-remove-host-button`,
`remove-host-confirm`), leaving the harness app with 127.0.0.1:6790 only. The phone was not
used; its check waits for the next phone session.

### J: browser probes

Station, `npm run probe -- .dev/probes/` with the committed example and two check probes:

| Check                                                                                       | Result                                                                                                    |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Example: a seeded agent's chat settles                                                      | Passes in 3.4 s after a 15–20 s `qa:web --seed heavy` boot                                                |
| `desktop: "local-daemon"`, then settings from the sidebar                                   | `settings-section-permissions` visible; without `desktop`, absent while `settings-section-general` shows  |
| A probe that fails on purpose after `console.error("Warning: %s received %d props: %o", …)` | `test-failed-1.png`, a trace and `console-tail.txt` with `Warning: ProbeCheck received 2 props: { a: 1 }` |
| Real app console                                                                            | React Native Web's `Animated: useNativeDriver is not supported…` warning arrives as text                  |
| Daemons after runs with failures                                                            | Every `.dev/qa-web` home stopped; a failure restarts the worker, which boots its own daemon               |
| App typecheck, oxlint, knip                                                                 | Clean for `packages/app/e2e/probe`; knip reports nothing new                                              |

The first fake returned `null` for `start_desktop_daemon`, and the app showed "The local server
failed to start". The desktop app parses a daemon status from start and restart as well as from
`desktop_daemon_status`, and connects over TCP when the status has `listen`.

## Current boundary

- `?open=` has no automated fork guard. Upstream #7918's hook test covers the hydration demand;
  the route wiring is covered only by the tablet pass, and upstream plans to remove `?open=` after
  2027-01-22.
- A running agent's open chat cannot be dumped on installed builds, whatever the animation
  scales: its elapsed time changes every second. G's frozen clock covers flag-gated builds only.
- Dump failures during loading were not reproduced on the tablet, and the phone was not measured.
- A real pairing (valid offer, connected host) cannot run on the tablet: the guest has no
  network and the harness daemon has no relay. The pass covers routing and the failure path; the
  redirect after a connected import is unchanged listener code and untested.
- Whether the soft keyboard stays up after Enter moves focus to the port is unchecked on a phone.
- The update row and update stages only run in `fork` builds, so their testIDs and logs get
  unit tests only. A run-time updater switch cannot help: a non-fork build fails the updater's
  installed-version check before it fetches anything. A fork-variant harness build is a Phase 3
  candidate.
- The readiness marker is web-only; Android waits use the `timeline state` log line.

## Active risks and decisions

| Risk or decision | Evidence or uncertainty                                                                      | Mitigation                                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared tablet    | Other sessions drive the same guest and harness APK                                          | `/tmp/t3/LOCK-agent-testing` while driving; focus guard on every action; HARNESS.md updated                                                                    |
| Upstream drift   | `dev` is rebased onto upstream periodically (645 commits on 2026-10-30), which rewrites SHAs | Cite PR numbers with SHAs; check upstream before each app fix                                                                                                  |
| Transfer switch  | The preferences transfer flow is being retired (user decision, 2026-10-31)                   | T removes the `transfer` switch; builds that still get it log `debug rejected key=transfer reason=unknown-key`                                                 |
| Turn batching    | The turn counter relies on the turn's open and close reaching the store as separate updates  | Only the station probe (a 0 ms CLI-sent turn) detects a change; the unit test calls `setState` by hand and cannot. No automated guard                          |
| CI headroom      | After the rebase, server-2 and server-3 take 219 s and 222 s against the 300 s critical path | Watch each chunk's run; app tests from F and G land in app lanes                                                                                               |
| App lane noise   | Dev pushes with no app change ran app-2 in 115–204 s (`cdb9e43e5`, `5563b2dc8`, `efb823a20`) | Compare app-1 plus app-2 across several runs before calling a regression; G's two runs (151 s, 156 s) sit inside that range and its new tests take under 0.2 s |

## Open questions

- **Connect with the keyboard up:** at phone width, tapping Connect while the host field has the
  keyboard up sometimes does not submit the direct form. Seen once in E; in the retry on
  2026-10-31, one valid try did not submit even after a second tap and one submitted on the first
  (a third try did not open the form). Unexplained; check the modal's tap handling before
  deciding scope.
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
- B and C merged as `d2cc31dc7` (#267) and `316706e7c` (#268); Phase I complete.

### 2026-10-31

- Phase II approved with the reviewer's amendments: G gated by a build flag; the deferred
  permission prompt dropped in favour of a test-mode skip in G.
- `dev` was rebased onto upstream after Phase I merged. The harness APK is now `89889fa6d`; Phase I
  behaviour re-checked on it. The cold-cache CI run missed the critical-path budget; the warm rerun
  passed and is the new baseline.
- E measured: animation scales at 0 plus a relaunch stop the ring and loader; the 1 Hz elapsed
  time still blocks dumps in a running chat; the web app already honours reduced motion. E ships
  as documentation, and the frozen clock moves to G.
- E merged as #272. F's readiness marker and `timeline state` log line pass the web probe with
  CLI-sent 0 ms, 200 ms and cancelled turns, and the tablet logcat wait; the marker is web-only.
- F merged as #274. G: trace, frozen clock and notification switches pass on the tablet; the
  harness APK is now the flagged G build.
- G: the transfer switch shows the Transfer row on web with no source edit; the updater switch is
  deferred to a fork-variant harness build (Phase 3 candidate).
- G merged as #275 and #276. Phase II complete; the guide now points running-chat dumps at the
  frozen clock and warns that `pm clear` wipes the shared harness.
- Phase III approved: T (retire the `transfer` switch), H `qa:web`, I Android helper, J
  `e2e/probe/`, K `desktop:sandbox` (the userData default flip comes back as its own decision),
  and L, a fork-variant harness build that brings back the updater switch. The phone-debug skill
  update after I includes a home-manager switch.
- T merged as #278. H: `qa:web` starts a scratch daemon in 3.4–4.3 s on the station with only the
  mock provider on; the isolation, readiness and stop checks pass.
- H merged as #280. I: `agent-adb.py` repeats the Phase I link and form checks and F's turn wait
  on the tablet with no other adb commands, and refuses input outside the app and restarts of the
  user's own app.
- I merged as #282; the phone-debug skill points at the helper (nix-home-manager-config
  `07a39af`). No home-manager switch was needed: skills are linked out of the store, and a
  generation built from the pushed commit matched the active one file for file.
- J: probes in `.dev/probes` run with `npm run probe` against a `qa:web` daemon, with a typed fake
  desktop bridge and console tails on failure.
