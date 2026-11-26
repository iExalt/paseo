# Upstream rebase inputs and supersession ledger

The version 2 ledger carries the reviewed retained outcomes onto published `dev`. Exact fully superseded and empty/history-only matches are drop instructions; partial decisions require target-bound source retain receipts. Retained curated commits keep one-to-one replay. [The rebase procedure](upstream/rebase-dev.md#carry-supersession-decisions-forward) owns matching, target and release-boundary safeguards.

The ledger matches published `dev` after the rebase onto `0273b6b614bac623168d03e7f89f9e161274b468`. It changes no application code and does not establish runtime parity.

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

The ledger has 145 rows: 136 carried rows, seven new keep rows and two historical
fully superseded rows that match no current commit. Rows were carried through the
replay's original-to-rewritten mapping, not by subject, because each rebase adds
generated commits with repeated subjects. The carry changed 18 patch IDs and every
SHA hint. The new keep rows are #498 to #501 and this rebase's three generated
commits. The engine's ledger check on published dev with this ledger retains every
published commit and drops none.

[The manifest](upstream-rebase-inventory.json) records the carried keys, incoming
paths and capture provenance. The previous ledger is available at
[the pre-rebase dev](https://github.com/iExalt/paseo/blob/37a7244debe3ed1dd2b3682d4db94a5b55e2748e/docs/upstream-rebase-inventory.json).

The ten partial rows authorized retaining their distinct outcomes at this
target. Two of them changed patch identity through upstream context and content
drift: the engine hashes moved files whole, and `git range-diff` shows the fork's
own changes unchanged. Their receipts carry the published identity and cite the
resolution snapshot and run.
A newer target needs new source review and receipts for every partial row. Nine listed source-path sets do not overlap the incoming changes. The
replica-rendering row overlaps only `_layout.tsx`: incoming changes add two plugin
routes away from the fork's favicon mount and hidden-selector behavior. These
source decisions authorized rehearsal; validate-only and the publishing run then
passed the full routine on the exact tree. Runtime and platform parity remain
unproven.

## Decisions

| Category             | Ledger rows | Replay                                                      |
| -------------------- | ----------: | ----------------------------------------------------------- |
| keep                 |         133 | Retain one-to-one.                                          |
| partially superseded |          10 | Retain with the exact-target source review receipt.         |
| fully superseded     |           2 | Historical decisions; neither commit is in current history. |

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

- `070bacffa`: target evidence: `0a549945b` replaces JS terminal rows with native views and layout caches.; retain and reconcile: Keep fork screen-store subscriptions, latency stages, find/selection overlays and bundled fonts through the new renderer; do not restore deleted JS row abstractions. Native latency parity remains unproven..
- `1125d440c`: target evidence: `82d5f6c58` backports root constraints to Unistyles 3.2.4.; retain and reconcile: Keep selected 3.8.1 and CSSOM resize detection/self-check. Existing local 3.8.1 source preserves latest root constraints/context on retry. Confirm it from the locked clean install before choosing C++ hunks; source presence does not prove Android rotation runtime..
- `00b6b6eab`: target evidence: `4f7813d3a` pins disclosure trigger edges.; retain and reconcile: Carry content reveal and the active-element stale-trigger guard through `holdRow`; preserve find/outline jumps after an earlier toggle..
- `1e403c813`, `1e403c813`, `1e403c813`: target evidence: `1c4400194`, `9e607a3aa` supply shortcut dispatch and physical arrows.; retain and reconcile: Keep broader terminal key capture, iPad command priorities, app-shortcut priority and Android IME Enter/Backspace pairing. Preserve the explicit unsupported fork iOS build gate..
- `1bd082ae9`, `1bd082ae9`, `1bd082ae9`: target evidence: `c6f0c24bf` creates separate summary rows.; retain and reconcile: Carry CLI sends, received-agent input membership, folded message counts and downward expansion into those rows..

Full SHAs, source paths and the cheapest later invariant checks are on each
ledger row. These checks are requirements for later adaptation, not results of
this inventory.

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

### Git diff index snapshots

For the next target-bound ledger refresh, verify that
[`d49991318f088623155231a1e293d4efc7b3cade`](https://github.com/getpaseo/paseo/commit/d49991318f088623155231a1e293d4efc7b3cade)
is an ancestor of the captured target. Then add a fully superseded drop row for
`d27133f4bc34a630828548e8367b93f11d6c5e6c`. Match the subject `fix(diff): preserve index timestamps in worktree comparisons (#620)`
and stable patch ID `d9a2c3f773f349eea1865452f8e821c992742e62`.

Upstream covers both affected comparison paths. Drop the fork's extra regression
variants and bigint rounding with the backport. The precision edge stays an
upstream candidate. [PR #620](https://github.com/iExalt/paseo/pull/620)

## Reproduction and evidence boundary

Recompute the captured curated list with `git rev-list --reverse --topo-order --no-merges BASE..TIP`. Compute identities with `git show --format= --binary --no-ext-diff --no-textconv --no-renames --ignore-submodules=none --no-color SHA | git patch-id --stable`, paired with `git show -s --format=%s SHA`. A null patch ID identifies an empty patch; it does not classify the commit for dropping. The immutable capture and archive refs make the source review reachable after rewritten SHAs change. No new generator or proof framework is required to consume the ledger.

The refresh swept every ledger identity against published history and all 40
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
