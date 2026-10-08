# Configurable notifications

**Complete and archived.** M1–M4, S1–S8, T1–T5, and G1–G4 are accepted.
The feature and menu icon follow-up are on `dev`; the implementation worktree
has been removed. The constraints and execution instructions below record the
approved campaign. See the final status for subsequent user installation reports,
retained artifacts, and limits of the local Android build.

The user has authorized implementation of this confirmed plan in the explicitly
requested sibling worktree. Implementation, automation parity, browser OS proof,
and macOS builds are accepted. Isolated Android connectivity, final device
controls, and cleanup are also accepted. The
[shared status](CONFIGURABLE_NOTIFICATIONS_STATUS.md) owns current evidence.
Production state and deployment are excluded.

## Summary

- Let users change workspace notification settings from the workspace menu.
- Make CLI and MCP control first-class: set policy during workspace creation,
  change it at runtime, and read it back through automation interfaces.
- Preserve attention indicators, pending permissions, and agent-to-agent events.
  Previously agreed muting covers banners and push, including permission prompts.
- Build on branch `feat/configurable-notifications` from the clean baseline
  `4ea125b83` in the requested sibling worktree. Keep changes in the personal fork;
  do not submit upstream.
- Cover agent and terminal attention with one shared policy across devices.
- Add an empty-by-default daemon-wide regex denylist for completed assistant
  replies. Matching replies suppress banners and push across all workspaces while
  keeping messages, attention, and observation events.
- Verify the desktop menu and existing Android app push over relay/mobile data.
  Defer Android menu verification while keeping implementation cross-platform.
- Finish with a built and verified feature, including real-phone evidence.
  Production deployment and the overseer skill update belong to a later plan.

## 1. Outcome and scope

**North star (the user, 2026-10-04):** configurable workspace notifications that
the user can change, probably from a workspace's right-click menu. “Most
importantly, agents need to be able to change these settings at workspace
creation time/runtime through the CLI tools as well as the MCP.”

**First useful result:** create a quiet workspace through either CLI or
MCP before any work starts; inspect the persisted policy, change it while work is
running, and observe that the menu and other connected clients reflect it.
An otherwise identical unmuted workspace remains eligible to notify.

**Scope extension (the user, 2026-10-04):** Claude periodically emits replies such
as “No news.” that the user does not want to trigger notifications. Use shared
daemon-wide rules, limited to completed assistant replies, with no rules enabled
by default. This extends notification filtering without restoring per-agent policy.

Execution boundaries carried forward from the conversation:

- T1/S1 was documentation and evidence only. Later work follows the approved
  sequence; each live launch still needs its named gate. No production daemon
  restart, app replacement, deployment, or overseer change is authorized.
- Keep work in the requested sibling worktree, preserve unrelated changes, and
  keep raw logs and generated bundles out of commits. No upstream issue or PR.
- Preserve protocol compatibility. Optional wire fields, explicit capability
  gating for a new client feature, pure schemas, and dotted new RPC names follow
  [protocol compatibility](../upstream/protocol-compatibility.md) and
  [RPC namespacing](../upstream/rpc-namespacing.md).

Ranked preference already supplied: creation-time and runtime automation access
is essential, not a follow-up after the UI. The contract and scope below were accepted with Tier 1 confirmation.

Exclusions: notification schedules, snooze durations, per-device policy,
project-wide defaults, title-based rules, changes to parentage
or archive semantics, and unrelated OS/app-update notifications.

## 2. Background and verified evidence

### 2.1 Earlier direction

The earlier per-agent proposal addressed quiet top-level workers, with the overseer and `Question: …`
threads still eligible to notify. The user chose all-notification suppression
with attention state preserved, current `main`, and fork-only delivery.
No notification feature was implemented.

**Changed (the user, 2026-10-04):** the requested primary configuration boundary
is now the workspace, with UI, CLI, and MCP surfaces. The user confirmed workspace-only settings in D4, replacing the unimplemented
per-agent proposal. This document owns the workspace design and retained build
evidence. The superseded proposal remains in Git history at `2f5619217`.

### 2.2 Repository and runtime evidence

The implementation baseline is clean `feat/configurable-notifications` at
`4ea125b83` in the requested sibling worktree. The earlier planning checkout at
`4869214bc` and its uncommitted Mise/Android tool declarations are historical
receipts from a different tree; they are not part of this baseline.

Historical build receipts from `4869214bc`, with local documentation and Mise
configuration changes, record successful unsigned macOS packages without a
notification patch. Artifact metadata was inspected; neither app, bundled CLI,
nor daemon was launched. These receipts establish packaging feasibility only.

