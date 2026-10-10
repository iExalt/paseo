# GitHub workflows status

## Current snapshot

- Baseline: `f48cc61be6457f2d90f3acb79551f4e1b27fe8a7`; sibling
  `paseo-github-workflows`, branch `ci/github-workflows`.
- Reviewed implementation `72300136d` is integrated on `dev`; PRs #1–#3 merged
  by fast-forward after their final-source routine checks passed.
- Authority: Phase A approved; phases B–D and personal-device/public-release
  operations retain the boundaries in the [script](GITHUB_WORKFLOWS_SCRIPT.md).
- [Plan](GITHUB_WORKFLOWS_PLAN.md) owns decisions and gates;
  [roadmap](GITHUB_WORKFLOWS_ROADMAP.md) owns exhaustive task coverage.
- Phase A / G0–G1 complete. Linux and Windows ARM64 native dependency
  probes and hosted Android ARM64 APK startup passed. The routine baseline is measured;
  the user requires an under-five-minute PR gate, with two minutes preferred. Reviewed probe code and semver contracts are published
  on the work branch. Routine CI has rejected a real PR failure and passed a full
  PR run and both same-SHA cold/warm dev runs. A controlled comparison found no
  net npm-cache gain; its removal passed final-source PR and dev verification.
  Final PR/dev verification passed in 4m15s/4m18s; the two-minute stretch remains
  unmet. Initial queue adds 3s to each. Required checks are preserved.

## Outcome gates

| Goal                                      | Status / evidence   | Depends on | Exit and owner                                               |
| ----------------------------------------- | ------------------- | ---------- | ------------------------------------------------------------ |
| A1: feasible candidate and cost contracts | complete / verified | none       | G0, author with user decisions                               |
| A2: measured routine verification         | complete / verified | A1         | step 2 live events and accepted latency ceiling, author/user |
| A3: exact rebased-tree verification       | complete / verified | A2         | G1 including atomic publication failure fixtures, author     |

Reviewer design agreement covers these three chunks. A1 closes feasibility and
interface decisions only; it does not establish package or release correctness.
A3's exact-tested-tree and atomic-publication fixtures passed; the shared rebase
gate remains complete and uses its existing 45-minute whole-job bound. The user's
under-five-minute requirement applies to blocking PR CI, now verified on PR/dev.

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
- The user approved manual-only legacy packaging until step 9's candidate
  coordinator. Ordinary dev pushes stop producing Mac/Android candidates; the
  temporary test-path exceptions are removed. Manual packaging retains the
  trusted `dev`/`iExalt` guards. `dev` is the repository's default branch, so the
  dispatch definition is now available there after integration; no dispatch or
  signing operation is authorized by this CI trial. The integration audit found
  only routine CI triggered by the dev push. Baseline repairs include production
  import-boundary fixes as well as test fixtures.
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
After the first successful routine save, usage was **5,511,004,413 bytes** across
four entries; the trial npm cache occupied 1,401,350,157 compressed bytes from
1,611,004,773 raw bytes, below the 2 GiB raw entry cap. The 10 GB ceiling is unchanged.
After integrating cache removal, the trial entry `8779695022` was deleted only
after its exact key, dev ref and size were rechecked. Usage returned to
**4,109,654,256 bytes** across the three original entries; their IDs and sizes
were preserved, and the API still reports a 10 GB ceiling.

The cache setting is an enforced ceiling. GitHub documents that cache overage
is charged only when the configured limit exceeds the included 10 GB
([billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)).
Keep this limit unchanged. Initial native probes use standard public runners,
logs/job summaries only, and no cache/artifact writes. Artifact allowance and
hard no-overage evidence remain required before an upload-producing operation;
zero net historical billing does not establish those controls.

Routine and rebase verification use isolated npm download directories without
Actions cache transfers: the controlled comparison below found no net benefit.
Existing packaging caches remain unchanged. Future caches must demonstrate useful
savings including transfer costs; prefer one immutable dependency cache per
OS/architecture/toolchain/lockfile over SHA-per-run or duplicate entries. Avoid
`node_modules` archives and Nix store caches competing with Gradle inside 10 GB.
Trusted signing must not consume untrusted cached build products, and misses must
still run every required check.

The measured baseline candidate is `63315404a`, run `38087084460`, attempts 1/2,
on standard public `ubuntu-24.04` x64 runners with Node26.11.0/npm11.20.0,
two unit workers and one integration worker. Queue time is excluded; the separate
required aggregate took 2s cold and 4s warm. Physical CPU models were not captured
for these runs, so the following is a hosted-pool baseline, not a same-machine
cache speed comparison.

