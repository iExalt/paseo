# Upstream rebase inputs and supersession ledger

The version 2 ledger carries the reviewed retained outcomes onto published `dev`. Exact fully superseded and empty/history-only matches are drop instructions; partial decisions require target-bound source retain receipts. Retained curated commits keep one-to-one replay. [The rebase procedure](upstream/rebase-dev.md#carry-supersession-decisions-forward) owns matching, target and release-boundary safeguards.

The ledger carries the published decisions forward for rehearsal at the pinned mirror `518e58cd639f01f63da35544bce3eff5123b10ee`. The refreshed receipts record source review. Run the listed integration checks on the replay tree.

## Published rebase

- Published fork dev: `c7eb9ec7b20b30bfdcb702a8e462f1ae10e0f170`, from [rebase-dev run 43810387905](https://github.com/iExalt/paseo/actions/runs/43810387905).
- Backup of the pre-rebase dev: `backup/rebase-dev/43810387905-1` at `37a7244debe3ed1dd2b3682d4db94a5b55e2748e`.
- Incorporated upstream: `0273b6b614bac623168d03e7f89f9e161274b468`.
- Resolutions: `307f2300ce7786e06b74b6d40f2344738c9f479d`.

The published history has 143 non-merge commits above the incorporated upstream:
140 replayed curated commits and the run's three generated commits. The verifier
matched all 143 to a clean replay, commit for commit and tree for tree, apart from
the generated `last-release-sha`. All 143 carry the pinned production signature
and GitHub verification.

After the published carry-forward, the ledger had 145 rows: 136 carried rows, seven new keep rows and two historical
fully superseded rows that match no current commit. Rows were carried through the
replay's original-to-rewritten mapping, not by subject, because each rebase adds
generated commits with repeated subjects. The carry changed 18 patch IDs and every
SHA hint. The new keep rows are #498 to #501 and this rebase's three generated
commits. The ledger check for that publication retained every published commit.

[The manifest](upstream-rebase-inventory.json) records the carried keys, incoming
paths and capture provenance. The previous ledger is available at
[the pre-rebase dev](https://github.com/iExalt/paseo/blob/37a7244debe3ed1dd2b3682d4db94a5b55e2748e/docs/upstream-rebase-inventory.json).

## Pending replay

The ten partial rows carry refreshed source reviews for the pinned mirror. Each
receipt names the evidence commits, the fork behavior to retain and the checks
to run against the replay tree. A newer target requires source review and new
receipts for all ten rows.

The ledger's minimum upstream ancestor advances to `d49991318f088623155231a1e293d4efc7b3cade`
so the planner rejects targets that lack the #620 replacement. The manifest's
incoming inventory and `refs.actual_upstream` record the published capture above.

## Decisions

| Category             | Ledger rows | Replay                                                                                          |
| -------------------- | ----------: | ----------------------------------------------------------------------------------------------- |
| keep                 |         133 | Retain one-to-one.                                                                              |
| partially superseded |          10 | Retain with the exact-target source review receipt.                                             |
| fully superseded     |           3 | Drop the #620 backport. The other two rows record historical drops absent from current history. |

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
  remains an upstream candidate. Run both comparison cases after replay.
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

The published carry-forward swept every ledger identity against published history and all 40
incoming subjects and touched paths, then checked the partial rows against their
listed source paths. It does not claim a line-by-line audit of every incoming
change or runtime parity. Non-keep decisions retain their source evidence.

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
