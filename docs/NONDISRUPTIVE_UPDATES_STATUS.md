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

- The original implementation's updater script tests ran only locally. The current
  routine CI helper lane includes the updater tests through
  [the routine planner](../.github/scripts/ci-routine.mjs).

## Restart recovery follow-up (2026-11-06)

User approval: "All three chunks are approved." Scope: durable async question recovery,
an explicit CLI supervisor replacement, and integration verification with one merged PR
to `dev`. Medium autonomy; no release, installed-app change, or production restart.
Baseline: `fd4f01a4c`. Preserve unrelated checkout changes.

- [x] A: expose saved Codex async questions without launching idle runtimes; reopen the
      original thread on answer; commit resolution after accepted delivery. Live approvals,
      running turns, background work, and in-flight responses still block idle shutdown.
- [x] B: add local `daemon restart --replace-supervisor`; preflight the invoked install,
      retain home/configuration/desktop ownership and terminals, reject competing launches,
      and preserve default worker-only restart semantics.
- [x] C: isolated cold-restart and actual CLI entry-point proof, affected full suites,
      review, required CI and merge. Update durable usage docs.
- [ ] D: user clarified "Sidebar project order." The closed-tab repair is separate;
      project-key transition restoration is implemented and reviewed, with rendered QA
      and publication in progress below.

Estimate for A–C: 45–90 minutes of agent wall-clock, 3–5 implementation/integration
review rounds. Bounds: cold-recovery and supervisor orchestration tests, review latency,
and CI. D is a separate diagnostic addition; initial allowance 10–25 minutes and one
review, pending reproduction. Local warm baseline: `mise exec -- npm exec
--workspace=@getpaseo/server -- vitest run
src/server/agent/providers/codex-async-questions.test.ts`, 11 tests passed in 2.06 s
before changes. Routine CI target: under five minutes; no required proof is waived.

Acceptance includes startup with automatic turn resume disabled, a visible question
before any runtime is reopened, answer delivery to its original thread, rejection/retry
and concurrent-answer safety, and no resurrection after answer or dismissal. It does
not claim exactly-once delivery across a crash between upstream acceptance and local
persistence; that requires an upstream idempotency contract.

Reviewer: persistent native `restart_reviewer`, Sol/high. A2 accepted with cold
projection/answer loading, live-approval coexistence, accepted-start completion, and
failed-delivery retry safeguards. Review ledger: A1 1 material / 1 total; A2 0 / 0.
Current A checks: six affected server suites passed, 298 tests in 20.42 s; server
typecheck passed. Cold-process answer/dismiss cases passed (2 tests, 12.04 s), using
the real daemon/bootstrap and public WebSocket API with a deterministic Codex transport.
This is not a real upstream Codex service check or an installed-app rollout.

B2 and C2 code review accepted: B1 1 material / 1 total, B2 0 / 0; integration C1
1 / 1, C2 0 / 0. The findings closed wrong-peer shutdown and inherited live-identity
overrides. The installed-entry lifecycle case with a hostile identity environment failed
before the pin and passed after rebuilding (32.61 s). It also proves legacy launch
replacement by the invoked runner, saved managed configuration, desktop ownership, and
terminal adoption. The full local CLI lifecycle suite passed 19 tests with one platform
skip in 205 s before the final identity pin; its affected counterexample was rerun after.
The replacement/Nix preflight suites passed 16 tests; missing store executables and
invalid markers fail before shutdown. Default restart keeps its prior launch contract.

D1 code review accepted (0 material / 0 total). A deterministic old-code probe showed
an explicitly closed tab reappearing only when the hydrated directory reconciled after
reload. The prior tested contract intentionally kept hidden-tab intent in memory only.
The repair persists that intent per workspace and clears it on explicit reopen. Three
affected app suites passed 195 tests; app typecheck passed. The rendered tab checks below
complete that verification. The separate sidebar-order diagnosis follows in the
2026-11-07 section; the tab reproduction does not explain project ordering.

### Local verification limits and follow-up

The complete server unit command (`npm run test:unit --workspace=@getpaseo/server --
--maxWorkers=4`) ran with a temporary Git configuration that includes the user's normal
configuration but disables tag signing, and a canonical `TMPDIR`. This changes no user
configuration. The initial run inherited signed-tag settings, blocking synchronous Git
fixtures; an unchanged-base probe reproduces the waits and passes when only tag signing
is disabled. Canonical `TMPDIR` resolves the existing macOS `/var` versus `/private/var`
assertion mismatch.

