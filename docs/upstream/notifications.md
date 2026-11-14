# Notifications

Use `notification-open` for OS notification taps. It owns delivery, parsing,
process-local deduplication, startup readiness, and native acknowledgement.
Keep agent and workspace navigation in their existing navigation modules.
Import the pure API from `@/notification-open` and the app-shell component from
`@/notification-open/react`; senders must not load the React routing runtime.

Agent payloads name a host and agent. Ignore their workspace hint when opening:
the agent can move after a notification is sent. Use `navigateToAgent`, which
uses the current store record or the agent route to resolve the workspace from
the host. Terminal payloads name their workspace and use `navigateToWorkspace`.

See [agent targets and deferred opens](expo-router.md#agent-targets) for route
ownership and workspace recovery. Notification generation, presence, and push
eligibility remain daemon concerns.

## Native delivery

Keep the router instance at module scope. Android's `singleTask` Activity can
finish on Back while its JS context remains alive. A React ref is lost when the
root remounts; process-local handled IDs must survive that remount.

Clear `lastNotificationResponse` after dispatch. Reading a launch response does
not acknowledge it. Without clearing it, a later Activity launch can reopen the
old agent.

With expo-notifications 57, Android also replays its pending response list to
new native listeners. Clearing the last response does not drain that list.
Deduplication covers listener registration within one JS context. A development
JS reload creates another context and can replay a cold-launch response; do not
add persisted handled IDs to compensate. Recheck this limitation when upgrading
expo-notifications.

iOS drains pending responses when its delegate first handles them. Push data
read by Expo arrives under `userInfo.body`; simulator payloads must match:

```json
{
  "aps": { "alert": { "title": "Agent finished", "body": "Open the agent" }, "sound": "default" },
  "body": {
    "serverId": "host",
    "workspaceId": "workspace",
    "agentId": "agent",
    "reason": "finished"
  }
}
```

An Android FCM launch intent needs `google.message_id` and a JSON `body` extra.
An arbitrary Activity launch with data extras does not exercise Expo's FCM path.

While the app is open, pushes other than the test push are not presented at all
(`foregroundNotificationBehavior` in `push-notifications/test-push.ts`): the app already shows
what they report.

## Dismissal

Each client removes its own notifications once their thread no longer needs the user
(`notification-dismissal/`). A turn-finished notification goes when the thread's attention
clears. A question stays until no permission request is pending, even after the thread is read.
Any notification goes when its agent is archived or deleted or its host is removed. Archive
dismisses as soon as the app archives optimistically, so an archive that then fails has
already removed the notification.

The daemon sends `agent_attention_required` before the agent update that explains it. A
notification therefore arms only once this client has seen its condition active, or after an
agent-directory refresh requested after it arrived, and a resolved condition must hold for
1.5 s before the notification goes. Cached or offline state never dismisses anything; the
tracker holds directory demand for every host it has notifications for.

| Platform            | Tracked notifications                              | Limit                                                                                                                                                                         |
| ------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser             | Sent by this page; `tag` = thread key              | A reload loses them; they stay until the user clears them.                                                                                                                    |
| Electron, macOS     | Sent this launch, plus `Notification.getHistory()` | Needs a signed build. The reason rides in `groupId`. Replaced notifications stay held for the session, since macOS reports no event.                                          |
| Electron, Win/Linux | Sent this launch                                   | Notifications from an earlier launch can't be reached.                                                                                                                        |
| iOS, Android        | Whatever is in the notification shade              | Synced on start, foreground and push receipt. Capable Android registrations also process background resolution; other registrations reconcile on open. Android stacks pushes. |

### Android background lifecycle

A daemon advertising `features.androidNotificationLifecycle` accepts an optional
`androidLifecycleRegistrationId` with a push token. The Android app supplies it
only after registering the Expo TaskManager handler and native lifecycle owner.
Older apps, hosts and iOS keep existing delivery. Terminal and test pushes do not
use this lifecycle. F-Droid excludes the push lifecycle and TaskManager modules.

Managed Android attention uses data-only Expo messages with a nested
`data.paseoLifecycle` envelope. No top-level alert fields or native `data.title` /
`data.message` keys are sent. Expo delivers the task; the local native module
owns durable state and the final Android post/remove calls. Do not replace that
owner with `scheduleNotificationAsync`: on the pinned SDK its promise resolves
before asynchronous native presentation finishes, allowing a canceled alert to
post later. The module reuses Expo's builder and marshalled request for taps and
enumeration. Existing display-only `data.preview` anchors travel alongside the
lifecycle envelope, use the same byte-budget helper, and are restored to local
notification data for the normal tap handler. The owner then rechecks durable desired state after building and calls
Android notify/cancel under the shared process lock.

Each host/agent has two independent episode IDs. Finished/error attention keeps
one ID while unread; read clears that episode. A later unread episode gets a new
ID. Error still does not generate a background alert. Permission requests share
one question episode from the first pending request until the pending set is
empty. Reading a chat or resolving only one of several questions does not close
that episode. Unavailable provider state is unknown, never proof of resolution.
Archive/delete closes both lanes after the source mutation commits. Existing
read commands remain unconditional at daemon processing time; the cancellation
identifies only the episode actually cleared.

The daemon persists active identities and an outbox of resolutions. A partial
source/lifecycle commit blocks the next source transition until repaired; flush
also retries committed clears/deletes. Source reconstruction occurs on startup,
not from a stale list during live sync. Expo acceptance removes an outbox item;
it is not proof that a device received it. The total active/outbox record bound
holds new episode creation rather than evicting undelivered resolutions.

The native owner persists a tombstone before canceling, so a late or duplicate
alert cannot recreate a resolved episode or cancel a newer one. Alert expiry is
immutable and bounded to 24 hours; retries cannot extend it. Closed entries stay
through expiry plus five minutes of clock allowance. At local capacity, dropped
resolution identities block that host's alerts through their possible expiry.
Removing a host disables its registration before canceling its rows; re-pairing
uses another registration ID. No headless host-list loading state implies removal.

Foreground catch-up snapshots the device's observed episode IDs before requesting
the daemon's active IDs. It resolves only those observed IDs missing from the
reply, so a delayed reply cannot remove a newer arrival. Managed rows are excluded
from legacy presented-notification reconciliation; every managed removal goes
through the native owner.

Background execution and transport remain best effort. Android can delay normal
priority cancellation and suppress task execution; high-priority silent delivery
can be deprioritized. Force-stopped apps need reopening. Pending native work is
reconciled when the owner runs again, using deterministic notification IDs. A
crash between notify and recording its receipt can repeat an unresolved alert;
normal recovery does not recreate rows the user dismissed after a recorded post.
A committed tombstone always blocks a later managed post. Uninstall/data clearing
removes this local ordering history. Non-force-stopped process death requires its
own native proof; it is not implied by a disconnected-background test.

### Legacy Android reconciliation

Firebase posts legacy background alert messages itself. Validated unique Android
tags from the attribution fix identify the owning host, agent and reason even
when Expo's presented row has no data. A current owning-host refresh can remove
its resolved row without waiting for an unrelated offline host. Dismiss only the
observed identifier snapshot so a newer notification survives.

Unknown/untagged rows retain conservative fallback in
`notification-dismissal/caught-up.ts`. A question is held by a pending question
whose thread title matches, or whose agent is missing from the directory. Other
rows are held by matching unread threads or ones unread within ten minutes of
delivery. Archived agents and subagents do not hold them. Every saved host must
have a fresh online directory before ambiguous rows can clear; two same-title
threads can hold each other's rows. Test notifications are never reconciled away.

On every Electron platform, a notification the user clears stays tracked until its thread
resolves: main does not forward the close to the renderer.

Never call `close()` on a replaced Electron notification on macOS: macOS removes by identifier, so
it removes the newer notification. On macOS dismiss a live notification with `close()`, not
`Notification.remove()`, which leaves the native object registered under the id, where it can take
clicks meant for the thread's next notification.

## Startup and verification

Wait for the root navigator, host registry, remembered selection, and startup
redirects before handing off a tap. A compact agent route must demand the host's
directory itself; its sidebar can be closed for the entire cold launch.

Verify warm and cold taps, stale and missing workspace hints, two distinct taps,
and Android Back followed by launcher reopen or a different notification tap. Check the focused tab and every
workspace's saved layout, since a foreign pinned tab survives navigation.
Use the daemon's payload shape on both iOS and Android; a browser event alone
does not test native replay or acknowledgement.

Existing foreign pins belong to the reconciliation fix in
[#6900](https://github.com/getpaseo/paseo/issues/6900). Desktop main-process window
selection is tracked separately in
[#6875](https://github.com/getpaseo/paseo/issues/6875).
