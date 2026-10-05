# Customizable agent notifications

Historical proposal: superseded by the
[workspace notifications plan](CONFIGURABLE_NOTIFICATIONS.md) on 2026-10-04.
The user chose workspace-only settings and deferred deployment and skill changes
to a separate campaign. Retain this document for the earlier rationale and build
receipts; its per-agent implementation and cutover steps are not active work.

Status: proposed plan. No feature, fork, daemon switch, or skill edit has been
implemented. The user selected muting all user-facing notifications while
preserving existing attention state, and current `main` as the patch baseline.

## Outcome and boundaries

Let selected agents run as ordinary top-level threads without sending user-facing
notifications. Silence `Worker: …` threads in an overseer run while keeping the
overseer and `Question: …` threads eligible to notify. Titles describe roles;
they must not automatically control policy.

The first useful demonstration is a muted top-level worker on an isolated fork
daemon: it finishes or requests permission, remains visible, and produces no
banner or push. An unmuted control still notifies under existing delivery rules.
The overseer still receives its internal worker events.

Priorities are preserving running agents, separating notification policy from
parentage, keeping a small maintainable patch, and proving operation before
changing the overseer skill. This task authorizes planning and documentation only.
Implementation, fork creation, publication, daemon changes, and skill edits are
future work. This change will remain fork-only; do not open an upstream issue or PR.
Never restart the production daemon without permission.

## Decisions

| Choice             | Selected or recommended route                                                                       | Alternative and consequence                                                                                      | State            |
| ------------------ | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------- |
| Notification scope | `paseo.notifications: "off"` suppresses completion, error, and permission/question banners and push | Permission exceptions and push-only suppression were not selected                                                | Selected by user |
| Attention state    | Preserve existing completion/error attention and pending-permission behavior                        | Clearing attention hides useful state and expands scope                                                          | Selected by user |
| Fork baseline      | Current `main` plus the notification patch                                                          | Includes 121 commits beyond installed `v0.10.2`; requires broader compatibility testing than a release-tag patch | Selected by user |
| First rollout      | Separate home and endpoint, then approved production cutover                                        | Immediate replacement puts active turns at risk                                                                  | Proposed         |
| Upstream           | Keep the change in the personal fork; no upstream issue or PR                                       | Upstream submission is out of scope                                                                              | Selected by user |

Muted workers rely on the overseer's pending-permission inspection for escalation.
The overseer and its unmuted `Question: …` threads retain notification eligibility.

Pin the exact `main` commit when execution starts and record any difference from
the inspected `4869214bc`. Verify the installed 0.10.2 clients against that build;
protocol compatibility alone does not prove every existing workflow still works.
Include agent resume, permissions, workspace placement, relay/pairing, and label
persistence in the isolated checks before production cutover.

## Evidence and remaining uncertainty

The checkout was clean on `main` at `4869214bc`, with `origin` pointing to
`https://github.com/getpaseo/paseo.git`. Local Git reports 121 commits after
`v0.10.2`. Installed 0.10.2, no personal fork, and live overseer runs are facts from
the handoff; this planning pass did not independently inspect installation,
GitHub fork existence, or live agent state.

Source inspection established:

- `packages/server/src/server/agent/agent-manager.ts` owns the shared
  `broadcastAgentAttention` callback and its delegated-agent guard.
  `checkAndSetAttention` sets completion/error attention before calling it.
- Permission requests take a separate pending-permission path and do not force
  `requiresAttention` to true. The manager test named “permission request notifies
  once without forcing unread attention state” captures this distinction.
- `packages/server/src/server/agent-attention-policy.ts` owns presence/focus
  routing. Errors are never push-eligible. Keep this behavior for unmuted agents.
- `packages/protocol/src/agent-labels.ts` owns parentage helpers. Generic label
  updates already persist and emit agent state.
- `packages/server/src/server/agent/tools/paseo-tools.ts` accepts labels on
  creation and update, including at `v0.10.2`. Mute can be set before work begins.
- `packages/app/src/desktop/daemon/daemon-management-toggle.ts`, also inspected
  at `v0.10.2`, stops the running desktop-owned daemon when management is disabled.
  That toggle belongs in cutover, not preliminary setup.
- `packages/cli/src/commands/daemon/local-daemon.ts` resolves the server runner
  from its own workspace package. The built checkout CLI is a candidate launcher;
  source inspection does not prove that deployment works.

See [development](upstream/development.md), [protocol compatibility](upstream/protocol-compatibility.md),
and [agent lifecycle](upstream/agent-lifecycle.md) for the owning conventions.

The main uncertainty is whether the installed desktop can use the isolated fork
daemon while its existing daemon continues to manage live runs. No runtime probe
has run. Push/relay delivery and production restart recovery also remain unproven.

## Proposed contract

For the selected all-delivery policy, recognize only the exact string `"off"`. Missing,
empty, or other values retain current behavior. `"on"` explicitly re-enables
eligibility without overriding delegated/internal suppression or presence rules.

