# Configurable notifications roadmap

The original Tier 2 was confirmed on 2026-10-04. This revision incorporates the
daemon-wide reply denylist from the [confirmed plan](CONFIGURABLE_NOTIFICATIONS.md)
and was confirmed by the user after review on 2026-10-04. The corresponding
[execution script](CONFIGURABLE_NOTIFICATIONS_SCRIPT.md) revision is also confirmed.
The user later authorized implementation in the requested sibling worktree. T1/S1
and S3–S4/G2 are complete within their focused local verification gates. User
controls/G3 and feature builds/S6 are accepted; phone/device acceptance remains
open. See the [current status](CONFIGURABLE_NOTIFICATIONS_STATUS.md).

## Progress and ordering

| Outcome                             | Steps | Done | Exit |
| ----------------------------------- | ----- | ---- | ---- |
| Contract and validation feasibility | S1–S2 | 1/2  | G1   |
| Durable policy and automation       | S3–S4 | 2/2  | G2   |
| User controls                       | S5    | 1/1  | G3   |
| Device proof and handoff            | S6–S8 | 1/3  | G4   |

Dependency graph, selected by the user on 2026-10-04:

```text
S1 ──> S3 ──> S4 ──> S5 ──> S6 ──┐
 └───> S2 ────────────────────────┴──> S7 ──> S8
```

**Current order (the user, 2026-10-07):** finish automated work first: T1, T3,
then T4; schedule phone work afterward as T2 then T5. S3 needs accepted S1, not S2.
T2 remains a prerequisite for T5, not for T3 or T4. G1 still requires both S1 and
S2. Final acceptance requires every gate regardless of which finishes first.

**Build preparation split (2026-10-08):** after accepted S5c automated proof,
prepare S6 packages before the human OS notification session. This honors the
automated-first order and gives that session an identified feature artifact.
S5/G3, S6 final acceptance, and T4 remain open until the original live proof passes.

Each step ends in its proof, normally a few scoped commits. Check it off here and
its **Ticks** boxes in the plan in the same commit, with a concise evidence receipt.
Use the explicitly requested sibling worktree. Independent readiness allows
scheduling around the phone, not concurrent edits or competing heavy builds.

## Live runs

| Run                      | Steps | Resources and lifetime                                                                                                            | Cost/control                                                                                                                     |
| ------------------------ | ----- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Early connectivity probe | S2    | Separate test home, server identity, loopback endpoint and relay registration; existing Android app; stop test daemon after probe | Initial 30-minute setup allowance, then reassess; user pairs and observes a positive push over mobile data                       |
| Desktop proof            | S5–S6 | Isolated test daemon and updated desktop/browser client; disposable workspaces; stop processes after each proof session           | No production home, port, settings, app replacement, or auto-update takeover                                                     |
| Final phone session      | S7–S8 | Reuse the approved test identity/pairing if retained from S2; existing Android app on mobile data; remove test pairing at cleanup | Roughly 15 minutes of guided checks initially; presence windows or delivery delays may extend this; no silent timeout-based pass |

No paid services or cloud runners are required by this proposal. Expo and Paseo
relay are external dependencies; their availability is evidence to establish, not
a service change to make. Fork CI, if used, stays within existing account allowance;
unexpected paid requirements return to the user. Never copy production agent state.

## Phase summary

- **Establish contracts and feasibility:** pin source and check costs (S1), prove
  completion-text and bounded-regex feasibility (S1), then isolated Android
  relay/push connectivity (S2). **Gate: G1.**
- **Deliver automation first:** durable policy and delivery semantics (S3), then
  workspace creation/update/read and daemon rule get/set/clear through CLI/MCP
  (S4). **Gate: G2.**
- **Add user controls:** shared workspace menu, host rule editor, synchronized
  state, and desktop proof (S5).
  **Gate: G3.** Android menu proof remains deferred.
- **Prove and hand off:** package the feature revision (S6), observe real phone
  controls (S7), clean up and record limits (S8). **Gate: G4.** No production cutover.

## Steps

