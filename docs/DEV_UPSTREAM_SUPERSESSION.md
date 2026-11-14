# Upstream rebase inputs and supersession ledger

Target selected at 15:10 UTC on 2026-11-14; refs read back after fresh fetch on the Mac. This source inventory and replay ledger covers the next rebase. No rebase, conflict training, fixup generation or candidate platform
proof has run. Keep the fork's one-to-one replay contract, including redundant
and intentionally empty commits. A supersession classification permits removing
redundant code during later reviewed adaptation; it does not authorize dropping
or squashing history.

## Frozen inputs

- Fork `dev` (0.28.0): `8c5a2620b92b09ad6db1d8b4b31917bc25c0bc5f`.
- Target mirror `origin/upstream/main`: `42c7b7f886ff1395d4d292838daaca9ca929cbda`.
- Actual upstream at target selection: `42c7b7f886ff1395d4d292838daaca9ca929cbda`.
- Actual upstream at fresh readback: `a730ad1924f1f067889db69193e5c3fdbd964e09`.
- Merge base / incorporated upstream: `a4f696620b5d248598a882b1a78d82ec5038c74b`.
- `rebase-resolutions`: `553fea05a0312196bf948570c3d4695fa9967baa`.

The mirror contains the selected actual-upstream tip. Fresh readback found one
post-capture commit, `a730ad192`, giving restored runtimes a fresh idle-cleanup
window in agent-manager.ts and its tests. It is recorded separately in the
manifest and is outside the frozen target. This preserves the captured target;
retargeting later requires refreshing the inventory and target-bound evidence.

The incoming range contains 307 non-merge commits, up from the prior 263; the fork range contains 734, up from
696. Both ranges contain zero merges. The unions of paths touched anywhere in
each history overlap on 408 paths, including paths later deleted. This count is
neither a net-tree overlap nor a predicted conflict count.

[The manifest and full ledger](upstream-rebase-inventory.json) records every
incoming and fork commit's full SHA, subject and touched paths, the exact refs,
new docs, patch filenames, tool versions and workflow changes. Its `fork` array
is the replay ledger in topological order. Every fork commit has a category,
replay rule, retained behavior and cheapest later proof. `source_paths` and
`upstream` identify independently inspected overlap candidates; the default keep
entries preserve history without claiming semantic uniqueness.

A changed input invalidates target-bound resolution, fixup and proof data. This
PR itself adds a docs commit to `dev` after the capture. Later rehearsal must
record that descendant separately and refresh the fork inventory before replay;
the 734 rows describe the captured input, not the future branch tip.

## Decisions

- keep: commits: 717; meaning: Preserve replay; explicit high-risk comparisons are in the ledger..
- fully superseded: commits: 2; meaning: Redundant behavior can be removed under the conditions below; retain replay history..
- partially superseded: commits: 9; meaning: Reconcile the overlapping implementation and retain distinct fork outcomes..
- empty/history-only: commits: 6; meaning: Four already-empty nonrelease commits and two obsolete implementations; retain replay..
- unresolved: commits: 0; meaning: No source-unsettleable replay choice is selected. Implementation and runtime proof remain pending..

### Fully superseded behavior

- `f7d0538e0193cc7818a9b2982298503e8b2525ee`:
  upstream `b280ca53554295b9cf8b60afb08076152c6703bf` retains the explicit
  `--var PASEO_RELAY_UPSTREAM:` in `packages/relay/src/e2e.test.ts`. Keep the
  override once and retain local-worker isolation.
- `c5839fdf40c0b7aa40a50d807f7e1645dae69b9f`:
  `40b95f70f409b8d636bbbb7cb93002850fb6528d` duplicates the inverted-list
  wheel correction, then `4f7813d3aafdb5f6cdcf5453d0128c1156f80e60` removes
  the inverted implementation and its correction/tests in favor of forward
  LegendList. This verdict requires adopting that noninverted list. If replay
  keeps any inverted consumer, retain its correction and reopen the verdict.
  Check `packages/app/modules/paseo-scroll/` for independently used test context
  before deleting the old test scaffolding. Later Android proof must cover wheel
  direction, history prepend and reading position.

### Partial overlap

