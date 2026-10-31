# Plan: make Paseo easy for agents to test ad hoc

Written 2026-10-30. Progress and evidence: [AGENT_TESTING_STATUS.md](AGENT_TESTING_STATUS.md).
The agent-facing result is [agent-testing.md](agent-testing.md).

It draws on 21 past agent sessions, read through the transcripts:

- **Mobile:** the 8 `/phone-debug` sessions, plus 4 earlier adb sessions that the skill-authoring session mined.
- **Desktop and web:** 9 sessions.

"Ad hoc" means an agent checking a change or reproducing a bug on request, not the committed test suites.

## What the transcripts show

- **Selectors are not the problem.** `testID` already appears 1,194 times and surfaces as `resource-id` on Android and `data-testid` on web. Tapping or clicking by ID worked whenever the agent could see the UI tree.
- **Mobile friction**, in the order agents hit it:
  - getting to a screen took long tap sequences, and the pairing link opens an "Unmatched Route" page;
  - `uiautomator dump` fails while the app animates, so agents tapped coordinates estimated from screenshots;
  - forms shift when the keyboard opens;
  - app state (connection, update progress, push received) is visible only in screenshots;
  - trace flags are compiled in, so each change meant a 5–50 minute rebuild.
- **Desktop friction:** no agent ever drove a real Electron window on the Mac. They used headless web, e2e probes, or Electron in CI or on dev-station under Xvfb, and every session rebuilt its isolation setup by hand: daemon config, ports, userData, CDP, fake desktop bridges, fixtures.
- **Shared friction:**
  - animations and missing ready signals forced sleeps and gave screenshots that contradicted their own state;
  - notification-permission prompts stole focus;
  - logs were too noisy or missing the line that mattered.

## Principles

1. **Reach any state by URL, not by taps.** Deep links on mobile, routes on web.
2. **Expose state as data, not pixels.** Use log lines with stable tags, accessibility text, and `data-` attributes.
3. **Make the safe path the easy path.** One command gives an isolated, minimal, seeded instance that never touches the user's app or daemon.
4. **Debug switches at run time in debug builds,** never only at build time.
5. **Fix once for both platforms** where the cause is shared (motion, readiness, logging, prompts).

## Phase 0: documentation and skills, no app code (about half a day)

Results are in [agent-testing.md](agent-testing.md) and the status doc.

- [x] On the Cuttlefish tablet, check the deep links from cold and warm start. Settings and agent routes work; `?open=` works only warm and never selects `file:` tabs; `paseo://pair#` shows "Unmatched Route".
- [x] Make `?open=` select its tab on native from cold start and for `file:`. Cause: the workspace route never demanded the host directory, so workspaces never hydrated and the pending intent waited forever. Fixed by cherry-picking upstream #7918, which is upstream's own commit on `dev` since the 2026-10-30 rebase; the `COMPAT(workspace-open-url)` marker stays.
- [x] Write `docs/agent-testing.md`: packages and launch components, package-qualified `am start`, `pm grant … POST_NOTIFICATIONS`, the deep-link table, reading state from dumps, isolation variables, `daemon start` versus `daemon run`.
- [x] Animator test: not run. Idle dumps succeeded 15 of 15 on the tablet at the default scale, so there was no failure to compare against. The failures were on the phone while lists loaded or an agent ran; item 8 owns them.
- [x] Update the `phone-debug` skill (in the home-manager config repo): a pointer to `docs/agent-testing.md`, the idle-dump failure and its fallback, and that `input tap` has no hold. The Find tap path is left out until Find has a URL or testID (item 5).

## Phase 1: small, independent app and CLI fixes (each S)

