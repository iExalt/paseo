# GitHub workflows status

## Current snapshot

- Baseline: `f48cc61be6457f2d90f3acb79551f4e1b27fe8a7`; sibling
  `paseo-github-workflows`, branch `ci/github-workflows`.
- Authority: Phase A approved; phases B–D and personal-device/public-release
  operations retain the boundaries in the [script](GITHUB_WORKFLOWS_SCRIPT.md).
- [Plan](GITHUB_WORKFLOWS_PLAN.md) owns decisions and gates;
  [roadmap](GITHUB_WORKFLOWS_ROADMAP.md) owns exhaustive task coverage.
- A1 active; G0/G1 are not complete. The Linux ARM64 dependency probe passed;
  Windows and Android runtime feasibility remain pending. No routine baseline
  exists. Reviewed probe code and semver contracts are published on the work branch.

## Outcome gates

| Goal                                      | Status / evidence  | Depends on | Exit and owner                                               |
| ----------------------------------------- | ------------------ | ---------- | ------------------------------------------------------------ |
| A1: feasible candidate and cost contracts | active / designed  | none       | G0, author with user decisions                               |
| A2: measured routine verification         | planned / designed | A1         | step 2 live events and accepted latency ceiling, author/user |
| A3: exact rebased-tree verification       | planned / designed | A2         | G1 including atomic publication failure fixtures, author     |

Reviewer design agreement covers these three chunks. The semver helper and bounded
probe code passed review; native evidence remains open, so A1 is not accepted.

## Decisions and current boundary

- User selected **0.1.0**, **semver-only upgrade ordering**, and **clean break
  with manual migration**. The independent reservation/sequence design and
  legacy compatibility bridge are superseded. No installed client was changed.
- `scripts/fork-version.mjs` implements a stable-version comparator and a
  deterministic Android versionCode encoding. It is not yet wired to packages
  or updaters; that is C. Android's mandatory integer remains internal.
- Native Windows ARM64 is unresolved: locked `sherpa-onnx-node@1.13.8` lists
  Windows x64/ia32 native packages but no Windows ARM64 package. Linux ARM64
  is listed. Package presence is not a runtime proof.
- Actual Android shipped-ABI execution remains unresolved. The hosted ARM64
  kernel lacks exposed KVM but enables modular Android Binder, with the matching
  extra-modules package available. One bounded Redroid container trial is designed;
  no local emulator or physical-device operation is authorized or running.
- A2's controlled dev-event proof uses a discovered `.mise/tasks/ci/routine`
  file task, avoiding `mise.toml`, which triggers existing packaging. Before
  integration, prove the complete cumulative diff does not match the old packaging
  filters, recheck remote movement, and inspect resulting events. Preserve the old
  trigger until step 9; no temporary workflow disablement is needed.
- Bot PR credentials are not proven. Existing repository secret names contain
  signing/configuration secrets but no dedicated release-please credential;
  never treat secret names as proof of usable material.

## Performance and storage contract

Read-only GitHub API inspection on 2026-10-10 found a public repository, standard
workflow permissions set to read, and cache `max_cache_size_gb: 10`. Cache usage
was **4,109,654,256 bytes** across two npm download caches (about 0.83 GB each)
and one Gradle cache (2.45 GB). Artifact storage is separate: 24 artifacts,
1,656,704,773 bytes. Do not delete unrelated caches or artifacts.

The cache setting is an enforced ceiling. GitHub documents that cache overage
is charged only when the configured limit exceeds the included 10 GB
([billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)).
Keep this limit unchanged. Initial native probes use standard public runners,
logs/job summaries only, and no cache/artifact writes. Artifact allowance and
hard no-overage evidence remain required before an upload-producing operation;
zero net historical billing does not establish those controls.

For routine CI, prefer one npm download cache per OS/architecture/lockfile,
shared where useful with packaging. Avoid SHA-per-run keys, dependency caches
duplicated by job, `node_modules` archives and Nix store caches competing with
Gradle inside 10 GB. Restore dependencies only; trusted signing must not consume
untrusted cached build products. Cache misses must work. Measure whether restore
and save time actually improve total latency before expanding cache scope.

The routine baseline and budget are **unknown**. A2 records one cold/warm pair
on the same standard Linux runner/toolchain/concurrency and proposes a ceiling
for user acceptance. Keep setup/build/test timings separate; broad suites run
on GitHub, targeted changed-file tests locally. Do not trade away required proof
or reset the baseline to conceal growth.

## Next sequence and deferred gates

- [x] Verify the revised semver contract and reconcile all three planning tiers.
- [ ] Reconcile bounded native probes; return unsupported requirements for
      explicit resolution. Linux dependency proof passed; Windows/Android pending.
- [ ] Close G0, then establish A2's shared routine command and live baseline.
- [ ] Close A3 with exact-tested-tree, failed-check and branch-movement fixtures.

Remote event, full-package and device proofs remain B/C/D as assigned in the
roadmap. Do not mark A1 complete while native feasibility is unresolved.

## Progress log

- 2026-10-10: Phase A approved in a sibling worktree; reviewer agreed chunk
  boundaries. Read-only cache/release inspection established the cost snapshot.
  User superseded numeric sequence/legacy bridge with semver0.1.0/manual migration.
- 2026-10-10: Published `510974a2` and `dd08d506` after review. The
  [native trial](https://github.com/iExalt/paseo/actions/runs/38079931018)
  passed real PTY output, recursive watcher events and sherpa native buffer calls
  on `ubuntu-24.04-arm`/Node26.11.0; locked install took 50 seconds. Windows is
  still installing dependencies. The
  [Android prerequisite inventory](https://github.com/iExalt/paseo/actions/runs/38080289694)
  established the Binder module route, not Android runtime correctness. Local
  targeted checks and all-workspace typecheck passed; broad tests remain GitHub-only.
