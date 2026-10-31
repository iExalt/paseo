# Dismiss resolved notifications

Goal: Paseo removes its own OS notifications once the thread that raised them no
longer needs the user. Before this work, turn-finished and question notifications
stayed in the notification center after the thread was read, and piled up with
several agents in flight.

## Decisions

| Decision       | Choice                                                                                                                                 | Why                                                                                                                                                     |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rule           | Finished: attention cleared. Question: no pending permission. Any: agent archived or missing, host removed                             | User decision 2026-10-31: questions stay until answered, not until read.                                                                                |
| Archive        | Always dismiss, including auto-archive and an optimistic archive that later fails                                                      | User chose option (a) on 2026-10-31; the client can't tell auto-archive apart without a protocol change.                                                |
| Arming         | Act on a resolved condition only after seeing it active, or after a directory refresh requested later                                  | The daemon sends the attention event before the agent update that explains it, so the store can still hold the previous state.                          |
| Grace          | A resolved condition (including an agent missing from the directory) must hold 1.5 s; a seen `archivedAt` and host removal act at once | An agent update queued before the attention change can arrive after a refresh that showed it.                                                           |
| Readiness      | Only hosts online with a whole-directory refresh on the current connection; cached state never dismisses                               | The directory loads from cache before the host connects, and only syncs while something demands it, so the tracker holds directory demand.              |
| One per thread | Browser `tag` + `renotify`; Electron `id` (+ `groupId` with the reason on macOS)                                                       | A newer notification replaces the thread's older one. macOS history returns only ids and group ids, so a restarted app reads the reason from `groupId`. |
| Scope          | Client-side only; no protocol change. Phone clears on next open; terminal notifications untouched                                      | A closed phone app can't run code without a silent push and a background task (deferred).                                                               |

## Chunks

| Chunk                   | Status      | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1 rule and browser     | verified    | `notification-dismissal/plan.test.ts` and `tracker.test.ts` (rule table, arming, grace, absence refresh, replacement); `os-notifications.test.ts` (tag, renotify, dismissal while permission is pending, superseded sends, user close). `e2e/browser/notification-dismissal.spec.ts` against a real daemon: a finished notification stays 3 s past the unread indicator and closes when the thread opens; a plan-approval notification stays after reading and closes when allowed; archive closes one without reading. 52–70 s on dev-station. Reviewer accepted at 0e21a0771. |
| A2 Electron             | implemented | `desktop/src/features/notifications.test.ts` (electron mocked: macOS replace without close and dismiss by `close()` of the live object, Linux/Windows close-before-show, per-platform group ids, history and reload re-adoption); renderer desktop-path tests in `os-notifications.test.ts`. Integration review complete at afbeb2d09. Live behaviour waits for the signed-build gate.                                                                                                                                                                                          |
| B mobile                | implemented | `notification-dismissal/presented.test.ts` (per-thread grouping of stacked pushes, newest-wins reason, ties wait for both conditions, dismissal only up to the tracked delivery, forget on user clear, one sync at a time, iOS seconds). F-Droid stubs typed against expo-notifications. Integration review complete at afbeb2d09. Device proof waits for the Android gate.                                                                                                                                                                                                     |
| C docs, integration, PR | active      | Dismissal section in `docs/upstream/notifications.md`; reviewer accepted the integration of `cdb9e43e5..afbeb2d09`. Gates below.                                                                                                                                                                                                                                                                                                                                                                                                                                                |

The browser journey can't show the arming rule on its own: on the station the
attention update always arrived within the grace period, so forcing arming on
still passed. Arming is proven at the unit layer.

## Gates

| Gate               | Needs                                    | Checks                                                                                                                                                                         |
| ------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Android phone      | The user's phone, debug APK, test daemon | Real pushes: read on the laptop then open the phone app; answer a question; archive; a push arriving after a dismissal stays.                                                  |
| macOS signed build | A release on the user's Mac              | Removal from Notification Center; leftovers resolved across a relaunch go; notify, read, notify the same thread again and click opens the agent; click after two replacements. |
| iOS                | None available                           | Unverified.                                                                                                                                                                    |

## Known gaps

- Electron, every platform: a notification the user clears stays tracked, holding its host's directory, until its thread resolves; main does not forward the close.
- Electron on macOS: a replaced notification object stays held for the session, because macOS reports no event when it is replaced.
- The F-Droid stub lacks `getNotificationChannelAsync`, which the notification settings call inside a `try`; this predates the feature.
