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

| Platform            | Tracked notifications                              | Limit                                                                                                                                        |
| ------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser             | Sent by this page; `tag` = thread key              | A reload loses them; they stay until the user clears them.                                                                                   |
| Electron, macOS     | Sent this launch, plus `Notification.getHistory()` | Needs a signed build. The reason rides in `groupId`. Replaced notifications stay held for the session, since macOS reports no event.         |
| Electron, Win/Linux | Sent this launch                                   | Notifications from an earlier launch can't be reached.                                                                                       |
| iOS, Android        | Whatever is in the notification shade              | Synced on start, on foreground and when a push arrives. Pushes resolved while the app was closed go on the next open. Android stacks pushes. |

When Paseo is killed or in the background on Android, the Firebase SDK posts pushes itself, with
only a title and body: no data says which thread they belong to. Those go
only once every host is caught up (`notification-dismissal/caught-up.ts`). A `❓️` question goes
when no thread on any host has a pending question; any other push goes when every thread on
every host is read. Archived agents and subagents don't count: subagents never push. A thread
that needed attention without pushing, from a workspace with notifications off or a reply rule,
still holds them. Every saved host must be online with a fresh directory, so one offline host
keeps them all, and only pushes delivered before every host's latest refresh are considered.
While such pushes wait, the app holds every host's directory and refreshes them all on
foreground. The push test notification is never dismissed.

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
