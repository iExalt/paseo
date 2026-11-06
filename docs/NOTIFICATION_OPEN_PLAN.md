# Immediate notification opens

Approved on 2026-11-06 through `iExalt:keep-me-in-the-loop`. Implementation,
reviewed commits, pushes and a merged PR to `dev` are authorized. No release is
authorized.

## Outcome and boundaries

A notification tap shows its available message on the destination's first
readable chat frame while the authoritative conversation synchronizes.

The original target was p95 below 100 ms from callback to visible content. The
S24U recording showed Android's return transition covering the chat until
428–465 ms after the callback, with the correct message already present in the
first readable frame in all 16 opens. Previews committed in 16–38 ms. The user
explicitly approved the first-updated-chat-frame criterion in place of the
original callback-to-visible target, then authorized CI and merge. The original
100 ms target was not met and is not claimed.

The user dropped the iOS verification gate. iOS remains unverified; there is no
separate iOS pre-release requirement for this change.

Approval provenance from this session on 2026-11-06:

- Performance gate and publication: “Use the first updated chat frame; proceed to CI and merge” — replaces the callback-to-visible threshold for this change and authorizes CI/merge, not a release.
- iOS scope: “Actually I don't have an iOS device handy to test notifications, we can drop that gate.” — removes the iOS verification gate for this change, without an iOS verification claim.

Never trust a notification workspace hint over current agent ownership. Push
content cannot advance canonical timeline coverage, fabricate agent records,
enable permission or file actions, or create fork boundaries. Subscribe before
catch-up fetches and preserve notification acknowledgement and dismissal policy.
No background task dependency, new service, production daemon restart or release.

## Checklist

- [x] **A: prepare before navigation.** Restore destination cache and acquire
      temporary observation demand before navigation readiness. Transfer demand
      to the visible chat, cancel superseded opens, and bound waits. Preserve
      current workspace resolution, replay and acknowledgement behavior.
- [x] **B: paint notification content while synchronizing.** Versioned,
      byte-bounded display-only snapshots come from the same projected rows as
      their anchors. Cold/loading screens retain the receipt; canonical history
      replaces it without duplicate messages or cursor promotion. Permission
      previews stay read-only. Each valid tap requests latest content once;
      subsequent reader scrolling takes precedence.
- [x] **C: native and local verification.** Android emulator and S24U checks
      support the approved first-readable-frame criterion. Focused regression
      tests, root/app typechecks, scoped lint and review passed. Device state and
      test processes were restored or stopped.
- [ ] **Publication.** Run the full routine suite in CI, obtain final integration
      acceptance, then merge. No full suite runs locally.

## Evidence and review

[Status](NOTIFICATION_OPEN_STATUS.md) records the checks, review findings,
limitations and publication state. Native test APK SHA-256:
`76eba078fd9589e168cf2fcc542a2567f642e465990de743af86d610845effcc`.
The tested notification changes are equivalent to the rebased implementation;
unrelated image and message-disclosure changes entered the branch afterward.

One reviewer at a time reviews the work. Material findings make behavior wrong,
unsafe, lossy or short of an approved criterion. Existing reviewed source was
preserved across reviewer recovery after the interrupted turn.

## Estimate and check budget

Original estimate: 1.5–3 hours wall-clock and two review rounds, bounded by native
builds and verification, assuming push-enabled test devices exist. Device-access
waiting is separate. Record actual time, rounds and the calibration lesson at
completion.

Baseline `2c27bd2`, macOS arm64, Node 26.11.1, warm dependencies, two Vitest workers:
57 model/sync tests in 5.32 s; after A, 62 in 5.19 s. Routine CI's advisory
critical-path budget is below 300 s; compare unchanged lane conditions without
resetting the baseline or weakening checks.

## Decisions made

- Continue ignoring stale workspace hints; their removal was deliberate.
- Keep notification snapshots in presentation state, never synchronization state.
- Use the first readable chat frame as the performance gate, explicitly approved
  by the user after native measurement. Preserve timing limits in the report.
- Drop the iOS gate at the user's request and keep its verification status explicit.
- Keep this checkout as requested. Preserve unrelated `.qa/` and other sessions'
  changes; publish only task paths. No worktree was created.