| Route                  | Artifact                                       | Recorded result                                          |
| ---------------------- | ---------------------------------------------- | -------------------------------------------------------- |
| npm / electron-builder | `packages/desktop/release/mac-arm64/Paseo.app` | Success; 535 MB, version 0.11.0-beta.3, macOS 13 minimum |
| Nix                    | `result/Applications/Paseo.app`                | Success; 470 MB, version 0.11.0-beta.3, macOS 13 minimum |

Both build tasks used `PASEO_DESKTOP_SMOKE=0` to prevent the packaged-app smoke
hook from launching outputs. The npm build ran outside the sandbox because Expo
writes settings under `~/.expo`; logs were retained locally in
`.dev/build-validation`. See [development](../upstream/development.md#nix-desktop-package)
for the Nix build route.

Installed 0.10.2 and live overseer runs come from the handoff, not a fresh runtime
inventory. Recheck them before any future cutover.

Verified source constraints:

| Subject         | Evidence and implication                                                                                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Identity        | [Glossary](../upstream/glossary.md): a workspace belongs to one project; sibling workspaces can share a directory. Key policy by workspace ID, not project or `cwd`.                                                     |
| Persistence     | `packages/server/src/server/workspace-registry.ts` owns workspace records and updates. Its labels are a string array, unlike agent key/value labels. Do not assume the old label implementation transfers unchanged.     |
| Creation        | `packages/protocol/src/messages.ts` defines `WorkspaceCreateRequestSchema`. `session.ts` provisions before creating the initial agent. Creation policy must enter the provisioning transaction, not a later mutation.    |
| MCP creation    | `packages/server/src/server/agent/tools/paseo-tools.ts` calls directory/worktree creation paths directly. Changing only the WebSocket creation handler leaves MCP uncovered.                                             |
| CLI             | `packages/cli/src/commands/workspace/index.ts` exposes create/list/rename/archive/setup. Notification updates and readback need explicit API and command design.                                                         |
| User menus      | `packages/app/src/components/sidebar/sidebar-workspace-menu.tsx` shares item rendering between context and button menus. Use that shared surface for right-click and touch access; follow [menus](../upstream/menus.md). |
| Delivery        | `packages/server/src/server/websocket-server.ts` has separate agent and terminal attention broadcasts. Both carry non-notifying observation events. Preserve those events while suppressing user-facing delivery.        |
| Client behavior | `packages/app/src/contexts/session-context.tsx` inspects `shouldNotify` for agent and terminal attention.                                                                                                                |
| Attention       | Manager completion/error handling sets attention before delivery. Pending permissions do not force the unread attention flag. Preserve both existing behaviors.                                                          |
| Authority       | [Permissions](../upstream/permissions.md) classifies workspace management independently from protocol names. New mutation paths must use the existing authority model.                                                   |

## 3. Decision ledger and current frontier

Decided means the user's call; Proposed is unaccepted design advice; Open names
what must settle it; Verified refers to inspected evidence rather than approval.

| ID  | Decision                      | Status                                                                                                                                                                 |
| --- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | UI and automation parity      | **Decided (the user, 2026-10-04):** users can change workspace settings; CLI and MCP must support creation and runtime control. Right-click placement is a suggestion. |
| D2  | Mute semantics                | **Decided (prior conversation):** suppress banners and push, including permission/question alerts, while preserving attention/pending state.                           |
| D3  | Baseline and publication      | **Decided (current execution):** requested sibling worktree, branch `feat/configurable-notifications` from `4ea125b83`, personal fork only, no upstream submission.    |
| D4  | Workspace versus agent policy | **Decided (the user, 2026-10-04):** workspace-only settings; drop the unimplemented per-agent override proposal.                                                       |
| D5  | Event sources                 | **Decided (the user, 2026-10-04):** agent and terminal attention notifications.                                                                                        |
| D6  | Device scope                  | **Decided (the user, 2026-10-04):** one daemon-owned workspace policy shared across devices.                                                                           |
| D7  | Campaign completion           | **Decided (the user, 2026-10-04):** built and verified feature; plan deployment separately. No production cutover or overseer skill edit in this campaign.             |
| D8  | Real-device evidence          | **Decided (the user, 2026-10-04):** test connected devices, especially the Android phone.                                                                              |

**Verified for D4:** the current overseer skill at
`~/Projects/nix-home-manager-config/dotfiles/skills/overseer/SKILL.md` creates a
local overseer workspace (lines 22–24), a separate workspace for each worker
(lines 236–244), and a local question workspace (lines 518–521). It explicitly
says, “Never launch a worker into your own workspace.” The lone-worker shortcut
shares the checkout, not the workspace. The user's recollection is correct for
the skill's prescribed layout; live runs were not inspected.

**Decided (the user, 2026-10-04):** workspace-only policy fits the verified layout.
The earlier per-agent proposal is superseded, not a second feature to implement.

Additional decisions:

| ID  | Decision                       | Status                                                                                                                                                                |
| --- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D9  | Defaults and temporal behavior | **Agreed (the user, 2026-10-04):** existing/new workspaces notify by default; changes govern future delivery decisions; unmute does not replay past events.           |
| D10 | Android menu proof             | **Decided (the user, 2026-10-04):** desktop menu proof and existing-app Android push tests; defer Android menu proof. Cross-platform implementation remains required. |
| D11 | Phone connection route         | **Decided (the user, 2026-10-04):** relay/mobile data, matching remote use, against the isolated test host.                                                           |
| D12 | Regex scope                    | **Decided (the user, 2026-10-04):** daemon-wide denylist shared across all workspaces and devices connected to that daemon.                                           |
| D13 | Regex event coverage           | **Decided (the user, 2026-10-04):** completed assistant replies only; suppress both notification delivery paths, retaining messages and attention.                    |
| D14 | Regex defaults                 | **Decided (the user, 2026-10-04):** empty by default; configure the optional case-insensitive whole-reply “No news.” rule where wanted.                               |

The original workspace decisions remain confirmed. D12–D14 settle the new scope.
T1/S1 closed the M1.3 feasibility design and measured the fixed check baseline.
At T1, the filter collector was not implemented. S3 subsequently implemented and
verified its lifecycle handling; the final status owns completion evidence.

## 4. Design constraints

The workspace constraints were accepted with Tier 1; API names remain adaptable
to repository conventions. The confirmed regex extension is specified in §4.3.

1. Persist a typed workspace policy, exposed in workspace descriptors and automation
   summaries. Default existing workspaces to current notification behavior.
2. Apply creation policy before setup, first-agent execution, or the initial
   descriptor can expose a workspace with the wrong policy. Cover local and
   worktree provisioning through CLI and MCP, including retry/idempotency behavior.
3. Runtime updates acknowledge durable success and publish the updated descriptor.
   Preserve unrelated workspace metadata; make failure visible to users and agents.
4. Resolve notification eligibility at the delivery decision. A successful mute
   governs subsequent decisions; it cannot retract a push already sent. Keep source
   events and attention state even when no client should display a notification.
5. Gate control surfaces once on daemon capability. Old daemons must not silently
   accept a setting they cannot enforce; old clients must still parse new messages.
6. Use the shared workspace menu with pending/success/failure behavior and policy
   readback. Cross-device synchronization follows D6; no new menu engine is needed.

### 4.1 Contract

Use `notifications: "on" | "off"` on workspace creation and persisted descriptors,
with omitted values resolving to `"on"`. Keep new wire fields optional; validate
invalid inputs instead of silently coercing them. Readback exposes the effective
policy so automation can verify existing records as well as explicit settings.
Workspace policy is independent of labels, parentage, titles, and directory paths.

| Surface      | Proposed contract                                                                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI creation | `paseo workspace create … --notifications off`, supporting local and worktree isolation                                                                        |
| CLI runtime  | `paseo workspace update <workspace-id> --notifications on\|off`; JSON output reports durable state                                                             |
| CLI read     | Include policy in workspace list JSON and a useful human-readable column                                                                                       |
| MCP creation | Optional `notifications` on `create_workspace`                                                                                                                 |
| MCP runtime  | A workspace-settings mutation accepting workspace ID and `notifications`, with readback in its result                                                          |
| MCP read     | Include policy in workspace creation and list summaries                                                                                                        |
| Wire         | A dotted mutation request/response pair, such as `workspace.notifications.set.request` / `.response`, behind an optional `workspaceNotifications` feature flag |
| UI           | Shared sidebar context/button action: `Mute notifications` or `Unmute notifications`, reflecting current persisted state                                       |

Names may be refined during implementation within repository conventions; behavior
and parity are the requirements. Apply workspace-management authority through the
existing authorization module. Do not create a separate permission system or add
provider-auth tests. A failed save leaves the prior state authoritative; the UI
and automation report the error. Concurrent sets follow committed server order,
and each successful mutation publishes its resulting descriptor.

Setting `on` means eligible under existing rules, not guaranteed notification:
delegated/internal suppression, focus/presence rules, and agent-error push exclusion
still apply. Setting `off` disables push sending and gives observation subscribers
non-notifying attention events. Do not infer policy from `cwd` when a legacy
terminal event lacks a workspace ID; preserve existing behavior outside an identified
workspace. Resolve policy against the current workspace at delivery time rather
than copying it into agents when they are created.

Old clients may receive the optional descriptor field without using it. A new
client must detect unsupported servers before sending a policy-bearing creation
or update; do not silently create an unmuted workspace when `off` was requested.
An idempotent creation retry with unchanged policy must retain the creation outcome;
a conflicting policy must follow the existing conflicting-intent rule, not mutate
the prior workspace as a side effect. Use shared provisioning logic so MCP and
WebSocket creation establish the same ordering.

The runtime update must survive daemon restart without requiring one to take effect.
Archiving, reopening, or renaming a workspace retains its policy. A genuinely new
workspace starts at the default unless its creation explicitly sets policy.

### 4.2 Safety and boundaries

All validation runs use a separate home, endpoint, and server identity. No test
launch may reuse `~/.paseo`, port 6767, desktop production settings, or an existing
agent/provider session. Disable automatic updates and built-in-daemon takeover in
the test desktop environment. Check the launch configuration before executing it;
the previous packaged-app no-launch restriction is lifted only for an explicitly
approved isolated validation phase, not by this planning document.

Earlier source inspection found two deployment traps: disabling desktop daemon
management stops its running daemon, and `--publish never` prevents build-time
publication without disabling runtime automatic updates. The inspected publisher
targeted `getpaseo/paseo` and automatic downloads were enabled. Recheck those
behaviors on the chosen revision before launching a fork desktop.

Do not change notification permissions, erase data, or replace the production app
on the phone. Test pairing/removal and switching to mobile data need named human
steps in the roadmap. No Android debug installation is needed for this campaign. If isolation cannot be established, stop that probe and
report the missing prerequisite. Never restart production to unblock testing.

Production cutover and overseer integration remain deferred under D7. The later
deployment plan must identify exact process targets, startup ownership, and
rollback commands before requesting interruption. Inspect idle overseers for
background work, and perform the switch from a session independent of the daemon
being replaced. Never run two daemons against the production home. Back up durable
state and desktop settings consistently; preserve identity, pairings, relay, and
credentials. Verify desktop relaunch and update behavior cannot replace the fork.
Rollback must repeat the live-work check and account for newer writes before
restoring any backup; never overwrite new agent history automatically. Active
turns and provider-owned background work are not guaranteed to survive a restart.

### 4.3 Daemon-wide reply denylist

Persist one rule list per daemon home, shared by its connected clients and applied
to every workspace and provider. An empty or absent list preserves existing
behavior. This is a host setting, not a workspace default, a creation argument, or
a per-workspace override. Workspace `off` always suppresses delivery; workspace
`on` remains subject to the denylist and existing eligibility rules. The denylist
cannot force notifications on or bypass internal/delegated-agent suppression.

Rules contain regex source and explicit flags. Any matching rule suppresses a
`finished` notification on both delivery paths. Permission/question, error, and
terminal events never consult this list; workspace mute still governs them.
Do not filter transcript storage, pending permissions, observation events, or
agent-to-agent completion subscriptions. Existing error-notification behavior stays.

Match the retained final assistant-text segment associated with the completion
being notified, joining streaming chunks in order, before notification-preview
formatting or truncation. Do not match titles, tools, previous turns, or an entire
conversation. Preserve Markdown, case, and whitespace; normalization belongs in an
explicit pattern or flag. Regex search semantics apply; anchors express whole-reply
matching. The optional example is source `^\s*No news\.\s*$` with flag `i`.
It must not suppress `No news. A decision is needed.`. No built-in Claude rule
or provider-specific behavior is introduced.

**Source-grounded hazard:** [AgentManager.handleStreamEvent](../../packages/server/src/server/agent/agent-manager.ts#L4174)
assigns managed turn identity before the [stream coalescer](../../packages/server/src/server/agent/agent-stream-coalescer.ts#L44)
can merge chunks. A matching terminal flushes buffered items, but
[finalizeForegroundTurn](../../packages/server/src/server/agent/agent-manager.ts#L2606)
clears the active turn before `emitState` triggers the running-to-idle attention
callback. That callback carries agent ID, provider, and reason only. The WebSocket
path then asynchronously calls [getLastAssistantMessage](../../packages/server/src/server/agent/agent-manager.ts#L3208),
which selects live/durable text without a completion identity. The notification
preview in [agent-attention-notification.ts](../../packages/protocol/src/agent-attention-notification.ts)
normalizes and truncates its display text. Neither path is a safe rule subject.

**M1.3 design at T1, before the later verified S3 implementation:** initialize a
bounded collector at the manager-owned foreground turn boundary. After event
content limiting and turn-identity assignment, observe live assistant-message
chunks before coalescing. Keep only the latest assistant segment for that turn;
join compatible adjacent chunks, reset on an explicit message-ID change, and do
not join across tool or reasoning items. Those events break adjacency without
erasing the latest segment; a later assistant chunk begins the next segment. Seal
an immutable `{ turnId, text,
completeness }` snapshot only for the matching successful `turn_completed`, before
foreground finalization clears the active ID. Pass that snapshot to the attention
and delivery decision. Never query history or fall back to the latest message.
Missing turn start, history replay, unknown identity, ambiguous segment boundaries,
declared or unestablished truncation, cancellation/failure, stale terminal events,
or collector overflow is ineligible for suppression. Overflow remains incomplete
for that segment even if later chunks fit; only a
genuinely new assistant segment resets it. The collector defines
completeness as all normalized live chunks observed for the matching identity from
turn start, within the subject cap; it does not claim a provider never internally
truncates an answer. No generalized provider matrix is required absent a concrete
counterexample. S3 must add focused lifecycle/counterexample tests before enforcement.

Use `re2-wasm@1.0.2` (Google RE2) with Unicode mode fixed by the engine; accept
only `i`, `m`, and `u` flags, treating `u` as implicit when omitted and rejecting
other, duplicate, or malformed flags. Matching uses search semantics; anchors
express whole-reply matching. Limit a replacement to 8 rules, 256 UTF-16 code
units per pattern, and 16,384 UTF-16 code units per subject. Compile and validate
the entire replacement before persistence. Invalid configuration fails the save
and retains the previous rules; a missing, ambiguous, or overflowed subject fails
open for that delivery. Temporary adversarial probes accepted the 8/256/16,384
sample in 2.35 ms compile and 18.27 ms match; these are observed sample timings,
not hard latency bounds.
The tested syntax rejects lookaround, backreferences, and malformed expressions;
anchored case/whitespace, significant suffix, astral-character, and multiline
cases passed. Package load took 44.5 ms separately. An initial 16-rule,
1,024-unit pattern, 65,536-unit subject candidate took 650–661 ms to match and
was rejected as too costly; the smaller accepted limits retain bounded input.

| Surface            | Proposed behavior                                                                                                                                                                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host settings UI   | A cross-platform editor under the selected host's notification settings; add/remove/edit rules, show validation, and explicitly save or clear the list. State that rules affect every workspace on this host.                                                               |
| CLI                | Host-targeted get/set/clear commands, with structured JSON input/readback so regex escaping survives shell transport. Names follow existing configuration commands.                                                                                                         |
| MCP                | Host-settings read and mutation tools with the same structured rule list, errors, and authoritative readback; workspace creation must not mutate global settings.                                                                                                           |
| Wire and authority | Optional capability for reply filtering, distinct from workspace mute, pure optional wire fields and dotted RPCs. Reuse host-configuration authority; workspace-management authority alone must not grant global mutation. M1.3 identifies the existing permission mapping. |

The existing persistence seam is the strict
[`PersistedConfigSchema`](../../packages/server/src/server/persisted-config.ts#L227)
and [`DaemonConfigStore`](../../packages/server/src/server/daemon-config-store.ts#L311),
which validate and save the private daemon config atomically and support live
apply/rollback. Exact
field names and capability keys were unselected at T1; the final status records
the implemented `replyRules` field and capability negotiation. Host
reads require `daemon.read`; host mutations require `daemon.manage`. Use an
explicit host-authorization context: workspace-only permissions and a shared
agent token do not grant global mutation. [`resolveSessionAdmission`](../../packages/server/src/server/session-admission-auth.ts#L11) currently
grants owner permissions when password auth is disabled, so it must not be used
as an implicit host-level authorization shortcut. Check the shared agent token
first in both password modes. Host operations default to no authority; grant
host permissions only through a verified local-owner credential or configured
password. Existing workspace tools keep their current authority.

Successful updates persist atomically, survive restart, apply without restart, and
publish current state to connected settings clients. Invalid or failed saves leave
the old list authoritative. Concurrent whole-list replacements follow committed
server order; the editor exposes an external update rather than silently overwriting
unsaved edits. Read the current policy at the delivery decision after asynchronous
subject retrieval. Changes affect future decisions only, with no replay or retraction.
An old client still receives the same non-notifying source events; new controls
must report unsupported hosts before sending a mutation.

## 5. Work areas to turn into milestones

- **W1 — Contract:** settle the policy table, identity boundary, and wire/readback
  contract; identify the relevant creation and runtime mutations.
- **W2 — Durable enforcement:** persist creation/runtime policy and apply it to
  selected event sources without changing attention or lifecycle state.
- **W3 — Automation parity:** CLI and MCP create/update/read paths enforce the
  same contract, including errors and unsupported-daemon behavior.
- **W4 — User control:** shared workspace menu, current state, failed-save feedback,
  and synchronization with CLI/MCP changes.
- **W5 — Proof and delivery:** targeted tests, isolated demonstrations if authorized,
  and packaging. Exclude production deployment and overseer integration per D7.
- **W6 — Reply filtering:** completion-bound matching, bounded regex evaluation,
  durable daemon policy, host UI and CLI/MCP parity, and real delivery proof.

### M1 — Contract and safe validation route

- [x] **M1.1 Policy contract:** binary workspace policy, stable defaults, no replay,
      source coverage, identity, and feature negotiation agreed.
- [x] **M1.2 Validation feasibility:** identify the isolated host/client setup and
      phone pairing route without replacing or stopping production.
- [x] **M1.3 Filter feasibility and contract:** source trace and bounded-engine
      probe support the accepted completion-bound design in §4.3. T1 established
      feasibility only; S3 later implemented the collector, immutable subject,
      persistence field, capability, and lifecycle/counterexample tests. The final
      status records that verification; the latest-message getter is not used.
- **G1:** review the policy truth table and create/update/readback contract and
  establish a viable Android validation route. A blocker leaves G1 open. During implementation,
  allow an initial 30-minute setup probe before reassessing missing prerequisites.
  The revised gate also requires M1.3's accepted filtering contract.

### M2 — Durable policy and automation parity

- [x] **M2.1 Persistence and creation:** local/worktree creation applies policy
      before work starts; retries and updates preserve unrelated state.
- [x] **M2.2 Delivery enforcement:** agent and terminal user-facing notifications
      honor workspace policy while observation events and attention survive.
- [x] **M2.3 CLI/MCP parity:** create, update, and readback demonstrate the same
      behavior and clear errors for unsupported hosts or failed writes.
- [x] **M2.4 Daemon denylist:** durable get/set/clear and CLI/MCP parity; completion
      matching suppresses both delivery paths without altering state. Invalid rules,
      missing/truncated/stale text, and non-finished reasons preserve the specified
      behavior; workspace mute takes precedence.
- **G2:** targeted tests prove those contracts, same-directory workspace isolation,
  restored workspace and daemon policy, and unchanged behavior with an empty
  denylist. Include M2.4's filter invariants. No full local suite.

### M3 — User controls

- [x] **M3.1 Shared menu:** current policy and mute/unmute actions work from the
      sidebar context/button menu, with pending and failure feedback.
- [x] **M3.2 Synchronization:** CLI/MCP changes update connected UI state, and UI
      changes are visible to automation without reconnecting.
- [x] **M3.3 Host filter editor:** users can edit/save/clear the daemon-wide rules,
      see validation and save failures, and observe CLI/MCP changes across clients.
- **G3:** desktop menu demonstration and UI/CLI/MCP synchronization; errors leave
  the authoritative state visible. Old-daemon gating is explicit. Android menu
  verification is deferred under D10 and is not a condition for this gate. Include
  a desktop demonstration of the host filter editor and its synchronization.

G3 is accepted: the isolated browser journey and lower-layer checks prove the
controls and synchronization; the user confirmed both OS positives arrived and
the workspace-muted/rule-filtered trials stayed silent on 2026-10-08. Native
logs separately record both banners. M4.1 also has accepted Android delivery
evidence; Android menu proof remains excluded under D10.

### M4 — Real-device proof and handoff

- [x] **M4.1 Device delivery:** desktop/browser local notifications and Android remote
      push controls prove muted/unmuted behavior over relay/mobile data on the existing
      Android app.
      Include a matching completion suppressed by the global rule in an otherwise
      unmuted workspace, plus nonmatching and rule-cleared positive controls.
- [x] **M4.2 Build and record:** both macOS packaging paths pass for the feature
      revision; required checks pass and the proof states platform limitations.
- [x] **M4.3 Cleanup:** remove only test hosts/pairings and temporary test resources
      after preserving concise evidence, with production unchanged.
- **G4:** actual phone-positive controls bracket muted trials; source-event evidence
  proves the muted events occurred. Record build revision, checks, and receipts.
  No claim of deployment, production readiness validation, or overseer integration.

G1–G4 and W5/W6 are accepted within the stated platform boundaries. The
[status receipt](CONFIGURABLE_NOTIFICATIONS_STATUS.md#android-relay-and-push-proof)
records actual Android arrivals, retained source events, silence controls, and
test-state cleanup separately from the package-build evidence.

## 6. Verification and runtime cost

Use fast unit coverage for policy/default/eligibility matrices. Use fewer integration
tests for persistence, creation ordering, protocol and CLI/MCP contracts. Reserve
end-to-end coverage for one representative menu/automation synchronization journey
and real delivery controls. Do not repeat the full policy matrix in browsers.

Same-directory sibling workspaces must remain independent. Muted and unmuted
controls must share the same client-presence conditions, so focus suppression
cannot masquerade as policy enforcement. Prove observation state is retained.

Put regex syntax/flags, empty/any-match behavior, streaming assembly, significant
suffixes, stale/next-turn races, missing/truncated text, limits, and precedence in
the cheapest reliable tests. Use integration tests for completion identity,
durability, authority mapping, invalid-write atomicity, and UI/CLI/MCP contracts.
Do not add provider credential/authentication tests. Prove a global rule affects
two distinct workspaces on one daemon and cannot affect a separate daemon home.
Keep detailed matrices out of device tests.

### Phone delivery and required proof

Source trace: `packages/app/src/push-notifications/internal/subscriptions.ts`
obtains an Expo push token with OS permission, registers it with the daemon, and
registers again on reconnection. `packages/server/src/server/push/index.ts` sends
to active tokens (48-hour leases); `push-service.ts` posts to Expo's push service.
The live desktop/browser path uses WebSocket attention events and local OS
notifications. `packages/app/src/utils/os-notifications.ts` returns without
showing local notifications on native platforms; phone delivery uses remote push.
`session-context.tsx` also suppresses agent-error notifications, beyond the server's
push exclusion. Preserve these baseline behaviors. This is code evidence of
Paseo's mechanism, not inspection of the user's actual phone registration.

The required real-device gate must include:

1. An isolated test home, distinct server identity and endpoint, and a paired
   installed Android app. Connect the phone through Paseo relay with Wi-Fi off,
   verify the test server identity and retained state over mobile data, and keep
   production pairing intact. Never replace the production daemon or reuse its state.
2. Foreground, unfocused desktop/browser controls for local notifications, then
   an Android remote-push test. Check retained state on the connected phone;
   do not require native WebSocket-driven banners that the current app never
   displays. Focus can suppress delivery independently of workspace settings.
3. For push, all relevant clients must have no activity within the existing
   180-second presence window (or be disconnected with that condition verified).
   Merely backgrounding them does not establish push eligibility.
4. User-observed unmuted push controls before and after the muted trial, a bounded
   observation window, and proof that the muted event occurred and retained its
   attention/pending state. Include runtime unmute. Use completion/permission and
   terminal attention; agent errors are not a valid user-visible positive control.
5. Record actual phone arrival for positive controls. Expo HTTP/ticket acceptance
   alone cannot prove phone delivery. Failure to deliver a control blocks the mute
   conclusion; silence is not a passing test by itself.
6. In an unmuted workspace, configure the optional “No news.” rule on the isolated
   daemon. Bracket a matching completion with observed nonmatching/rule-cleared
   controls on desktop and Android. Retain the matching message and attention
   evidence; absence of a push alone is insufficient. Reuse the same phone session
   and presence checks rather than duplicating the full reason matrix.

Detailed reason matrices stay in unit tests; this gate samples the real path.
An installed old phone app can prove server-side suppression, but cannot prove a
new phone menu. Android menu verification is explicitly deferred under D10;
revisit it before claiming native menu behavior is verified or making a separate
Android UI release. Do not claim all-platform UI coverage from this campaign.

The user authorized and completed this isolated relay/Expo session on 2026-10-08,
after automated work. Any future repeat needs its own named launch scope. Allow
roughly 15 minutes for guided checks, then reassess if setup or delivery delays
extend them; elapsed time alone never passes the gate. This session exceeded that
allowance during disposable terminal-fixture diagnosis, with no weakened proof
or baseline reset.

Use the installed Android app for the push gate; no mobile rebuild, debug app
installation, or upstream signing credentials are planned. Confirm the installed
variant supports push before the early connectivity probe. The F-Droid variant
excludes push support ([Android docs](../upstream/android.md)) and cannot establish this gate.
If the installed variant or relay connection cannot support a positive control,
report the blocker and revisit the validation route without replacing the app.

The fixed pre-feature baseline was measured on clean `4ea125b83` in the sibling
worktree (macOS arm64, Node 26.11, copied dependencies/output, one Vitest worker,
no overlapping builds). Previous build durations are not a test-suite baseline.

| Check                   | Command and result                                                                                                                                                                                                                                                                                                                                                                                        | Investigation threshold |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Focused server baseline | From `packages/server`: `time mise exec -- npx vitest run src/server/agent-attention-policy.test.ts src/server/workspace-registry.test.ts src/server/session/workspace-provisioning/workspace-provisioning-service.test.ts src/server/websocket-server.notifications.test.ts src/server/websocket-server.terminal-notifications.test.ts --bail=1 --maxWorkers=1`; 92 passed, Vitest 7.49 s, wall 10.183 s | >15.183 s               |
| Root typecheck          | `time mise exec -- npm run typecheck`; wall 27.508 s                                                                                                                                                                                                                                                                                                                                                      | >33.010 s               |
| Root lint               | `time mise exec -- npm run lint`; wall 13.768 s                                                                                                                                                                                                                                                                                                                                                           | >18.768 s               |

The accepted practical budgets are at most 15 s for focused tests, 33 s for
typecheck, and 19 s for lint. A budget breach triggers investigation. Separately,
investigate growth that is both more than 20% and more than 5 s above the fixed
baseline, as well as material cumulative growth. Compare the same machine, cache,
and concurrency conditions. These thresholds do not permit regressions below them.
Do not increase concurrency or remove required checks to hide growth. Maintain
latency in each implementation step without moving required evidence into optional
checks.
Never run the full local suite; follow [testing](../upstream/testing.md) and the
repository's targeted-test rule.

## 7. Review and next action

**Confirmed revision:** D12–D14 record the user's regex decisions. §4.3, W6,
M1.3/M2.4/M3.3 and the extended device gate passed continuous review with no material
findings. The user confirmed revised Tier 1 on 2026-10-04 and requested the roadmap.
The reviewer has accepted the current M1.3 feasibility design and fixed baseline.
That planning acceptance is separate from implementation and runtime proof.
The [status](CONFIGURABLE_NOTIFICATIONS_STATUS.md) now records the accepted
implementation, desktop and Android delivery, builds, and cleanup.

- [x] Ground notification text and ask regex scope/default decisions.
- [x] Record daemon-wide, finished-only, empty-default answers.
- [x] Obtain reviewer acceptance of revised Tier 1.
- [x] Obtain user confirmation of revised Tier 1.
- [x] Propagate the confirmed delta into the roadmap, review and confirm Tier 2.
- [x] Propagate the confirmed roadmap into the script, review and confirm Tier 3.

The continuous reviewer checked the first question round and identified separate
MCP creation paths, same-directory workspace identity, observation-event retention,
readback requirements, and missing routine-test timing evidence. The grounding
draft first passed discussion review. The final Tier 1 snapshot is now
reviewer-accepted with no unresolved material findings. Review corrected native
phone notification assumptions and preserved non-notifying source events.
The user confirmed Tier 1 on 2026-10-04 and requested the roadmap. Neither
review nor confirmation is implementation or runtime proof.

- [x] Ground workspace identity, creation, menus, and delivery paths.
- [x] Review and ask the first independent decision round.
- [x] Record answers and resolve the product-scope decision frontier.
- [x] Finish milestone gates and obtain reviewer acceptance of Tier 1.
- [x] Confirm Tier 1 with the user before deriving the roadmap.
- [x] Confirm the roadmap before deriving the execution script.
- [x] Confirm the execution script for publication, planning only.

- 2026-10-08 UTC (2026-10-07 EDT): recorded T1/S1 completion, source-grounded
  M1.3 feasibility, fixed check baselines and accepted budgets. Implementation,
  immutable completion subjects, and G1 remain open.

The earlier plan, roadmap, and script were published to the personal fork,
`iExalt/paseo`, never upstream. This T1 reconciliation records the reviewed
contract and baseline; publication is scoped to these four documentation files
on the personal-fork feature branch. Production deployment remains outside this campaign.
