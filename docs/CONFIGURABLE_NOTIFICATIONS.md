# Configurable workspace notifications

Tier 1 confirmed by the user on 2026-10-04 after reviewer acceptance. The
confirmation authorizes deriving the roadmap, not implementation, app launches,
or deployment. The [roadmap](CONFIGURABLE_NOTIFICATIONS_ROADMAP.md) is confirmed; the execution
script is the next planning tier.

## Summary

- Let users change workspace notification settings from the workspace menu.
- Make CLI and MCP control first-class: set policy during workspace creation,
  change it at runtime, and read it back through automation interfaces.
- Preserve attention indicators, pending permissions, and agent-to-agent events.
  Previously agreed muting covers banners and push, including permission prompts.
- Build on current `main` in a personal fork. Do not submit this upstream.
- Cover agent and terminal attention with one shared policy across devices.
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

Constraints carried forward from the conversation:

- Planning only until implementation is requested. No production daemon restart
  without explicit approval; protect existing overseer runs.
- The prior build authorization prohibited launching built apps, bundled CLIs, or
  daemons. Those builds passed; no runtime probe is authorized by this plan edit.
- Keep work in this checkout, preserve unrelated changes, and keep raw logs and
  generated bundles out of commits. No upstream issue or PR.
- Preserve protocol compatibility. Optional wire fields, explicit capability
  gating for a new client feature, pure schemas, and dotted new RPC names follow
  [protocol compatibility](protocol-compatibility.md) and
  [RPC namespacing](rpc-namespacing.md).

Ranked preference already supplied: creation-time and runtime automation access
is essential, not a follow-up after the UI. The contract and scope below were accepted with Tier 1 confirmation.

Exclusions: notification schedules, snooze durations, per-device policy,
project-wide defaults, title-based rules, changes to parentage
or archive semantics, and unrelated OS/app-update notifications.

## 2. Background and verified evidence

### 2.1 Earlier direction

The [earlier per-agent plan](CUSTOMIZABLE_NOTIFICATIONS.md) records the initial
overseer use case: quiet top-level workers, with the overseer and `Question: …`
threads still eligible to notify. The user chose all-notification suppression
with attention state preserved, current `main`, and fork-only delivery.
No notification feature was implemented.

**Changed (the user, 2026-10-04):** the requested primary configuration boundary
is now the workspace, with UI, CLI, and MCP surfaces. The user confirmed workspace-only settings in D4, replacing the unimplemented
per-agent proposal. This document owns the new workspace design; the earlier
document remains the history and build-evidence record.

### 2.2 Repository and runtime evidence

Grounding inspected local `main` at `4869214bc`; `origin` still points to
`getpaseo/paseo`. The checkout contains uncommitted documentation and the Mise
configuration replacement from the prior task. No personal remote has been
configured in this checkout. GitHub fork existence was not queried.

Both npm and Nix macOS packages built successfully; see the earlier plan's build
receipts. Neither was run. Installed 0.10.2 and live overseer runs come from the
handoff, not a fresh runtime inventory. Recheck them before any future cutover.

Verified source constraints:

| Subject         | Evidence and implication                                                                                                                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity        | [Glossary](glossary.md): a workspace belongs to one project; sibling workspaces can share a directory. Key policy by workspace ID, not project or `cwd`.                                                              |
| Persistence     | `packages/server/src/server/workspace-registry.ts` owns workspace records and updates. Its labels are a string array, unlike agent key/value labels. Do not assume the old label implementation transfers unchanged.  |
| Creation        | `packages/protocol/src/messages.ts` defines `WorkspaceCreateRequestSchema`. `session.ts` provisions before creating the initial agent. Creation policy must enter the provisioning transaction, not a later mutation. |
| MCP creation    | `packages/server/src/server/agent/tools/paseo-tools.ts` calls directory/worktree creation paths directly. Changing only the WebSocket creation handler leaves MCP uncovered.                                          |
| CLI             | `packages/cli/src/commands/workspace/index.ts` exposes create/list/rename/archive/setup. Notification updates and readback need explicit API and command design.                                                      |
| User menus      | `packages/app/src/components/sidebar/sidebar-workspace-menu.tsx` shares item rendering between context and button menus. Use that shared surface for right-click and touch access; follow [menus](menus.md).          |
| Delivery        | `packages/server/src/server/websocket-server.ts` has separate agent and terminal attention broadcasts. Both carry non-notifying observation events. Preserve those events while suppressing user-facing delivery.     |
| Client behavior | `packages/app/src/contexts/session-context.tsx` inspects `shouldNotify` for agent and terminal attention.                                                                                                             |
| Attention       | Manager completion/error handling sets attention before delivery. Pending permissions do not force the unread attention flag. Preserve both existing behaviors.                                                       |
| Authority       | [Permissions](permissions.md) classifies workspace management independently from protocol names. New mutation paths must use the existing authority model.                                                            |

## 3. Decision ledger and current frontier

Decided means the user's call; Proposed is unaccepted design advice; Open names
what must settle it; Verified refers to inspected evidence rather than approval.

| ID  | Decision                      | Status                                                                                                                                                                 |
| --- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | UI and automation parity      | **Decided (the user, 2026-10-04):** users can change workspace settings; CLI and MCP must support creation and runtime control. Right-click placement is a suggestion. |
| D2  | Mute semantics                | **Decided (prior conversation):** suppress banners and push, including permission/question alerts, while preserving attention/pending state.                           |
| D3  | Baseline and publication      | **Decided (prior conversation):** current `main`, personal fork only, no upstream submission. Pin the implementation revision when work starts.                        |
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