Add a constant and helper in `agent-labels.ts`, then consult it beside
`isDelegatedAgent` in the manager's attention callback. No wire schema, RPC,
client settings, or routing change is expected.

The label affects subsequent notification decisions. It does not retract emitted
notifications. Unmuting does not replay events or clear attention; new events
follow existing attention-reset rules. Updates persist and apply without restarting
the agent. Keep streams, pending permissions, attention indicators, workspace
placement, lifecycle, and parent-directed `notifyOnFinish` behavior intact.
The label neither establishes parentage nor enables archive cascade.

Older daemons accept generic labels but ignore this policy. Readback alone is not
proof of support. Verify the running fork and a behavioral control before enabling
the skill. Reconsider explicit capability advertisement if this becomes a general
client feature or spans mixed daemon versions.

## Next item: external-daemon probe

Proposed allowance: 45 minutes for setup, build, connection, and analysis after
execution is authorized. Reassess if setup consumes that allowance; do not expand
the probe into a desktop rewrite or interrupt production to make it pass.

1. Confirm the baseline, installed version, tooling, production process identity,
   and live agent state using read-only checks.
2. Build using `mise exec -- npm run build:server`, following instructions from
   the selected baseline. Run network/setup commands outside the sandbox.
3. Use fresh state in `.dev/notifications-home`, relay disabled, and a verified
   free loopback port other than 6767. Do not copy production session state.
4. Configure and launch through the checkout's built CLI with explicit `--home`.
   Current source supports `daemon config set daemon.listen …`,
   `daemon config set daemon.relay.enabled false`, and `daemon start`. Check the
   chosen baseline's help before recording exact execution commands.
5. Connect the installed desktop as an additional host without disabling its
   existing daemon management. Exercise a disposable agent. Record endpoint, PID,
   home, executable/build provenance, and client connectivity; confirm the
   production process identity stayed unchanged.
6. Stop only the isolated daemon and demonstrate repeatable startup. Keep a short
   receipt here, not raw logs or runtime state in Git.

Success permits the isolated feature demonstration. If the installed app cannot
connect, decide whether to repair the connection or use a matching fork desktop
in isolation. The probe does not establish push delivery or production safety.

Planning found no `node_modules`. Mise reported untrusted checkout configuration
and unavailable pinned tool versions; a version check triggered blocked setup
activity. The subsequently authorized build attempts installed pinned Node
22.20.0 and npm dependencies and completed both desktop builds. Mobile toolchain
activation was unnecessary. Runtime probes remain unexecuted.

## Implementation and proof

Once requested, verify GitHub state and create `iExalt/paseo` if absent. Keep the
upstream URL under `upstream` and use `origin` for the personal fork. Create the
feature branch from the chosen baseline in this checkout, preserving this plan
and unrelated work. Keep publication limited to the personal fork.

Implement small tested increments in existing suites:
`packages/protocol/src/agent-labels.test.ts` and
`packages/server/src/server/agent/agent-manager.test.ts`. Extend an existing MCP
suite if necessary to prove creation/detach and parent-event behavior.

Acceptance checks for the proposed contract:

- Exact `off` suppresses every attention reason; absent, empty, and `on` retain
  eligibility. Existing delegated/internal suppression still applies.
- Completion/error attention persists; pending permissions remain discoverable
  and resolvable with their current attention semantics.
- A live label update affects the next eligible event and survives reopening.
  Unmuting sends no retrospective event.
- A worker muted at creation remains muted after clearing parentage, appears
  top-level, and avoids parent archive cascade. Its subscribed overseer still
  receives worker events.
- Paired controls demonstrate delivery: another active client gets a banner;
  no active clients permits completion/permission push. Test errors via banners,
  since they never push. A focused client suppressing both controls proves nothing
  about the mute label.
- Verify desktop banners and real mobile push before claiming both paths work.
  Record untested platforms explicitly.

Run only changed test files with `mise exec -- npx vitest run <file> --bail=1`
from the appropriate workspace. Run npm typecheck and lint after changes; rebuild
owning declarations before diagnosing cross-package errors. Use npm formatting
scripts and `npm run format` before committing. Use conventional commits without
attribution trailers. Never run the full local suite; use fork CI for broader
checks. Report checks exceeding a minute and avoid redundant reruns. Follow
[testing](upstream/testing.md) and [QA](upstream/qa.md).

## macOS app build option

Both npm and Nix macOS builds succeeded on the inspected `4869214bc` baseline,
with local documentation and Mise configuration changes. No notification patch
is included. Neither app, bundled CLI, nor daemon was launched; runtime
compatibility remains unverified. Building the app is an available rollout option,
not yet a replacement for the external-daemon probe.

- Root `package.json` provides `build:desktop`: build app dependencies, export the
  Expo renderer for Electron, then build/package the desktop workspace. The desktop
  build also builds the server and CLI, so the bundle can carry the patched daemon.
