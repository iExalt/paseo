# Immediate notification opens status

Updated 2026-11-06. Implementation, approved Android verification and publication
are complete. [PR #371](https://github.com/iExalt/paseo/pull/371) merged at
17:43:31 UTC as `469753f5f6178765a68f2e052cdcaca96c4a84a1`. No release is authorized.

## Gates

| Gate                                     | State                       | Evidence                                                                                                                                                               |
| ---------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: prepare before navigation             | Reviewer accepted           | Held-readiness, bootstrap, demand adoption, cancellation and replay regressions                                                                                        |
| B: display-only notification content     | Reviewer accepted           | Payload bounds, reconciliation/cursors, read-only rendering and native retap closure                                                                                   |
| C: approved Android first-frame behavior | Verified; reviewer accepted | 16/16 S24U first readable frames already contain the new message; Cuttlefish functional matrix                                                                         |
| CI and merge                             | Passed; merged              | [Routine CI](https://github.com/iExalt/paseo/actions/runs/42263310009) passed at exact PR head `b8aa6090d`; [PR #371](https://github.com/iExalt/paseo/pull/371) merged |

The [plan](NOTIFICATION_OPEN_PLAN.md) contains the current acceptance boundary.
The user approved replacing the original under-100 ms callback-to-visible target
with the first-updated-chat-frame criterion, and dropped the iOS gate entirely.
The original time target is not met; iOS is unverified.

## Native evidence

APK SHA-256: `76eba078fd9589e168cf2fcc542a2567f642e465990de743af86d610845effcc`.
The initial cold Android build took 37m23s; the incremental rebuild took 9m30s.
The notification implementation is equivalent to the rebased source checkpoint;
unrelated upstream image/message-disclosure changes were integrated afterward.

Cuttlefish Android 17 checks show the receipt while the host is held or offline,
then a single canonical message after release. Checks include a killed-process
cold open, a deliberately stale workspace hint, an unknown agent, a Unicode
snapshot bounded to exactly 3000 UTF-8 bytes with truncation indicated, the
correct second workspace, and read-only permission content followed by the real
question controls.

Native testing exposed a detached-chat retap gap. The fix gives each valid tap
one latest-content intent, including legacy payloads without a preview. The
rebuilt APK reveals the new receipt from an older reading position. After the
reader scrolls away, replay of the same tap preserves the anchor; canonical
catch-up changes its measured position by one native pixel (1532 to 1533).
The corrected legacy test positively establishes an offscreen latest message
and visible jump-to-bottom button before the tap, then the latest canonical
message in view afterward. An earlier identical before/after pair is withdrawn.

On the S24U (Android 16), 16 distinct notification opens completed before the
control deadline; 20 were planned. The host's traffic was held while actual
Android notifications carried production-shaped receipt data. Video frame
indices were mapped to Android's embedded elapsed-clock timestamps and the
recorded callback clock. OCR calibration used positive app and negative shade
frames. All 801 recorded frames through callback +400 ms lacked readable fixture
chat content; the boundary-frame check then found the correct new message on the
first readable app frame in all 16 cases.

| S24U measurement                                              |   Median | p95 / maximum |
| ------------------------------------------------------------- | -------: | ------------: |
| React preview commit after callback                           |  18.5 ms |         38 ms |
| Following JavaScript animation-frame callback                 | 121.5 ms |        177 ms |
| First readable app frame, including Android return transition | 440.9 ms |      464.5 ms |

These are separate measurements. They do not prove sub-100 ms visible pixels.
The native helper exercises the real Android/Expo tap lifecycle, without proving
cloud transport. The first cloud test was received but suppressed by the app's
foreground policy; it was not a transport failure. The debug installation also
auto-restored an older host profile with background relay traffic, so this is
not an isolated performance benchmark. The final physical canonical read crossed
automatic restoration and was withdrawn; canonical replacement is supported by
Cuttlefish and focused tests instead.

## Checks

- Baseline model/sync: 57 tests in 5.32 s. A: 62 in 5.19 s. Held navigation and
  unrelated-localhost-bootstrap regressions fail before their fixes.
- Runtime preparation: three focused cases passed in 34.54 s.
- B: protocol 15, app model/preview 23, push/websocket 15, producer one,
  presentation 36 and fallback one focused tests passed. Fallback and preview
  mutation probes fail for the intended reasons.
- C: preview/controller/route 39 tests passed; fallback one passed under the app
  test configuration in 7.80 s. A wrong-root fallback invocation lacked
  `matchMedia`; that was a test-configuration failure.
- Root/app typechecks and all 29 task-source lint checks passed. B's commit hook
  passed format/lint/typecheck in 30.88 s. A's earlier typecheck hook took 76.36 s.
- Shared browser held-history checks show the receipt and then exactly one
  canonical message at phone, tablet and desktop sizes. Following-JS-frame
  diagnostics were 26, 35 and 21 ms respectively; these are not native pixels.
- Twenty same-chat emulator taps completed, but its log ring retained only 14
  complete timing traces. The p95 following-JS-frame diagnostic was 344 ms;
  this incomplete emulator distribution is not physical timing proof.
- Full routine CI passed all eight lanes and the required aggregate at exact
  PR head `b8aa6090d613203730d85d7e821659e63825cb56`. Critical path: 174 s,
  compared with 191 s for the comparable full-dev baseline (run 42259038265),
  within the unchanged 300 s budget. New notification regressions ran in the
  app lanes. The full routine suite did not run locally.

## Review ledger

| Round           | Material / total | Disposition                                                                                                  |
| --------------- | ---------------- | ------------------------------------------------------------------------------------------------------------ |
| A1              | 1 / 2            | Separate registry readiness from the optional localhost probe; distinguish synchronization logs from pixels. |
| A2              | 0 / 0 new        | A accepted.                                                                                                  |
| B1              | 2 / 2            | Keep cold fallback until chat renders; prevent plugins hiding snapshot provenance. Both fixed.               |
| B2              | 0 / 0 new        | B source accepted.                                                                                           |
| C1              | 0 / 0            | Explicit per-tap anchor accepted; native retap regression closed.                                            |
| Native evidence | 1 / 1            | Withdraw invalid legacy before-state; corrected proof independently accepted.                                |
| Final recovery  | 0 / 0            | Native gate independently recalculated, safe crops checked, and exact-head CI/PR accepted before merge.      |

## Evidence retention and cleanup

Exact native first-frame proof and regression artifacts are retained locally in
one `.dev/notification-open/evidence.tar.zstd` archive. It contains fixture-only
frame crops, timing/index/OCR results, filtered notification traces, focused-check
logs and selected historical review evidence. It excludes raw physical video,
uncropped SystemUI frames, credentials and push tokens. Extract with Python's
`tarfile` (`r:zst`) or a zstd-capable `tar`. This local archive is retained for
verification/reproduction, not published as a repository artifact.

Cuttlefish was restored at 16:22 UTC: original app, display, settings and 6790
connection preserved; debug/helper packages, test reverses, tunnel and lock
removed. The S24U was restored at 16:39:56 UTC: original Settings screen and
recorded timeout/stay-awake settings restored, both test packages removed and
reverse mappings cleared. Its recording was saved locally and the user was told
they could unplug. Own Metro, tunnel, proxy and scratch daemon were stopped.
No production daemon restart or release occurred.