The product-scope decision frontier is closed. The design below was accepted with
Tier 1 confirmation. Runtime feasibility remains an explicit implementation probe,
not a claimed result.

## 4. Design constraints

These constraints were accepted with Tier 1; API names remain adaptable to repository conventions.

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

Do not change notification permissions, erase data, or replace the production app
on the phone. Test pairing/removal and switching to mobile data need named human
steps in the roadmap. No Android debug installation is needed for this campaign. If isolation cannot be established, stop that probe and
report the missing prerequisite. Never restart production to unblock testing.

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

### M1 — Contract and safe validation route

- [ ] **M1.1 Policy contract:** binary workspace policy, stable defaults, no replay,
      source coverage, identity, and feature negotiation agreed.
- [ ] **M1.2 Validation feasibility:** identify the isolated host/client setup and
      phone pairing route without replacing or stopping production.
- **G1:** review the policy truth table and create/update/readback contract and
  establish a viable Android validation route. A blocker leaves G1 open. During implementation,
  allow an initial 30-minute setup probe before reassessing missing prerequisites.

### M2 — Durable policy and automation parity

- [ ] **M2.1 Persistence and creation:** local/worktree creation applies policy
      before work starts; retries and updates preserve unrelated state.
- [ ] **M2.2 Delivery enforcement:** agent and terminal user-facing notifications
      honor workspace policy while observation events and attention survive.
- [ ] **M2.3 CLI/MCP parity:** create, update, and readback demonstrate the same
      behavior and clear errors for unsupported hosts or failed writes.
- **G2:** targeted tests prove those contracts, same-directory workspace isolation,
  restored policy, and unchanged unmuted behavior. No full local suite.

### M3 — User controls

- [ ] **M3.1 Shared menu:** current policy and mute/unmute actions work from the
      sidebar context/button menu, with pending and failure feedback.
- [ ] **M3.2 Synchronization:** CLI/MCP changes update connected UI state, and UI
      changes are visible to automation without reconnecting.
- **G3:** desktop menu demonstration and UI/CLI/MCP synchronization; errors leave
  the authoritative state visible. Old-daemon gating is explicit. Android menu
  verification is deferred under D10 and is not a condition for this gate.

### M4 — Real-device proof and handoff

- [ ] **M4.1 Device delivery:** desktop/browser local notifications and Android remote
      push controls prove muted/unmuted behavior over relay/mobile data on the existing
      Android app.
- [ ] **M4.2 Build and record:** both macOS packaging paths pass for the feature
      revision; required checks pass and the proof states platform limitations.
- [ ] **M4.3 Cleanup:** remove only test hosts/pairings and temporary test resources
      after preserving concise evidence, with production unchanged.
- **G4:** actual phone-positive controls bracket muted trials; source-event evidence
  proves the muted events occurred. Record build revision, checks, and receipts.
  No claim of deployment, production readiness validation, or overseer integration.

The roadmap will map these boxes to explicit dependencies, proof, and human actions.

## 6. Verification and runtime cost

Use fast unit coverage for policy/default/eligibility matrices. Use fewer integration
tests for persistence, creation ordering, protocol and CLI/MCP contracts. Reserve
end-to-end coverage for one representative menu/automation synchronization journey
and real delivery controls. Do not repeat the full policy matrix in browsers.

Same-directory sibling workspaces must remain independent. Muted and unmuted
controls must share the same client-presence conditions, so focus suppression
cannot masquerade as policy enforcement. Prove observation state is retained.

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

Detailed reason matrices stay in unit tests; this gate samples the real path.
An installed old phone app can prove server-side suppression, but cannot prove a
new phone menu. Android menu verification is explicitly deferred under D10;
revisit it before claiming native menu behavior is verified or making a separate
Android UI release. Do not claim all-platform UI coverage from this campaign.

This is a future gated validation session: it needs explicit authorization to
launch the isolated test host/app, use Expo's external service, and ask the user
to pair/observe the phone. The earlier no-launch constraint remains in force now.
Propose a guided phone session after automated checks, with an early connectivity
probe before final UI work. Allow roughly 15 minutes for the guided checks, then
reassess if setup or OS delivery delays extend it; elapsed time alone never passes
the gate.

Use the installed Android app for the push gate; no mobile rebuild, debug app
installation, or upstream signing credentials are planned. Confirm the installed
variant supports push before the early connectivity probe. The F-Droid variant
excludes push support ([Android docs](android.md)) and cannot establish this gate.
If the installed variant or relay connection cannot support a positive control,
report the blocker and revisit the validation route without replacing the app.

No accepted numeric routine-test budget was found during grounding. The roadmap
must schedule an early measurement on the pinned baseline with fixed machine,
cache, and concurrency conditions, then set a reviewed budget. Previous build
durations are not a test-suite baseline. Maintain latency in each implementation
step without moving required evidence into optional checks. Never run the full
local suite; follow [testing](testing.md) and the repository's targeted-test rule.

## 7. Review and next action

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

Publish confirmed planning tiers to the personal fork, `iExalt/paseo`, never
upstream. Unconfirmed roadmap/script drafts remain local until their tier is
reviewed and confirmed. Keep feature implementation and production deployment
outside planning publication.
