# Fork glossary

Terms for modules the fork owns. Product and domain terms (project, workspace,
host, agent session and the rest) live in the upstream
[glossary](upstream/glossary.md), which stays authoritative for those and is
not edited here. Add a term when its module lands, in the same change.

## CI and release

**Routine lane**:
One parallel job of fork Routine CI (`quality`, `workspaces`, `app-1..2`,
`server-1..3`, `integration`). Every planned step declares its lane group when
it is created; the group's shard count and single prerequisite live in one
table, `laneGroups` in `.github/scripts/ci-routine.mjs`.
_Avoid_: shard (one numbered member of a sharded lane group), job

**Dependency fingerprint**:
The digests of what decides an installed dependency tree: the lockfile without
the release's own version bump, plus, for installed modules, the install
patches and the runner ABI. Routine CI's dependency cache key and the release's
Android cache pin both use it (`.github/scripts/dependency-fingerprint.mjs`).
Nix filters the lockfile separately for its own fetch.
_Avoid_: cache inputs, lock hash

**Release asset catalog**:
The one list of every asset a fork release carries, by role, and the exact
upload set the publish job checks, including which delta files belong
(`.github/scripts/release-assets.mjs`). Desktop delta names come from the
shipped updater; the app's own readers keep their copies.
_Avoid_: asset list, expected assets

## Server

**Notification policy**:
What decides whether one attention event pushes, notifies one client in app,
or stays silent: the workspace mute, the daemon's reply rules, and upstream's
presence plan, read in that order at decision time. It also owns how a mute or
a rule change is saved (`packages/server/src/server/notification-policy.ts`).
Push titles carry their reason as a prefix that the app reads back with
`parseAgentAttentionTitle` in `@getpaseo/protocol`.
_Avoid_: notification filter, suppression

## App

**Notification dismissal**:
Removes an agent notification once nothing is left to see in it: its thread was
read, answered, archived or removed, or, for an Android push that names no
thread, every host is caught up. One driver runs both plans against the app's
stores (`packages/app/src/notification-dismissal/dismissal.ts`); the native
shade, desktop bridge and browser notifications are its callers.
_Avoid_: notification clearing, auto-dismiss

**Fork updater controller**:
The one state machine behind the fork Android updater: what the About row
says and offers, whether the sidebar icon shows, and what a press or the hourly
check does next. It runs over a port to the native updater
(`packages/app/src/android/fork-updates/controller.ts`); `updater.ts` wires the
app's single instance.
_Avoid_: update store, updater state
