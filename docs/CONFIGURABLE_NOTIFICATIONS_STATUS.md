# Configurable notifications status

Last updated: 2026-10-08 UTC (2026-10-07 EDT)

## Purpose

This status links the [governing plan](CONFIGURABLE_NOTIFICATIONS.md) to the
[implementation roadmap](CONFIGURABLE_NOTIFICATIONS_ROADMAP.md) and
[execution script](CONFIGURABLE_NOTIFICATIONS_SCRIPT.md). It records current
evidence and the next gates; it is not a second implementation checklist.

## Current snapshot

| Field                        | Status                                                                                               |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| Baseline                     | Clean `feat/configurable-notifications` at `4ea125b83`, macOS arm64, Node 26.11                      |
| Current phase                | T1/S1 complete; feature implementation not started                                                   |
| Overall state                | Contract, M1.3 feasibility, and baseline are accepted; G1 remains open pending phone connectivity S2 |
| Immediate focus              | T3/S3–S4 automated policy and automation implementation                                              |
| Product or release readiness | No feature is implemented, packaged, deployed, or runtime-verified                                   |
| Worktree state               | Documentation-only T1 reconciliation; no feature source or config changes                            |

The T1 result closes planning and feasibility questions only. There is no shipped
collector or immutable completion subject. The accepted design does not establish
that a provider never truncates its internal response. Later lifecycle tests and
phone/desktop gates remain required.

## Accomplishments with evidence

### Contract and feasibility

Evidence state: verified.

- The accepted workspace contract is binary, defaults enabled, and suppresses user-facing banners
  and push while preserving attention and observation events.
- M1.3 has an accepted source-grounded design: collect normalized assistant
  chunks after managed-turn identity assignment and before coalescing; retain only
  the latest contiguous segment; seal it only for the matching successful
  `turn_completed` before foreground finalization clears the active turn.
- Missing start, history, unknown or ambiguous identity, declared or unestablished
  truncation, overflow, stale terminal, cancellation, and failure fail open. No
  history or latest-message fallback is allowed. S3 must add focused lifecycle and
  counterexample tests before enforcement. Overflow stays incomplete until a
  genuinely new segment starts.
- RE2 feasibility was checked with `re2-wasm@1.0.2`. Limits are 8 rules, 256
  UTF-16 code units per pattern, and 16,384 per subject. Accept only unique `i`,
  `m`, and `u` flags; Unicode mode is fixed and implicit when omitted. Reject
  unsupported, duplicate, or malformed flags atomically. Invalid saves retain
  prior rules; an incomplete subject fails open. Matching performs no text
  normalization.
- Current persistence seam is strict `PersistedConfigSchema` plus
  `DaemonConfigStore`, with validated private-config persistence and live
  apply/rollback. Exact new field and capability names remain unselected.
- Host reads require `daemon.read`; mutations require `daemon.manage`. Use an
  explicit host authorization context. Workspace-only permissions and the shared
  agent token do not grant global mutation. The current no-password session
  admission path grants owner permissions and must not be reused as an implicit
  host authorization shortcut.

