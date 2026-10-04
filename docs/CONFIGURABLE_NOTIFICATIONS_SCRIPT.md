# Configurable workspace notifications execution script

Scope revision pending: the confirmed plan now includes a daemon-wide reply regex denylist.
Thread proposals are on hold until the revised plan, roadmap, and script are
reviewed and confirmed. The entries below retain the earlier confirmed scope.

Five threads deliver the [roadmap](CONFIGURABLE_NOTIFICATIONS_ROADMAP.md) through
G4. The feature path is T1 → T3 → T4 → T5; T2 provides phone-connectivity evidence
and can run whenever the phone is available after T1. The [plan](CONFIGURABLE_NOTIFICATIONS.md)
owns scope. Tier 3 was confirmed by the user on 2026-10-04 after reviewer
acceptance. Publication completes planning; execution remains unapproved.

## Rules and current state

- Each thread is one `/keep-me-in-the-loop` phase with a continuous reviewer and
  approval of its concrete chunks before execution. Script confirmation alone
  does not authorize implementation or runtime launches. Phase approval includes
  scoped commits and pushes to the personal fork after checks and review.
- **All execution threads are mutually exclusive.** Work in this checkout;
  no parallel worktrees, edits, tests, builds, or test daemons from these threads.
  This overrides the skill template's parallel-thread default. The next thread
  acquires ownership only after the current one finishes or safely pauses.
- A phone wait must not hold the checkout indefinitely. Before yielding, stop
  test processes, finish or record the exact uncommitted state, and record a safe
  pause in the shared status document. Resume only after reacquiring ownership
  and checking the current revision. Never interrupt an active operation to hand off.
  The successor preserves recorded uncommitted work without treating it as accepted
  source; resumed phone probes revalidate the accepted revision and isolation.
- At execution approval, name every permitted isolated CLI, test daemon, and app
  launch. Until then the previous no-built-binaries/no-app-launch constraint holds.
  Never use production `~/.paseo`, port 6767, desktop settings, existing provider
  sessions, or app replacement. No production restart, deployment, release tags,
  upstream submission, or overseer skill changes.
- Use the roadmap's verification pyramid, stable timing baseline, and budget.
  Keep policy matrices at the cheapest reliable layer; run required checks, never
  the full local suite. Do not substitute build success for device proof.
- T1 creates one `docs/CONFIGURABLE_NOTIFICATIONS_STATUS.md` using
  `maintain-project-status`. Each completed chunk reconciles it, roadmap ticks,
  and plan boxes in the same scoped commit. Keep a few decisive receipts inline;
  logs and test state stay ignored. Point its next-action section at ready threads
  below instead of maintaining a second ordering.
- Before every push, inspect local and fork branch state and integrate intervening
  changes without overwriting them. Push only reviewed scoped changes. At thread
  completion, mark it done here, record deviations affecting others, and update
  newly ready threads. Never mark a deferred proof as passed.

Planning and both baseline macOS builds are complete; the apps were never launched.
No feature step S1–S8 is complete and no test host is running from this campaign.
The confirmed tiers are published on `iExalt/paseo` branch
`docs/configurable-notifications`. The local `.mise.toml` → `mise.toml` replacement
is pre-existing uncommitted work: preserve it and record its effect on the baseline;
do not silently include it in a feature commit. Verify current Git state at startup.

## Dependencies and human participation

```text
T1 ──> T2 ──────────┐
 └───> T3 ──> T4 ──┴──> T5
```

The arrows mean required completed outcomes, not concurrency. T2 and T3 become
ready together after T1, but run one at a time. Prefer T2 when the phone is
available; otherwise run T3, then T4. T2 may run between T3/T4 or just before T5.
It records whichever accepted source revision is current; it proves connectivity,
not final-feature behavior. T5 repeats the required device proof on the final revision.
T2 joins the critical path if phone availability delays T5.

| When                                  | Human action                                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Before each thread's work             | Approve its phase proposal and exact isolated launch scope, where applicable                                 |
| T2 phone session                      | Pair the additional test host, disable Wi-Fi, and observe an unmuted remote push on the existing Android app |
| T4 desktop demonstration, if prompted | Grant the isolated desktop/browser notification permission                                                   |
| T5 final phone session                | Observe positive/muted/unmuted trials over mobile data, then remove only the test pairing                    |

No appointment is fixed by this script. T2 and T5 proposals arrange availability;
do not guess a deadline or treat silence as a phone observation. No paid services
are authorized. Unexpected access, cost, or isolation requirements return to the user.

## T1 — Contract and stable check baseline: S1

**State:** ready to propose; Tier 3 confirmed, execution not approved.

```text
/keep-me-in-the-loop Run T1 in docs/CONFIGURABLE_NOTIFICATIONS_SCRIPT.md. Read its rules, dependencies, Human entry, and chunks before proposing the phase. On completion, update the script, roadmap, plan, and shared status; record deviations affecting later threads.
```

