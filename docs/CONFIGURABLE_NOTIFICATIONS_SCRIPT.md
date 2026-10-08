# Configurable notifications execution script

This revision incorporates daemon-wide reply filtering from confirmed Tiers 1–2.
The user confirmed the original planning revision on 2026-10-04 and later
authorized implementation in the requested sibling worktree. T1/S1 and T3/S3–S4/G2
are complete within focused local verification; user controls and live delivery
gates remain open. See the [current status](CONFIGURABLE_NOTIFICATIONS_STATUS.md).

Five threads deliver the [roadmap](CONFIGURABLE_NOTIFICATIONS_ROADMAP.md) through
G4. The current order is T1 → T3 → T4 → T2 → T5. T2 remains a prerequisite for
T5, but not for T3 or T4. The [plan](CONFIGURABLE_NOTIFICATIONS.md)
owns scope. The workspace-only Tier 3 was confirmed on 2026-10-04; this revision
keeps its dependencies and extends the chunks and proofs below.

## Rules and current state

- Each thread is one `/keep-me-in-the-loop` phase with a continuous reviewer and
  concrete chunk reviews. Implementation is authorized in the requested sibling
  worktree; future live launches remain subject to their named gates. Commit and
  push only after checks and lead review.
- **All execution threads are mutually exclusive.** Work in the requested sibling
  worktree; no parallel edits, tests, builds, or test daemons from these threads.
  This overrides the skill template's parallel-thread default. The next thread
  acquires ownership only after the current one finishes or safely pauses.
- A phone wait must not hold the checkout indefinitely. Before yielding, stop
  test processes, finish or record the exact uncommitted state, and record a safe
  pause in the shared status document. Resume only after reacquiring ownership
  and checking the current revision. Never interrupt an active operation to hand off.
  The successor preserves recorded uncommitted work without treating it as accepted
  source; resumed phone probes revalidate the accepted revision and isolation.
- Name every permitted isolated CLI, test daemon, and app launch at its gate.
  Never use production `~/.paseo`, port 6767, desktop settings, existing provider
  sessions, or app replacement. No production restart, deployment, release tags,
  upstream submission, or overseer skill changes.
- Use the roadmap's verification pyramid, stable timing baseline, and budget.
  Keep policy matrices at the cheapest reliable layer; run required checks, never
  the full local suite. Do not substitute build success for device proof.
- The shared status document is
  `docs/CONFIGURABLE_NOTIFICATIONS_STATUS.md`. Each completed chunk reconciles it, roadmap ticks,
  and plan boxes in the same scoped commit. Keep a few decisive receipts inline;
  logs and test state stay ignored. Point its next-action section at ready threads
  below instead of maintaining a second ordering.
- Before every push, inspect local and fork branch state and integrate intervening
  changes without overwriting them. Push only reviewed scoped changes. At thread
  completion, mark it done here, record deviations affecting others, and update
  newly ready threads. Never mark a deferred proof as passed.

Historical macOS packaging receipts are documented in the plan; neither packaged
app was launched. T1/S1 and T3/S3–S4/G2 are accepted, and no test host is running.
The clean implementation base is `4ea125b83` in the requested sibling
worktree; older planning-branch and local Mise receipts are historical and do not
describe this checkout.

## Dependencies and human participation

```text
T1 ──> T3 ──> T4 ──┐
 └───> T2 ──────────┴──> T5
```

The arrows mean required completed outcomes, not concurrency. Follow the user's
current order: complete automated T3 and T4 before scheduling phone sessions for
T2 and T5. T2 proves connectivity, not final-feature behavior; T5 repeats the
required device proof on the final revision. T2 is on T5's critical path.

| When                                         | Human action                                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Before each thread's work                    | Approve its phase proposal and exact isolated launch scope, where applicable                                 |
| T1, only if investigation exposes a conflict | Decide how to resolve a host-authority restriction that prevents required automation before T3               |
| T2 phone session                             | Pair the additional test host, disable Wi-Fi, and observe an unmuted remote push on the existing Android app |
| T4 desktop demonstration, if prompted        | Grant the isolated desktop/browser notification permission                                                   |
| T5 final phone session                       | Observe workspace mute and reply-filter controls over mobile data, then remove only the test pairing         |

No appointment is fixed by this script. T2 and T5 proposals arrange availability;
do not guess a deadline or treat silence as a phone observation. No paid services
are authorized. Unexpected access, cost, or isolation requirements return to the user.

