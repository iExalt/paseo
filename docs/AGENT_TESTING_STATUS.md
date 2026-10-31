# Agent testing status

Last updated: 2026-10-31

## Purpose

This links the [agent testing plan](AGENT_TESTING_PLAN.md), which holds the phase checklist,
to current evidence. The agent-facing result is [agent-testing.md](agent-testing.md).

## Current snapshot

| Field             | Status                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------- |
| Baseline          | `89889fa6d`, `dev` after the 2026-10-30 rebase onto upstream; Phase III ends at `bb6460ca5`   |
| Current phase     | Phase III (plan Phase 3) complete 2026-10-31: T, H, I, J, K, K2, L                            |
| Overall state     | Phases I–III merged; Phase 4 waits for its areas to be touched; limits under Current boundary |
| Immediate focus   | None approved; the approved follow-ups and the tablet network are done                        |
| Routine CI budget | Critical path under 300 s from the `plan` job's start (`docs/GITHUB_WORKFLOWS_STATUS.md`)     |

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

| Chunk                    | Status   | Evidence                                                                      |
| ------------------------ | -------- | ----------------------------------------------------------------------------- |
| A. Docs and device facts | complete | #264, `416ab4e8c`; tablet results below                                       |
| B. Reach and observe     | complete | Upstream #7918 (`9abc4f41f`); pair route and log lines #267, `cab4305db`      |
| C. Forms and selectors   | complete | #268, `058c9ce85`                                                             |
| D. CLI and build         | complete | #265, `7d58cefc8`; scratch-home runs below                                    |
| E. Motion                | complete | #272, `5563b2dc8`; no app change needed; [results below](#e-motion-and-dumps) |
| F. Ready markers         | complete | #274, `ab8dafbe5`; [results below](#f-ready-markers)                          |
| G. Debug switches        | complete | #275, `489adafe4`; #276, `3b41fbffb`; [results below](#g-debug-switches)      |
| T. Retire `transfer`     | complete | #278, `e3ad6f5f7`                                                             |
| H. `qa:web`              | complete | #280, `333551771`; [results below](#h-qaweb)                                  |
| I. Android helper        | complete | #282, `ddf9a2af5`; [results below](#i-android-helper)                         |
| J. Browser probes        | complete | #283, `ba090cd40`; [results below](#j-browser-probes)                         |
| K. Desktop sandbox       | complete | #284, `23675058b`; userData #285, `75d66c608`; [results](#k-desktop-sandbox)  |
| L. Fork-variant build    | complete | #286, `bb6460ca5`; [results below](#l-fork-variant-build)                     |

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

### K: desktop sandbox

Station, desktop main built from `ba090cd40` plus K, renderer from the daemon-served web UI:

| Check                                                   | Result                                                                                                      |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `desktop:sandbox --seed heavy`                          | Ready in 19.1 s, 11.7 s of it seeding; one JSON line                                                        |
| First start                                             | Electron aborted: `chrome-sandbox` is not setuid root on the station; `--no-sandbox` is now added only then |
| `desktop_daemon_status` through the real preload bridge | The sandbox home and server, `running`, `desktopManaged: false`; supervisor pid unchanged                   |
| `connectToPaseoRenderer` from a second process          | The app's page in 65 ms                                                                                     |
| Settings from the sidebar                               | `settings-section-permissions` visible, with the real bridge's 16 members                                   |
| `--stop`                                                | Electron and Xvfb process group gone, daemon stopped (`daemonWasRunning: true`), CDP port closed            |

The desktop app adopts a running daemon in its `PASEO_HOME` without managing it, so quitting
Electron leaves the daemon to `--stop`. No existing desktop e2e changed: they run in deep CI
(`daemon-lifecycle.e2e.mjs`) or by hand, and adopting `connectToPaseoRenderer` in
`browser-tabs.e2e.mjs`, `packaged-app-smoke.js` and `verify-electron-cdp.mjs` is left for when
those upstream files are next touched.

### L: fork-variant build

Tablet, `npm run build:apk:arm64 -- --fork` from `75d66c608` plus L, with
`EXPO_PUBLIC_PASEO_AGENT_SWITCHES=1` and a placeholder Firebase file at
`~/.config/paseo-agent-testing/google-services-placeholder.json` on the station (sha256
`399576e2…`):

| Check                                     | Result                                                                                                                                    |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| APK identity                              | `sh.paseo.iexalt`, versionName 0.16.0, versionCode 216000, equal to `forkAndroidVersionCode("0.16.0")`; no Firebase copy left in the tree |
| Helper without `AGENT_ADB_ALLOW_PACKAGES` | `open` refused, exit 2                                                                                                                    |
| Launch, background check                  | `update failed status=checking reason="… UnknownHostException: Unable to resolve host \"api.github.com\" …"`; the row stays idle          |
| `fork-android-update-row` after launch    | Status "Check for a signed stable fork update.", action "Check"                                                                           |
| Tap Check                                 | `update status status=checking`, the same `update failed` line, then `update status status=error`                                         |
| Row after the check                       | "Could not verify the published fork update. Check your connection and retry.", action "Check"                                            |
| Afterwards                                | `sh.paseo.iexalt` uninstalled with its data; `sh.paseo` untouched; HARNESS.md notes it                                                    |

