# Upstream rebase inputs and supersession ledger

The version 2 ledger carries the 2026-11-14 source review onto the curated `dev` series. Exact fully superseded and empty/history-only matches are drop instructions; partial decisions require target-bound reviewed replay receipts. Retained curated commits keep one-to-one replay. [The rebase procedure](upstream/rebase-dev.md#carry-supersession-decisions-forward) owns matching, target and release-boundary safeguards.

No production rebase, conflict training, fixup generation or candidate platform proof was run for this ledger change. Source classifications do not establish runtime parity.

## Frozen inputs

- Fork `dev` (0.28.0): `cb6ccc43a5983d24d30af819a7ec6c6fa6a85557`.
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

The incoming capture contains 307 non-merge commits. The curated fork capture contains 128. The original source inventory covered 734 fork commits, and its touched-path union overlapped incoming history on 408 paths. That historical count is neither a net-tree overlap nor a predicted conflict count for the curated series.

[The manifest and ledger](upstream-rebase-inventory.json) retains the incoming inventory and target evidence. Its `fork` array now keys curated commits by subject plus `git patch-id --stable`, with the curated SHA as a hint. Direct old-to-curated mappings and shared-file hunk contributors both participate in aggregation. Reasons, upstream evidence and retained outcomes survive aggregation. The archive branch [`archive/dev-2026-11-14`](https://github.com/iExalt/paseo/tree/archive/dev-2026-11-14) at `b037344126bf21c118a1e6d6ab4a15436600f930` retains old source commits. The [pre-migration inventory](https://github.com/iExalt/paseo/blob/cb6ccc43a5983d24d30af819a7ec6c6fa6a85557/docs/upstream-rebase-inventory.json) retains the SHA-keyed classifications. These are historical provenance, not additional replay inputs.

The ledger refreshes the three scrubbed identities against the signed curated series: the rebase engine, the 0.28.0 release metadata and its release-please boundary. The ten partial rows carry reviewed retain receipts for `c1d7d56b71960bca17ce86f8d358445b6135b809`, grounded in the [reviewed rehearsal](https://github.com/iExalt/paseo/commit/744f502c5a8d7ad8297d10e59c0fbb5e37cfd218). Integration and platform gates remain separate.

The ledger covers the captured curated series. New descendants retain by default. A changed patch on a known subject or SHA requires reviewed reclassification; target-bound conflict, fixup and platform proof still needs refreshing when its inputs change.

## Decisions

| Category             | Curated commits | Replay                                                                                          |
| -------------------- | --------------: | ----------------------------------------------------------------------------------------------- |
| keep                 |             116 | Retain one-to-one.                                                                              |
| fully superseded     |               2 | Drop exact matches against the reviewed target or a descendant.                                 |
| partially superseded |              10 | Retain with an exact-target review receipt; preserve constituent reasons and distinct outcomes. |
| empty/history-only   |               0 | No standalone empty entry survives curation.                                                    |

The six old empty/history-only entries became four mixed curated commits and two omitted source commits. The mixed commits are partial; the omitted commits have no curated patch to replay. The curated release-metadata commit also inherits a partial shared-file contributor, so it requires a reviewed retain receipt for each target. Curation is not evidence that an overlapping outcome is dispensable.

### Fully superseded behavior

- `3ea263557de459e60c86cd0624b2dc083b66d868`:
  upstream `b280ca53554295b9cf8b60afb08076152c6703bf` retains the explicit
  `--var PASEO_RELAY_UPSTREAM:` in `packages/relay/src/e2e.test.ts`. Keep the
  override once and retain local-worker isolation.
- `23904996c5b637d44097b716354d9eadcb63d9ad`:
  `40b95f70f409b8d636bbbb7cb93002850fb6528d` duplicates the inverted-list
  wheel correction, then `4f7813d3aafdb5f6cdcf5453d0128c1156f80e60` removes
  the inverted implementation and its correction/tests in favor of forward
  LegendList. This verdict requires adopting that noninverted list. If replay
  keeps any inverted consumer, retain its correction and reopen the verdict.
  Check `packages/app/modules/paseo-scroll/` for independently used test context
  before deleting the old test scaffolding. Later Android proof must cover wheel
  direction, history prepend and reading position.

### Partial overlap

- `d5636a1ef`: target evidence: `0a549945b` replaces JS terminal rows with native views and layout caches.; retain and reconcile: Keep fork screen-store subscriptions, latency stages, find/selection overlays and bundled fonts through the new renderer; do not restore deleted JS row abstractions. Native latency parity remains unproven..
- `13344965c`: target evidence: `82d5f6c58` backports root constraints to Unistyles 3.2.4.; retain and reconcile: Keep selected 3.8.1 and CSSOM resize detection/self-check. Existing local 3.8.1 source preserves latest root constraints/context on retry. Confirm it from the locked clean install before choosing C++ hunks; source presence does not prove Android rotation runtime..
- `2d944a59d`: target evidence: `4f7813d3a` pins disclosure trigger edges.; retain and reconcile: Carry content reveal and the active-element stale-trigger guard through `holdRow`; preserve find/outline jumps after an earlier toggle..
- `989d75d53`, `989d75d53`, `989d75d53`: target evidence: `1c4400194`, `9e607a3aa` supply shortcut dispatch and physical arrows.; retain and reconcile: Keep broader terminal key capture, iPad command priorities, app-shortcut priority and Android IME Enter/Backspace pairing. Preserve the explicit unsupported fork iOS build gate..
- `b129c036a`, `b129c036a`, `b129c036a`: target evidence: `c6f0c24bf` creates separate summary rows.; retain and reconcile: Carry CLI sends, received-agent input membership, folded message counts and downward expansion into those rows..

Full SHAs, source paths and the cheapest later invariant checks are on each
ledger row. These checks are requirements for later adaptation, not results of
this inventory.

### Distinct behavior to keep

- In-place Claude rewind (`7ad5c90ba`) keeps helpers alive; `b117e3fb0` adds
  steered-message anchors. The target resolver is async, so adapt the fork's
  `trackedRewindLeaf` and other callers rather than losing either behavior.
- Last-agent workspace archive (`9755b4904`) and unpublished worktree cleanup
  (`7f97257d1`) remain distinct from upstream sidebar archive/undo and timestamp
  restoration (`6c1b48d29`, `83f4ef990`). Preserve lifecycle locks and undo's
  operation ownership.
- Fork sliced decryption and native base64 decoding (`cb8e1efdf`, `cb8e1efdf`,
  `cb8e1efdf`) remain alongside chunk framing and routed backpressure
  (`0be49c062`, `01888dc5d`). Test ordering and close during decrypt later.
- Plugin API compatibility across the fork's version reset (`7d13cddd7`) remains
  separate from options APIs (`28c188513`). `af6ca46ae` already retains the old
  `timeline: []` hook payload behind a compatibility shim; its breaking-change
  subject alone does not establish a fork API-version decision.
- Live skill refresh (`737ebdafd`) watches edits during sessions; `eab9ac3b0`
  waits for late initial ACP command batches. Preserve both lifecycles.
- Terminal process-tree cleanup (`96f0510df`) snapshots descendants and birth
  times before signaling; `68fc16b85` authenticates terminal worker ownership
  without process identity queries. Preserve cleanup without signaling unknown
  identities.
- Native favicon unmount/selector invariants (`c1a72ed6e`) and retained hidden
  chat selectors (`c1a72ed6e`) remain distinct from `d426088c3` scalar selectors,
  demand gating and open-tab subscriptions, and `e79e826e2` field sharing.
- Retain notification policy/background dismissal, queue/steer, native find,
  outline and diff selection, MCP-to-CLI transport and the new CLI parity work,
  fork updater/release behavior and selected toolchain. Shared paths do not
  establish supersession.

### History and release markers

Curation folded obsolete and empty source history into the groups above or omitted it when no independent final-state projection survived. The archived source inventory records those old decisions. Intentional release markers remain retained. Newly empty picks still stop unless the existing reviewed conflict/deletion handling explicitly preserves an empty retained commit.

The old S1–S7 fixes already landed in #233–235 and #237. They are not new savings. Retain their curated outcomes and the broad parity commit rather than treating the historical audit as new removals. Watched upstream PR numbers #6466, #4398 and #5756 are not semantic proof of equivalence. Shared paths do not establish supersession.

## Integration constraints for later work

The manifest lists exact patch filenames on both sides. Keep the fork-selected
versions: Node 26.13.0, Rust 1.99.1, Java 27, Android SDK 23, Unistyles 3.8.1,
SVG 15.15.5 and WebView 13.16.1. Upstream pins older tools and several older patch
versions. Reconcile patch contents and `scripts/postinstall-patches.mjs` against
installed packages; never accept an entire upstream patch/version set wholesale.
In particular, combine `fc710be1a` linked-badge Markdown changes with the fork's
`5588838ec` preview repair and retained native focus/web image behavior.

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
`fff14240619cd393ba1b09d9e1ee85908ccfffed`, preserved through the archived history and curated source projection.
Preserve those fixes instead of reopening the old reports from the earlier
snapshot. The separate retry/cancellation guard verification task remains parked;
this inventory does not adopt it or add dependencies. Those are tracker/source
statuses, not fresh runtime proof.

## Reproduction and evidence boundary

Recompute the captured curated list with `git rev-list --reverse --topo-order --no-merges BASE..TIP`. Compute identities with `git show --format= --binary --no-ext-diff --no-textconv --no-renames --ignore-submodules=none --no-color SHA | git patch-id --stable`, paired with `git show -s --format=%s SHA`. A null patch ID identifies an empty patch; it does not classify the commit for dropping. The immutable capture and archive refs make the source review reachable after rewritten SHAs change. No new generator or proof framework is required to consume the ledger.

Source review covered all commit subjects/touched-path inventories and selected
high-risk comparisons, including the 44 incoming and 38 fork commits added since
the prior review. It does not claim a line-by-line semantic audit of all 1,041
commits. Default keep is conservative replay policy; non-keep rows carry source
evidence. Patch identity and shared paths alone do not establish supersession.

Later replay uses Git >=2.55 and the merge-backend procedure in [the rebase guide](upstream/rebase-dev.md). Validation runs `mise run --skip-tools ci:routine` against the exact candidate; the workflow pins Node 26.13.0 / npm 11.20.0. That guide owns execution and diagnostics; this document records the source inventory and performance baseline.

The routine budget is under 300 seconds excluding initial queue and including
job scheduling; it is separate from the rebase job's hard limit. The existing [captured-dev baseline](https://github.com/iExalt/paseo/actions/runs/43602539783)
passed eight routine lanes in 210 seconds from plan start to the required check
(217 seconds from workflow creation to completion). It used Ubuntu 26.04 x86_64
image `20261111.196.1`, Node 26.13.0 / npm 11.20.0 and a warm installed-dependency
cache. Compare a future candidate under the same lane, runner and cache
conditions; a docs-only PR selects fewer checks and cannot establish candidate
performance parity. No candidate CI, build, replay or platform result is
implied by publication of this docs PR.