- `packages/desktop/electron-builder.yml` defines the `.app` resources, icons,
  entitlements, macOS 13 minimum, and DMG/ZIP targets. Output goes under
  `packages/desktop/release`.
- `.github/workflows/desktop-release.yml` builds both arm64 and x64 with Node 22.
  Its signed/notarized release path requires Apple signing and notarization secrets.
- [Development](upstream/development.md#nix-desktop-package) documents `nix build .#desktop`.
  `nix/desktop-package.nix` includes an unsigned macOS path with signing,
  hardened runtime, and notarization disabled, yielding
  `result/Applications/Paseo.app` and a launcher.

The root `mise.toml` replaces `.mise.toml`, preserves `.tool-versions` pins, and
provides `build:macos:npm` and `build:macos:nix` tasks. Both disable the packaged-app
smoke hook with `PASEO_DESKTOP_SMOKE=0`. The npm task creates an unsigned app
directory without publishing, signing, hardened runtime, or notarization.

Build receipts (artifact metadata inspection only):

| Route                  | Artifact                                       | Result                                                   |
| ---------------------- | ---------------------------------------------- | -------------------------------------------------------- |
| npm / electron-builder | `packages/desktop/release/mac-arm64/Paseo.app` | Success; 535 MB, version 0.11.0-beta.3, macOS 13 minimum |
| Nix                    | `result/Applications/Paseo.app`                | Success; 470 MB, version 0.11.0-beta.3, macOS 13 minimum |

The npm build required running outside the sandbox because Expo writes user
settings under `~/.expo`. Logs remain local under `.dev/build-validation`.

Before installing or launching a fork desktop, decide app/settings identity and
daemon ownership so it cannot collide with the installed app. Disable or redirect
its updater: the checked-in publisher points at `getpaseo/paseo`, and the runtime
enables automatic downloads. `--publish never` prevents build-time publication;
it does not establish a fork-safe runtime update policy.

## Cutover and rollback

Prepare exact commands, process targets, startup ownership, and rollback before
requesting production interruption. Inspect all live runs, including idle overseers
with background work; idle alone is not proof that stopping is safe. Perform the
switch from a terminal/session independent of the daemon being replaced.

After explicit approval, quiesce work, disable desktop management as part of the
stop, verify process exit, back up durable home state and desktop settings
consistently, and launch the verified fork against `~/.paseo` on 6767. Never run two
daemons against that home. Preserve identity, pairings, relay, and credentials.
Verify executable/build provenance, desktop/mobile connectivity, resumable agents,
and muted/unmuted controls. Do not promise that active turns or provider-owned
background work survive a restart.

Prove external startup ownership and desktop relaunch behavior so desktop updates
cannot silently replace the fork. Rollback stops only the fork, restores built-in
management, and verifies the stock daemon. Repeat the live-work gate. Restore
backed-up state only if necessary and after accounting for newer writes; never
overwrite new agent history automatically.

## Overseer integration

Only after the fork is verified on the host used by overseer runs, edit
`~/Projects/nix-home-manager-config/dotfiles/skills/overseer/SKILL.md`:

- Supply `labels: {"paseo.notifications": "off"}` when creating workers, then
  retain the existing parent-label clearing step. If a verified path cannot set
  creation labels, apply mute and empty parent together in one update while
  delegated suppression still protects the preceding interval.
- Preserve parent-directed finish subscriptions. Keep overseer and `Question: …`
  threads unmuted, including the launch instructions they share with workers.
- Validate one run containing all three roles. Do not retroactively relabel
  existing runs without a separate request.

Read that repository's instructions and applicable skill-edit workflow first.
Validate, then commit and push scoped skill changes as requested by the user's
skill-edit policy. Reload Home Manager if adding, removing, or renaming skills.
None of these actions belong to this planning edit.

Defer UI controls, per-reason modes, workspace defaults, and title-based rules.
Upstream submission is excluded. Reassess if the installed app cannot connect, creation
cannot avoid an unmuted interval, parent events depend on the suppressed callback,
or setup/compatibility work materially exceeds the probe allowance.

## Checklist

- [x] Inspect checkout, notification/label paths, and daemon-management source.
- [x] Record the proposed route and unproven runtime assumptions.
- [x] Select all-notification suppression with existing attention state preserved.
- [x] Select current `main` plus the notification patch as the release baseline.
- [ ] Authorize execution and complete the isolated external-daemon probe.
- [ ] Create fork, implement, and pass targeted checks and fork CI.
- [ ] Demonstrate muted/unmuted delivery with installed clients.
- [ ] Approve and complete production cutover with rollback ready.
- [ ] Verify the active fork, then update and validate the overseer skill.
- [x] Keep the change fork-only; exclude upstream submission.
- [x] Build npm and Nix macOS apps without launching the outputs.
