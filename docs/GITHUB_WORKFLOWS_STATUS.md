# GitHub workflows status

## Current snapshot

- Baseline: `f48cc61be6457f2d90f3acb79551f4e1b27fe8a7`; sibling
  `paseo-github-workflows`, branch `ci/github-workflows`.
- Authority: Phase A approved; phases B–D and personal-device/public-release
  operations retain the boundaries in the [script](GITHUB_WORKFLOWS_SCRIPT.md).
- [Plan](GITHUB_WORKFLOWS_PLAN.md) owns decisions and gates;
  [roadmap](GITHUB_WORKFLOWS_ROADMAP.md) owns exhaustive task coverage.
- A1 / G0 complete; G1 remains open. Linux and Windows ARM64 native dependency
  probes and hosted Android ARM64 APK startup passed. No routine baseline exists;
  A2 implementation is active. Reviewed probe code and semver contracts are published
  on the work branch. Routine CI is published and has rejected a real PR failure;
  successful PR/dev runs and cache measurements remain outstanding.

## Outcome gates

| Goal                                      | Status / evidence    | Depends on | Exit and owner                                               |
| ----------------------------------------- | -------------------- | ---------- | ------------------------------------------------------------ |
| A1: feasible candidate and cost contracts | complete / verified  | none       | G0, author with user decisions                               |
| A2: measured routine verification         | active / implemented | A1         | step 2 live events and accepted latency ceiling, author/user |
| A3: exact rebased-tree verification       | planned / designed   | A2         | G1 including atomic publication failure fixtures, author     |

Reviewer design agreement covers these three chunks. A1 closes feasibility and
interface decisions only; it does not establish package or release correctness.

## Decisions and current boundary

- User selected **0.1.0**, **semver-only upgrade ordering**, and **clean break
  with manual migration**. The independent reservation/sequence design and
  legacy compatibility bridge are superseded. No installed client was changed.
- `scripts/fork-version.mjs` implements a stable-version comparator and a
  deterministic Android versionCode encoding. It is not yet wired to packages
  or updaters; that is C. Android's mandatory integer remains internal.
- Native Windows ARM64 feasibility is verified using a custom binding built from
  pinned `sherpa-onnx@1.13.8` sources and upstream ARM64 core libraries. The locked
  npm distribution lacks that binding. B must integrate the assembled addon,
  matching ONNX Runtime DLLs and Node layout; keeping compiler output beside the
  wrapper selects an unintended loader fallback. Native buffer calls, real Silero
  VAD inference, PTY output and recursive watching passed. STT/TTS model journeys,
  packaged Electron integration and clean lifecycle/upgrade proof remain G3.
- Actual Android shipped-ABI startup is verified on a hosted ARM64 runner using
  distro Binder and a pinned ashmem compatibility module. The repaired trial
  booted Android 16, installed the signed ARM64 APK and retained its foreground
  process for 30 seconds. This proves container startup; hardware, GPU and
  Bluetooth fidelity and the full candidate G3 gate remain unproven. No local
  emulator or physical-device operation is authorized or running.
- A2's controlled dev-event proof uses a discovered `.mise/tasks/ci/routine`
  file task, avoiding `mise.toml`, which triggers existing packaging. Before
  integration, prove the complete cumulative diff does not match the old packaging
  filters, recheck remote movement, and inspect resulting events. Necessary client
  and relay test repairs now match those filters. A narrow trigger amendment is awaiting
  user approval; dev integration is pending that decision. No workflow is disabled.
- Bot PR credentials are not proven. Existing repository secret names contain
  signing/configuration secrets but no dedicated release-please credential;
  never treat secret names as proof of usable material. The selected App-token
  event route, signed V2 interface and trusted draft-asset transport are recorded
  in plan section 4; credential/event and draft API proofs remain G4/G5.

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

The shared entrypoint is `mise run --skip-tools ci:routine` after `npm ci`;
`--skip-tools` avoids installing unrelated Android/Java/Rust tools. With no
arguments it runs the complete routine gate for dev and rebased candidates.
PRs pass `--changed-from <captured-base-sha>`; full Git diffs include both sides
of renames, ownership expands to dependent consumers, and unknown paths run all
checks. `--plan` prints the selected commands without executing them.

Routine code runs include cheap Node helper tests, units and focused integrations.
The real Antigravity prompt case is explicitly excluded because paid-provider
tests are outside this campaign. G3 must execute `builtin-plugins-dist.test.mjs`,
`trace-daemon-dist.test.mjs`, the Nix signature fixture and macOS reactivation
fixture; a green Linux routine run does not prove these package contracts.
Critical browser/Electron/Android journeys, CLI lifecycle and the local relay E2EE
journey with `FORCE_RELAY_E2E=1` remain required B gates. The relay suite deliberately
skips runtime checks on Node 26; successful collection is not its runtime proof.