| Measurement            |  Cold / attempt 1 |                  Warm / attempt 2 |
| ---------------------- | ----------------: | --------------------------------: |
| Routine job wall time  |             9m15s |                            12m55s |
| Cache state            |              miss |                     exact-key hit |
| Cache restore          | 0.20s miss lookup |                         about 11s |
| Locked npm install     |            42.98s |                            59.49s |
| Workspace declarations |            12.13s |                            19.61s |
| Workspace typechecks   |            17.52s |                            28.22s |
| Server units           |           236.81s |                           321.81s |
| App units              |            91.63s |                           149.01s |
| Cache save             |             5.70s | skipped: exact key already exists |

The user rejected the proposed 15-minute ceiling and requires the complete PR
gate in **under five minutes**, with **two minutes preferred**. Measure from the
first job start through the required aggregate, including planning, installations
and all dependent scheduling gaps; report event-to-start queue time separately.
The first trial uses seven parallel lanes: quality/types, other workspaces, app,
three native Vitest server shards, and selected integrations. JSON routing needs
no dependency installation and omits irrelevant lanes. Each selected lane retains
the same checks and two unit workers, with fresh installation/build prerequisites.
The first full parallel PR trial at `69bb39f97`
([run](https://github.com/iExalt/paseo/actions/runs/38092757078)) passed in **4m39s**
from planner start to aggregate completion. Summed runner work was **23m04s**,
versus 13m05s for the prior serial dev run including its aggregate; repeated
install/build prerequisites account for much of that cost. The three server
shards took 74/82/143s of test execution and app units took 139s. This is one
observed under-five-minute result, with 21s headroom; two minutes remains unmet.
The final implementation removes desktop's unnecessary Electron binary installer and uses
the app's own dependency build instead of compiling server/CLI there. The
five-minute lane timeout bounds hangs. The required aggregate also reads the
current attempt's job timestamps with read-only Actions permission and fails if
elapsed time reaches 300s or timing evidence cannot be retrieved; final job
cleanup follows that check and its completed duration is recorded separately.
Default shared rebase
execution remains complete; no fifteen-minute deadline was accepted or applied.
Keep this source and pair as the comparison anchor; investigate material or
cumulative growth even below the ceiling, explicitly accounting for parallelism without weakening
required gates. Broad suites run on GitHub; targeted changed-file tests run locally.
The actual Electron install/runtime and package journeys remain mandatory B/G3
gates; the routine desktop lane only runs existing mocked/unit contracts.

Final exact-source receipts at `72300136d`:

| Run                                                             | Complete gate | Initial queue | Event to completion | Summed runner work |
| --------------------------------------------------------------- | ------------: | ------------: | ------------------: | -----------------: |
| [PR](https://github.com/iExalt/paseo/actions/runs/38093356616)  |         4m15s |            3s |               4m18s |             20m18s |
| [Dev](https://github.com/iExalt/paseo/actions/runs/38093673761) |         4m18s |            3s |               4m21s |             20m37s |

Both required aggregates passed their live timing check; these durations include
the remaining job cleanup. Dev ran from 23:03:23–23:07:41 UTC
(19:03:23–19:07:41 EDT). Compared with the prior serial 13m05s including aggregate,
wall time fell about 67%, while summed runner work increased about 58% on dev.
Standard free runners, two workers per unit suite across up to seven concurrent
lanes, and zero new Actions cache or
artifact writes preserve the cost boundary. Host variation affects comparisons;
the original `63315404a` pair remains the baseline, not silently replaced here.

The warm run was slower across unrelated build/test stages as well as installation;
it does not establish that caching accelerates CI. The
[same-host install comparison](https://github.com/iExalt/paseo/actions/runs/38088702487)
used the same `63315404a` source on one four-vCPU AMD EPYC 7763 runner,
Ubuntu image `20261004.327.1`, with fresh cold caches and independent copies of
the restored seed, in cold/warm/warm/cold order. Cold installs took 71.265/74.965s;
warm installs took 65.196/67.621s plus the real 8s restore cost. Mean deployed cost
was 73.115s cold versus 74.409s warm, excluding the probe-only seed-copy overhead.
Postinstall caches were isolated per pass. With no demonstrated net gain, routine
and rebase Actions caches are removed, along with the unused helper/tests and
temporary probe. This experiment added no permanent coverage or cache/artifact writes.

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

Concurrent dev runs retain verification of every source SHA. Routine verification
uploads no Actions artifacts and now performs no Actions cache reads or writes.
The original trial's 2 GiB raw save cap and immutable key contract describe the
measured experiment, not active cache plumbing.

The reviewed rebase workflow uses the same complete routine command after rebasing
and installing the captured lockfile. Validation requires a clean tracked tree,
rejects untracked environment overrides, and checks the commit again after tests.
Publication requires that exact tested SHA and retains the atomic backup/dev lease.
CLI fixtures prove that failed checks, tree mutation and ignored environment
overrides produce no tested-SHA output; Git fixtures reject branch movement and
stale leases without publishing a backup. These are fresh-checkout assumptions,
not an audit of every ignored build output. The workflow transfers no Actions
caches, removes signing material before dependency execution,
exposes push credentials only during publication, and records bounded diagnostics
without artifact uploads. No production rebase has been dispatched.

## Next sequence and deferred gates

- [x] Verify the revised semver contract and reconcile all three planning tiers.
- [x] Reconcile bounded native probes and close G0; all selected architectures
      retain a feasible native route, with package proof assigned to G3.
- [x] Close A2 after parallel optimization and live proof of the under-five-minute
      PR gate; preserve required checks and account for total runner work.
- [x] Close A3 after A2; exact-tested-tree, failed-check and branch-movement
      fixtures and shared workflow wiring are verified.

G1 is complete. Phase B remains unapproved: deep journeys and safe-PR routing,
Mac/Android candidate preservation, Linux package matrix, then Windows package
matrix. Preserve routine latency; deeper gates do not join ordinary PR blocking
work. Bot events and installed-user migration remain C/D.

Before B uploads, verify an actual free/no-overage path; retention alone is not
proof. Same-job build/install/runtime proofs can proceed within B approval without
uploads. Cross-job draft Release transport needs explicit B authority and immutable
candidate/asset bounds. Retained UI screenshots/traces must have a verified free
transport. Android deep closure depends on B2's rebuilt same-SHA APK, not the
legacy feasibility APK. Missing signing access blocks dependent proofs only.
Each initial native trial needs a job deadline and explicit matrix cells, followed
by diagnosis before retries; no paid runners, personal devices or public releases
are included by default. Windows proof includes STT/TTS and PTY lifecycle beyond
A1's VAD smoke. Disposable upgrades must preserve meaningful state.

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
- The [broader routine trial](https://github.com/iExalt/paseo/actions/runs/38084411293)
  passed client, relay and plugin checks, then exposed ten failures in seven server
  test files. Server units took 232.95 seconds at two workers; no complete baseline
  exists. Repairs preserve the import-boundary assertions, separate shared schemas
  from wire messages, correct stale fixtures, and remove dependence on a locally
  installed Claude binary. Desktop Node contracts remain under Node; CLI lifecycle
  and installed-provider compatibility have explicit B gates.
- The [complete PR trial](https://github.com/iExalt/paseo/actions/runs/38085275889)
  passed at head `26665aef0` (tested merge `842cc2666`), including the required
  aggregate. Routine job wall time was 12m48s on `ubuntu-24.04`, Node26.11.0,
  two unit workers and one integration worker: cold npm install 62.56s,
  declarations 19.35s, types 26.58s, server units 315.52s and app units 147.02s.
  Server time exceeded the prior failed run's 232.95s, with the largest differences
  in unchanged subprocess-heavy suites. The same-SHA dev cold/warm pair must
  resolve that variability before accepting a baseline or numeric ceiling.
  Reviewed A3 fixtures and workflow wiring now share this routine gate; no live
  production rebase is needed for step 3's isolated publication proof.
- The [final-source PR trial](https://github.com/iExalt/paseo/actions/runs/38086191830)
  passed at `63315404a` in 12m49s (server units 320.83s). After a fresh remote and
  complete workflow-event audit, `dev` fast-forwarded to that SHA and PR #1 merged.
  The [cold dev trial](https://github.com/iExalt/paseo/actions/runs/38087084460/attempts/1)
  passed in 9m15s: cache miss, npm install 42.98s, declarations 12.13s, types 17.52s,
  server units 236.81s and app units 91.63s. At the same SHA as the final PR, server
  time returned close to the earlier 232.95s result, so no stable regression is established; the
  specific source of hosted variation is unproven. The conditional extra timing
  probe was not needed or dispatched. The successful trusted cache save took 5.70s;
  [attempt 2](https://github.com/iExalt/paseo/actions/runs/38087084460/attempts/2)
  also passed, in 12m55s, with an exact cache hit and no duplicate save. The cache
  benefit was unresolved because restore plus install took about 70.5s,
  close to the comparable slower final PR's 70.37s uncached install. The subsequent
  controlled install-only comparison above found no net gain and justified removing
  routine/rebase cache transfers without changing required checks.
- The cache-free [final-source PR trial](https://github.com/iExalt/paseo/actions/runs/38089332689)
  passed at `4f278588e` in 12m50s, with a separate 2s aggregate: npm install 69.31s,
  server units 315.68s and app units 145.94s, consistent with the slower baseline.
  Following final integration review and fresh remote/event checks, `dev`
  fast-forwarded at 22:06:46 UTC (18:06:46 EDT) and PR #2 merged. Only routine CI
  was emitted by the push. The [final dev trial](https://github.com/iExalt/paseo/actions/runs/38090182199)
  passed in 13m02s with a separate 3s aggregate, ending at 22:19:57 UTC
  (18:19:57 EDT). No cache transfer or packaging operation ran. The trial cache
  was removed after exact metadata verification; unrelated entries and the 10 GB
  ceiling remain unchanged. Numeric-ceiling acceptance and enforcement are the
  remaining G1 closure gate; no later phase has started.
