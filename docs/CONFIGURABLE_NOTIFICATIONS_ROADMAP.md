# Configurable workspace notifications roadmap

Tier 2 confirmed by the user on 2026-10-04 after reviewer acceptance.
The [confirmed plan](CONFIGURABLE_NOTIFICATIONS.md)
owns scope and decisions. No feature work or runtime probe has started. The
[execution script](CONFIGURABLE_NOTIFICATIONS_SCRIPT.md) is confirmed and defines
the threads to open. Planning confirmation does not authorize implementation or
runtime probes.

## Progress and ordering

| Outcome                             | Steps | Done | Exit |
| ----------------------------------- | ----- | ---- | ---- |
| Contract and validation feasibility | S1–S2 | 0/2  | G1   |
| Durable policy and automation       | S3–S4 | 0/2  | G2   |
| User controls                       | S5    | 0/1  | G3   |
| Device proof and handoff            | S6–S8 | 0/3  | G4   |

Dependency graph, selected by the user on 2026-10-04:

```text
S1 ──> S2 ────────────────────────┐
 └───> S3 ──> S4 ──> S5 ──> S6 ──┴──> S7 ──> S8
```

**Decided (the user, 2026-10-04):** allow offline work while phone validation is
arranged. S3 needs accepted S1, not S2. G1 still requires S1 and S2;
the plan's gates describe outcomes rather than mandatory chronological barriers.
Final acceptance requires every gate regardless of which finishes first.

Each step ends in its proof, normally a few scoped commits. Check it off here and
its **Ticks** boxes in the plan in the same commit, with a concise evidence receipt.
Use this checkout; do not introduce parallel worktrees. Independent readiness
allows scheduling around the phone, not concurrent edits or competing heavy builds.

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
  isolated Android relay/push connectivity (S2). **Gate: G1.**
- **Deliver automation first:** durable policy and delivery semantics (S3), then
  creation/update/read parity through CLI/MCP (S4). **Gate: G2.**
- **Add user controls:** shared menu, synchronized state, and desktop proof (S5).
  **Gate: G3.** Android menu proof remains deferred.
- **Prove and hand off:** package the feature revision (S6), observe real phone
  controls (S7), clean up and record limits (S8). **Gate: G4.** No production cutover.

## Steps

- [ ] **S1 — Pin the contract and verification baseline.** Inventory the creation,
      update, notification, descriptor, and permission paths against a fixed source
      revision. Turn the confirmed contract into a small policy table and select the
      cheapest existing suites for each invariant. Establish the stable timing record
      and reviewed budgets described below before feature edits.
  - **Needs:** confirmed plan and execution-phase approval.
  - **Proof:** source-path inventory, policy table, and baseline receipt with exact
    commands, revision, environment, timings, budgets, and any tests that launch
    isolated runtimes. Missing baseline or launch authority leaves those checks open.
  - **Ticks:** M1.1; W1.
  - **Human:** at execution approval, authorize the named isolated test processes
    needed by selected checks; no production actions. Planning approval is insufficient.

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

- [ ] **S3 — Persist and enforce workspace policy.** Add optional wire fields and
      capability negotiation, durable workspace policy, shared creation ordering,
      runtime mutation, descriptor publication, and agent/terminal delivery gating.
      Preserve attention, pending permissions, and non-notifying source events.
  - **Needs:** accepted S1. S2 is not a prerequisite.
  - **Proof:** fast policy matrix plus minimal registry/provisioning/delivery
    integration for persisted state, restart recovery in isolation, same-directory
    workspace independence, idempotency, failed writes, and unsupported-host errors.
    Reuse existing authorization classification; no provider-auth checks.
  - **Ticks:** M2.1–M2.2; W2. Timing review is part of acceptance.

- [ ] **S4 — Complete CLI and MCP parity.** Connect creation flags/fields, runtime
      update, and effective-policy readback through the real CLI and MCP adapters.
      Cover both local and worktree provisioning; reject unsupported policy changes
      before creating an incorrectly unmuted workspace.
  - **Needs:** accepted S3.
  - **Proof:** targeted adapter tests plus a minimal isolated automation journey
    showing CLI-created and MCP-created quiet workspaces before work starts,
    runtime changes, readback, and failure propagation. Do not repeat the policy
    matrix here. The policy governs future decisions with no unmute replay.
  - **Ticks:** M2.3; W3; G2 with S3.

- [ ] **S5 — Implement and prove desktop user control.** Extend the shared workspace
      context/button menu with authoritative current state and mute/unmute actions.
      Reflect CLI/MCP changes without reconnecting; expose failed saves and unsupported
      daemon state. Keep the implementation cross-platform.
  - **Needs:** accepted S4/G2.
  - **Proof:** one focused desktop journey through menu change, automation readback,
    external update, and failed-save feedback; verify desktop/browser notification
    controls separately from Android's remote-push path. Preserve production app
    isolation. Run targeted changed tests and review timing changes.
  - **Ticks:** M3.1–M3.2; W4; G3.
  - **Human:** at phase approval, authorize the isolated desktop/browser launch;
    any OS notification permission prompt requiring a person is handled before
    the demonstration. Android menu evidence is not required or claimed.