- `e8fb2e6c5`: target evidence: `0a549945b` replaces JS terminal rows with native views and layout caches.; retain and reconcile: Keep fork screen-store subscriptions, latency stages, find/selection overlays and bundled fonts through the new renderer; do not restore deleted JS row abstractions. Native latency parity remains unproven..
- `5311a29f2`: target evidence: `82d5f6c58` backports root constraints to Unistyles 3.2.4.; retain and reconcile: Keep selected 3.8.1 and CSSOM resize detection/self-check. Existing local 3.8.1 source preserves latest root constraints/context on retry. Confirm it from the locked clean install before choosing C++ hunks; source presence does not prove Android rotation runtime..
- `b350abca4`: target evidence: `4f7813d3a` pins disclosure trigger edges.; retain and reconcile: Carry content reveal and the active-element stale-trigger guard through `holdRow`; preserve find/outline jumps after an earlier toggle..
- `6f98ef0e4`, `847a095a3`, `00554122b`: target evidence: `1c4400194`, `9e607a3aa` supply shortcut dispatch and physical arrows.; retain and reconcile: Keep broader terminal key capture, iPad command priorities, app-shortcut priority and Android IME Enter/Backspace pairing. Preserve the explicit unsupported fork iOS build gate..
- `293034650`, `7f37aa3a7`, `bd0e87cc2`: target evidence: `c6f0c24bf` creates separate summary rows.; retain and reconcile: Carry CLI sends, received-agent input membership, folded message counts and downward expansion into those rows..

Full SHAs, source paths and the cheapest later invariant checks are on each
ledger row. These checks are requirements for later adaptation, not results of
this inventory.

### Distinct behavior to keep

- In-place Claude rewind (`2125b9b4f`) keeps helpers alive; `b117e3fb0` adds
  steered-message anchors. The target resolver is async, so adapt the fork's
  `trackedRewindLeaf` and other callers rather than losing either behavior.
- Last-agent workspace archive (`54a8905a1`) and unpublished worktree cleanup
  (`75b6d946a`) remain distinct from upstream sidebar archive/undo and timestamp
  restoration (`6c1b48d29`, `83f4ef990`). Preserve lifecycle locks and undo's
  operation ownership.
- Fork sliced decryption and native base64 decoding (`53020cd43`, `70f41fb7c`,
  `ffe45e7e2`) remain alongside chunk framing and routed backpressure
  (`0be49c062`, `01888dc5d`). Test ordering and close during decrypt later.
- Plugin API compatibility across the fork's version reset (`005155fd1`) remains
  separate from options APIs (`28c188513`). `af6ca46ae` already retains the old
  `timeline: []` hook payload behind a compatibility shim; its breaking-change
  subject alone does not establish a fork API-version decision.
- Live skill refresh (`4a3a8be53`) watches edits during sessions; `eab9ac3b0`
  waits for late initial ACP command batches. Preserve both lifecycles.
- Terminal process-tree cleanup (`08cb69b07`) snapshots descendants and birth
  times before signaling; `68fc16b85` authenticates terminal worker ownership
  without process identity queries. Preserve cleanup without signaling unknown
  identities.
- Native favicon unmount/selector invariants (`1aa055cc1`) and retained hidden
  chat selectors (`3e405115b`) remain distinct from `d426088c3` scalar selectors,
  demand gating and open-tab subscriptions, and `e79e826e2` field sharing.
- Retain notification policy/background dismissal, queue/steer, native find,
  outline and diff selection, MCP-to-CLI transport and the new CLI parity work,
  fork updater/release behavior and selected toolchain. Shared paths do not
  establish supersession.

### Old history candidates

The previous audit used commit IDs from before the last rebase. Current mappings:

- `83387d6ca`: captured fork id: `25758352d3`; current source result: Installer deleted by `7e8941f78`; candidate CI removed by `bc9558156`/`d2ab6e42b`. Target early install calls `polyfillNavigator` before consumers..
- `0959d34fb`: captured fork id: `6ba169a3fe`; current source result: WebView hash/generated HTML removed by `73d599696` after upstream removes that renderer..
- `ccd1576fe`: captured fork id: `e637bf2511`; current source result: Tree equals parent; empty nonrelease commit..
- `79336b7f4`: captured fork id: `07e0cc5566`; current source result: Tree equals parent; empty nonrelease commit..
- `4db10f49f`: captured fork id: `fe7020e01b`; current source result: Tree equals parent; empty nonrelease commit..
- `472b2ca4c`: captured fork id: `01624f09ce`; current source result: Intentional empty release marker; keep..
- `4ebf3e3d5`: captured fork id: `67f10da63d`; current source result: Intentional empty release marker; keep..

`ae42e1986e` is also empty at the captured fork tip. None is a history-drop
instruction. Dropping the first two would also require rewriting later deletion
hunks and same-tip-tree proof, outside this scope. Newly empty picks still stop;
use the existing reviewed conflict/deletion handling rather than silently skipping.

