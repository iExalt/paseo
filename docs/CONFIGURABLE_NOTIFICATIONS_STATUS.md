# Configurable notifications status

Last updated: 2026-10-08 04:54 UTC (2026-10-08 00:54 EDT)

## Purpose

This status links the [governing plan](CONFIGURABLE_NOTIFICATIONS.md) to the
[implementation roadmap](CONFIGURABLE_NOTIFICATIONS_ROADMAP.md) and
[execution script](CONFIGURABLE_NOTIFICATIONS_SCRIPT.md). It records current
evidence and the next gates; it is not a second implementation checklist.

## Current snapshot

| Field                        | Status                                                                                               |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| Baseline                     | Fixed T1 baseline `4ea125b83`, macOS arm64, Node 26.11; current branch includes T1 commit `de83523e` |
| Current phase                | S5c automation and S6 package builds verified; human OS notification proof remains open              |
| Overall state                | M2.1–M2.4 complete; OS notification proof, M1.2/S2, and G1 remain open                               |
| Immediate focus              | Arrange the authorized human OS-proof session using the prepared opt-in browser route                |
| Product or release readiness | CLI/MCP/UI flows have headless local verification; OS arrival and phone delivery remain open         |
| Worktree state               | S6 build subproof published as `82548f0cc`; test/docs-only OS-proof preparation accepted             |

The T1 result closes planning and feasibility questions only. S3a adds durable
workspace policy storage and mutation; S3b now enforces that policy for agent and
terminal attention delivery and advertises the capability. S3c now collects a
turn-scoped completion subject and provides a bounded RE2 matcher. S3d adds an
empty-by-default daemon-home `replyRules` list, validates and compiles the whole
candidate before persistence, and swaps the runtime matcher with the persisted
config transaction. Only opted-in current clients receive rules in the existing
authorized config-change event. Finished notifications consult the current
matcher after asynchronous lookups and use only the explicit immutable
completion subject; workspace mute takes precedence and other attention reasons
are unchanged. S4a adds workspace CLI/MCP create, update, and effective-policy
list adapters. S4b adds host-targeted rule get/set/clear and permission-scoped
MCP adapters with review acceptance. S5a's shared workspace menu is accepted.
The S5b host-rule editor is accepted. The S5c isolated browser journey now verifies
workspace and host-rule changes through the UI, CLI, and owner MCP client, plus
filtered and unfiltered mock completions at the browser Notification API. This is
not proof of operating-system notification arrival. The accepted design does not
establish that a provider never truncates its internal response. S3c lifecycle
tests are accepted; human desktop OS-arrival and phone gates remain required.

## Accomplishments with evidence

### Contract and feasibility

Evidence state: verified.

- The accepted workspace contract is binary, defaults enabled, and suppresses user-facing banners
  and push while preserving attention and observation events.
- M1.3 has an accepted source-grounded design: collect normalized assistant
  chunks after managed-turn identity assignment and before coalescing; retain only
  the latest contiguous segment; seal it only for the matching successful
  `turn_completed` before foreground finalization clears the active turn.
- Missing start, history, unknown or ambiguous identity, declared or unestablished
  truncation, overflow, stale terminal, cancellation, and failure fail open. No
  history or latest-message fallback is allowed. S3 must add focused lifecycle and
  counterexample tests before enforcement. Overflow stays incomplete until a
  genuinely new segment starts.
- RE2 feasibility was checked with `re2-wasm@1.0.2`. Limits are 8 rules, 256
  UTF-16 code units per pattern, and 16,384 per subject. Accept only unique `i`,
  `m`, and `u` flags; Unicode mode is fixed and implicit when omitted. Reject
  unsupported, duplicate, or malformed flags atomically. Invalid saves retain
  prior rules; an incomplete subject fails open. Matching performs no text
  normalization.
- Global `replyRules` use strict `PersistedConfigSchema` plus
  `DaemonConfigStore`, with whole-list RE2 validation before private-config
  persistence and transactional runtime matcher replacement. S3a separately
  adds the durable workspace field `notifications: "on" | "off"`; the real
  server advertises `workspaceNotifications` only after S3b delivery enforcement.
- Host reads require `daemon.read`; mutations require `daemon.manage`. Use an
  explicit host authorization context. Workspace-only permissions and the shared
  agent token do not grant global mutation. The current no-password session
  admission path grants owner permissions and must not be reused as an implicit
  host authorization shortcut.