The complete isolated-environment run remains **not green**: 482 files / 7,515 tests
passed, two tests failed, 52 tests skipped, 344.58 s. Remaining cases are unchanged from
`fd4f01a4c`, including their runtime dependencies; review confirmed the new manager code
cannot execute in either case. No tests were skipped or timeouts raised for this change.
Required CI at the PR head and the changed-path checks remain publication gates.

No `acyclic` project configuration was found in this repository. Follow-up for a later
test/bugfix run:

- `providers/omp/session-descriptor.test.ts`: the 400-file cwd-overscan fixture exceeds
  its existing 30 s test deadline on this Mac, including when selected separately.
- `providers/pi/extensions/index.test.ts`: the child-tail filesystem poll fails under
  broad local-suite load but passes in the focused run; capture its readiness/event race
  before changing the implementation or its checks.
- `cli/commands/plugin/scaffold.test.ts`: the unchanged npm-pack fixture exceeds its
  existing 5 s deadline under the same local load. The final CLI unit run passed 539
  tests with this one failure; an earlier run passed all 534 then-selected tests.

### Rendered restoration and remaining investigation

The production web build was exercised against an isolated mock daemon. Main-agent
browser automation verified a closed tab stays absent after reload once the host is
connected, while the retained tab stays selected; explicitly reopening the closed tab
survives another reload. Independent browser QA verified close/reload/History-reopen
on desktop and phone, and tab order/selection restoration on tablet. Tablet touch-close,
native devices, and sidebar reorder/collapse round trips were not verified.

Normal root-agent close also requests archival, so that browser journey is a neighboring
workflow check. The failing-old/passing-new store regression specifically proves saved
local suppression for active/layout-only agents, failed archives, and stale directory
snapshots. It does not prove that every instance of the user's unspecified jumbled
project state shares this cause.

Additional browser findings, deferred to a separate startup/UI investigation:

- A fresh browser opening a valid workspace URL lands on `/open-project`; both tester
  and main reproduced it with the expected host/workspace present afterward and no
  error boundary. Established-workspace reloads restore correctly. Startup route code
  is unchanged by this change; the first-connection route-loss mechanism remains
  unproven. Preserve the explicit destination through host registration as a follow-up.
- The emulated touch phone shows a keyboard-shortcut hint. No visual redesign is part
  of this change.

