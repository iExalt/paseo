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
- [ ] B — CLI options/output, usage docs and isolated CLI-to-daemon checks,
      final integration review and required CI, then merge. Next; designed.

The reviewer agreed both chunks and the catalog/registry locking boundary before
implementation. Unknown additions fail; absent removals are idempotent. Existing
notification-only commands retain their established RPC for older hosts.

## Evidence and checks

- Local baseline: label suite passed; notification CLI fixture failed because it
  lacks `fetchAgent` while the environment supplies `PASEO_AGENT_ID`. Repair its
  mock in B; no production caller behavior change is needed. Combined run: 3.47 s.
- A: `npx vitest run packages/server/src/server/workspace-labels/index.test.ts
  packages/protocol/src/messages.workspaces.test.ts
  packages/client/src/daemon-client.test.ts --bail=1`: 276 passed, 5.61 s.
- `npm run typecheck`: passed before the final test-only additions.
- Full suites run in CI only, per repository instructions. Routine CI advisory
  budget: under 300 s; compare with a nearby successful dev run using the same
  lanes and cache conditions, as far as available.
- Not yet proven: CLI behavior, directory stream visibility changes, final CI,
  publication and deployment. Deployment is outside this change.

## Review ledger

Material findings make the requested behavior wrong, unsafe, lossy or incomplete.
Optional improvements do not block publication.

- A1: 0 material / 1 total. Accepted; optional capability/service alignment
  will be included in B and reviewed with that delta.

## Progress

2026-11-05: Reviewer agreed the two-chunk design. A uses the catalog operation
queue and one registry write without changing the catalog or its recovery journal.