- [x] **S1 — Pin the contract and verification baseline.** Inventory the creation,
      update, notification, descriptor, and permission paths against a fixed source
      revision. Turn the confirmed contract into a small policy table and select the
      cheapest existing suites for each invariant. Establish the stable timing record
      and reviewed budgets described below before feature edits.
      Resolve M1.3 by tracing a completion-bound, complete retained text source,
      selecting a bounded regex engine and finite limits, and identifying host
      persistence, authority, capability, and control surfaces. Temporary isolated
      probes may inform this investigation; do not ship filtering code in S1.
  - **Needs:** confirmed plan and execution-phase approval.
  - **Proof:** source-path inventory, policy table, and baseline receipt with exact
    commands, revision, environment, timings, budgets, and any tests that launch
    isolated runtimes. Missing baseline or launch authority leaves those checks open.
    Separately record accepted M1.3 evidence: stale/next-turn/truncated subjects
    cannot suppress, engine syntax/flags/limits are explicit, and host mutation
    authority supports the required automation. Missing feasibility leaves S1 open.
  - **Ticks:** M1.1 and M1.3; W1; contract portion of W6.
  - **Human:** at execution approval, authorize the named isolated test processes
    needed by selected checks; no production actions. Planning approval is insufficient.
    If host authority cannot support automation without changing the agreed scope,
    return that concrete conflict to the user before dependent implementation.

**T1 receipt:** the source inventory, accepted fail-open lifecycle/authority
contract, actual RE2 feasibility probe, and fixed measured baseline close this
feasibility gate. The [status](CONFIGURABLE_NOTIFICATIONS_STATUS.md) and plan retain
the evidence and budgets. S3 still must implement and test the collector and
delivery behavior; T1 does not claim those feature proofs or any live/device proof.

- [ ] **S2 — Prove the existing phone can use the test host.** Configure a new home,
      identity, endpoint, and relay connection. Pair the installed Android app as an
      additional host, verify server identity/state with Wi-Fi off, and observe an
      eligible unmuted remote push. Inspect launch configuration before running it.
  - **Needs:** S1; approved isolation and test identities.
  - **Proof:** actual phone-observed positive push over relay/mobile data, with the
    source event and presence conditions recorded. Token registration or an Expo
    ticket alone does not pass. Stop the test daemon after the session; keep only
    the test home/pairing needed for S7, with its retention recorded.
  - **Ticks:** M1.2; G1 with S1; enables W5.
  - **Human:** authorize isolated launches and external relay/Expo use at phase
    approval; pair, switch to mobile data, and observe the phone during the scheduled
    session. S2 waits for those actions; independent approved work may continue
    under the selected ordering. Reassess after the setup allowance rather than
    substituting a weaker phone proof.

- [x] **S3 — Persist and enforce notification policies.** Add optional wire fields and
      capability negotiation, durable workspace policy, shared creation ordering,
      runtime mutation, descriptor publication, and agent/terminal delivery gating.
      Preserve attention, pending permissions, and non-notifying source events.
      Review two increments independently: workspace enforcement, then daemon-wide
      filtering with completion-bound subjects and bounded regex evaluation.
      Persist an empty-default host rule list with atomic runtime replacement and
      readback; match only finished replies, with workspace mute taking precedence.
  - **Needs:** accepted S1, including M1.3 and the stable baseline. S2 is not a prerequisite.
  - **Proof:** fast policy matrix plus minimal registry/provisioning/delivery
    integration for persisted state, restart recovery in isolation, same-directory
    workspace independence, idempotency, failed writes, and unsupported-host errors.
    Reuse existing authorization classification; no provider-auth checks.
    Filter unit proofs cover missing/ambiguous/truncated subjects, streaming text,
    significant suffixes, stale/next-turn races, flags/invalid patterns/limits, and
    non-finished bypass. Minimal integration proves durable host state, failed-write
    atomicity, two-workspace global coverage, separate-daemon isolation, capability
    gating, and retained observation/attention/subscription behavior.
  - **Ticks:** M2.1–M2.2; enforcement portion of M2.4; W2 and part of W6.
    M2.4 remains open until S4. Timing review is part of each increment's acceptance.

- [x] **S4 — Complete CLI and MCP parity.** Connect creation flags/fields, runtime
      update, and effective-policy readback through the real CLI and MCP adapters.
      Cover both local and worktree provisioning; reject unsupported policy changes
      before creating an incorrectly unmuted workspace.
      Add host-targeted rule get/set/clear through both adapters, using structured
      source/flags input and authoritative readback. Workspace creation must not
      mutate the daemon-wide denylist.
  - **Needs:** accepted S3.
  - **Proof:** targeted adapter tests plus a minimal isolated automation journey
    showing CLI-created and MCP-created quiet workspaces before work starts,
    runtime changes, readback, and failure propagation. Do not repeat the policy
    matrix here. The policy governs future decisions with no unmute replay.
    Include daemon rule set/read/clear, invalid-save retention, unsupported-feature
    errors, correct host authority mapping, and a regex escaping round trip. Rule
    changes affect future decisions without restart, replay, or retraction.
  - **Ticks:** M2.3 and M2.4 with S3; W3 and automation portion of W6; G2 with S3.