Routine caches contain only npm downloads, with immutable keys for pinned
OS/architecture/Node/npm/lockfile. Only successful trusted dev pushes save.
Concurrent dev runs retain every source SHA; same-key cache reservations may
race harmlessly. The provisional per-entry save cap is 2 GiB of raw file bytes,
distinct from compressed cache size and the enforced 10 GB repository ceiling.
Cache misses still execute all selected checks; no Actions artifacts are uploaded.

## Next sequence and deferred gates

- [x] Verify the revised semver contract and reconcile all three planning tiers.
- [x] Reconcile bounded native probes and close G0; all selected architectures
      retain a feasible native route, with package proof assigned to G3.
- [ ] Establish A2's shared routine command and live baseline.
- [ ] Close A3 with exact-tested-tree, failed-check and branch-movement fixtures.

Real routine PR/dev events remain A2; bot events, full-package and device proofs
remain B/C/D as assigned in the roadmap.

## Progress log

- 2026-10-10: Phase A approved in a sibling worktree; reviewer agreed chunk
  boundaries. Read-only cache/release inspection established the cost snapshot.
  User superseded numeric sequence/legacy bridge with semver0.1.0/manual migration.
- 2026-10-10: Published `510974a2` and `dd08d506` after review. The
  [native trial](https://github.com/iExalt/paseo/actions/runs/38079931018)
  passed real PTY output, recursive watcher events and sherpa native buffer calls
  on `ubuntu-24.04-arm`/Node26.11.0; locked install took 50 seconds. Windows reached
  the 15-minute job cap during `npm ci`; no native probe ran there. The
  [Android prerequisite inventory](https://github.com/iExalt/paseo/actions/runs/38080289694)
  established the Binder module route, not Android runtime correctness. Local
  targeted checks and all-workspace typecheck passed; broad tests remain GitHub-only.
- The [first Android runtime trial](https://github.com/iExalt/paseo/actions/runs/38080667758)
  verified signed APK bytes, certificate and ABI, then stopped at the five-minute
  boot deadline with `output buffer not gpu writeable` SurfaceFlinger aborts;
  the app was not installed or executed. Cleanup removed the owned container.
  Upstream's [corrected report](https://github.com/remote-android/redroid-doc/issues/934#issuecomment-5178199895)
  attributes the analogous failure to missing ashmem, superseding its initial
  graphics diagnosis; the following trial tested that repair on this ARM64 runner.
- The [repaired Android trial](https://github.com/iExalt/paseo/actions/runs/38081538748)
  at `def29fde5` passed kernel-module load, boot, APK verification/install and
  sustained app startup. Bluetooth HAL crashes were visible, but no app crash;
  this proves container feasibility, not Bluetooth/GPU/hardware fidelity or G3.
  The [focused Windows trial](https://github.com/iExalt/paseo/actions/runs/38081538703)
  built the native binding, then exposed the ONNX Runtime version mismatch before
  the required native behavior assertions. Its package gate remains open.
- The [Windows runtime trial](https://github.com/iExalt/paseo/actions/runs/38082403349)
  at `268e5f8df` passed custom ARM64 binding, ONNX Runtime 1.28.2 from the assembled
  runtime directory, real VAD inference, terminal output and recursive watching.
  A nonfatal `AttachConsole` diagnostic followed cleanup of the already-exited
  PTY; clean lifecycle behavior still needs G3. Together with Linux at `510974a2`
  and Android at `def29fde5`, this closes G0 feasibility, not full-package proof.
- The [first routine PR trial](https://github.com/iExalt/paseo/actions/runs/38083227517)
  at `6e823602c` failed on a stale client capability expectation; its required
  aggregate also failed. This observed failure replaces the proposed synthetic
  PR failure trial; A3's injected publication failure and G2's broken journey
  remain required. Cold dependency installation took 73 seconds; the run
  stopped before all checks, so it is not a routine latency baseline. The one-line
  fixture repair in `e72419f3e` passed its targeted local test, client typecheck,
  lint and formatting. Successful live verification remains pending.
- The [next PR trial](https://github.com/iExalt/paseo/actions/runs/38083743209)
  passed the repaired client suite, then failed collecting relay E2E because
  Wrangler no longer exports its private CLI path. The test now resolves the
  executable through exported package metadata; targeted collection succeeds,
  its three runtime cases remain skipped on Node 26, and relay typecheck passes.