- [ ] **S6 — Build the feature revision.** Run the npm and Nix macOS build tasks
      sequentially with packaged-app smoke launching disabled. Record source revision
      and artifact identity; review existing fork CI results where available.
  - **Needs:** accepted S5/G3; builds include accepted S3–S4.
  - **Proof:** both builds succeed, required checks pass, and artifact metadata
    matches the feature revision. Builds alone do not prove notification behavior.
  - **Ticks:** M4.2; part of W5.

- [ ] **S7 — Prove muted/unmuted behavior on the actual phone.** Start the approved
      isolated feature host using S6's revision. The installed Android app connects
      over relay/mobile data. Prove retained state, then remote push suppression and
      runtime unmute with positive controls before and after the muted trial.
  - **Needs:** accepted S2, S3, S4, S5 and S6; phone session arranged.
  - **Proof:** follow the plan's five-part phone gate. Observe real positive arrival,
    record muted source events and a bounded silence window, and establish that
    all relevant clients are outside the 180-second presence window or disconnected.
    Sample both agent and terminal paths; never use agent errors as positive controls.
    A failed positive control leaves the gate open. No mobile app rebuild/replacement.
  - **Ticks:** M4.1; device proof portion of W5.
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
  - **Ticks:** M4.3; completes W5 and G4 only when all prior proof passes.
  - **Human:** remove the test host from the phone when prompted; keep the production
    pairing. Afterward no human action remains in this campaign.

## Testing pyramid and runtime budget

Use existing suites such as `agent-attention-policy.test.ts`,
`workspace-registry.test.ts`, workspace-provisioning tests, the two WebSocket
notification suites, and CLI workspace suites. S1 selects the exact affected files;
this is a candidate list, not an instruction to run all of them each increment.
Keep detailed policy cases at the fast unit layer. Integration covers boundaries;
one desktop journey and the real-phone gate cover behavior unavailable below them.

Routine verification uses `mise exec -- npx vitest run <changed-file> --bail=1`
from its owning workspace, then the required root npm lint and typecheck scripts.
Rebuild owning workspace declarations before diagnosing stale cross-package types.
Use npm formatting scripts; full format before commits. Never run the full local
test suite. Any broader evidence belongs to an explicit fork-CI gate, not an optional
replacement for required targeted checks. Review fork workflow side effects before
pushing feature commits; no release tags or app publication.

S1 records baseline timings on the pinned pre-feature revision with fixed machine,
Node version, worker count, cache state, and no overlapping builds. Separate build
setup cost from test runtime. Author and reviewer accept budgets from those measured
results; until recorded, this is an open S1 requirement, not an invented numeric
baseline. Keep that baseline fixed across implementation. Use required runs for
comparison and repeat only to resolve uncertainty.

Proposed investigation trigger: both more than 20% and more than 5 seconds above
the comparable baseline, or material cumulative growth even below either threshold.
This trigger is not permission for smaller regressions. Repair confirmed growth
within the changing step, or justify necessary added cost without weakening proof.
Do not reset the baseline, increase concurrency, or remove required checks to conceal
growth. Report any routine check taking over a minute. Retain only distinct tests
with small fixtures, and include latency review in every step's acceptance.

## Human interventions and scheduling

| Step     | Kind                 | Action and timing                                                                                          | Status                                                       |
| -------- | -------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| S1/S2/S5 | Execution approval   | Approve named isolated test processes and external-service use before their phase starts; never production | Future execution gate                                        |
| S2       | Phone presence       | Pair additional test host and observe relay/mobile-data positive control                                   | Arrange during execution; offline work may proceed meanwhile |
| S5       | OS prompt, if needed | Grant test desktop/browser notification permission before local notification proof                         | Conditional                                                  |
| S7       | Phone presence       | Observe muted/unmuted trials on existing Android app                                                       | Required final session                                       |
| S8       | Manual cleanup       | Remove only test pairing from phone                                                                        | End of final session, or after failed probe                  |

The sequencing decision and Tier 2 are confirmed. No exact
appointment is needed during planning: the execution script makes these waits
explicit and groups approvals so autonomous work can proceed between phone sessions.
Desktop and Android menu scope, relay route, and production exclusions are already
settled in the plan and are not reopened here.

The continuous reviewer accepted the final roadmap with no unresolved material
findings. Its dependency and coverage review confirmed that offline progress does
not bypass phone feasibility or the final real-device gate. The user confirmed this tier on 2026-10-04 and requested the execution script.
The roadmap is published to the personal fork; no implementation was authorized.