- [x] **S5 — Implement and prove desktop user control.** Extend the shared workspace
      context/button menu with authoritative current state and mute/unmute actions.
      Reflect CLI/MCP changes without reconnecting; expose failed saves and unsupported
      daemon state. Keep the implementation cross-platform.
      Add a host-settings rule editor with explicit save/clear, syntax feedback,
      and visible external updates when local edits are unsaved. Clearly identify
      the selected daemon and the all-workspaces scope.
  - **Needs:** accepted S4/G2.
  - **Proof:** one focused desktop journey through menu change, automation readback,
    external update, and failed-save feedback; verify desktop/browser notification
    controls separately from Android's remote-push path. Preserve production app
    isolation. Run targeted changed tests and review timing changes.
    In the same desktop session, prove host-rule edit/save/clear, invalid/failed-save
    retention, automation synchronization, and unsaved-edit conflict feedback.
    Bracket a filtered completion with nonmatching and rule-cleared local notification
    controls, independently of workspace mute. Detailed regex matrices stay offline.
  - **Ticks:** M3.1–M3.3; W4 and UI portion of W6; G3.
  - **Human:** at phase approval, authorize the isolated desktop/browser launch;
    any OS notification permission prompt requiring a person is handled before
    the demonstration. Android menu evidence is not required or claimed.
  - **Receipt:** the user confirmed the isolated browser's first/fourth OS
    notifications arrived and the workspace-muted/rule-filtered trials were
    silent. Scoped macOS logs record both banners; G3 and M3.1–M3.3 are accepted.

- [x] **S6 — Build the feature revision.** Run the npm and Nix macOS build tasks
      sequentially with packaged-app smoke launching disabled. Record source revision
      and artifact identity; review existing fork CI results where available.
  - **Needs:** build preparation may follow accepted S5c automated proof; builds
    include accepted S3–S4. Final acceptance still requires accepted S5/G3.
  - **Proof:** both builds succeed, required checks pass, and artifact metadata
    matches the feature revision. Builds alone do not prove notification behavior.
  - **Ticks:** M4.2; part of W5.
  - **Build receipt:** npm and Nix arm64 packages passed for `2cd1ee978` plus the
    refreshed RE2 dependency hash; M4.2 is complete. See the status receipt for
    artifact identity and timing limits. S5/G3's browser OS proof now closes S6
    final acceptance; later test/docs-only preparation did not require rebuilding.

- [ ] **S7 — Prove muted/unmuted behavior on the actual phone.** Start the approved
      isolated feature host using S6's revision. The installed Android app connects
      over relay/mobile data. Prove retained state, then remote push suppression and
      runtime unmute with positive controls before and after the muted trial.
      In an otherwise unmuted workspace, prove daemon-wide regex suppression with
      nonmatching and rule-cleared positive controls in that same phone session.
  - **Needs:** accepted S2, S3, S4, S5 and S6; phone session arranged.
  - **Proof:** follow the plan's six-part phone gate. Observe real positive arrival,
    record muted source events and a bounded silence window, and establish that
    all relevant clients are outside the 180-second presence window or disconnected.
    Sample both agent and terminal paths; never use agent errors as positive controls.
    A failed positive control leaves the gate open. No mobile app rebuild/replacement.
    Retain matching completion/attention evidence, verify the rule is on the isolated
    host, and use identical eligible presence conditions for regex controls.
  - **Ticks:** M4.1; device proof portions of W5 and W6.
  - **Human:** at the named phone session, select the test host, turn Wi-Fi off,
    background the app when requested, and report arrivals. This step waits for
    observations; no silent assumption that a missing response means no notification.

- [ ] **S8 — Clean up and hand off the verified feature.** Stop only test processes,
      remove test-host subscriptions/pairings and temporary runtime state, and retain
      build artifacts and concise proof receipts. Reconcile roadmap and plan status.
  - **Needs:** S7 completed or stopped with a recorded failure; final acceptance
    additionally needs S1–S7 accepted. Cleanup also runs after failed live probes.
  - **Proof:** test process/resource cleanup verified, production identity unchanged,
    all G1–G4 evidence linked to the feature revision, and explicit limits: no Android
    menu proof, production deployment, or overseer integration. Failed gates stay open.
    Verify no rule or settings mutation escaped the isolated test daemon. Remove
    test-only rule configuration with the test state; preserve production policy.
  - **Ticks:** M4.3; completes W5, W6, and G4 only when all prior proof passes.
  - **Human:** remove the test host from the phone when prompted; keep the production
    pairing. Afterward no human action remains in this campaign.

