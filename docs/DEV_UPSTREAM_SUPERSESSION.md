# Upstream rebase inputs and supersession ledger

The version 2 [ledger](upstream-rebase-inventory.json) records fork commits and
their supersession decisions. Retained commits replay one-to-one. Partial
decisions require a source retain receipt for the exact target.
[The rebase procedure](upstream/rebase-dev.md#carry-supersession-decisions-forward)
owns matching and release-boundary safeguards.

## Published rebase

- Published fork dev: `1a488ea75bb3d714ca442027d307e5156eeed181`, from [rebase-dev run 46025306940](https://github.com/iExalt/paseo/actions/runs/46025306940).
- Pre-rebase dev: `78659722ce22d3365166cd3aa89047299eea9d8c`, preserved at `backup/rebase-dev/46025306940-1`.
- Incorporated upstream: `518e58cd639f01f63da35544bce3eff5123b10ee`.
- Resolutions: `9df92c453ba668eab31a448f372ad7b578611abd`.

The published history has 271 non-merge commits above the incorporated
upstream. The verifier matched all 268 retained commits and three generated
commits to the clean replay. Each published commit carries the pinned
production signature and GitHub verification. The final tree differs only in
the generated `last-release-sha`.

The ledger carries 143 prior rows by replay position and recomputes their
identities on published dev. Of those rows, 61 have a changed patch ID. It adds
128 keep rows, including the three generated commits, and preserves three
historical drop decisions. The engine planner retains the full published
history with zero drops at the incorporated upstream.

Seven of the ten partial patches changed during replay. Each changed receipt
records the fresh source decision and the original and published patch
comparison. Three receipts retain their existing patch ID. Review all partial
decisions against any newer upstream before rehearsal.

The minimum upstream ancestor remains
`d49991318f088623155231a1e293d4efc7b3cade` to require the #620 replacement.
The manifest records the publication in `provenance.published_rebase` and
preserves the earlier source capture in `counts`, the incoming inventory,
and the other `refs` fields. The
[previous ledger](https://github.com/iExalt/paseo/blob/78659722ce22d3365166cd3aa89047299eea9d8c/docs/upstream-rebase-inventory.json)
records the source decisions before this publication.

## Decisions

| Category             | Ledger rows | Replay                                              |
| -------------------- | ----------: | --------------------------------------------------- |
| keep                 |         261 | Retain one-to-one.                                  |
| partially superseded |          10 | Retain with the exact-target source review receipt. |
| fully superseded     |           3 | Historical drops absent from published history.     |

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

- `e623aa387766e8d2b8457a7645e0aa323eddbb46`:
  upstream `d49991318f088623155231a1e293d4efc7b3cade` preserves the index timestamp
  and covers same-size edits in both comparison modes. The decision accepts
  dropping the fork's fixture hardening and bigint rounding. The precision edge
  remains an upstream candidate. Keep both comparison cases in validation.
  [Supersession decision #623](https://github.com/iExalt/paseo/pull/623)

### Partial overlap

The ten [retain receipts](upstream-rebase-inventory.json) carry the current
source witnesses and the cheapest checks for each affected behavior.

### Distinct behavior to keep

- In-place Claude rewind (`591c7b95c`) keeps helpers alive; `b117e3fb0` adds
  steered-message anchors. The target resolver is async, so adapt the fork's
  `trackedRewindLeaf` and other callers rather than losing either behavior.
- Last-agent workspace archive (`91afeb77c`) and unpublished worktree cleanup
  (`5e4d78f3b`) remain distinct from upstream sidebar archive/undo and timestamp
  restoration (`6c1b48d29`, `83f4ef990`). Preserve lifecycle locks and undo's
  operation ownership.
- Fork sliced decryption and native base64 decoding (`d9d919481`, `d9d919481`,
  `d9d919481`) remain alongside chunk framing and routed backpressure
  (`0be49c062`, `01888dc5d`). Test ordering and close during decrypt later.
- Plugin API compatibility across the fork's version reset (`d5a65223e`) remains
  separate from options APIs (`28c188513`). `af6ca46ae` already retains the old
  `timeline: []` hook payload behind a compatibility shim; its breaking-change
  subject alone does not establish a fork API-version decision.
- Live skill refresh (`553040991`) watches edits during sessions; `eab9ac3b0`
  waits for late initial ACP command batches. Preserve both lifecycles.
- Terminal process-tree cleanup (`474d00219`) snapshots descendants and birth
  times before signaling; `68fc16b85` authenticates terminal worker ownership
  without process identity queries. Preserve cleanup without signaling unknown
  identities.
- Native favicon unmount/selector invariants (`35e709958`) and retained hidden
  chat selectors (`35e709958`) remain distinct from `d426088c3` scalar selectors,
  demand gating and open-tab subscriptions, and `e79e826e2` field sharing.
- Retain notification policy/background dismissal, queue/steer, native find,
  outline and diff selection, MCP-to-CLI transport and the new CLI parity work,
  fork updater/release behavior and selected toolchain. Shared paths do not
  establish supersession.

### History and release markers

Curation folded obsolete and empty source history into the groups above or omitted it when no independent final-state projection survived. The archived source inventory records those old decisions. Intentional release markers remain retained. Newly empty picks still stop unless the existing reviewed conflict/deletion handling explicitly preserves an empty retained commit.

The old S1–S7 fixes already landed in #233–235 and #237. They are not new savings. Retain their curated outcomes and the broad parity commit rather than treating the historical audit as new removals. Watched upstream PR numbers #6466, #4398 and #5756 are not semantic proof of equivalence. Shared paths do not establish supersession.

## Integration constraints for later work

Preserve the fork-selected toolchain and dependency versions when reconciling
upstream changes. The [rebase guide](upstream/rebase-dev.md) owns fixup, docs-layout
and validation requirements.

Check platform resolution explicitly: fork `composer/dock/index.native.tsx`
shadows upstream's generic file. Typecheck alone cannot prove runtime export or
native behavior parity. Timeline, terminal, keyboard/IME, archive/undo,
notifications, updater and plugin surfaces need the later platform matrix.
Incoming iOS changes are inventoried, not proven on a device. No physical device
or Google Play Services proof was performed here.

Stored resolution records cover this target only. A newer target needs new
rerere training, fixups and validation.

The previously listed browser dependency-optimization, shared timeline-fencing
and subscription-memory-test risks are now recorded done in the tracker at
`bf81c7fe008b4351dc6497aa9fccb48de46245bf`, preserved through the archived history and curated source projection.
Preserve those fixes instead of reopening the old reports from the earlier
snapshot. The separate retry/cancellation guard verification task remains parked;
this inventory does not adopt it or add dependencies. Those are tracker/source
statuses, not fresh runtime proof.

## Reproduction and evidence boundary

Recompute the captured curated list with `git rev-list --reverse --topo-order --no-merges BASE..TIP`. Compute identities with `git show --format= --binary --no-ext-diff --no-textconv --no-renames --ignore-submodules=none --no-color SHA | git patch-id --stable`, paired with `git show -s --format=%s SHA`. A null patch ID identifies an empty patch; it does not classify the commit for dropping. The immutable capture and archive refs make the source review reachable after rewritten SHAs change. No new generator or proof framework is required to consume the ledger.

The carry-forward checks each ledger identity against the published chain.
The partial receipts record source decisions. Platform and device proof
remains scoped to the checks that ran.

Later replay uses Git >=2.55 and the merge-backend procedure in [the rebase guide](upstream/rebase-dev.md). Validation runs `mise run --skip-tools ci:routine` against the exact candidate; the workflow pins Node 26.13.0 / npm 11.20.0. That guide owns execution and diagnostics; this document records the source inventory and performance baseline.

The routine budget is under 300 seconds excluding initial queue and including
job scheduling; it is separate from the rebase job's hard limit. The existing [captured-dev baseline](https://github.com/iExalt/paseo/actions/runs/43602539783)
passed eight routine lanes in 210 seconds from plan start to the required check
(217 seconds from workflow creation to completion). It used Ubuntu 26.04 x86_64
image `20261111.196.1`, Node 26.13.0 / npm 11.20.0 and a warm installed-dependency
cache. Compare a future candidate under the same lane, runner and cache
conditions; a docs-only PR selects fewer checks and cannot establish candidate
performance parity. This rebase's [full Routine CI](https://github.com/iExalt/paseo/actions/runs/46013384653)
passed ten lanes in 248 seconds from event to completion on the reviewed candidate.
The workflow used a cold dependency install after the lock changed.