## T1 — Contract and stable check baseline: S1

**State:** complete. M1.1, M1.3 feasibility, S1, and T1 are recorded in the plan,
roadmap, and status. Feature implementation and G1 remain open.

```text
/keep-me-in-the-loop Run T1 in docs/CONFIGURABLE_NOTIFICATIONS_SCRIPT.md. Read its rules, dependencies, Human entry, and chunks before proposing the phase. On completion, update the script, roadmap, plan, and shared status; record deviations affecting later threads.
```

- **Depends on:** none. Completed before T3.
- **Human:** T1 required no live process. Its source investigation and bounded
  temporary feasibility probe are complete; no host-authority conflict remains
  to resolve. Future runtime/device processes need their named gates.
- **Chunks:** completed: (1) pin revision and contract inventory; (2) record the
  M1.3 source-grounded design, bounded RE2 engine, limits, and current host
  persistence/authority seams; (3) measure selected checks under fixed conditions
  and record reviewer-accepted budgets. Exact future persistence/capability names
  and implementation remain open.
- **Live:** only explicitly approved local test runtimes; no phone or relay; clean up
  each runtime before handing off. Regex investigation probes remain temporary;
  no shipped feature edits in T1. Separate setup cost from routine-check runtime.
- **Done:** source-traced completion-bound design and RE2 feasibility recorded;
  fixed baseline and reviewer-accepted budgets recorded. No collector, immutable
  subject, feature code, or runtime delivery proof exists. S3 lifecycle tests remain
  mandatory. G1 remains open until T2. T3 is next; T2 follows T4.

## T2 — Isolated Android connectivity: S2

**State:** waiting on T1 and a phone session.

```text
/keep-me-in-the-loop Run T2 in docs/CONFIGURABLE_NOTIFICATIONS_SCRIPT.md. Read its rules, dependencies, Human entry, and chunks before proposing the phase. On completion, update the script, roadmap, plan, and shared status; record deviations affecting later threads.
```

- **Depends on:** after T1 for contract, source inventory, and approved baseline;
  not alongside T3, T4, T5, or any other execution thread.
- **Human:** before the live chunk, arrange Android availability. At approval,
  authorize the named isolated host/CLI and relay/Expo use. At pairing/positive
  control, the user selects the test host and observes delivery over mobile data.
  A phone wait pauses only T2; release the checkout using the rules above.
- **Chunks:** (1) review launch configuration and establish isolated identity/home/
  endpoint; (2) pair, verify state and real unmuted push with workspace notifications
  on and an empty denylist (or original unfiltered behavior on a pre-feature revision);
  (3) stop test processes
  and record retained test home/pairing for T5, or clean up after failure.
- **Live:** one test daemon/relay identity plus existing Android app; no replacement
  or production-state copy. Reassess after the initial 30-minute setup allowance.
- **Done when:** S2/G1 accepted with an actual observed positive control and stopped
  test processes. Missing control leaves the gate open. Record the revision and
  any retained test resources; do not keep a daemon running while waiting for T5.

## T3 — Durable policy and automation parity: S3–S4

**State:** complete. S3–S4/G2 and M2.1–M2.4 accepted through focused local tests
and isolated CLI/MCP transport journeys. Phone delivery remains unverified until T5.

```text
/keep-me-in-the-loop Run T3 in docs/CONFIGURABLE_NOTIFICATIONS_SCRIPT.md. Read its rules, dependencies, Human entry, and chunks before proposing the phase. On completion, update the script, roadmap, plan, and shared status; record deviations affecting later threads.
```

- **Depends on:** after T1 for accepted M1.3 filtering contract and stable baseline; not alongside any other
  execution thread. Do not wait for T2 if the phone session is unavailable.
- **Human:** implementation is authorized in the requested sibling worktree. Name
  isolated CLI/MCP/test-daemon launches at their verification gate; no phone
  participation or GUI launch is needed for T3.
- **Chunks:** (1) persisted workspace policy, optional wire contract, shared provisioning
  and runtime mutation; (2) workspace agent/terminal delivery suppression retaining
  state/events; (3) durable host denylist and bounded matching of completion-bound
  text, independent capability and host authority, with workspace mute precedence;
  (4) CLI/MCP workspace create/update/read and host rule get/set/clear parity with
  minimal adapter journeys. Review workspace enforcement and global filtering as
  separate increments; M2.4 closes only after enforcement and adapter proofs pass.