| #   | Change                                                                                                                                                                                                                                                                                                 | Evidence                                                                                                                                      | Where                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 1   | Done (chunk B): `src/app/pair.tsx` redirects to startup; `OfferLinkListener` stays the only importer                                                                                                                                                                                                   | 3 sessions hit "Unmatched Route" after pairing; 1–2 min per stint, plus a "Go back" tap guessed from a screenshot                             | `src/app/pair.tsx`, `OfferLinkListener` in `src/app/_layout.tsx`    |
| 2   | Done (chunk C): Enter in host focuses port; host and port select their text on focus                                                                                                                                                                                                                   | 3 sessions: keyboard shift sent taps to the wrong field (`67908`, port in password, SSL toggled by accident); `6767` prefill gave `67676790`  | Direct connection sheet                                             |
| 3   | Done (chunk B): `[paseo-agent]` lines for link import, connection status, push received/register and update status/failures; see `docs/agent-testing.md#agent-log-lines`                                                                                                                               | Agents inferred state from screenshots, daemon logs or system `DownloadManager` lines; one update failure ended with no cause logged          | host runtime, `OfferLinkListener`, push, `src/android/fork-updates` |
| 4   | Done (chunk B): one-line bootstrap probe; a missing Firebase config logs once per session                                                                                                                                                                                                              | Every agent filtered these out of logcat                                                                                                      | `src/runtime/host-runtime.ts:1805`, push subscriptions              |
| 5   | Done (chunk C): `pane-find-*`, `settings-section-*` and `fork-android-update-{action,status}` testIDs. Closed compact panels were already hidden from accessibility (upstream #7424)                                                                                                                   | Buttons found only by changing labels; stale sidebar nodes in dumps; a 9.5 min probe build just to learn the Find bar had rendered            | update row, find bar, sidebar                                       |
| 6   | Done (chunk D): `daemon start` names the setting overrides it ignores; `daemon pair --app-url <url>`, and a `paseo://` base now gives `paseo:///#offer=`. `workerPid` was already in `daemon status --json`, and `daemon stop --home` already ends the worker (scratch-home check), so neither changed | Misleading failure; a `pgrep "Paseo Daemon"` helper that could match the user's daemon; pairing URL rewritten with `sed`                      | `packages/cli`, `packages/server`                                   |
| 7   | Done (chunk D): `build:main` runs with `--incremental false` like the other packages' builds, so a stale `tsconfig.tsbuildinfo` can no longer skip the emit                                                                                                                                            | `build:main` "succeeded" in 0.4 s and emitted nothing: 96 s timeout plus about 6 min of diagnosis. Same bug as the fresh-worktree memory note | `packages/desktop/package.json`                                     |

## Phase 2: shared foundations (each M)

- [ ] **8. Motion and readiness, on both platforms.**
  - **Find the idle animation.** Find what still animates at idle on native (`dumpsys gfxinfo` with the app idle) and gate it behind reduce-motion. `could not get idle state` hit 4 sessions after the running-ring fix in `7cac0db95`.
  - **Honour `prefers-reduced-motion` on web,** so Playwright's `reducedMotion: 'reduce'` snaps the switch thumb and similar animations.
  - **Ready markers.** Add stable markers for "app ready and connected" (a testID or accessibility node carrying the connection status) and for "timeline settled" (`data-` attributes).
  - **Proof:** dumps succeed on the tablet with the app idle; a web probe asserts readiness without `waitForTimeout`.
  - **Measured (chunk E, 2026-10-31):** nothing animates at idle on the tablet. While an agent runs, the status ring and turn loader block dumps until the animation scales are 0 and the app is relaunched; the turn's elapsed time, which changes every second, still blocks dumps of the open chat. The web app already honours `prefers-reduced-motion`, switch thumbs included. So the first two bullets need documentation only, and the elapsed clock gets a debug switch in item 9.
- [ ] **9. A debug control surface, in debug builds only.** Use `paseo://debug?…` or intent extras for:
  - turning on traces at run time (replacing compile-time `EXPO_PUBLIC_PASEO_TERMINAL_INPUT_TRACE` and similar);
  - a platform or variant override for gated UI (replacing temporary source edits such as `// PROBE-ONLY`);
  - turning on the fork updater with a configurable release base URL (replacing the `sed` patch of `app-variant.js` plus a 14 min rebuild).

  Proof: change a trace on the tablet without reinstalling.

  **Shape (approved 2026-10-31):** the switches exist only in builds made with an explicit build flag, which the harness recipe sets; releases stay unchanged. Agents set them with `adb shell am start` intent extras, not a `paseo://` link, so other apps cannot flip them. Each switch logs a `[paseo-agent]` line and none changes user data. In order of risk: trace toggles; a frozen elapsed clock (only the one-second tick stops) and the notification-prompt skip from item 10; a platform override that resets on cold start; and the fork updater with a custom base URL, only if the updater exists in non-fork builds and still checks the APK's signing key whatever the URL. **Outcome (2026-10-31):** trace, frozen clock, notification skip and a narrow `transfer` override (the cited `// PROBE-ONLY` edit) shipped; the updater switch was dropped because a non-fork build fails the updater's installed-version check before fetching, so a fork-variant harness build moves to Phase 3.

- [ ] **10. No surprise prompts in debug and test runs.** Defer the notification-permission request until after the first connection. In test mode, skip it. The prompt stole focus after every fresh install (phone, tablet, Android CI about 5 times).
  - **Decided 2026-10-31:** no deferral. The prompt already waits for a host, so deferring it moves it by about a second and changes upstream behaviour for every user. The test-mode skip ships as one of item 9's switches.

## Phase 3: one-command entry points for agents (each M; depends on 3, 8)

**Approved 2026-10-31** as chunks T (retire the `transfer` switch, since the transfer flow is being retired), H (item 11), I (item 13), J (item 14), K (item 12) and L (a fork-variant harness build, so the updater switch from item 9 can come back). Making dev Electron isolate userData by default stays out of K and returns as its own decision with K's evidence.

- [ ] **11. `qa:web`.**
  - **What it runs:** an isolated, minimal daemon serving the web UI on a free port, printing `{url, serverId}`.
  - **What it turns off and on:** relay, plugins and speech off; mock provider on.
  - **Seed data:** an optional synthetic "heavy chat" seed with tool calls, diffs and icons.
  - **Replaces:** hand-written `config.json`, an 11 min fight with plugins and speech downloads, an isolated home that registered with the real relay, and a profiling run blocked by having no fixtures.
  - **Outcome (2026-10-31):** `npm run qa:web [--seed heavy]` and `--stop`. The relay registration came from a config that omitted `daemon.relay.enabled` (`COMPAT(relayOptInDefault)`); qa:web sets it, turns off usage sources and every provider but `mock`, and is ready in about 4 s on the station.
- [ ] **12. `desktop:sandbox`.**
  - **What it is:** the existing `createIsolatedDesktopEnv`, `reserveDesktopDebugPort` and temporary-userData code from the release smoke scripts, promoted to a script.
  - **What it does:** keeps paths short (avoiding `Socket path too long`), prints the CDP URL, and defaults to dev-station under Xvfb, so no window opens on the Mac.
  - **Shared helper:** `connectToPaseoRenderer()`, which every `packages/desktop/e2e/*.mjs` should use (fixes empty `pages` from `connectOverCDP`).
  - **Isolation by default:** make dev Electron isolate userData by default, including the main checkout.
- [ ] **13. Android agent helper (`scripts/android/agent-adb.sh` or similar):**
  - print a dump as `id | text | desc | centre`;
  - tap by `id`, guarded on the app having focus;
  - wait for an `id`;
  - open a route by deep link.

  Use it on both the phone and Cuttlefish. It replaces six one-off variants (`ui.sh`, `ph.sh`, `p.sh`, `ph.zsh`, `tab.sh`, the tablet `ui.sh`), one of which threw away `resource-id`.

  **Outcome (2026-10-31):** `scripts/android/agent-adb.py`, in Python because the tablet's pod has no Node. Besides the four commands it types and sends keys under the same focus guard, sets switches, waits on turn counts, holds lock files, and refuses to restart the user's own app.

- [ ] **14. `e2e/probe/` project (gitignored).**
  - runs throwaway scripts with the repo's Playwright, so agents stop copying files into `packages/app/scripts/.x-tmp.mjs`;
  - console capture with formatted arguments, so React warnings stop arriving as `%s`;
  - screenshot and console tail always saved on failure;
  - quieter Metro logs;
  - a committed fake `window.paseoDesktop` bridge with scenarios, used with the item 9 override.

## Phase 4: larger seams (each L; do when the area is next touched)

- [ ] **15. Electron test seams:**
  - auto-answer `dialog.showMessageBox` from a test variable and record the prompt (today this needs `xdotool` on a private display);
  - notification show and error receipts (three headed runs proved nothing);
  - a graceful-quit path, and flushing storage on SIGTERM (theme lost after SIGTERM cost a 21 min CI trial).
- [ ] **16. Diff text in the accessibility tree.** Terminal rows already carry their text as `terminal-row-N` (checked on the tablet, 0.16.0). Give the diff canvas a summary label, updated on a throttle. This helps TalkBack too. Until it lands, read diffs from a screenshot.

## Order and dependencies

- **Phase 0** first. It may show that Phase 1 needs fewer deep-link changes.
- **Phase 1** items are independent and can go out as separate small PRs.
- **Item 8** before **items 11, 13 and 14,** so the helpers can wait on ready signals instead of sleeping.
- **Item 3** before **items 11 and 13,** so the helpers can print state.
- Update **`docs/agent-testing.md` and the `phone-debug` skill** at the end of each phase.

I'd do 1, 3, 8, 11 and 13 first. They address the friction that showed up in the most sessions.

### Phase I chunks (approved and complete 2026-10-30)

Phase I covers Phase 0 and Phase 1. Phases 2–4 need their own approval.

| Chunk                    | Covers                   | Gate                                                                                                            |
| ------------------------ | ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| A. Docs and device facts | Phase 0                  | Deep links checked on the tablet from cold and warm start; animator test recorded                               |
| B. Reach and observe     | 1, 3, 4, native `?open=` | Unit tests; tablet pass on a build combining B and C before either merges                                       |
| C. Forms and selectors   | 2, 5                     | Same combined tablet pass: Enter chaining with the keyboard up, sidebar nodes absent when closed                |
| D. CLI and build         | 6, 7                     | Scratch-home daemon run on dev-station; `build:main` emits after deleting `dist`; no tsbuildinfo in the package |

### Phase II chunks (approved 2026-10-31)

Phase II covers Phase 2. Phases 3 and 4 need their own approval.

| Chunk             | Covers      | Gate                                                                                                                     |
| ----------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| E. Motion         | 8 (motion)  | Frames, accessibility events and dumps measured per state on the tablet; web animations listed with and without `reduce` |
| F. Ready markers  | 8 (markers) | A web probe waits on the markers with no `waitForTimeout`; one native wait on the same marker                            |
| G. Debug switches | 9, 10       | A trace turned on without reinstalling; with the frozen clock and scales at 0, a running chat dumps 3 of 3               |

Open questions and doc/code disagreements are tracked in [AGENT_TESTING_STATUS.md](AGENT_TESTING_STATUS.md).
