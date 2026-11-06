# Immediate notification opens status

Last updated: 2026-11-06 16:25 UTC

## Current outcome

Implementation is active on `feat/instant-notification-chat-implementation`.
A is accepted and pushed as `2d64b5660`. B is reviewer-accepted against the C1 task manifest after rendered verification
and closure of the native retap gap. C remains active; no release or merge has occurred.

The [approved plan](NOTIFICATION_OPEN_PLAN.md) remains the acceptance boundary.
Android Cuttlefish is authorized, and the user has approved up to two ten-minute
USB S24U windows ending at 16:30 UTC (11:30 AM Toronto). iOS and physical-device
p95 timing remain unverified.

## Gates

| Gate                                      | State             | Remaining proof                                                     |
| ----------------------------------------- | ----------------- | ------------------------------------------------------------------- |
| A: prepare destination before navigation  | Reviewer accepted | Complete                                                            |
| B: show display-only notification content | Reviewer accepted | Complete; C owns final timing/platform/CI gates                     |
| C: verify and publish                     | Active            | Physical timing, platform boundary, CI, final integration and merge |

## Evidence

- Baseline `2c27bd2`: model/sync 57 tests, 5.32 s; A: 62 tests, 5.19 s.
  Held navigation and held unrelated localhost bootstrap fail before their fixes.
  Runtime preparation cases: three passed in 34.54 s. Root/app typecheck and
  targeted lint passed. The A commit hook's typecheck took 76.36 s.
- B: protocol 15, app model/preview 23, push/websocket 15, producer one,
  presentation 36 and fallback one focused tests passed. Root/app typecheck
  and targeted lint passed. Fallback removal under hidden canonical coverage
  fails against B1 and passes after B2. Preview reconciliation mutation fails.
- Shared browser path: actual target history response held; preview visible,
  then exactly one canonical message after release. Callback-to-following-rAF:
  phone 26 ms, tablet 35 ms, desktop 21 ms. These are browser diagnostics,
  not native pixels or a p95 distribution. Logs/screenshots are retained locally
  under `.dev/notification-open/` (`web-tablet.log`, `web-desktop.log`,
  `web-preview-{held,canonical}*.png`).
- Android arm64 release test APK: SHA-256
  `76eba078fd9589e168cf2fcc542a2567f642e465990de743af86d610845effcc`.
  Initial build SHA was `0e29bb49573f5ac918f22b6c90640c240975539859ed1ca72a77187b6dfae267`;
  the final incremental rebuild took 9m30s.
  Cold Gradle build took 37m23s. Cuttlefish Android 17 has no Google Play services;
  a local helper posts an actual Android notification carrying Expo-shaped data.
  Native taps enter the real Expo lifecycle, without proving cloud delivery.
- Cuttlefish held/offline open: notification text remains visible while the host
  cannot connect, then becomes canonical on release. Native trace reported
  preview commit 106 ms / following-rAF 121 ms (one emulated sample).
  Killed-process cold tap also shows the receipt with a deliberately stale
  workspace hint. Evidence: `native-b2.log`, `native-held.png`,
  `native-cold-held.txt`; all local evidence, not tracked release artifacts.
- Native testing found a material same-chat retap bug: a detached viewport kept
  older paragraphs visible while the notification's new message stayed below it.
  `native-detached-tap.{txt,png}` records the failing B2 build. C1 adds one explicit
  notification-entry anchor per tap, retaining it across other chats' taps and
  respecting later user scrolling. The rebuilt APK closes the gap: `native-c-detached-tap.txt` and
  `native-c-preview.png` show the new receipt in view. User scroll, replay of the
  same tap, and canonical catch-up retain the measured older-row anchor within
  one native pixel (1532 -> 1533).
- C1: preview/controller/route focused tests passed (39); fallback passes under
  the app's test config (one, 7.80 s). A wrong-root fallback invocation failed
  because its browser setup lacked matchMedia; this was a harness configuration
  error. Targeted lint passed. Final root typecheck and all 29 task-file lint checks passed.
- Corrected legacy proof: `native-c-legacy-detached-proven.txt` contains the jump-to-bottom
  button and no latest message; `native-c-legacy-retap-proven.txt` shows that
  message after a new tap, without a preview. The earlier identical before/after
  pair was invalid and is withdrawn. Cold unknown-agent Unicode reply: payload
  exactly 3000 UTF-8 bytes, truncated=true, receipt shown offline; canonical
  LONG END appears once in the correct second workspace after reconnect.
- Twenty repeated same-chat emulator notification taps completed. Only fourteen
  complete traces survived the Android log ring: callback-to-following-JS-rAF
  p50=178 ms, p95/max=344 ms. This incomplete emulated diagnostic does not meet or
  establish the physical under-100 ms criterion.
- Cuttlefish restored and verified at 16:22 UTC: original app, display and settings;
  original reverse/daemon 6790 preserved; debug/helper packages, test reverses,
  tunnel and exclusive lock removed. Own Metro process also stopped.
- S24U test APK installed under its authorized debug package; no input or settings
  changes made. The phone auto-locked while the final build completed and has
  remained locked after the unlock request. Physical timing is still unverified.

## Review ledger

Material means wrong, unsafe, lossy or below the agreed outcome.

| Round      | Material / total | Result                                                                                                                   |
| ---------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| A1         | 1 / 2            | Unrelated localhost probe blocked preparation; fixed in A2. Current-commit is synchronization evidence, not pixel proof. |
| A2         | 0 / 0 new        | A accepted.                                                                                                              |
| B1         | 2 / 2            | Cold fallback could vanish before chat paints; plugins could hide provenance. Both fixed.                                |
| B2         | 0 / 0 new        | Source accepted; rendered proof subsequently completed in C.                                                             |
| C1         | 0 / 0            | Scroll intent accepted and native regression closed on final APK.                                                        |
| C evidence | 1 / 1            | Invalid legacy before-state withdrawn; corrected proof verified.                                                         |

The reviewer accepted the B checkpoint against the exact C1 task manifest after
native closure; this acceptance excludes C's timing, iOS, CI and merge gates.

## Decisions and workspace protection

- Ignore notification workspace hints; current agent ownership is authoritative.
- Push content never advances canonical cursors or grants permission/file/fork actions.
- A valid tap records entry intent even when an older host supplies no preview.
- User requested keeping this checkout after another session changed its branch
  during the A commit hook. Preserve the resulting accepted A commit and unrelated
  `.qa/`, attachment/zoom and wishlist edits. Stage only task allowlisted paths.
- Main daemon and production app state are outside the test setup. Test fixtures
  use a separate daemon on 6823, own temporary tunnel and a separate debug package.

## Next

Run physical timing after device unlock within the authorized window, or obtain
new access/explicit gate disposition. Obtain the pending iOS verification decision.
Then run CI once, obtain final integration acceptance, and merge when C passes.
The scratch daemon remains available for the phone window; no production daemon
restart or release is authorized.
