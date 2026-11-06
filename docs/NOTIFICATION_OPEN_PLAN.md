# Immediate notification opens

Approved scope: the user said “SGTM, kick off /iExalt:keep-me-in-the-loop” on
2026-11-06, approving the preceding mobile notification plan. Autonomy: medium.
Implementation and reviewed commits, pushes and a merged PR to `dev` are authorized;
a release and control of the user's own devices require separate approval.

## Outcome and constraints

A notification tap shows its available message content on the destination's first
content frame while the authoritative conversation catches up. Warm opens with local
content target p95 below 100 ms from the app's notification callback. Cold app startup
and physical tap-to-content time are measured separately. Long replies can exceed the
push byte limit; their snapshot must identify truncation and fetch the remainder.

Never trust the notification's workspace hint over the agent's current workspace.
Do not fabricate agent records, advance timeline coverage from push content, permit
actions from a push snapshot, or miss events between subscription and history fetch.
Keep current notification policy and dismissal behavior. No background task dependency,
new service, production daemon restart, release or paid resource.

## Chunks and acceptance

- [x] **A: Prepare before navigation.** Start cached route/timeline preparation and
      temporary destination demand at tap delivery, before navigation readiness. Let the
      existing timeline owner subscribe before fetching, transfer demand to the visible
      chat without interruption, cancel superseded demand, and bound readiness waits.
      Preserve stale-hint routing and native replay/acknowledgement. Add content-free
      trace stages. Checks: held readiness and subscription tests, cancellation, visible
      adoption and replay. Native timing remains at C.
- [x] **B: Paint notification content while syncing.** Add an optional versioned,
      display-only assistant snapshot with identity sampled from the same projected rows
      as its text. Bound the actual serialized Expo payload by UTF-8 bytes. Show provisional
      content in cold route resolution and chat loading; reconcile canonical coverage
      without duplicate messages or rollback. Permission previews remain read-only.
      Checks: stale and malformed snapshots, epoch changes, Unicode/escaping/size,
      delayed cache loads, canonical replacement, and unchanged resume cursor.
- [ ] **C: Prove and publish.** Use actual native notification delivery/tap paths for
      warm and cold opens, different chats/workspaces, offline/slow hosts, long content,
      and successive taps. Record platform/build and frame timing. Run focused checks,
      typecheck and lint locally; full routine suite runs once in CI. Reviewer accepts
      the final revision before publication. Merge when required gates pass.

One persistent reviewer shapes and reviews the changes. Material findings make the
result wrong, unsafe, lossy or short of the agreed criteria. Track material/total
findings per round in [status](NOTIFICATION_OPEN_STATUS.md); optional findings do not
extend scope. No more than two increments await acceptance.

## Estimate and check budget

Original implementation estimate: 1.5–3 hours wall-clock, two review rounds, bounded
by native builds and device verification, assuming push-enabled test devices exist.
Device-access waiting is separate. This estimate predates increment sizing; record
actual rounds and explain any difference at completion.

Baseline `2c27bd2ef741967693ad49928b153cc07f0ed3e4`, macOS arm64, Node 26.11.1,
warm installed dependencies, two Vitest workers: notification-open/model and
viewed-timeline-sync tests pass 57 tests in 5.32 s. Use that same focused command for
the A comparison. Root typecheck/lint are required; establish current timings on the
first check. Routine CI has an advisory critical-path budget below 300 s
([workflow guide](GITHUB_WORKFLOWS_STATUS.md)); compare unchanged lane conditions,
without resetting baselines or weakening checks. Do not run the full suite locally.

## Decisions made during implementation

- Keep ignoring stale workspace hints. The earlier planning answer misclassified
  their deliberate removal as a bug; `docs/upstream/notifications.md` and the agent
  route establish canonical agent-to-workspace resolution as the intended behavior.
- Push snapshots are presentation data, never synchronization authority. A projected
  anchor and its text must come from one snapshot, not independently sampled stores.
- Background prefetch is optional and outside this change's critical path.

## Verification checkpoint, 2026-11-06

B is reviewer-accepted against the C1 source manifest and final Android test APK
`76eba078fd9589e168cf2fcc542a2567f642e465990de743af86d610845effcc`.
Native verification found and closed a detached-chat retap gap: each valid tap now
requests latest content once, including legacy payloads without previews; later
user scrolling remains authoritative.

C remains open. Twenty repeated native emulator taps completed, but the log ring
retained only fourteen complete callback-to-JS-rAF traces (p50 178 ms, p95/max
344 ms). This is an incomplete emulated diagnostic, not proof of the physical
under-100 ms target. iOS native verification, physical timing, CI, integration
acceptance and merge are still required. The requested iOS pre-release deferral
has not been approved.
