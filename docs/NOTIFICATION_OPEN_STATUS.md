# Immediate notification opens status

Last updated: 2026-11-06

## Purpose and current snapshot

The [approved plan and checklist](NOTIFICATION_OPEN_PLAN.md) define scope and exit
criteria. This document records outcomes and missing proof.

| Field                     | State                                                                  |
| ------------------------- | ---------------------------------------------------------------------- |
| Source baseline           | `2c27bd2ef741967693ad49928b153cc07f0ed3e4`                             |
| Current chunk             | B: display-only push content                                           |
| Overall state             | Active; A reviewer-accepted, B under implementation                    |
| Verification boundary     | Source inspected; 57 existing focused tests passed before edits        |
| Product/release readiness | Not verified, not deployed; no release authorized                      |
| Workspace                 | `feat/instant-notification-chat`; unrelated untracked `.qa/` preserved |

## Intermediate gates

| Gate | Workflow | Evidence | Depends on / exit condition                                                                     |
| ---- | -------- | -------- | ----------------------------------------------------------------------------------------------- |
| A    | complete | verified | Pre-navigation cache/observation, cancellation/adoption and replay tests pass; reviewer accepts |
| B    | active   | designed | A; bounded provisional snapshot and canonical reconciliation tests plus rendered proof          |
| C    | planned  | designed | A/B; native notification/timing matrix, combined checks, final review, required CI and merge    |

## Evidence

- Ran before edits: `mise exec -- npm exec vitest -- run
  src/notification-open/model.test.ts src/timeline/viewed-timeline-sync.test.ts --bail=1`
  from `packages/app`: 2 files, 57 tests passed, 5.32 s (macOS arm64, warm dependencies).
- Read: notification routing waits for startup leaf readiness; cache preparation is
  initiated by workspace visibility; existing owner subscribes before catch-up fetch.
- Read: notifications deliberately discard workspace hints to avoid stale foreign pins.
- Ran: `mise exec -- adb devices -l` reports no attached devices;
  `xcrun simctl list devices booted` reports no booted simulator. No native UX timing
  or actual push delivery has been verified. The user authorized the Cuttlefish simulator, with the S24U available if it is insufficient.

## Current boundary and sequence

1. Complete A regression checks and stable snapshot review.
2. Implement B on the agreed display-only provenance boundary.
3. Obtain test-device access and exercise the native gate C.
4. Reconcile the final revision's review, CI and merge evidence.

The reported half-second delay is a user observation, not a measured root cause.
Native timing, cold-launch pixels, scroll stability and offline behavior remain
required proof at C. Device control, credentials and paid resources are not implied
by phase approval. No proof has been silently deferred outside the approved scope.

## Review ledger

Design: reviewer agreed A/B/C, with canonical workspace authority, temporary demand
handoff, subscription-before-fetch and display-only snapshot provenance as conditions.
A1: 1 material / 2 total. R-A1 closed in A2 by separating registry readiness from the optional localhost startup probe. R-A2 is an instrumentation limit: current-commit is synchronization evidence, not pixel timing.

A2: 0 material / 0 new total; reviewer accepted the frozen A2 snapshot. The held-bootstrap regression fails against A1 and passes after the fix. The three runtime preparation cases passed in 34.54 s; app typecheck and targeted lint passed. The model/sync cases passed 62 tests in 5.19 s versus baseline 57 in 5.32 s.

## Progress

2026-11-06: user approved execution. One persistent native reviewer acknowledged
baseline and agreed the corrected design. A is in progress; B/C remain unopened.