## Testing pyramid and runtime budget

Use existing suites such as `agent-attention-policy.test.ts`,
`workspace-registry.test.ts`, workspace-provisioning tests, the two WebSocket
notification suites, and CLI workspace suites. S1 selects the exact affected files;
this is a candidate list, not an instruction to run all of them each increment.
Keep detailed policy cases at the fast unit layer. Integration covers boundaries;
one desktop journey and the real-phone gate cover behavior unavailable below them.
S1 adds completion-text and regex-engine candidates to that inventory. Benchmark
bounded worst-case pattern/subject combinations in isolated probes before adopting
the engine; retain only distinct regression invariants in existing appropriate
suites. Measure any added dependency/setup cost separately from routine runtime.

Routine verification uses `mise exec -- npx vitest run <changed-file> --bail=1`
from its owning workspace, then the required root npm lint and typecheck scripts.
Rebuild owning workspace declarations before diagnosing stale cross-package types.
Use npm formatting scripts; full format before commits. Never run the full local
test suite. Any broader evidence belongs to an explicit fork-CI gate, not an optional
replacement for required targeted checks. Review fork workflow side effects before
pushing feature commits; no release tags or app publication.

The fixed baseline was measured on clean `4ea125b83` in the macOS arm64 sibling
worktree with Node 26.11, copied dependencies/output, one Vitest worker, and no
overlapping builds. Do not repeat it without a specific comparability gap.

| Check                | Result                                  | Accepted budget | Growth trigger |
| -------------------- | --------------------------------------- | --------------- | -------------- |
| Focused server tests | 92 passed; Vitest 7.49 s, wall 10.183 s | ≤15 s           | >15.183 s      |
| Root typecheck       | 27.508 s                                | ≤33 s           | >33.010 s      |
| Root lint            | 13.768 s                                | ≤19 s           | >18.768 s      |

A budget breach triggers investigation. Separately, investigate growth that is
both more than 20% and more than 5 s above the fixed baseline, and material
cumulative growth. These thresholds do not permit regressions below them. Repair
confirmed growth within the changing step, or justify necessary added cost without
weakening proof.
Do not reset the baseline, increase concurrency, or remove required checks to conceal
growth. Report any routine check taking over a minute. Retain only distinct tests
with small fixtures, and include latency review in every step's acceptance.

## Human interventions and scheduling

| Step  | Kind                       | Action and timing                                                                                          | Status                                                       |
| ----- | -------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| S2/S5 | Execution approval         | Approve named isolated test processes and external-service use before their phase starts; never production | Future execution gate                                        |
| S1    | Conditional scope decision | Resolve a host-authority conflict only if implementation exposes one                                       | No conflict identified in T1                                 |
| S2    | Phone presence             | Pair additional test host and observe relay/mobile-data positive control                                   | Arrange during execution; offline work may proceed meanwhile |
| S5    | OS prompt, if needed       | Grant test desktop/browser notification permission before local notification proof                         | Conditional                                                  |
| S7    | Phone presence             | Observe workspace mute and reply-filter controls on existing Android app                                   | Required final session                                       |
| S8    | Manual cleanup             | Remove only test pairing from phone                                                                        | End of final session, or after failed probe                  |

The scheduling decision is updated in the execution script. T1/S1 is complete;
automated T3 and T4 precede the T2/T5 phone sessions. No exact appointment is set.
Desktop and Android menu scope, relay route, and production exclusions remain as
settled in the plan.

The prior workspace-only roadmap was reviewed, confirmed, and published on
2026-10-04. This regex revision keeps the eight-step dependency graph and resource
boundaries, adds M1.3 before enforcement, and distributes W6 across S1/S3/S4/S5/S7/S8.
It adds no Android build, app replacement, or separate phone session. Reassess the
initial phone-session estimate if added controls or presence waits need more time;
do not reduce positive controls to fit it. Implementation is authorized in the
requested sibling worktree; future live/device gates remain separate.

- [x] Map revised Tier 1 scope and gates into the existing steps.
- [x] Review the revised roadmap; no unresolved material findings.
- [x] Confirm revised Tier 2 with the user.
- [x] Revise and confirm the execution script after publishing this roadmap.

- 2026-10-08 UTC (2026-10-07 EDT): T1/S1 closed with accepted M1.3 feasibility
  and fixed baseline. User order is T1 → T3 → T4 → T2 → T5; T2 is still required
  before T5, but not before T3 or T4.
