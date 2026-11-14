
## Server

**Notification policy**:
What decides whether one attention event pushes, notifies one client in app,
or stays silent: the workspace mute, the daemon's reply rules, and upstream's
presence plan, read in that order at decision time. It also owns how a mute or
a rule change is saved (`packages/server/src/server/notification-policy.ts`).
Push titles carry their reason as a prefix that the app reads back with
`parseAgentAttentionTitle` in `@getpaseo/protocol`.
_Avoid_: notification filter, suppression