- **Live:** local disposable test homes only; clean up before handoff. Record check
  timings against T1, repair regressions within the changing chunk.
- **Done when:** S3–S4/G2 accepted and published, including same-directory workspace
  isolation, creation ordering, failures, and unsupported-host behavior. Include
  regex escaping, invalid-save retention, stale/missing/truncated/next-turn subjects,
  global two-workspace coverage and separate-daemon isolation, at the cheapest
  reliable layers. Preserve completion subscriptions as well as UI attention. Phone
  suppression remains unverified until T5. Mark T4 ready.

## T4 — Desktop user control and feature builds: S5–S6

**State:** complete. S5/G3 and S6 are accepted, including actual browser OS
delivery confirmed by the user and supported by native logs. No phone session
has started; arrange T2 next, then T5 after T2 acceptance.

```text
/keep-me-in-the-loop Run T4 in docs/CONFIGURABLE_NOTIFICATIONS_SCRIPT.md. Read its rules, dependencies, Human entry, and chunks before proposing the phase. On completion, update the script, roadmap, plan, and shared status; record deviations affecting later threads.
```

- **Depends on:** after T3/G2 for policy and automation APIs; not alongside any other
  execution thread. T2 need not be complete.
- **Human:** at approval, authorize the isolated updated desktop/browser and test
  daemon with protected production boundaries. If OS permission requires a person,
  arrange it before the demonstration; affected notification proof waits on it.
  No Android install or menu proof.
- **Chunks:** (1) shared cross-platform workspace menu and synchronized state;
  (2) cross-platform host rule editor with explicit save/clear, validation and
  unsaved-edit/external-update handling; (3) desktop UI/CLI/MCP synchronization,
  failed-save/unsupported-host and notification demonstrations for both policies;
  (4) sequential npm/Nix packaging and artifact provenance for the feature revision.
  Build preparation in (4) now precedes the human OS-arrival portion of (3),
  following the user's automated-first order. This supplies an identified feature
  artifact for the isolated demonstration; it does not waive that demonstration
  or complete S5/G3, S6, or T4.
  Filter proof uses an unmuted workspace and nonmatching/rule-cleared positive
  controls around a matching completion. Do not repeat the regex matrix in the UI.
- **Live:** isolated desktop settings/daemon and disposable workspaces; prevent
  built-in takeover and updates. Stop test processes; packaging smoke hooks stay
  disabled. Preserve the built artifacts, not running applications.
- **Done when:** S5/G3, including M3.3 host controls, and S6 accepted and published
  with required checks/timings.
  Mark T5 ready only if T2 is also done; otherwise recommend T2 next.

### Browser OS proof — repeat requires separate approval

Two earlier runs passed browser/API checks but native permission was denied.
After the user enabled Google Chrome for Testing's macOS notifications, the
authorized retry passed with origin permission granted automatically. The user
confirmed both positives arrived and the middle trials stayed silent. Native
logs separately record both as banners with display allowed. S5/G3 and T4 are
accepted; another run would require separate approval. The test did not change
macOS settings.

The user has authorized automatically granting notification permission for the
disposable test origin. This browser permission does not enable macOS
notifications: native authorization remains user-controlled. The mode preserves
the real Notification API and shows the same four completion trials for ten
seconds each: positive, workspace-muted, rule-filtered, and rule-cleared positive.
The test has a five-minute bound. API calls remain separate from the person's
report of actual banners or Notification Center arrival.

The disposable profile isolates site data. macOS notification permission may be
shared across profiles using Google Chrome for Testing's
`com.google.chrome.for.testing` identity. Approval must cover that browser's
native permission; no production Paseo app permission or settings are changed.
The fixture uses only its fake-provider daemon, disables provider/metadata work
and relay, and uses dynamic loopback ports. No packaged app launches or desktop
daemon/update controls are involved.

After approval, use this exact recipe from the app workspace. The exit trap
removes only the newly created profile/home; workspace, browser, worker daemon,
and Metro teardown remain in the existing harness.

