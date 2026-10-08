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
| Baseline                     | Fixed T1 baseline `4ea125b83`, macOS arm64, Node 26.11; current branch includes T1 commit `de83523e` |
| Current phase                | T1/S1 complete; S3a policy storage and S3b agent/terminal enforcement implemented                    |
| Overall state                | S3 remains open; S3c, M1.2/S2, and G1 are not complete                                               |
| Immediate focus              | S3c completion subjects and bounded matcher                                                          |
| Product or release readiness | Server suppression is verified in focused fixtures; user controls and phone delivery remain open     |
| Worktree state               | S3b source and focused tests accepted for scoped publication                                         |

The T1 result closes planning and feasibility questions only. S3a adds durable
workspace policy storage and mutation; S3b now enforces that policy for agent and
terminal attention delivery and advertises the capability. Regex filtering and
the immutable completion subject remain unimplemented in S3c. The accepted design
does not establish that a provider never truncates its internal response. Later
lifecycle tests and phone/desktop gates remain required.

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
- The global-rule persistence seam remains strict `PersistedConfigSchema` plus
  `DaemonConfigStore`, with validated private-config persistence and live
  apply/rollback. S3a separately adds the durable workspace field
  `notifications: "on" | "off"`; the optional
  `workspaceNotifications` capability remains absent from the real server until
  delivery suppression is implemented.
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
- S3a workspace policy storage and mutation are implemented, verified, and
  review-accepted. S3b enforces the stored policy for agent and terminal
  attention delivery, preserving attention/source events with
  `shouldNotify: false` while muted. The shared production readiness setting
  enables both MCP policy support and the `workspaceNotifications` capability.
  S3c filtering and its immutable completion subject remain open.
- The original creation disconnect fixture fails on both this worktree and the
  untouched `4ea125b83` baseline at the same `prompts === 1` assertion (actual 7).
  The baseline run took 17.39 s in Vitest and 19.551 s wall time, so this is a
  reproduced baseline limitation rather than an S3a regression.
- The collector, immutable subject, global filter, CLI controls, and end-user
  workspace controls have not been implemented.
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

Workflow status: in progress.

Evidence state: S3a implementation and focused verification review-accepted;
delivery enforcement remains open.

Decision owner: approved plan.

Exit-condition owner: I1.

Dependencies: I0 evidence; T2 is not a prerequisite.

Deliverables: workspace policy persistence, delivery enforcement, and daemon-wide
reply filtering, followed by CLI/MCP create, update, and readback parity.

Exit conditions: focused tests preserve attention and source events; completion
subjects are immutable, matching-turn, complete retained live segments; host
authority and invalid-save behavior match the contract; required automation
operations have parity.

Evidence: S3a protocol, registry, provisioning, runtime mutation, and MCP creation
paths are implemented and review-accepted. Focused gates pass, with the
creation disconnect baseline limitation above. No delivery
suppression is claimed.

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

### 2026-10-08 01:04 UTC (2026-10-07 21:04 EDT)

- Implemented the S3a durable `notifications: "on" | "off"` workspace policy,
  optional backward-compatible wire fields, workspace create propagation, MCP
  creation propagation, and a runtime mutation RPC. The real server leaves
  `workspaceNotifications` unadvertised until S3b delivery enforcement.
- Focused S3a tests, root typecheck, lint, formatting, and generated protocol
  validation pass. The strengthened raw-wire test confirms an off workspace is
  persisted before its first descriptor while the real server leaves the
  capability unadvertised. MCP creation rejects explicit policy by default
  before parsing or side effects. The original creation disconnect assertion is
  a reproduced baseline limitation. S3 overall, delivery behavior, G1, phone
  proof, and production deployment remain open.
- Lead and navigator accepted the S3a snapshot. Final server build took 16.636 s;
  root typecheck, lint, and formatting took 17.354 s, 1.264 s, and 1.919 s.

### 2026-10-08 01:21 UTC (2026-10-07 21:21 EDT)

- Implemented S3b policy checks after asynchronous recipient/text lookups, using
  the captured workspace ID for both lookup and event payload. Muted workspaces
  suppress push and set `shouldNotify: false` without dropping legacy or modern
  attention events. Missing records retain the enabled behavior.
- Agent and terminal fixtures cover decision-time policy changes, distinct
  workspace IDs sharing a directory, muted and enabled push behavior, and
  modern/legacy delivery. The raw-wire creation and initial `server_info`
  capability tests pass with support enabled.
- Changed notification tests: 21 passed in 2.50 s. Targeted loopback tests:
  2 passed in 6.60 s; the first sandboxed attempt was blocked by listener
  permissions and was rerun outside the sandbox. Final server build took 15.381 s;
  root typecheck 18.695 s and lint 14.474 s. After the routing snapshot follow-up,
  server typecheck passed in 3.261 s; changed-file lint, formatting, and diff
  checks pass.
- Lead and navigator accepted S3b at 01:25 UTC (21:25 EDT). S3c filtering, user-facing controls, phone
  positive control, G1, and production deployment remain open.

### 2026-10-08 UTC (2026-10-07 EDT)

- Recorded reviewer-accepted M1.3 feasibility, source trace, RE2 constraints,
  fixed baselines, and practical budgets.
- Marked M1.1/M1.3/S1/T1 complete as contract and feasibility outcomes only.
- Updated the current sequence to T1 → T3 → T4 → T2 → T5. Implementation,
  G1, device proof, and production deployment remain open.