No updater switch came back. A fork build runs the updater by itself, and `updaterBase`, the one
switch that would add something, cannot work: the native module fetches only https from GitHub
hosts on port 443, redirects included (`PaseoForkUpdatesModule.kt:39-44`), and the guest has
no network. The helper's `open` named the activity `sh.paseo.MainActivity`, which the fork
package does not have; it is now package-relative. The error row blames verification for what
was a DNS failure; it now reads "Could not reach GitHub" for network errors (follow-up PR).

Follow-up, same day: a GitHub-only CONNECT proxy in the pod (port 443 to the native allowlist's
hosts, behind `adb reverse`) set as the guest's `global_http_proxy_*` did not help. The check
failed with the same `UnknownHostException` and the proxy logged no connection: with no network
interface (`cf-tablet` launches with `--enable_tap_devices=false`), the app resolves the host
itself. The settings, the reverse and the install were removed afterwards. Downloads go through
the system DownloadManager, which waits for a system network, so a proxy could not have carried
them either. A full update run needs tap devices, which need `NET_ADMIN` in the pod spec.

### Tablet network (N), 2026-10-31

At the user's choice, the dev pod's container gained `NET_ADMIN`, `NET_RAW` and `/dev/net/tun`
(infra repo, flux-apps `a92221e`, bumped in `ddfacf9`). The guest now reaches the internet over
Wi-Fi: Cuttlefish's OpenWRT VM serves VirtWifi, bridged on `cvd-wbr` and masqueraded out of the
pod, with guest DNS sent to the cluster resolver. `cf-tablet start` builds the taps and NAT and
connects Wi-Fi by default (`CF_NET=0` restores the offline guest with airplane mode). Cellular
stays connecting and Ethernet gets no DHCP; neither is needed. Over 22 minutes with network,
system_server did not restart, so the airplane-mode workaround is now only for `CF_NET=0`.

The restart wiped the pod's `/tmp/t3`. It came back from a 16 GB archive on the CephFS home
volume, which from this station flushes and reads at about 3 MB/s (a Tailscale relay to the
storage hosts). Splitting it into three zstd archives (5.1 GB) from a pod on a storage host cut
the restore to 31 minutes. HARNESS.md records the restore and the rule to sync before a restart.

| Run                                  | Result                                                                                                    |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Locally signed 0.15.0 fork build     | Found 0.16.0. The 2 MB zstd delta failed its checksum (different base APK); the 44.6 MB gzip verified     |
| Its Install                          | Android rejected the session: `INSTALL_FAILED_UPDATE_INCOMPATIBLE` (signers differ), as expected          |
| Row after the rejection              | "Could not verify the published fork update.", although verification passed; fixed in #292                |
| Published 0.15.0 release from GitHub | Verified 0.16.0 from the 2 MB delta and opened Android's installer (`INSTALL_PACKAGE` intent, not tapped) |
| Afterwards                           | `sh.paseo.iexalt` uninstalled; the installer and Settings force-stopped; `sh.paseo` untouched             |

## Current boundary

- `?open=` has no automated fork guard. Upstream #7918's hook test covers the hydration demand;
  the route wiring is covered only by the tablet pass, and upstream plans to remove `?open=` after
  2027-01-22.
- A running agent's open chat cannot be dumped on installed builds, whatever the animation
  scales: its elapsed time changes every second. G's frozen clock covers flag-gated builds only.
- Dump failures during loading were not reproduced on the tablet, and the phone was not measured.
- A real pairing (valid offer, connected host) has not run on the tablet: the harness daemon
  has no relay, though the guest now has network. The pass covers routing and the failure path; the
  redirect after a connected import is unchanged listener code and untested.
- Whether the soft keyboard stays up after Enter moves focus to the port is unchecked on a phone.
- The fork updater's check, delta and full downloads, verification and Android's signer
  rejection ran live on the tablet (N). A completed install did not: the release's installer
  dialog was not tapped, and the shell cannot make the app its own installer
  (`cmd package set-installer` throws `SecurityException`), so a prompt-free self-update needs a
  device where a release installed itself. The session-install success path is untested.
- `agent-adb.py` ran only on the tablet; it is unchecked on a phone (next phone session).
- `connectToPaseoRenderer` is not used by the existing desktop e2e scripts
  (`browser-tabs.e2e.mjs`, `packaged-app-smoke.js`, `verify-electron-cdp.mjs`); adopt it when they
  are next touched, or offer it upstream with #285.