- **Depends on:** no execution thread; Tier 3 must be confirmed. Not alongside any other thread.
- **Human:** at approval, authorize the enumerated isolated test-process launches
  needed for the baseline. None after approval unless setup exposes a new blocker.
- **Chunks:** (1) pin revision, inspect paths/dirty work, establish status and contract
  inventory; (2) measure selected existing checks under fixed conditions and have
  author/reviewer accept the stable timing baseline and budgets.
- **Live:** only explicitly approved local test runtimes; no phone or relay; clean up
  each runtime before handing off. No feature edits before the baseline is captured.
- **Done when:** S1/M1.1 accepted with exact commands and timing evidence. G1 remains
  open until T2. Mark T2 and T3 ready; the status recommends whichever is available.

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
  endpoint; (2) pair, verify state and real unmuted push; (3) stop test processes
  and record retained test home/pairing for T5, or clean up after failure.
- **Live:** one test daemon/relay identity plus existing Android app; no replacement
  or production-state copy. Reassess after the initial 30-minute setup allowance.
- **Done when:** S2/G1 accepted with an actual observed positive control and stopped
  test processes. Missing control leaves the gate open. Record the revision and
  any retained test resources; do not keep a daemon running while waiting for T5.

## T3 — Durable policy and automation parity: S3–S4

**State:** waiting on T1; T2 is not a prerequisite.

```text
/keep-me-in-the-loop Run T3 in docs/CONFIGURABLE_NOTIFICATIONS_SCRIPT.md. Read its rules, dependencies, Human entry, and chunks before proposing the phase. On completion, update the script, roadmap, plan, and shared status; record deviations affecting later threads.
```

- **Depends on:** after T1 for accepted contract/baseline; not alongside any other
  execution thread. Do not wait for T2 if the phone session is unavailable.
- **Human:** at approval, authorize scoped feature implementation and named isolated
  CLI/MCP/test-daemon verification; no phone participation or GUI launch needed.
  None after approval unless scope, access, or safety assumptions change.
- **Chunks:** (1) persisted policy, optional wire contract, shared provisioning and
  runtime mutation; (2) agent/terminal delivery suppression retaining state/events;
  (3) CLI/MCP create/update/readback parity and minimal adapter journeys.
- **Live:** local disposable test homes only; clean up before handoff. Record check
  timings against T1, repair regressions within the changing chunk.
- **Done when:** S3–S4/G2 accepted and published, including same-directory workspace
  isolation, creation ordering, failures, and unsupported-host behavior. Phone
  suppression remains unverified until T5. Mark T4 ready.

## T4 — Desktop user control and feature builds: S5–S6

**State:** waiting on T3.

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
  (2) desktop success/failure/unsupported-host and notification demonstrations;
  (3) sequential npm/Nix packaging and artifact provenance for the feature revision.
- **Live:** isolated desktop settings/daemon and disposable workspaces; prevent
  built-in takeover and updates. Stop test processes; packaging smoke hooks stay
  disabled. Preserve the built artifacts, not running applications.
- **Done when:** S5/G3 and S6 accepted and published with required checks/timings.
  Mark T5 ready only if T2 is also done; otherwise recommend T2 next.

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
- **Chunks:** (1) verify final revision and execute the plan's phone gate: eligible
  positive controls around muted events plus runtime unmute, sampling agent and
  terminal paths with attention retained; (2) stop/remove test resources, verify
  production unchanged, and publish concise evidence and limitations.
- **Live:** retained test identity/home if still valid; otherwise repeat the approved
  pairing process. Allow roughly 15 minutes initially for guided checks, then
  reassess delays without weakening proof. Positive-control failure blocks success.
- **Done when:** S7–S8/G4 accepted, all other gates closed, test cleanup verified,
  and status distinguishes built/verified from deployed. On failure, perform cleanup
  and record open gates; do not mark the campaign complete.

## Deferred and revision history

Android menu verification, production deployment, and overseer integration require
separate planning. No roadmap step is otherwise deferred or omitted. An `overseer`
may launch ready threads one at a time in distinct Paseo workspaces using local
isolation and this same checkout. This script overrides its usual worker-worktree
choice for this campaign; it must enforce the ownership and handoff rules above.
This does not authorize changing the overseer skill. Manual use of the prompts
is equally supported.

The continuous reviewer accepted the script with no unresolved material findings.
The review confirmed step/gate coverage, safe phone-wait handoff, sequential
ownership, and explicit launch authority. The user confirmed Tier 3 on 2026-10-04
and authorized publication only. No execution thread has started.

- 2026-10-04: derived from confirmed Tiers 1–2; five threads preserve independent
  phone scheduling with sequential checkout ownership and mandatory final proof.

- 2026-10-04: user confirmed Tier 3 for publication, planning only.