Restart publication: [PR #379](https://github.com/iExalt/paseo/pull/379) merged as
`f849e8830913e448cb187a4a23c1d71ed0211159`. Both required checks and all eight routine
lanes passed at reviewed head `033dcbbac`; the routine critical path was 183 s, below
the advisory 300 s budget. Recent `dev` runs took 203–228 s; this is not a controlled
speedup comparison. Local-suite limits above remain recorded. No release or installation
was performed.

### Sidebar project-order diagnosis (2026-11-07)

User clarification: "Sidebar project order." Read-only inspection was explicitly
authorized; the running app was not reloaded or rearranged and chat contents were not
read. Saved order contained a host/project placement key at an earlier position and its
current shared project key at the end. The same stable project ID remains in the daemon's
directory. This supports an identity mismatch, rather than missing saved order; no
historical before/after snapshot establishes the exact transition that occurred.

The production-function reproducer establishes the mechanism: directory metadata or
duplicate-checkout grouping changes a project's view key from a host/project placement
to its shared repository key. Rendering no longer recognizes its saved position, and
reconciliation appends the new key. The reverse shared-to-split transition has the same
failure. The old project reorder browser case resets grouping after dragging, so it never
checked project-order persistence across reload; workspace sorting coverage did not guard
this identity transition.

- [x] Reproduce through the real directory projection, rendering selector and persisted
      order reconciliation: four of five new regressions fail before the fix.
- [x] Resolve known placement/shared aliases consistently before rendering and persistence;
      retain unknown/offline keys and honor explicit current-key positions.
- [ ] Finish rendered drag/reload/collapse checks, required CI and merged PR.

Five affected suites pass: 85 tests, 1.26 s. App typechecking passes after rebuilding
workspace dependencies for the current `dev` base. R1 review: 0 material / 0 total;
independent merge/collision/offline probes and 120 order permutations also pass. The
production web build restores a seeded placement-key order and rewrites it using current
keys; independent rendered interaction checks are in progress.

Decisions: use existing project/host identity metadata without changing project grouping
or the storage schema. A current key explicitly present in saved order wins over an old
alias, so the repair does not guess at an already-corrupted historical arrangement or
undo a later deliberate drag. Split projects inherit the former shared slot together in
deterministic directory order; genuinely unseen projects retain the existing policy.
Collapsed sections, workspace sorting and the separate first-connection route issue are
outside this project-order repair.

Estimate for this clarified diagnostic/fix: 20–40 minutes, one or two review rounds,
bounded by reproduction, the web build, rendered checks and required CI. Awaiting the
read-only inspection answer did not block independent work.

## App and host update status (2026-11-06)

User approval (conversation, 2026-11-06): “SGTM”, followed by the instruction to
implement in a remote worktree using `keep-me-in-the-loop`. Scope: app-only update controls in About; automatic
local daemon upgrade progress in Host Overview; links from About's connected hosts.
Medium autonomy. Implementation uses a sibling Git worktree from baseline
`388d619f2047d911bd444035118c4f6c741ea3b4`. No release or live laptop rollout authorized.

- [x] A: app-update facts independent of daemon version; authoritative idle-upgrader
      state through the desktop status/event bridge, with identity and cancellation guards.
- [x] B: Host Overview owns daemon progress; About app controls clear when current;
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
subscription and app-update resolver: 44 passed in 1.19 s in the isolated Linux worktree (warm
outputs, one runner). Desktop typecheck passed. The initial baseline setup lacked
workspace outputs; `node scripts/ensure-workspace-builds.mjs` built them once.
Rendered live refresh/navigation and integration checks remain C gates.

B review ledger: round 1, 2 material / 2 total findings; round 2, 0 material /
0 total, accepted frozen B3. Both findings closed: first-mount host identification
now retains the authoritative local identity during a stopped upgrade failure;
About suppresses pending upgrade hints when management is paused. Original identity
loader fails the new first-mount regression; repaired loader and card cases pass
(7 tests, 2.22 s, the warm Linux worktree). The host link follows the existing desktop
replace / compact push navigation policy. New English copy uses the existing English
fallback convention in other locales. Browser closure and integration remain C gates.

C integration ledger: 0 material / 0 total findings; reviewer accepted A + B + the
renderer tests and the missing CLI-status fixture response. Final combined local
command `npx vitest run` with the eight changed test files passed 53 tests in
5.23 s. Renderer commands, from the repository root with `E2E_DESKTOP_RUNTIME=1`:

- `npx playwright test --config packages/desktop/playwright.config.ts --grep "Nix app and local host" --workers 1 --retries 0 --max-failures 1`:
  3 passed in 43.3 s. Covers real successful app status before badge absence,
  a genuine pending app restart as the positive control, About-to-Overview
  navigation, live waiting/failed/upgrading/current states, safe retry dispatch,
  first mount during a stopped failure, and pausing attached-daemon management.
  No daemon stop or restart command was issued by the update-status flow.
- The same command with `--grep "remote desktop-managed"`: 1 passed in 54.8 s;
  ownership explanation remains and the fake disabled update action is absent.

Independent headed visual QA exercised wide and narrow desktop windows in an
isolated fixture; state/version text fit without clipping. Main checked dark
Overview as well. Its status-modal error candidate was traced to the existing
fixture returning null for `cli_daemon_status`, not production: the handler returns
text. The Nix fixture now supplies that response; the actual modal was rechecked.
No material product findings remain. Other locales use the existing English
fallback for the new copy; native mobile input and signed Mac installation were
not tested by this UI work. The installed Mac gate D remains separate.

Workspace typecheck, changed-file lint and formatting passed. Comparable timing
limits: typecheck took 27.68 s before host contention and 179.07 s on the same host under heavy contention from unrelated work. A renderer setup timed out before the test body during that
contention. These are not comparable conditions for a code-regression claim;
no timeout, retry or required assertion was weakened. Routine CI retains its
existing budgets and remains the publication gate. The isolated headed QA fixture
exited successfully and stopped its mock daemon and Metro server.

The main renderer regression was also run against the original app-update resolver
from baseline `388d619f`: it failed for the intended reason, receiving
“v0.23.0 is installed; restart to use it” where “Up to date” was expected. The
reviewed resolver was restored byte for byte after that temporary negative probe;
the same full renderer journey then passed in 43.6 s.