The old S1–S7 fixes already landed in #233–235 and #237. They are not new savings.
The current ledger retains their commits and the broad parity commit `3066fa703e`
(the former `0dfb58612`) rather than treating the historical audit as a new set of
removals. The watched upstream PR numbers #6466, #4398 and #5756 are not semantic
proof of equivalence. The fork's current streamed-block handling (`405fe9076c`)
and platform packaging remain keep unless source establishes a replacement.

## Integration constraints for later work

The manifest lists exact patch filenames on both sides. Keep the fork-selected
versions: Node 26.13.0, Rust 1.99.1, Java 27, Android SDK 23, Unistyles 3.8.1,
SVG 15.15.5 and WebView 13.16.1. Upstream pins older tools and several older patch
versions. Reconcile patch contents and `scripts/postinstall-patches.mjs` against
installed packages; never accept an entire upstream patch/version set wholesale.
In particular, combine `fc710be1a` linked-badge Markdown changes with the fork's
`c9e4884f9` preview repair and retained native focus/web image behavior.

Move new upstream top-level docs `agent-stream-disclosure.md`,
`keyboard-shortcuts.md` and `terminal-rendering.md` into `docs/upstream/` during
later fixup work, repair links and update the CLAUDE docs table. The new
`docs/qa-evidence/pi-resumed-subagents/` files need their relative references
checked without flattening the evidence layout.

Check platform resolution explicitly: fork `composer/dock/index.native.tsx`
shadows upstream's generic file. Typecheck alone cannot prove runtime export or
native behavior parity. Timeline, terminal, keyboard/IME, archive/undo,
notifications, updater and plugin surfaces need the later platform matrix.
Incoming iOS changes are inventoried, not proven on a device. No physical device
or Google Play Services proof was performed here.

The resolution snapshot contains 289 IDs / 632 resolution files, five historical
fixup patches and 50 deletion/keep records across five historical target SHAs.
It has no fixup or deletion record named for the selected target. These counts
establish stored data, not conflict coverage. Do not mutate `rebase-resolutions`, generate fixups, train rerere, dispatch
`rebase-dev`, or publish a rebase as part of this ledger task.

The previously listed browser dependency-optimization, shared timeline-fencing
and subscription-memory-test risks are now recorded done in the tracker at
`abefe5e7e8e25d2e1143a516658be4e5f3f238ac`, already an ancestor of captured dev.
Preserve those fixes instead of reopening the old reports from the earlier
snapshot. The separate retry/cancellation guard verification task remains parked;
this inventory does not adopt it or add dependencies. Those are tracker/source
statuses, not fresh runtime proof.

## Reproduction and evidence boundary

Recompute each list with `git rev-list --reverse --topo-order --no-merges
BASE..TIP`, its subjects with `git show -s --format=%s SHA`, and its paths with
`git diff-tree --root --no-commit-id --name-only -r SHA`. Empty means the commit's
tree equals its parent's tree. The manifest uses full immutable SHAs, not branch
names, for the captured ranges. No generator or new validation framework is
required to consume it.

Source review covered all commit subjects/touched-path inventories and selected
high-risk comparisons, including the 44 incoming and 38 fork commits added since
the prior review. It does not claim a line-by-line semantic audit of all 1,041
commits. Default keep is conservative replay policy; non-keep rows carry source
evidence. Patch identity and shared paths alone do not establish supersession.

Later replay uses Git >=2.55 and the merge-backend flags in
[the rebase procedure](upstream/rebase-dev.md). At this captured dev revision,
`.github/scripts/rebase-dev.mjs` validation invokes
`mise run --skip-tools ci:routine` against the exact candidate tree, and
`.github/workflows/rebase-dev.yml` pins Node 26.13.0 / npm 11.20.0 with a 45-minute
job limit. Failure diagnostics are a bounded step summary. The older procedure's
narrow validation/artifact wording needs reconciliation in the later mechanics
work; do not use that wording as the execution contract.

The routine budget is under 300 seconds excluding initial queue and including
job scheduling; it is separate from the rebase job's hard limit. The existing [captured-dev baseline](https://github.com/iExalt/paseo/actions/runs/43602539783)
passed eight routine lanes in 210 seconds from plan start to the required check
(217 seconds from workflow creation to completion). It used Ubuntu 26.04 x86_64
image `20261111.196.1`, Node 26.13.0 / npm 11.20.0 and a warm installed-dependency
cache. Compare a future candidate under the same lane, runner and cache
conditions; a docs-only PR selects fewer checks and cannot establish candidate
performance parity. No candidate CI, build, replay or platform result is
implied by publication of this docs PR.