- `desktop:sandbox --metro` was not tried.
- The readiness marker is web-only; Android waits use the `timeline state` log line.

## Active risks and decisions

| Risk or decision | Evidence or uncertainty                                                                                  | Mitigation                                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared tablet    | Other sessions drive the same guest and harness APK                                                      | `/tmp/t3/LOCK-agent-testing` while driving; focus guard on every action; HARNESS.md updated                                                                    |
| Upstream drift   | `dev` is rebased onto upstream periodically (645 commits on 2026-10-30), which rewrites SHAs             | Cite PR numbers with SHAs; check upstream before each app fix                                                                                                  |
| Dev userData     | Direct unpackaged launches outside a worktree use `<appData>/Paseo-dev` (#285, user decision 2026-10-31) | Every main checkout on a machine shares `Paseo-dev`; offer #285 upstream                                                                                       |
| Transfer switch  | The preferences transfer flow is being retired (user decision, 2026-10-31)                               | T removes the `transfer` switch; builds that still get it log `debug rejected key=transfer reason=unknown-key`                                                 |
| Turn batching    | The turn counter relies on the turn's open and close reaching the store as separate updates              | Only the station probe (a 0 ms CLI-sent turn) detects a change; the unit test calls `setState` by hand and cannot. No automated guard                          |
| CI headroom      | After the rebase, server-2 and server-3 take 219 s and 222 s against the 300 s critical path             | Watch each chunk's run; app tests from F and G land in app lanes                                                                                               |
| App lane noise   | Dev pushes with no app change ran app-2 in 115–204 s (`cdb9e43e5`, `5563b2dc8`, `efb823a20`)             | Compare app-1 plus app-2 across several runs before calling a regression; G's two runs (151 s, 156 s) sit inside that range and its new tests take under 0.2 s |

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

- **Typecheck in fresh worktrees.** Resolved on 2026-10-31. `CLAUDE.md` says to run typecheck
  after every change, but a fresh worktree has no workspace `dist` declarations: root typecheck
  failed with 2,344 errors in 8 workspaces. Worse, that run cached its errors in the CLI's
  incremental `tsconfig.tsbuildinfo`, so typecheck still failed after `npm run build:server`
  until the cache was deleted. Root `typecheck` and `typecheck:server` now run `build:server`
  first when a package it builds has no `dist` (41 s cold, then 23 s; the check adds about 60 ms).
  A worktree whose cache was already poisoned needs its `packages/*/tsconfig.tsbuildinfo` deleted.
- **Unpackaged desktop userData.** Resolved on 2026-10-31. The `main.ts` comment said the main
  checkout gets "default userData"; because `app.setName("Paseo")` runs before anything reads the
  path, that default was `<appData>/Paseo`, the installed app's directory. At the user's choice,
  direct unpackaged launches outside a worktree now use `<appData>/Paseo-dev` (a fork change, to
  offer upstream). electron-log wrote `<appData>/Paseo/logs/main.log` on Linux whatever the
  userData; unpackaged launches and launches with `PASEO_ELECTRON_USER_DATA_DIR` now log to
  `<userData>/logs/main.log` (checked with `desktop:sandbox`: the installed app's log did not grow). Because the single-instance lock lives in userData, a direct launch also
  no longer signals the user's running app as a second instance. Two main checkouts on one
  machine now share `Paseo-dev`.

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
- J merged as #283. K: `desktop:sandbox` runs the desktop app headless on the station against a
  qa:web daemon and refuses to report ready unless the app adopted that daemon. A direct
  unpackaged launch outside a worktree shares the installed app's userData (measured).
- K merged as #284. The user chose to isolate direct unpackaged launches: outside a worktree they
  now use `<appData>/Paseo-dev`, checked on the station from a plain git checkout, from outside git
  and from a linked worktree (unchanged `Paseo-<worktree>`).
- K2 merged as #285. L: the native updater fetches only https from GitHub and the guest has no
  network, so the planned loopback mirror was dropped. The user chose an offline run now and
  guest network as a follow-up. The fork build's update row and its offline failure ran on the
  tablet; the build was then uninstalled.
- L merged as #286. A GitHub-only proxy did not give the guest's updater network, so a full
  update run needs tap devices in the pod. Phase III complete.
- Follow-ups approved: the updater error copy, the CLAUDE.md platform-gating row, the
  unpackaged Electron log path, and network for the tablet.
- Follow-ups merged: #288 (network errors read "Could not reach GitHub"), #289 (CLAUDE.md row),
  #290 (unpackaged Electron log path), #291 (`qa:web` checks node-pty's native build). The user
  approved changing the shared dev pod; the tablet guest now has network (N above). The live
  update run found install rejections blamed on verification: #292. In the infra repo,
  `mise run check` failed only at check-inventory (ansible-core under Python 3.15 on the Mac,
  unrelated); check-flux, lint-markdown and check-submodules passed.