Evidence: [plan source trace and design](CONFIGURABLE_NOTIFICATIONS.md#43-daemon-wide-reply-denylist),
including links to `handleStreamEvent`, `finalizeForegroundTurn`,
`checkAndSetAttention`, and the asynchronous notification callback. The latest
message getter lacks completion identity and is not a safe rule subject.

### Fixed routine-check baseline

Evidence state: verified. Measured on clean `4ea125b83` with copied dependencies
and build output, one Vitest worker, and no overlapping builds.

| Check                | Command result                          | Accepted budget | Investigation threshold |
| -------------------- | --------------------------------------- | --------------- | ----------------------- |
| Focused server tests | 92 passed; Vitest 7.49 s, wall 10.183 s | ≤15 s           | >15.183 s               |
| Root typecheck       | 27.508 s                                | ≤33 s           | >33.010 s               |
| Root lint            | 13.768 s                                | ≤19 s           | >18.768 s               |

A budget breach triggers investigation. Separately, investigate growth that is
both more than 20% and more than 5 s above the fixed baseline, plus material
cumulative growth. These triggers are not permission for regressions below them.
Observed RE2 sample timings are feasibility evidence, not a hard latency bound.

## Current boundary

- M1.2 and S2/G1 remain open until an isolated test host produces a user-observed
  positive push on the existing Android app over mobile data.
- S3a workspace policy storage and mutation are implemented, verified, and
  review-accepted. S3b enforces the stored policy for agent and terminal
  attention delivery, preserving attention/source events with
  `shouldNotify: false` while muted. S3c implements the collector and immutable
  completion subject. S3d implements bounded host-rule persistence and finished
  notification filtering, with focused tests and review acceptance. S4 CLI/MCP
  adapters are accepted; end-user workspace controls remain open.
- The original creation disconnect fixture fails on both this worktree and the
  untouched `4ea125b83` baseline at the same `prompts === 1` assertion (actual 7).
  The baseline run took 17.39 s in Vitest and 19.551 s wall time, so this is a
  reproduced baseline limitation rather than an S3a regression.
- S3c implements the collector and immutable callback subject, with focused
  foreground/autonomous lifecycle tests. S3d implements the bounded host-rule
  persistence and finished-notification filter, with focused storage, RPC,
  authorization, config-publication, and notification tests and review acceptance.
  CLI/MCP adapters are accepted; end-user workspace controls remain open.
- No desktop, phone, relay, daemon, or provider was launched for T1. Production
  state and deployment remain excluded.
- T2 is required before T5, but not before automated T3 or T4.

## Intermediate goals

### I0 — Contract, feasibility, and baseline

Workflow status: complete.

Evidence state: verified.

Decision owner: approved plan and user-confirmed campaign order.

Exit-condition owner: I0.

Dependencies: confirmed plan and implementation authorization.

Deliverables: source-grounded workspace and filter contracts, bounded-engine
feasibility, and a fixed routine-check baseline.

Exit conditions: M1.1/M1.3/S1/T1 accepted; baseline and practical budgets recorded.

Evidence: the accepted design and receipts above. No feature-code completion is
implied.

### I1 — Durable policy and automation parity

Workflow status: complete.

Evidence state: S3–S4 implementation and focused verification review-accepted;
M2.1–M2.4/G2 and T3 complete. Live delivery and user-control gates remain open.

Decision owner: approved plan.

Exit-condition owner: I1.

Dependencies: I0 evidence; T2 is not a prerequisite.

Deliverables: workspace policy persistence, delivery enforcement, and daemon-wide
reply filtering, followed by CLI/MCP create, update, and readback parity.

Exit conditions: focused tests preserve attention and source events; completion
subjects are immutable, matching-turn, complete retained live segments; host
authority and invalid-save behavior match the contract; required automation
operations have parity.

Evidence: S3 protocol, registry, provisioning, runtime mutation, delivery gating,
completion subjects, and bounded host-rule persistence/filtering are implemented
and review-accepted. Focused gates pass, with the creation disconnect baseline
limitation above. S4a workspace CLI/MCP parity is implemented and review-accepted;
S4b host-rule CLI/MCP adapters and explicit host authority are review-accepted.

## Recommended next sequence

1. T4: finish the isolated human OS notification proof; controls and package builds are verified.
2. T2: arrange and run the isolated phone-connectivity positive control.
3. T5: verify the final feature revision on the phone and clean up test resources.

This automated-first order is the user's current scheduling decision. T2 remains
a prerequisite for T5 only.

## Explicitly deferred

- **Phone connectivity proof (T2):** scheduled after automated T3 and T4.
- **Final phone proof and cleanup (T5):** depends on both T2 and T4.
- **Desktop runtime proof (T4):** depends on T3 and its named isolated launch gate.
- **Production deployment and overseer integration:** outside this campaign.

## Active risks and decisions

| Risk or decision             | Evidence or uncertainty                                                                                     | Consequence                                   | Mitigation or next evidence                                                                                            | Owner          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------- |
| Completion subject lifecycle | The collector covers observed live chunks, but cannot prove a provider did not silently truncate internally | A truncated provider reply could match a rule | Match only the complete retained live segment; missing, ambiguous, declared-truncated, or oversized subjects fail open | T3             |
| Host settings controls       | S5c headless journey verifies UI, CLI, MCP, and browser Notification API behavior; OS arrival is unverified | OS permission/display may differ from the API | Agree the isolated OS-human demonstration boundary without a Notification stub                                         | T4             |
| Phone/relay availability     | No phone positive control has been run                                                                      | G1 and final device proof remain open         | Run T2 after automated work, then T5 against the final revision                                                        | User and T2/T5 |

## Progress log

### 2026-10-08 01:04 UTC (2026-10-07 21:04 EDT)

- Implemented the S3a durable `notifications: "on" | "off"` workspace policy,
  optional backward-compatible wire fields, workspace create propagation, MCP
  creation propagation, and a runtime mutation RPC. The real server leaves
  `workspaceNotifications` unadvertised until S3b delivery enforcement.
- Focused S3a tests, root typecheck, lint, formatting, and generated protocol
  validation pass. The strengthened raw-wire test confirms an off workspace is
  persisted before its first descriptor while the real server leaves the
  capability unadvertised. MCP creation rejects explicit policy by default
  before parsing or side effects. The original creation disconnect assertion is
  a reproduced baseline limitation. S3 overall, delivery behavior, G1, phone
  proof, and production deployment remain open.
- Lead and navigator accepted the S3a snapshot. Final server build took 16.636 s;
  root typecheck, lint, and formatting took 17.354 s, 1.264 s, and 1.919 s.

### 2026-10-08 01:21 UTC (2026-10-07 21:21 EDT)

- Implemented S3b policy checks after asynchronous recipient/text lookups, using
  the captured workspace ID for both lookup and event payload. Muted workspaces
  suppress push and set `shouldNotify: false` without dropping legacy or modern
  attention events. Missing records retain the enabled behavior.
- Agent and terminal fixtures cover decision-time policy changes, distinct
  workspace IDs sharing a directory, muted and enabled push behavior, and
  modern/legacy delivery. The raw-wire creation and initial `server_info`
  capability tests pass with support enabled.
- Changed notification tests: 21 passed in 2.50 s. Targeted loopback tests:
  2 passed in 6.60 s; the first sandboxed attempt was blocked by listener
  permissions and was rerun outside the sandbox. Final server build took 15.381 s;
  root typecheck 18.695 s and lint 14.474 s. After the routing snapshot follow-up,
  server typecheck passed in 3.261 s; changed-file lint, formatting, and diff
  checks pass.
- Lead and navigator accepted S3b at 01:25 UTC (21:25 EDT). S3c filtering, user-facing controls, phone
  positive control, G1, and production deployment remain open.

### 2026-10-08 UTC (2026-10-07 EDT)

- Recorded reviewer-accepted M1.3 feasibility, source trace, RE2 constraints,
  fixed baselines, and practical budgets.
- Marked M1.1/M1.3/S1/T1 complete as contract and feasibility outcomes only.
- Updated the current sequence to T1 → T3 → T4 → T2 → T5. Implementation,
  G1, device proof, and production deployment remain open.

### 2026-10-08 01:39 UTC (2026-10-07 21:39 EDT)

- Implemented S3c pre-coalescer collection for clean foreground and autonomous
  turns, immutable successful-completion callback subjects, and a pure bounded
  `re2-wasm@1.0.2` matcher. No global rules are persisted or applied to delivery.
- Collector, matcher, and existing stream-coalescing tests passed: 39 tests in
  0.681 s. `npm run build:server`, root typecheck, and root lint passed. Formatting
  and the changed-file format check passed.
- The affected eight-file gate passed 138 tests in 7.821 s wall time against
  the fixed 10.183 s baseline, within the unchanged 15 s budget. Later focused
  lifecycle/ambiguity regression checks passed 37 tests in 1.242 s. A mismatched
  live timeline identity makes the whole turn ineligible, even after a later
  segment reset; stale terminals cannot clear a newer collector.
- Lead and navigator accepted S3c at 01:46 UTC (21:46 EDT). Final server build
  passed in 9.984 s. The new runtime dependency requires the final Nix npm hash
  refresh and packaging verification in S6.
- S3 overall, CLI and workspace controls, S2, G1, phone proof, and production
  deployment remain open.

### 2026-10-08 02:06 UTC (2026-10-07 22:06 EDT)

- Implemented S3d daemon-home `replyRules` persistence, whole-list RE2
  validation before config writes, transactional runtime matcher replacement,
  daemon.read/manage RPCs, and opted-in current-client config publication.
- Finished notifications consult the current matcher after asynchronous
  recipient/text lookups, using only the explicit completion subject. A match
  suppresses local and push delivery while preserving attention events; workspace
  mute has precedence, and other attention reasons do not consult reply rules.
- Focused storage, persisted-edit, authorization, collector, matcher, and
  notification gates passed (73 tests in 10.991 s wall); final notification
  routing and named Session RPC checks passed (16 and 1 tests). The client RPC
  test passed (1 test). `npm run build:server` passed in 16.464 s, root
  typecheck in 17.968 s, root lint in 12.042 s, and root format check in 0.942 s.
  The build required a dependency-free completion-subject type module so the
  scripts compiler does not pull in the agent timeline store and its unrelated
  ES2023 `findLast` use. A broad `session.test.ts` invocation was interrupted
  after 1:27 without test output; the new Session RPC case passed separately.
- S3d is awaiting lead review. S3 overall, CLI/MCP settings parity, user
  controls, S2, G1, phone proof, and production deployment remain open.

### 2026-10-08 03:10 UTC (2026-10-07 23:10 EDT)

- Implemented the shared workspace notification menu row in workspace header and
  sidebar context/dropdown menus. Legacy descriptors normalize to `on`; live
  descriptor updates drive the displayed state. A shared pending coordinator
  disables both surfaces during one RPC, and the ACK never writes descriptor
  state. Failures show the existing toast and retain the authoritative value;
  unsupported hosts show an explanation and cannot invoke the RPC.
- The focused store, replica, and rendered menu tests passed (32 tests in 2.88 s);
  translation-resource tests passed (39 tests in 0.62 s). Root typecheck, lint,
  and format check passed in 11.28 s, 7.12 s, and 0.93 s. No browser, Metro,
  desktop, or device journey ran; S5a awaits lead review, and S5c owns the
  combined browser proof.

### 2026-10-08 02:12 UTC (2026-10-07 22:12 EDT)

- The reload receipt now classifies `replyRules` as applied and verifies the
  matcher after reload. An injected atomic-writer failure retains the
  prior config bytes, runtime rules, and matcher. The local notification fixture
  confirms rules apply to two workspace IDs sharing one directory.
- The fixed five-file command passed 106 tests in 3.48 s Vitest time and
  4.002 s wall, within the 15 s budget and below the fixed 10.183 s baseline.
  Final `build:server`, root typecheck, lint, and format check passed in 9.678 s,
  11.446 s, 1.371 s, and 0.626 s respectively. `git diff --check` is clean.
- Lead and navigator accepted S3d at 02:14 UTC (22:14 EDT), closing S3 and
  M2.1/M2.2 within focused local verification. M2.4/G2, CLI/MCP settings parity,
  end-user controls, S2, G1, phone proof, and production deployment remain open.

### 2026-10-08 02:28 UTC (2026-10-07 22:28 EDT)

- Lead and navigator accepted S4a workspace CLI/MCP adapters at 02:31 UTC
  (22:31 EDT). CLI
  command-handler tests exercise valid create and update flag forwarding; the
  invalid-enum test is parser-only. The isolated journey uses real CLI daemon
  transport and an authenticated in-process MCP HTTP client against a disposable
  daemon with fake agent clients. It verifies local/worktree CLI creation, durable
  update/readback, and MCP create/set/list; it does not launch an app or provider.
- Focused CLI, MCP, Session, and journey tests passed (15, 6, 2, and 1 tests),
  followed by the valid registration case (1 test in 1.03 s wall). The journey
  passed in 7.88 s. Server build, root typecheck, lint, and formatting passed in
  9.97 s, 11.75 s, 1.33 s, and 0.67 s respectively; diff checks passed. The
  journey required an outside-sandbox rerun after loopback binding was denied in
  the sandbox. Host-rule adapters, S4b, M2.4/G2, end-user controls, S2, G1, phone
  proof, and production deployment remain open.

### 2026-10-08 02:47 UTC (2026-10-07 22:47 EDT)

- Lead and navigator accepted S4b at 02:49 UTC (22:49 EDT), closing S4,
  M2.3/M2.4/G2, and T3 within focused local verification. The CLI exposes
  daemon notification-rule get/set/clear through the existing host-targeted RPC;
  MCP reads require `daemon.read`, mutations require `daemon.manage`, and only
  the HTTP request's verified local-owner or daemon-password authorization gets
  those permissions. Anonymous and injected agent-capability requests retain
  workspace MCP admission but have no host permissions; direct provider catalogs
  also default to no host permissions.
- Focused auth/MCP tests passed (148 tests); the final token-priority and
  workspace-create/global-rule-isolation cases also passed individually. CLI
  registration, escaped JSON, malformed-input, and unsupported-host checks
  passed. The disposable real-transport journey passed (1 test, 7.06 s wall),
  verifying escaped rule set/readback, invalid-candidate retention, and
  anonymous/token denial versus local-owner MCP get/set/clear. Server build, root
  typecheck, root lint, and root format check passed in 10.09 s, 11.67 s, 1.53 s,
  and 0.62 s. No app, provider, relay, or production entrypoint was launched. T4,
  T2, T5, and G1 remain open.

### 2026-10-08 03:13 UTC (2026-10-07 23:13 EDT)

- Lead and navigator accepted S5a shared workspace menu/state. Header and
  sidebar context/button menus reuse the existing menu engine, read normalized
  authoritative descriptors, and share pending state by host and workspace ID.
  Mutation ACKs never patch descriptors. Failure shows an error and retains
  policy; unsupported hosts have a disabled, explained control.
- Focused store, replica, and rendered-menu checks passed (32 tests in 2.88 s);
  translation checks passed (39 tests in 0.62 s). The final rendered checks
  passed (3 tests in 1.97 s), proving competing selections issue one RPC, delayed
  ACKs cannot rewind live state, and failed writes permit retry. Root typecheck,
  lint, and formatting passed in 11.28 s, 7.12 s, and 0.55 s; diff checks passed.
- S5/G3 remains incomplete. The host editor, combined browser proof, feature
  builds, desktop/device delivery, S2/G1, and phone gates remain open. No browser,
  Metro, headed app, device, or real OS notification was started for S5a.

### 2026-10-08 03:38 UTC (2026-10-07 23:38 EDT)

- Implemented the S5b daemon-wide rule editor in the shared Host Agents settings
  surface. It subscribes to authorized current-client config events before the
  initial read, ignores a late read success or failure after a newer event, and
  treats the event stream as authoritative; mutation ACKs never replace saved
  state. Unchanged config events do not disturb dirty drafts. Dirty drafts remain
  intact on external updates and failed saves, with explicit reload/keep conflict
  choices and host-epoch isolation. The editor explains read/write permission
  context, filtering support, scope, RE2 syntax, flags, and limits in all supported
  locales.
- Focused editor/model/translation checks passed (52 tests, 2.32 s). They cover
  unchanged-config events, same-client disconnect/reconnect with late read
  completion, selected-host isolation, pending authoritative confirmation, and
  source input preservation. Root typecheck, lint, and format check passed in
  11.285 s, 1.457 s, and 0.605 s. No app export, browser, Metro, provider, relay,
  phone, or production process was started. S5b is accepted; S5/G3 remains
  incomplete and S5c/S6 gates remain open.

### 2026-10-08 04:17 UTC (2026-10-08 00:17 EDT)

- The isolated S5c headless journey passed (1 test, 10.2 s in Playwright; 18.8 s
  total command time including Metro/daemon setup and teardown). Metro's web bundle
  took 1.039 s. The same session verified workspace policy through the menu, CLI
  list, and owner MCP list; saved and invalid rules; external-update conflict and
  reload; and four real mock completions. A source-only observer retained all four
  finished events with notifications disabled. The browser Notification API calls
  were exactly `Unrelated answer` and, after clearing rules, `No news.`; workspace
  mute and a matching rule each suppressed their eligible completion. The matching
  suppression had a bounded 400 ms settling window before the exact call list was
  asserted. The screenshot is `.dev/configurable-notifications/s5c/reply-rules.png`.
- App typecheck passed in 3.313 s; changed-spec lint, formatting, and diff checks
  passed. The worker daemon and Metro stopped, the temporary worker home was
  removed, and no task-owned listener remained. A persistent React `uniProps` DOM
  warning did not prevent rendering or journey completion.
- Browser startup exposed a source-grounded Expo Router 57 navigation-context
  mismatch: nine runtime `useNavigation`, `useIsFocused`, and `useFocusEffect`
  imports now use Expo Router's public exports. This compatibility repair is
  committed separately as `07db5751b` and is not an untouched-main runtime proof.
  No native desktop app, actual OS notification, provider, relay, phone, or
  production state was used. S5/G3 still needs the isolated human OS-arrival
  demonstration; S6 feature builds remain outstanding. Build preparation will now
  precede that human session to follow the automated-first order and provide an
  identified feature artifact. S5/G3, S6 final acceptance, and T4 stay open until
  the original live proof passes.

### 2026-10-08 04:39 UTC (2026-10-08 00:39 EDT)

- M4.2's package-build subproof is accepted. Source was `2cd1ee978` plus the final
  Nix dependency hash `sha256-XTbk9VwrCHqjbHqvX5xTYPCw6ewCJ4R+M2+bALkrOos=`.
  Hash refresh took 53 s and changed only `nix/npm-deps.hash`; the lock stayed
  unchanged. The tracked-source snapshot and full identity receipt are retained
  under `.dev/configurable-notifications/s6/`.
- Unsigned npm macOS directory packaging passed in about 2 min 15 s; Expo export
  took 30.0 s. The 491 MB artifact is `s6/npm/mac-arm64/Paseo.app` under that
  evidence directory. Signing, notarization, publishing, and smoke launching were
  disabled. npm stdout was not retained as a separate log.
- Nix passed at one job and four cores, reusing cached Node/Electron. The output
  is `/nix/store/ws1zv706wxaccnvhp44d5l9gyamljmyp-paseo-desktop-0.11.0` (477 MB),
  retained through the task-owned indirect GC root `s6/nix-result`. Phase timings
  were dependency closure 55 s, install 24 s, patches 40 s, Expo 51.3 s, and
  desktop build 76 s; total shell wall time was not captured. The actual Nix log
  is retained. The snapshot lacks Git metadata, so Nix uses its existing zero
  revision-count fallback; npm/Nix metadata equality is not claimed.
- All eight patches applied. Static inspection found the native helpers and
  RE2 JavaScript/WASM in both packages; no app launched. No fork CI runs were
  available for the branch. Human OS arrival, S5/G3, final S6/T4 acceptance,
  and phone gates remain open. The next browser proof will use a disposable
  profile and real Notification API; its browser-level macOS permission scope
  must be authorized before launch.

### 2026-10-08 04:54 UTC (2026-10-08 00:54 EDT)

- The opt-in browser OS-proof mode and exact launch recipe are accepted for
  preparation only. The existing script records the disposable profile/home,
  pre-start validation, production environment scrub, real Notification API,
  user-click permission button, two-minute permission bound, and ten-second
  spacing for the same four completion trials. The five-minute test remains
  unexecuted in that mode; actual OS arrival is still a human gate.
- The exact comparable default headless command passed: case 10.1 s, Playwright
  total 18.6 s, shell wall 19.01 s, against the unchanged accepted 10.2 s/18.8 s
  journey. Metro warmed in 3.02 s and the isolated daemon was ready 2.07 s after
  runner start; both stopped afterward. The earlier explicit-home run's 44.2 s
  was total setup-inclusive time, initially conflated with its 11.1 s case;
  it is not a comparable baseline. No material latency regression was found.
- App typecheck, changed-file lint, format, and diff checks passed. These are
  test/docs-only changes after the identified package source; no package rebuild,
  headed browser, actual Notification API trial, or permission action ran.
  S5/G3, final S6/T4, and phone gates remain open.
