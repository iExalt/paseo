
## Server

**Notification policy**:
What decides whether one attention event pushes, notifies one client in app,
or stays silent: the workspace mute, the daemon's reply rules, and upstream's
presence plan, read in that order at decision time. It also owns how a mute or
a rule change is saved (`packages/server/src/server/notification-policy.ts`).
Push titles carry their reason as a prefix that the app reads back with
`parseAgentAttentionTitle` in `@getpaseo/protocol`.
_Avoid_: notification filter, suppression

**Fork updater controller**:
The one state machine behind the fork Android updater: what the About row
says and offers, whether the sidebar icon shows, and what a press or the hourly
check does next. It runs over a port to the native updater
(`packages/app/src/android/fork-updates/controller.ts`); `updater.ts` wires the
app's single instance.
_Avoid_: update store, updater state
