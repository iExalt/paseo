# Workspace settings updates

User-approved scope (2026-11-05): “SGTM. Implement that feature”. The contract is
background visibility, title/reset, notifications, pinning and label assignments;
omitted fields stay unchanged, conflicting options fail, combined updates are atomic.
Project moves, filesystem/Git operations and lifecycle changes are excluded.

Baseline: `dfd91ac793706156836f224a898e7108a675a316` on `origin/dev`.
Medium autonomy. Estimate: 1–2 wall-clock hours, 2–3 review rounds, bounded by
builds, review and CI. Publication means a reviewed PR merged into `dev`; no release
or main-daemon restart is authorized.

## Plan and current boundary

- [x] A — Atomic daemon RPC and SDK method, capability gate, validation and
      persistence/concurrency tests. Verified and reviewer-accepted (A1).
- [x] B — CLI options/output, usage docs and isolated CLI-to-daemon checks,
      final integration review and required CI. Verified; reviewer accepted B2 at
      `57701e810`. Publication is tracked in [PR #360](https://github.com/iExalt/paseo/pull/360).

The reviewer agreed both chunks and the catalog/registry locking boundary before
implementation. Unknown additions fail; absent removals are idempotent. Existing
notification-only commands retain their established RPC for older hosts.

## Evidence and checks

- Local baseline: label suite passed; notification CLI fixture failed because it
  lacked `fetchAgent` while the environment supplies `PASEO_AGENT_ID`. Its
  mock was repaired in B; no production caller behavior change was needed. Combined run: 3.47 s.
- A: `npx vitest run packages/server/src/server/workspace-labels/index.test.ts
  packages/protocol/src/messages.workspaces.test.ts
  packages/client/src/daemon-client.test.ts --bail=1`: 276 passed, 5.61 s.
- `npm run typecheck`: passed before the final test-only additions.
- Full suites run in CI only, per repository instructions. Routine CI advisory
  budget: under 300 s; compare with a nearby successful dev run using the same
  lanes and cache conditions, as far as available.
- B: `npx vitest run packages/cli/src/commands/workspace/notifications.test.ts
  --bail=1`: 15 passed, 4.66 s (baseline 6 tests, 3.66 s after caller mock repair;
  same machine/Node 26.11.1 and warm dependencies, no competing test suite).
- `npx tsx packages/cli/tests/38-workspace-rename.test.ts`: passed with an isolated
  ephemeral daemon; atomic CLI/SDK settings, rejection preservation, inclusive and
  normal lists, remove/upsert discovery events, and caller inheritance.
- `npm run lint` and `npm run typecheck`: passed. Builds refreshed protocol/client
  declarations and server output; final commit hooks repeat typecheck.
- CI baseline: dev run [42039255648](https://github.com/iExalt/paseo/actions/runs/42039255648)
  at `dfd91ac`, all eight lanes, warm dependency cache, 217 s critical path.
- Final code CI: [42069245433](https://github.com/iExalt/paseo/actions/runs/42069245433)
  passed all eight routine lanes and the required gate at reviewed `57701e810`.
  Critical path 222 s versus 217 s baseline, below the 300 s advisory budget;
  workspace checks were the longest lane (186 s versus 175 s baseline).
  Both restored the same installed dependency cache. CLI units rose 0.86 s
  (515 to 524 passing tests); client units rose 0.05 s (295 to 296). Other
  unchanged suites varied too; these runs do not establish an implementation
  regression. No budget, concurrency or baseline was changed.
- This status-only closure changes no implementation; its required CI and merge
  status are recorded on PR #360. Deployment remains outside scope.

## Review ledger

Material findings make the requested behavior wrong, unsafe, lossy or incomplete.
Optional improvements do not block publication.

- A1: 0 material / 1 total. Accepted; optional capability/service alignment
  repaired and accepted in B.
- B2: 0 material / 0 total. Final local integration accepted. B1 was superseded
  during validation before a completed verdict.

## Progress

2026-11-05: Reviewer agreed the two-chunk design. A uses the catalog operation
queue and one registry write without changing the catalog or its recovery journal.
B passed registered CLI and isolated daemon checks; reviewer accepted the integrated
implementation. Reconciled English/Chinese usage docs and removed obsolete
creation-only visibility claims. Existing rename assertions now include the current
`success` result field; no rename behavior changed. All required code CI passed;
implementation and verification are complete, with merge tracked on PR #360.