Evidence: [plan source trace and design](CONFIGURABLE_NOTIFICATIONS.md#43-daemon-wide-reply-denylist),
including links to `handleStreamEvent`, `finalizeForegroundTurn`,
`checkAndSetAttention`, and the asynchronous notification callback. The latest
message getter lacks completion identity and is not a safe rule subject.

### Fixed routine-check baseline

Evidence state: verified. Measured on clean `4ea125b83` with copied dependencies
and build output, one Vitest worker, and no overlapping builds.

| Check                | Command result                          | Accepted budget | Investigation threshold |
| -------------------- | --------------------------------------- | --------------- | ----------------------- |
| Focused server tests | 92 passed; Vitest 7.49 s, wall 10.183 s | ≤15 s           | >15.183 s               |
| Root typecheck       | 27.508 s                                | ≤33 s           | >33.010 s               |
| Root lint            | 13.768 s                                | ≤19 s           | >18.768 s               |

A budget breach triggers investigation. Separately, investigate growth that is
both more than 20% and more than 5 s above the fixed baseline, plus material
cumulative growth. These triggers are not permission for regressions below them.
Observed RE2 sample timings are feasibility evidence, not a hard latency bound.

## Current boundary

- M1.2 and S2/G1 remain open until an isolated test host produces a user-observed
  positive push on the existing Android app over mobile data.
- The collector, immutable subject, persistence fields, capability, workspace
  controls, and CLI/MCP changes have not been implemented.
- No desktop, phone, relay, daemon, or provider was launched for T1. Production
  state and deployment remain excluded.
- T2 is required before T5, but not before automated T3 or T4.

## Intermediate goals

### I0 — Contract, feasibility, and baseline

Workflow status: complete.

Evidence state: verified.

Decision owner: approved plan and user-confirmed campaign order.

Exit-condition owner: I0.

Dependencies: confirmed plan and implementation authorization.

Deliverables: source-grounded workspace and filter contracts, bounded-engine
feasibility, and a fixed routine-check baseline.

Exit conditions: M1.1/M1.3/S1/T1 accepted; baseline and practical budgets recorded.

Evidence: the accepted design and receipts above. No feature-code completion is
implied.

### I1 — Durable policy and automation parity

Workflow status: next.

Evidence state: designed.

Decision owner: approved plan.

Exit-condition owner: I1.

Dependencies: I0 evidence; T2 is not a prerequisite.

Deliverables: workspace policy persistence/enforcement and daemon-wide reply
filtering, followed by CLI/MCP create, update, and readback parity.

Exit conditions: focused tests preserve attention and source events; completion
subjects are immutable, matching-turn, complete retained live segments; host
authority and invalid-save behavior match the contract; required automation
operations have parity.

Evidence: none yet.

## Recommended next sequence

1. T3/S3: implement durable workspace policy, delivery enforcement, and the
   bounded daemon-wide filter with focused lifecycle tests.
2. T3/S4: implement and verify CLI/MCP parity for workspace and host settings.
3. T4: implement user controls, desktop proof, and feature builds.
4. T2: arrange and run the isolated phone-connectivity positive control.
5. T5: verify the final feature revision on the phone and clean up test resources.

This automated-first order is the user's current scheduling decision. T2 remains
a prerequisite for T5 only.

## Explicitly deferred

- **Phone connectivity proof (T2):** scheduled after automated T3 and T4.
- **Final phone proof and cleanup (T5):** depends on both T2 and T4.
- **Desktop runtime proof (T4):** depends on T3 and its named isolated launch gate.
- **Production deployment and overseer integration:** outside this campaign.

## Active risks and decisions

| Risk or decision             | Evidence or uncertainty                                                                                                          | Consequence                                                   | Mitigation or next evidence                                                                                                       | Owner          |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Completion subject lifecycle | The current notification path reads latest text asynchronously after the foreground turn is cleared; no immutable subject exists | A stale or partial reply could suppress a later notification  | Implement pre-coalescer collection and explicit successful-turn snapshot; add S3 race, missing-start, overflow, and failure tests | T3             |
| Host authorization           | No-password session admission grants owner permissions; shared agent tokens are not host-level credentials                       | Global settings could be exposed to a workspace-scoped client | Use explicit host authorization and test anonymous/shared-token denial plus authorized local/password cases                       | T3             |
| Phone/relay availability     | No phone positive control has been run                                                                                           | G1 and final device proof remain open                         | Run T2 after automated work, then T5 against the final revision                                                                   | User and T2/T5 |

## Progress log

### 2026-10-08 UTC (2026-10-07 EDT)

- Recorded reviewer-accepted M1.3 feasibility, source trace, RE2 constraints,
  fixed baselines, and practical budgets.
- Marked M1.1/M1.3/S1/T1 complete as contract and feasibility outcomes only.
- Updated the current sequence to T1 → T3 → T4 → T2 → T5. Implementation,
  G1, device proof, and production deployment remain open.