```sh
(
set -eu
cd /Users/clliaw/Projects/paseo/configurable-notifications/packages/app
notification_proof_root=$(mktemp -d "/Users/clliaw/Projects/paseo/configurable-notifications/.dev/configurable-notifications/os-proof.XXXXXX")
trap 'rm -rf -- "$notification_proof_root"' EXIT
mkdir -p "$notification_proof_root/paseo-home"
mise exec -- env -u PASEO_HOME -u PASEO_HOST \
  -u ANTHROPIC_API_KEY -u OPENAI_API_KEY -u GOOGLE_API_KEY -u GEMINI_API_KEY \
  -u OPENROUTER_API_KEY -u XAI_API_KEY -u GROQ_API_KEY \
  PASEO_NOTIFICATION_OS_PROOF=1 \
  PASEO_NOTIFICATION_OS_PROFILE="$notification_proof_root/browser-profile" \
  E2E_PASEO_HOME="$notification_proof_root/paseo-home" \
  E2E_FORK_PASEO_HOME_FROM='' E2E_KEEP_PASEO_HOME=0 E2E_WORKERS=1 BROWSER=none \
  npm run test:e2e -- --project=browser --headed --workers=1 --retries=0 \
  e2e/browser/configurable-notifications.spec.ts \
  --grep 'keeps workspace and reply rules authoritative across CLI, MCP, and live turns'
)
```

## T5 — Final Android proof and cleanup: S7–S8

**State:** waiting on T2 and T4; concrete commands refined from their evidence.

```text
/keep-me-in-the-loop Run T5 in docs/CONFIGURABLE_NOTIFICATIONS_SCRIPT.md. Read its rules, dependencies, Human entry, and chunks before proposing the phase. On completion, update the script, roadmap, plan, and shared status; record deviations affecting later threads.
```

- **Depends on:** after T2 for viable pairing/relay path and T4 for accepted final
  feature revision/builds; not alongside any other execution thread.
- **Human:** before opening, arrange the Android observation session. At approval,
  authorize restarting only the recorded isolated test host and relay/Expo use.
  Mid-run, select test host, disable Wi-Fi, background the app as needed, and report
  actual arrivals. At cleanup, remove only the test host from the phone. The proof
  waits for these observations; after cleanup no human action remains in this scope.
- **Chunks:** (1) verify final revision and execute the plan's six-part phone gate: eligible
  positive controls around muted events plus runtime unmute, sampling agent and
  terminal paths with attention retained, then regex-filter a matching completion
  in an unmuted workspace with nonmatching and rule-cleared positive controls;
  (2) stop/remove test resources and test-only rule configuration, verify production
  and its settings unchanged, and publish concise evidence and limitations.
- **Live:** retained test identity/home if still valid; otherwise repeat the approved
  pairing process. Allow roughly 15 minutes initially for guided checks, then
  reassess extra controls and presence delays without weakening proof or duplicating
  the full offline matrix. Positive-control failure blocks success.
- **Done when:** S7–S8/G4 and W6 accepted, all other gates closed, test cleanup verified,
  and status distinguishes built/verified from deployed. On failure, perform cleanup
  and record open gates; do not mark the campaign complete.

## Deferred and revision history

Android menu verification, production deployment, and overseer integration require
separate planning. No roadmap step is otherwise deferred or omitted. This campaign
runs outside Paseo, using native work-item leads and pilots in the requested
sibling worktree. The literal prompts describe phase boundaries; execution does
not require Paseo's advanced tools or an overseer change.

The original script passed review for step/gate coverage, safe phone-wait handoff,
sequential ownership, and explicit launch authority. The user confirmed it on
2026-10-04 for publication only. The user later authorized implementation in the
requested sibling worktree. Current reviewer acceptance covers T1/S1 design and
baseline only; later live/device gates remain open.

- [x] Derive revised chunks from the confirmed regex roadmap.
- [x] Obtain reviewer acceptance of revised Tier 3.
- [x] Obtain user confirmation of revised Tier 3.
- [x] Finalize the confirmed script for publication; leave execution approval separate.

- 2026-10-04: derived from confirmed Tiers 1–2; five threads preserve independent
  phone scheduling with sequential checkout ownership and mandatory final proof.

- 2026-10-04: user confirmed Tier 3 for publication, planning only.

- 2026-10-04: drafted regex extension in the same five threads; M1.3 blocks T3,
  host controls join T3/T4, and final filter proof joins the existing T5 phone session.

- 2026-10-04: user confirmed the regex-extended Tier 3 for publication, planning only.

- 2026-10-08 UTC (2026-10-07 EDT): recorded T1/S1 completion and the user's
  automated-first order T1 → T3 → T4 → T2 → T5. M1.3 remains a design and feasibility
  result; implementation and phone proof remain open.
