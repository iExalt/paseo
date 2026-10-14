# GitHub workflows status

## Current snapshot

### Pipeline recovery, noise and speed (0.1.2/0.1.3) — in progress

Approved after the 0.1.1 retrospective (seven hours, six runs). Implemented and
reviewer-accepted at code level; live proof is due in the 0.1.2 candidate.

- **Mixed-attempt recovery.** "Re-run failed jobs" clones carried jobs into the
  new attempt with original timestamps. `candidate-attempts.mjs` resolves each
  job to the attempt that executed it, so proofs, grants, artifacts and receipts
  come from that execution and one run can mix attempts. Aggregate evidence
  records each group's `storage` attempt; publication re-reads the fresh draft
  and requires the signed aggregate to be the run's latest execution. Carried
  grants run only while `PASEO_CANDIDATE_NATIVE_ENABLED` is set and no newer
  candidate has issued. Known limit: an operator who re-enables the variable and
  reruns a stopped run is not detected.
- **Fewer failures.** Nix prefetches only the fixed outputs the build would
  build (the desktop closure: npm-deps only), with three attempts. Eight limits
  under 25% observed headroom were raised; the 300 s routine budget was not.
  Cache-hit predecessor paths were never observed, so their limits are unmeasured.
- **Noise.** Six completed probe/preflight workflows and their exclusive scripts
  are deleted. Candidate and deep runs start only when a merge or PR changes
  `.github/fork-release.json` or `.github/pending-candidate-replacement.json`;
  candidate authority requires every accepted source to change one of them.
  Deep verification for workflow PRs is now a manual `workflow_dispatch` on
  `ci/github-workflows`; dispatch it before merging changes to the deep lanes.
  Aggregate is skipped, not red, after a producer failure.
- **Routine CI.** Hosted runners have 4 vCPUs: four vitest workers cut app units
  from 139 s to 95 s. App runs as two shards and server as three; 24 of 24
  repeated shard runs passed, and executed file counts sum to the unsharded
  totals (app 633, server 427). Lanes restore installed `node_modules` (~0.9 GB,
  16-23 s against 57-74 s for `npm ci`), written only by the current dev head.
- **Release flow.** Prewarm the predecessor caches before a candidate: dispatch
  `windows-product-runtime.yml` (arm64, x64) and `linux-product-runtime.yml`
  (x64, arm64) on dev without a source, then confirm each key with
  `gh cache list --key paseo-<os>-predecessor-v1-<arch>`. A candidate miss now
  warns. Measured but not adopted: Gradle parallelism (no gain), a fixed-size
  Dev Drive (creation cost cancels the install gain), Defender CPU (0-3 s).

### History sanitization and 0.1.1 replacement — complete

The user authorized removal of personal-device details and local paths from
published history, followed by a fresh 0.1.1 release and retirement of 0.1.0.
Private rehearsal reconstructed and verified signatures on 260 commits while
preserving 5,940 commits byte-for-byte, including all 5,840 upstream ancestors.
Both affected merges retain parent order; author/committer metadata and messages
are preserved. All tree differences are explicit substitutions in 32 document
blobs across six historical paths. Scanning 103,430 proposed reachable objects
found no remaining identified private strings. A rollback bundle was restored
and integrity-checked; all 40 current release assets were backed up and verified
against GitHub sizes and digests.

The user approved replacing 0.11.0 migration coverage with 0.1.0-to-0.1.1 upgrade
and state-preservation checks. Linux and Windows rebuild sanitized 0.1.0 source
`b6e0474aec58b2c169f61b81b20de890d4138e30`; predecessor cache recipes therefore
invalidate old receipts. Mac and Android retain original signed 0.1.0 fixture
bytes with source provenance `dba97434bc07ae122625dbd66568cf7e0624c578`.
These historical test fixtures and the audited Node seed move to
`ci-upgrade-fixtures-v0.1.0`; they are not relabeled as new products. Scans of the
seed, Mac closure and Android APK covered 1,445,246,291 decompressed bytes with
no identified private strings. The six 0.11.0 assets are no longer CI inputs.

The release boundary retains original provenance while its ancestry pointer
uses the signed replacement. Eighteen focused native/cache/boundary checks passed
in 3.26 seconds. Full final-source CI, native 0.1.1 candidate verification,
publication, retirement and fresh-clone verification remain outstanding.
Existing runtime budgets and required release gates are unchanged. Personal
device installation or disruption is not part of these hosted checks.
The pre-push scan's false positive for a documented public-template Git blob SHA
is recorded as one exact historical fingerprint in `.gitleaksignore`; no rule
or path is broadly excluded.

The first sanitized candidate, run `38460110453`, passed all Linux and Windows
native upgrade/state checks, but paired authorization and a transfer rejected a
root reported as queued while jobs were executing. Retry `38466940433` failed
before native builds because completed authorization jobs had empty API step
lists. Neither attempt is publishable. The controller now reconciles required
steps through the exact job endpoint with a fixed deadline, and requires live
same-attempt jobs plus a fresh root-authority check when the root reports queued.
Identity, cancellation and successful-step checks remain mandatory. Twenty-seven
focused checks passed in 1.09 seconds. This policy repair requires a newly
authenticated replacement candidate; old attempt receipts cannot be combined.

PR #104 passed authenticated source checks and merged as `619bc3718945d9327305b0f36c9da9540fc240f5`.
Candidate `38474320696` again failed before tests because the successful grant
issuer had no step details in either GitHub API, and later jobs returned partial
step lists. GitHub's step records and job logs are no longer proof authority.
Each job whose success a verifier relies on now signs a Sigstore step proof with
`actions/attest` after explicit `success` outcomes of its required steps. The
subject names the repository, run, attempt and slot; the predicate carries the
source receipt or uploaded artifact identity. `.github/scripts/step-proof.mjs`
verifies it through `gh attestation verify` and checks the certificate's exact
run invocation, signer workflow, ref, source commit and GitHub-hosted runner.
PR source receipts, worker grants, the paired manifest, paired build/import/sign
jobs and every native producer use these proofs; job conclusions still come from
the jobs API. Routine signing runs beside the lanes, off the critical path, and
the required gate fails without it; fork PRs, which receive no signing token
and are never release sources, may skip it. Deep proofs also bind the signer's
merge checkout to the PR's exact base and head. Known limits: a certificate
names the workflow and attempt but not the job, so any job granted signing in
the same workflow attempt could sign another slot; every such job runs only
authenticated source, and job conclusions are still required. Recovering from a
routine signing outage needs a full rerun, because re-running only failed jobs
keeps the earlier planner receipt. Earlier attempts remain inadmissible.

Two more transient failures each cost a candidate attempt. Nix's single-threaded
xz pushed the desktop closure export to its 300-second command limit, so the export
now compresses in parallel and keeps the same signed `.nar.xz` format; exports
took 4.4 and 3.5 minutes instead of about 7. GitHub then answered valid reads with
HTTP 500, so idempotent GET reads now retry twice, after 2 and 5 seconds, on 5xx
responses or timeouts. Writes, 4xx and aborted requests are never retried, and
callers still check every response.

[Paseo 0.1.1](https://github.com/iExalt/paseo/releases/tag/paseo-v0.1.1) is
stable/latest from verified source `93e456d42126bbed9d4d2765ef1eed409499337c`.
Candidate run `38498613083` passed on its first attempt in 52.7 minutes with
attested step proofs for every relied-on job. All 32 signed packages, receipts and
metadata were copied from draft `412267116` without rebuilding or re-signing. Each
was hash-verified before staging, after re-downloading the destination draft, and
again after anonymous public download; the tag resolves to the source.
Bookkeeping now records 0.1.1 as the release boundary at that source, and PR #107
is `autorelease: tagged`. Production release preflight on dev reports the
recorded boundary verified and finds no user-facing commits since that source.

Release 0.1.0 and the six superseded tags, including `paseo-v0.1.0`, were then
deleted by exact ID and exact-lease atomic push, after a dry run. Stable 0.1.1 and
the `ci-upgrade-fixtures-v0.1.0` release were checked unchanged first. A fresh
clone of every published branch and tag scanned 103,177 objects with no identified
private strings, verified the signatures of all 228 reachable rewritten commits,
confirmed all 5,840 upstream ancestors unchanged, and passed `git fsck`. Proposals,
upstream sync and the dev rebase are back to their original state; native
candidate execution stays disabled. Old objects remain reachable by SHA and
through pull-request refs, which only GitHub Support can purge; this is accepted.

- D3 authority update, 2026-10-13: the user explicitly selected stable **0.1.0**,
  authorized deletion of all earlier releases/drafts, and requested removal of
  the old Mac app plus an Android download link. This supersedes the earlier
  release-preservation restriction for this cleanup. Historical Git tags remain.
  Stable publication, release bookkeeping and historical cleanup are complete. Personal-device installation,
  migration/recovery and final G6 acceptance are not established by this request.
- The old 0.11.0 `/Applications/Paseo.app` and `~/Applications/Paseo.app`
  launcher were removed after graceful shutdown of the app and its verified
  supervisor/daemon. Both entries are recoverable from
  `~/.Trash/Paseo-0.11.0-before-fork-0.1.0`; app data, credentials and Nix
  profiles were preserved. No new Mac installation or phone operation was performed.

### D3 stable publication — 2026-10-13

[Paseo 0.1.0](https://github.com/iExalt/paseo/releases/tag/paseo-v0.1.0), release
`411994337`, was published as stable/latest at 18:46:53 UTC (14:46:53 EDT).
Tag `paseo-v0.1.0` resolves exactly to verified source
`dba97434bc07ae122625dbd66568cf7e0624c578`. The 14 packages, closure metadata,
canonical manifest/signature and verification evidence were copied without
rebuilding or re-signing from draft `411807759`; attempt prefixes were removed
to match the signed canonical asset names. All 40 destination-draft assets were
downloaded and hash-verified before publication. All 40 anonymous public downloads
subsequently matched the exact verified sizes and SHA-256 digests; stable/latest
discovery and the source-bound tag were rechecked before handoff.

The release includes eight preserved CI dependencies: six assets from the pinned
0.11.0 predecessor, transported as `legacy-0.11.0-*`, and the two pinned Node seed
assets. Consumers save legacy files under their original basenames; original
signed metadata, package/source identities, size/hash and signature checks remain
unchanged. This permits deletion of old release records without breaking future
upgrade verification or forcing Node source builds. These are CI fixtures, not
current app downloads. Cache policy and the routine CI budget are unchanged.

Release bookkeeping records 0.1.0 at the published source, removes the bootstrap
`release-as` override, and preserves the original Git history. Production proposals
were paused during handoff and are enabled again. PR #99 is now
`autorelease: tagged`; native candidate execution remains disabled.
Unknown publication/deletion API outcomes require
exact-ID/tag reconciliation before retrying; never recreate a public release,
overwrite verified assets or rebuild different bytes under the published tag.
Rebases preserve `originalSha` while rebinding `currentSha` through the existing
signed replay checks. Later version overrides go through the authenticated bot
proposal and the full candidate gate, followed by separately authorized promotion.

The [Android APK](https://github.com/iExalt/paseo/releases/download/paseo-v0.1.0/paseo-0.1.0-android-arm64.apk)
is the manual phone download. Mac installation uses the signed Nix closure and
`mise exec -- node scripts/paseo-nix-update.mjs migrate`; this command has not been
run on the personal Mac. Normal `rollback` / `reactivate-high-water` commands
retain the verified recovery state after migration. Personal installation,
state/recovery checks and final G6 acceptance remain open.

Handoff [PR #101](https://github.com/iExalt/paseo/pull/101), `7374b8e0a`, passed
full seven-lane PR/dev runs `38449862807` / `38450533878` in **4m30s / 4m08s**
before cleanup. The stable updater independently selected release `411994337`,
and production release preflight accepted the new boundary. Five focused
boundary/preflight/release-engine checks passed in 2.32s, including the next
semver proposal. Required verification and the original baseline were unchanged.

All 20 earlier releases were then deleted by an exact-ID allowlist: five public
releases and 15 drafts, including the promoted source draft. Fresh destination
asset IDs, uploaded state, sizes and hashes were checked before deletion; only
stable release `411994337` remains. All **252 historical Git tags** are unchanged;
only `paseo-v0.1.0` was added. The 14 retired signed descriptor/digest authorities,
source metadata and exact promoted payloads remain in the local ignored audit
directory; old release URLs no longer resolve. Redundant verification downloads
were removed, freeing 6,037,704,540 bytes. GitHub caches remain six entries /
5,306,868,709 bytes against the unchanged 10 GB limit. No personal device
installation or recovery test is claimed.

### Prior phase baseline and evidence

- Baseline: `f48cc61be6457f2d90f3acb79551f4e1b27fe8a7`; sibling
  `paseo-github-workflows`, branch `ci/github-workflows`.
- Reviewed implementation `72300136d` is integrated on `dev`; PRs #1–#3 merged
  by fast-forward after their final-source routine checks passed.
- Authority: Phase D1/D2 approved on 2026-10-12, including reviewed commits/pushes,
  bounded free-runner signing, draft transfers and native candidate trials under
  the confirmed $0 stop control. D3 personal-device/public-release operations retain the boundaries in the
  [script](GITHUB_WORKFLOWS_SCRIPT.md).
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
- Phase B / G2–G3 complete; all four chunks and integration are reviewer-accepted.
  Mac/Android evidence is at `842a70f0c`, Nix at `b74c9822e`, Linux formats at
  `db2316365`, Windows ARM/x64 at `b065b31e5`, and x64 cache transfer at `c787e125c`.
  These are named contributors, not a universal current-SHA rebuild. Public
  release and installed-user 0.1.0 migration remain unperformed D gates.
  Latest routine PR/dev passed in 4m24s/4m15s at `c787e125c`;
  this does not replace the accepted baseline above.
- Phase C / G4 live evidence is complete at source `07b997d79`: scoped App
  credentials created and updated authentic 0.1.0 and 0.1.1 proposals, stale
  checks and forged identity were rejected, and an isolated rebase merge matched
  the tested tree. Final integration is reviewer-accepted. No public release,
  production proposal activation or device migration
  occurred; the two rehearsal refs have been removed.
- Phase D1/D2 / G5 is verified at `dba97434bc07ae122625dbd66568cf7e0624c578`.
  Authentic proposal #99, current-head routine/deep checks, native-disabled
  canary and the complete unpublished trial passed. The independent reviewer
  accepted the final signed inventory and runtime/cleanup evidence. D3/G6 public
  publication was subsequently authorized and completed above. Personal-device
  migration remains unperformed.

### G5 completion evidence — 2026-10-13

[Full trial 38420127176, attempt 1](https://github.com/iExalt/paseo/actions/runs/38420127176)
completed all 14 cells across eight producer groups and ten verification lanes.
Its 53-job graph took 51m52s from first job to final completion (7s initial queue;
52m from creation), with 4h28m49s summed successful runner time. This is the
release-candidate gate, separate from ordinary PR CI. It finished at 16:05:00 UTC
(12:05:00 EDT). The stop monitor removed native enablement afterward.

At G5 completion draft `411807759` was unpublished with exactly 32 assets. Its descriptor
SHA-256 is `06305743b30e9778fc8681d83474a307b49ad14c99dadbe78f7b18185a867680`;
its signed canonical manifest SHA-256 is
`22753678a016e300c1b10448e680a265e4bf244f5b1406b76bc57fee1950a43d`.
Aggregate job `115399845699` independently downloaded and hashed the complete
current-attempt package inventory before signing. Local reconciliation verified
signatures, metadata, signing-input digests and exact inventory; it did not
repeat every large package download. All eight retained UI archives were
independently digest-checked, extracted and inspected. Native state, normal close,
real Windows STT/TTS, zero-owned-process and storage cleanup proofs passed.
These disposable upgrade fixtures do not establish personal-device migration.

| G5 failure boundary                                                                              | Discriminating evidence                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Missing/failed native cell cannot qualify                                                        | Canary `38418838711` passed all ten verification lanes with native/signing disabled; aggregate alone rejected the incomplete matrix. Failed full trial `38407499134` stopped without publication.                                    |
| Stale identity, wrong signature, mixed attempts, competing candidates and published immutability | Cheap `scripts/candidate-descriptor.test.mjs` authority, aggregate and immutable-transport fixtures; exact authenticated proposal #99 tree/sole-parent merge proof.                                                                  |
| Partial upload and interrupted response recovery                                                 | Live starter-asset failure and same-draft attempt-three recovery on `38326028608`; REST rehearsal at `4e4122904` downloaded identical bytes after a simulated lost response. Signed assets were preserved.                           |
| Cancellation and strict cleanup                                                                  | Earlier owned-process cancellation trials plus full current Windows ARM cleanup: 19 links per tree unlinked without following targets, both worktrees/registrations and VHD removed in 128s within the unchanged three-minute limit. |
| Complete same-SHA success                                                                        | Run `38420127176` attempt 1, signed 14-cell manifest and exact 32-asset unpublished inventory; no cross-attempt substitution.                                                                                                        |

At G5 completion public release and historical tag inventories were unchanged;
all 14 retired candidate authorities and their assets were preserved. D3's later
authorized cleanup is tracked above. The exact owned
`ci/macos-bundle-diagnostic` remote branch was deleted with its expected-head
lease, and its clean sibling worktree/local branch removed; focused proof logs
remain in the ignored implementation evidence directory. The requested main
worktree and original checkout are retained. Legacy
`fork-builds.yml` now exposes only `workflow_call`; its old push/manual entrypoints
and temporary path exceptions are gone. Ordinary dev pushes run routine CI and
proposal automation without starting release packaging. Candidate execution uses
the authenticated merged-proposal/owner-retry entrypoint and explicit native gate.

The final repair PR/dev pair `38414844264` / `38415751617` passed in 4m39s/4m47s,
with 23m59s/23m23s summed runner work. The seven-lane 4m15s/4m18s baseline and
under-five-minute ceiling remain unchanged. No required check was relaxed.
The all-CI timing review identifies Windows ARM as the longest producer at
40m22s: candidate/predecessor dependency installs took 12m07s/8m56s and builds
5m15s/4m07s. The earlier native baseline took 65m28s with installs 23m32s/20m55s;
these different-source hosted runs are not a controlled speedup ratio. The
controlled ReFS extraction comparison and current full cleanup validate the
storage optimization. Android assembly took 20m07s; Linux Nix x64/ARM producers
27m37s/23m28s; Mac production build took 9m48s, including 305.656s web bundling.
The scoped Darwin heap repair completed without increasing deadlines. Final
aggregate verification/signing took 1m56s. Native package work remains parallel
and outside ordinary PR blocking CI.

Six repository caches total 5,306,868,709 bytes, unchanged by this trial and below
the 10 GB limit; save admission remains 8 GB and candidate consumers restore only.
The confirmed $0 Actions stop control and standard free runners remain the cost
boundary. The two-minute routine goal and broader timing improvements are stretch
work, not claimed complete; installed-dependency caching remains explicitly
deferred by the user.

### Historical D repair evidence

The following records explain earlier failures and their repairs. Statements of
then-pending native proof are superseded by the complete G5 receipt above.

The cold macOS diagnostic [38411654299](https://github.com/iExalt/paseo/actions/runs/38411654299)
was based on exact source `2c6f331bd`, with the disposable export-only memory
change, Nix 2.34.7 and the pinned Node 26.11.0 derivation
on the standard 7 GiB / three-core runner. Its single Metro worker and export-only
`--max-old-space-size=4096` completed web bundling in 269.584s and the complete
cold Nix build in 525s. Default heap capacity was 2,248,146,944 bytes; the explicit
setting yielded 4,395,630,592 bytes. Sampled Metro RSS reached 2,230,960 KiB;
all one-minute swap samples were zero. Samples do not establish peak RSS, and the
heap setting is not a whole-process memory bound. The production repair scopes
these settings to the Darwin web export, retaining all existing build deadlines.
The observer now binds a build-emitted root to the prepared exact desktop output,
covering the observed `/nix/var/nix/builds/nix-…/source` layout; invalid or conflicting
identity disables sampling without altering the build result.

The preceding long-path repair passed routine PR/dev runs `38403404109` and
`38404178748` in 4m51s/4m25s (25m09s/23m17s summed runner time). The seven-lane
4m15s/4m18s baseline and under-five-minute ceiling remain unchanged; no recurring
checks or budgets were relaxed. Its dedicated long-path fixture succeeded, but
the initial cancellation log did not distinguish a surviving directory from
surviving registration; the focused reproduction below resolves that uncertainty.

The cancellation cleanup failure was reproduced by hosted Windows fixture
[38413287313](https://github.com/iExalt/paseo/actions/runs/38413287313): Git returned
zero and removed registration but left `node_modules` containing junctions. The
repair removes recognized junctions/symlinks without following targets before Git
removal, after zero-process and exact-volume checks. It rejects redirected roots
and unknown reparse types. Hosted fixture
[38414104233](https://github.com/iExalt/paseo/actions/runs/38414104233) then removed
both owned worktrees, their registrations and the VHD in eight seconds, preserving
an external sentinel reached by a junction. Both trees included 1,000 long-path
files and owned writers terminated at their deadlines. The subsequent full installed npm-tree cleanup passed in 128s in the G5 trial
above, within the unchanged three-minute limit.

## Outcome gates

| Goal                                             | Status / evidence   | Depends on                     | Exit and owner                                                                                    |
| ------------------------------------------------ | ------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------- |
| A1: feasible candidate and cost contracts        | complete / verified | none                           | G0, author with user decisions                                                                    |
| A2: measured routine verification                | complete / verified | A1                             | step 2 live events and accepted latency ceiling, author/user                                      |
| A3: exact rebased-tree verification              | complete / verified | A2                             | G1 including atomic publication failure fixtures, author                                          |
| B1: deep journeys and safe PR routing            | complete / verified | A1–A3; B2 for Android closure  | G2, author                                                                                        |
| B2: Mac/Android candidate preservation           | complete / verified | A1–A3                          | Mac/Android portion of G3, author                                                                 |
| B3: Linux package matrix                         | complete / verified | B2 for closure                 | Linux portion of G3, author                                                                       |
| B4: Windows package matrix                       | complete / verified | B2, B3                         | Remaining G3 and phase integration, author                                                        |
| C1: independent version and updater transition   | complete / verified | B1–B4                          | Step 7 source/fixture integration; installed migration belongs to D, author                       |
| C2: scoped version proposal automation           | complete / verified | C1                             | Step 8 configuration and actual bot event delivery, author                                        |
| C3: consecutive bot proposal rehearsal           | complete / verified | C2                             | Remaining G4 current-head, forged-label and merge-identity proofs, author                         |
| D1: exact-candidate coordination                 | complete / verified | C1–C3                          | Step 9 authenticated source, complete aggregate and legacy retirement, author                     |
| D2: failure recovery and complete draft          | complete / verified | D1                             | Step 10 / G5 signed same-SHA matrix and failure boundaries, author                                |
| D3: first public release and installed migration | active / mixed      | D2 and explicit user authority | Stable publication verified; personal-device recovery and final G6 acceptance remain, user/author |

### Historical coordinator implementation evidence

The records below retain incremental verification boundaries; the current G5
receipt above supersedes their then-open D1/D2 checks.

D1b source authority and draft transport are reviewer-accepted; the hosted
production entry-point rehearsal remains open. A merged proposal must match its authenticated
bot identity, verified premerge tree and sole rebase parent, and remain in dev's
ancestry. Candidate descriptors bind the 14 cells, upstream base, source and policy
digests, and premerge run attempts under a separate Ed25519 signature domain.
Version-plus-source draft identities and immutable attempt assets reject replacement
bytes; interrupted uploads reconcile by downloading and hashing the existing asset.
These cheap fixtures do not establish a live candidate: complete workflow wiring,
real package transfers, exact-source reruns and the D2 native matrix remain open.
The trusted closed-PR/owner-retry entrypoint is implemented with
keyless controller planning and independently revalidated issuance; only first issuance
receives the signing key. Retry requires historical policy bytes to match both
the signed digest and the currently trusted policy, so a policy change requires
explicit reauthorization rather than silently changing candidate identity.
Its local entrypoint fixture covers plan, issuance and retry without old logs.
Hosted descriptor issuance and attempt admission are now verified; worker
authentication and the full candidate remain unverified. The existing pinned
manifest key is provisioned as an Actions secret.

The reviewer-accepted transport-only REST rehearsal at `4e4122904` passed in
26.89s: draft `410728638` recovered a simulated lost upload response, reused
immutable asset IDs and verified downloaded bytes. Its ephemeral key and fixture
version 0.0.0 were never production candidate authority. The exact owned draft
was removed and release/tag inventories matched the initial snapshot afterward.
Real package streaming and admitted-attempt worker execution remain open.

Streaming and attempt admission source is reviewed and integrated:
package transfers verify a stable file handle and actual byte/hash
counts; the trusted coordinator admits only the current nonterminal root Actions
run and monotonic attempt. Workers check the active tuple before and after writes.
A supersession racing an upload may leave an immutable unadmitted asset; aggregate
admission must exclude it. No cross-attempt proof reuse is allowed initially, and
the full lifecycle must stay inside the coordinator's global concurrency group.
PR #70 integrates the preceding authority/entrypoint source at `4e4122904` after
routine run `38267651739` passed in 4m34s (21m30s summed); same-SHA dev run
`38268486424` passed in 4m33s (23m10s summed). Streaming/admission source
`7d4feb67f` is reviewer-accepted and integrated through PR #71: PR run
`38269152232` passed in 4m38s (23m59s summed), and same-SHA dev run
`38270034555` in 4m42s (22m57s summed), within the unchanged five-minute budget.
This does not close the complete candidate matrix.

D1c coordinator source through `5cf5d2043` is reviewed and integrated. Its
first production canary exposed GitHub event-identity assumptions before issuance;
the repair and recovery rehearsal remain active. The root connects seven routine lanes, three deep
journeys, all 14 native cells, eight trusted transfers and a final aggregate.
Workers authenticate descriptor/source/attempt and validate their current API job
name before costly execution. Transfers require completed signing/import/runtime/
cleanup evidence, exact ZIP provenance and independently hashed package bytes.
The aggregate downloads every draft package again and accepts only a complete
current-attempt matrix; a subsequent controller-only step rechecks admission and
signs an immutable attempt-scoped inventory. Drafts remain unpublished.

Linux Nix emits distinct daemon/desktop signed closures, then verifies exact
archive/manifest bytes and recursive NAR signatures in independent empty isolated
stores with builders/substituters disabled. This is isolated-store proof, not a
fresh-runner runtime claim. Mac retains fresh-runner closure verification and
unchanged consumer metadata. Android signing remains controller-only. Signing
key files have in-process and workflow-level cleanup. Retry inventory now uses
bounded asset pagination and rejects duplicate identities.

Coordinator calls restore exact predecessor/Gradle dependencies without saving;
manual Linux and Windows cache writers share one repository-wide lock. Android's
implicit npm cache and Gradle save hook are removed while preserving its exact
existing Gradle restore key/paths. Misses still build and verify; no cache was
removed. The first production candidate will run with native work disabled and
must fail final aggregation without receiving its signing key. Only after that
cheap identity/routine/deep canary is reconciled will a full same-policy retry
run native work; no proof carries across attempts. Actual native CLI behavior,
reusable job names, transfer timings and all 14 current-SHA cells remain D2 gates.

Published PR #72 at `9e3a450c2` passed routine run `38272451302` in 4m33s
(22m33s summed); same-SHA dev run `38273164338` passed in 4m28s (23m35s).
The unchanged baseline is 4m15s/20m18s PR and 4m18s/20m37s dev. App test time
in the latest PR was 149.64s versus 99.52s at baseline, with 633 versus 631 files;
imports accounted for 53% versus 51%. This localizes the critical-path growth but
does not isolate hosted-runner variation from source cost. The all-CI performance
review and two-minute stretch remain open; budgets and verification are unchanged.

PR #73 run `38277353937` failed the unchanged 90-second Linux file-observer
stress test; dev integration stopped. A deterministic injected-watch fixture
reproduced a coverage gap: a file created between enumeration and watch attachment
was permanently missed. Reviewed repair `f264f064d` attaches coverage before
enumeration and adds bounded failure-phase diagnostics without reducing the burst
or raising its deadline. The five local observer suites pass in 15.33s, including
the Linux backend fixture; hosted Linux verification and attribution of the
original timeout remain pending.

Reviewed API repair `a0d2a598c` batches fresh lifecycle metadata in GraphQL and
reuses only immutable authority within a transfer. Full REST asset pagination and
fresh admission checks remain mandatory. The first-page callgraph estimate is
760–880 REST requests plus 110–130 GraphQL queries; GraphQL point cost must be
measured separately. Additional pages, redirects, action internals and concurrent
CI add overhead. The native-disabled canary must reconcile sanitized live quota
evidence before full fanout; the estimate is not a measured full-attempt result.
Response-header counters cover the candidate adapter only, not authority/job
queries made through `gh` or action internals. Shared-token counter changes can
bound intervening usage but do not attribute it to individual callers. Missing
headers are reported as unavailable, never zero; only allowlisted counters are logged.
An actual read-only GraphQL schema probe rejected `targetCommitish`, which Release
does not expose. Supported lifecycle fields cost one point in the authenticated
probe; candidate target identity uses a fresh REST metadata read with cross-read
consistency checks. The corrected estimate includes that read on every guard.
Full enablement requires enough observed quota for conservatively estimated
remaining work and concurrent CI; the estimate alone does not authorize fanout.

Existing closed-PR run `38273169558` reports the PR head branch, while its mutable
API PR association now points at a later PR on that branch. Root validation uses
the original event payload to bind the authenticated merged PR and branch,
retaining the independent controller-SHA check and merged-source proof. Artifact
branch provenance follows that authenticated context; manual retries still require
`dev`. Actual rebased-bot event SHA and reusable context remain canary checks.

At `2f8c4a1ca`, routine PR run `38279311229` passed in 4m18s (20m40s summed);
the Linux observer suite completed in 977ms with its stress workload unchanged.
Final-source run `38280405652` then exposed repeated setup latency rather than
test failures: attempt 1 spent 104.8s downloading Node and hit the two-minute
planner deadline; attempt 2 spent 182s in app-lane Node setup, exhausting the
five-minute job before tests started. These failures do not count as passing
routine measurements, and the baseline/deadlines remain unchanged.

The bounded setup probe `38282228694` passed in 15s. The stock runner lacked exact
Node 26.11.0; pinned `setup-node` downloaded it from GitHub's Node distribution in
5s, and mise activated the same verified binary with npm 11.20.0. This is cold
download evidence, not a cache hit. Shared setup uses this route for Ubuntu x64
routine/deep CI and candidate controller/verification/transfer jobs. No repository
cache allocation is added; the existing six caches occupy 5,306,868,709 bytes.
The temporary probe mode is removed. Final-source PR/dev measurements remain open.

At `9e4b5e5fb`, PR run `38283121071` confirmed 10–13s runtime setup across all
seven lanes, but server-2 hit the five-minute deadline: dependency installation
took 190s, verification 88s, and the job ended cancelled at 303s despite passing
all test steps. Other installs took 63–113s. Required aggregation correctly failed;
this is not an accepted run. Existing logs cannot separate download, extraction
and dependency-script delay. Temporary npm phase timing on the next required run
preserves the lock, normal scripts, tests, caches, concurrency and deadlines.
Integration and candidate issuance remain gated on final-source CI success.

Diagnostic run `38284079731` isolated a package acquisition stall: quality completed
2,831 of 2,832 package extractions within 56s, then waited until the job deadline
on the locked nested `glob@13.0.6` tarball, before dependency lifecycle scripts.
Other lanes installed in 56–73s. A temporary loopback probe of npm 11.20.0's
bundled fetcher verified delayed headers retry, stalled bodies fail with
`EIDLETIMEOUT`, and healthy streaming can outlast the timeout. Routine installation
now bounds idle/request waits to 30s and retry waits to 1–5s, preserving two request
retries and normal lock/script/integrity behavior. Partial-body timeouts fail fast;
they are not automatically retried. Hosted acceptance remains open.

The bounded-install trial `38285100098` at `25f702751` passed all seven lanes and
aggregation in 4m11s (21m56s summed), with installs taking 47–73s. This single
hosted pass contains no observed request retry and does not establish a controlled
speedup. Temporary phase timing is removed; the same install-only bounds cover
Linux deep and exact-candidate verification. Final changed-source PR/dev gates
remain required before issuance; the stable performance baseline is unchanged.

Final-source PR `38285727192` and same-SHA dev `38286302261` both passed in
4m42s at `5cf5d2043`; exact nonforce integration closed PR #73. Installed-dependency
caching is deferred at the user's request. Authentic bot PR #74 passed routine
`38287154658` and all three deep lanes in `38287155192`. Conditional rebase merge
`376090618` retained sole parent `5cf5d2043` and tested tree
`3712c173aeb208518d4e2b856b07f0469cf41517`.

Native-disabled canary `38287902994` failed in read-only planning: GitHub emptied
the earlier runs' PR associations after merge. Its API run head remains PR head
`044171222`, while the trusted checkout is merge `376090618`. No draft or
descriptor was issued; public release/tag inventory is unchanged. The repair
uses immutable checkout receipts for merged-PR association, separates API head
from controller identity through artifact validation, and permits owner-only
initial issuance by authenticated merged PR number. This input is mutually
exclusive with draft-ID retry; only initial issuance receives the signing key.
Both plan and issue independently verify merged authority. New PR/dev checks and
native-disabled recovery against PR #74 remain required before native enablement.

Recovery repair `f419ba2cc` passed PR #75 in 4m27s. Same-SHA dev
`38289212754` attempt 1 passed all functional checks but failed the strict 300s
latency gate. Identical app tests took 97.20s in PR versus 156.93s in dev;
dependency builds took 6.90s/11.39s and installation 48.48s/75.25s on the same
Ubuntu image. One full unchanged rerun passed; both measurements remain evidence,
not a reset baseline or proof of a source regression.

Owner recovery `38290484353` verified merged authority and created draft
`410889371` with signed descriptor digest
`96b8c1592ddbb793a9529b5ca988b2ba8dd545151569e430b25dba483b186bd3`.
Admission then failed: GitHub's body-only PATCH replaced its draft tag with
`untagged-a3270c8a346d9ee3cb9d`. Disposable probe `410891045` reproduced the
mutation and verified that explicitly including the unchanged tag preserves it;
the probe was deleted. Only the descriptor and signature exist in the production
draft; no verification/native matrix or final manifest completed.

The adapter repair at `d03d5e5c6` validates current identity/admission, preserves
the verified tag in PATCH, and checks fresh readback. PR/dev runs
`38291282481`/`38291894498` passed in 4m53s/4m37s. With explicit user approval,
draft `410889371` was stopped and its draft tag changed to
`paseo-retired-candidate-410889371`; its descriptor/signature assets were preserved
and no Git tag created. Fresh signature, asset-ID/hash, lifecycle and no-tag
checks passed before and after retirement.

Replacement run `38308904161` verified the same PR #74/source `376090618`, issued
draft `410999337` and admitted attempt 1 while preserving its canonical draft tag.
Its descriptor digest is
`793f33590fdd798b132ae6e21948026bf1b2621d6c1cb07b203d16a99d4049eb`, under
policy `7ec07adb6c0dbf1ceaa93218c71a6a32969067080142575dcab61b02e9859b08`.
All ten verification workers then failed their first draft metadata request with
HTTP 403 using read-only workflow tokens, before candidate checkout or tests.
Native jobs and transfers were skipped; aggregate failed closed. The draft
contains only descriptor/signature assets `635005493`/`635005605`, with no final
manifest. A trusted authentication handoff to read-only workers is under design
review; any changed stop/admission boundary and replacement signed policy require
explicit reauthorization. Native enablement remains blocked on canary closure.

User-approved, reviewer-agreed amendment: controller-only authentication
jobs read fresh draft admission and pass a bounded immutable Actions artifact to
read-only workers. Separate grants cover verification, native build groups and
later Mac/Android installed runtime; signing stages retain fresh admission checks.
Each grant binds the signed descriptor, controller/source, root run/attempt and
allowed worker names. Consumers verify signature, artifact identity/digest,
successful authentication job provenance and a still-active root before checkout.
Authentication jobs receive no signing key and execute no candidate code.
Supported manual stop cancels the root, waits for terminal state and cleanup
evidence, then marks admission stopped. A draft-only stop after grant issuance may
allow computation to start, but fresh transfer/aggregate checks still reject it.
The extra controller/artifact overhead must be measured; existing CI budgets stay
unchanged. Implementation is active; replacement of draft `410999337` is approved after
review and source verification, preserving its signed assets.
The grant implementation is reviewer-accepted in the worktree. Its 48 targeted
checks passed in 4.74s, including real ZIP transport and grant-backed worker
authorization. Native-disabled hosted validation must still establish read-only
artifact access, exact nested job names, all ten verification lanes and added
scheduling overhead before native enablement.

Grant source `6b2dabfd5` is integrated through PR #77. PR run `38310681845`
passed in 4m01s; same-SHA dev `38311196465` also passed below five minutes.
Approved retirement preserved draft `410999337` and both signed assets under
`paseo-retired-candidate-410999337`. Replacement canary `38311736724` issued
draft `411016397`, retained its canonical tag and admitted attempt 1. Authentication
completed in 33s after a 3s scheduling gap and uploaded grant artifact `11774907552`.
Workers then exited before reading it: a dynamic import cycle deadlocked the
worker CLI's top-level await. Native execution/transfers and final signing stayed
off. The draft contains only signed authority assets `635064760`/`635064810`;
descriptor digest is `8f0975bad5caee0b5a47762c66e6b53bfde62864f182cc7bbe7e3dbdd3433fb9`.
The narrow static-import repair preserves the approved boundary; a real CLI
subprocess fixture rejects the old implementation and passes the repair.
The user explicitly approved retirement/reissuance of this additional signed
policy after review and green source checks.
CLI repair `28013c71d` is reviewer-accepted and integrated through PR #78;
PR run `38312349270` passed in 4m42s; same-SHA dev `38312910120` passed in 4m25s.
The resulting policy digest is
`e07aaca70911ea76c10ba7745deccaf75e4301e52172b2bc337b1c1c7a2fe3ed`.
The reviewed retirement preflight for `411016397` passes in read-only mode;
the proposed retired draft tag is `paseo-retired-candidate-411016397`, preserving
both signed assets. Public-release and Git-tag inventories remain unchanged.
User-approved standing authority: remaining unpublished D1/D2
implementation repairs may retire/reissue only the same PR #74/source `376090618`
after review and fresh exact-source PR/dev checks, recording old/new draft,
descriptor and policy identities and preserving signed assets. Security/acceptance
boundaries and budgets stay unchanged; native remains off until canary closure.
Ambiguous mutations, unexpected identities or required scope changes still stop
for reconciliation. This prevents a new approval request for each routine
same-source policy repair without bypassing signed-policy validation.

Under that approval, draft `411016397` was retired with signed assets preserved.
Canary `38313660840` issued draft `411027658` under policy `e07aaca7…`, with
descriptor `dcb25f57538faa96999a71a4ef1593589c8ccbb80fd2bb8de72564b9afa3609e` and
assets `635103580`/`635103644`. All ten workers authenticated through the grant;
nine verification lanes passed, including all three deep journeys. Quality alone
failed because a pinned-source transport fixture inherited the coordinator
workflow selector and attempted live authority. The reviewed repair unsets that
selector only in the routine-test subprocess, after authenticated source checkout;
execution gates, native transport and final admission remain unchanged. A
disposable checkout reproduced the failure and passed with the isolated context;
the checkout was removed. The 23 workflow checks pass in 3.25s. Repair `657cb216b`
is integrated through PR #79; PR `38314402607` passed in 4m30s and same-SHA dev
`38314890679` in 4m27s. Draft `411027658` was retired with its signed assets intact.
Replacement draft `411037339` carries descriptor
`bcabaf5d4be829407990861d763d55fa6ffe9fad5d4411e758aade6f91af44ca`, policy
`ecab8a7cb03a5a377919396e7c6f45729e1c8c050a22cab5ee30a3fc48a038d7`, and assets
`635139983`/`635140065`. Its first canary `38315432339` encountered npm
`ECONNRESET` during quality dependency installation; nine other lanes passed.

Unchanged same-draft retry `38316290049` passed all ten verification lanes.
The aggregate rejected the native-disabled run explicitly, with final signing
and native jobs skipped. Independent reconciliation verified the complete draft
identity, signature and admission tuple; downloaded and hashed grant artifact
`11776830882` (1,240 bytes, SHA-256
`2873d76d817d6b17fb2b4becc5b6b12f97d7a1fb97e6341c210e749052127120`); and checked
its controller/source context, worker allowlist, authentication job and upload
step. Worker logs show read-only Contents permission and those exact grant inputs.
Authentication took 25s plus 2s scheduling. All four retired drafts retain their
verified signed bytes and stopped body digests; public releases and Git tags are
unchanged. Observed adapter quota had at least 4,845 REST requests and 4,982
GraphQL points remaining, exceeding the 1,600 REST planning reserve plus 1,000
shared-usage headroom and 200 GraphQL points. These are partial counters, not
full-attempt usage. Six caches occupy 5,306,868,709 bytes; coordinator work remains
restore-only.

Reviewer reconciliation accepted the canary. Full unpublished same-draft trial
`38317031793` passed all ten verification lanes, but two native authentication
jobs saw the parent run reported as `queued` while child jobs were executing.
Their strict `in_progress` assertion failed. The trial was canceled, all jobs
are terminal, and native enablement was removed. Nix signing-key cleanup passed;
Windows stopped before building, and Linux jobs stopped during builds before
runtime verification. No complete package/runtime result is claimed.

The repair retains `in_progress` as the required execution state, revalidates
all identity fields on every response, and retries only `queued` with a null
conclusion. It allows at most six reads with 25s cumulative backoff and a 30s
acceptance deadline; an individual in-flight API request remains subject
to its existing 30s timeout. Terminal or changed authority fails immediately.
The existing fixture covers queued-to-running, cancellation, changed identity,
attempt replacement and bounded exhaustion without real sleeps. Fresh source
checks and reviewed same-source authority replacement remain before another
canary. G5 stays open; all 14 native cells and eight transfer groups must pass
in one admitted attempt. Existing deadlines, the confirmed $0 stop and
failure/identity stop conditions remain in force.

Polling repair `e7603e691` is integrated through PR #80; PR `38318022123`
passed in 4m29s and same-SHA dev `38318466707` in 4m38s. Draft `411037339`
was retired with signed assets preserved. Replacement `411057310` has descriptor
`be3612bb03e347c87b82a45c5e5e4493efd31600f7494bdd5cdef551e5d0dc1b`, policy
`7e019de71f1a8afb38e2becb2455ae18c2142ce92e4f810cf41f7e919248d10c` and assets
`635216684`/`635216756`. Canary `38319037371` passed all ten lanes, verified grant
bytes and read-only execution, and rejected native-disabled aggregation without
signing. Authentication took 24s plus 3s scheduling. Reviewer reconciliation
accepted one full same-draft retry; public inventories stayed unchanged and
observed quota exceeded the conservative reserve.

Full retry `38319798522` passed authentication and reached native builds, then
both Linux Nix architectures rejected the same stale dependency hash. The 0.1.0
lockfile reset changed the fixed-output input without refreshing
`nix/npm-deps.hash`. Both builders computed
`sha256-XUXsxOmy4fXeZlmgNlQAT+WG7MdQwj1Zgo1gOEFuXw0=`; an independent local
prefetch using the exact `flake.lock` nixpkgs fetcher reproduced it. The corrected
hash and refresh comment were subsequently published in `c052ac894`. Correcting the
immutable product source requires a new authenticated 0.1.0 proposal and fresh
proofs; the existing same-source authority does not cover that transition.
The user approved explicit unpublished-proposal replacement and pre-merge hash
maintenance, preserving bootstrap/publication history and signed assets, and
authorized autonomous resolution of routine Phase D issues. Public release and
personal-device migration remain excluded. The replacement transition is now
implemented and its proposal/canary proof is recorded below; full native proof remains open.

The failed trial is terminal/canceled and native enablement is removed. Linux
product cleanup and Linux/macOS signing-key cleanup passed. Both Windows jobs
were interrupted during dependency installation; their cleanup steps failed
because the monitor's final receipt was absent. Windows cleanup is unproven,
not waived by hosted-runner termination. A separate repair must exercise the
actual PowerShell wrapper under console cancellation, retain private kill-on-close
Jobs, persist verified zero-process evidence and continue rejecting missing
receipts. No package/runtime result or G5 completion is claimed.

The reviewed cancellation repair now records cancellation inside the owned-Job
monitor and atomically persists its final receipt before returning to PowerShell.
Private kill-on-close ownership remains unchanged; cancellation cannot qualify
for the build-only telemetry exception. Actual hosted cancellation trial
`38322791846` exercised the production child-PowerShell invocation, preserved a
canceled, complete, zero-active receipt, and independently found both fixture
descendants absent; ordinary execution also passed. Synthetic Ctrl-C/Break
trials covered both signals. Hard kills and missing receipts still fail closed.
This verifies the repaired cleanup boundary, not the interrupted native builds;
the fresh-source full matrix remains required.

Repair `c052ac894` is integrated through PR #81: routine PR `38323024917`
passed in 4m32s and same-SHA dev `38323517211` in 4m56s, within the unchanged
five-minute ceiling. Draft `411057310` is now stopped under
`paseo-retired-candidate-411057310`; descriptor/signature asset IDs and downloaded
bytes are preserved. Read-only verification authenticated all six stopped signed
predecessor drafts against PR #74 and its source. The original interrupted
Windows trial still lacks its cleanup receipts.

The replacement transition and future proposal hash maintenance are integrated at
`d58c1cc1e` through PR #82; PR/dev checks passed in 4m37s/4m53s.
The pinned release engine's complete generated lock is hashed before App credentials
exist; the hash and version edits share one frozen commit. Git publication uses
an explicit expected-head lease, and lost replies reconcile exact branch/tree/PR
identity. Owner-only replacement adds one selection record over the reviewed repair
parent, preserves version/manifest/changelog/publication history, and supersedes the
old pending label only after authenticating the new proposal. Trusted candidate
admission verifies all stopped signed predecessors, including retired tags;
read-only workers validate their current-attempt grant and immutable source structure.
Later same-source authority retirement remains possible without rewriting the record.
Cheap tree, lease, interrupted-publication and signed-history fixtures passed.
Owner proposal run `38325326647` completed in 1m31s, including a fresh 39.83s
dependency-hash fetch before App credentials. Authentic PR #83 contains only the
replacement selection record; PR #74 was marked superseded after its successor
was verified. Routine/deep runs `38325444812` / `38325446209` passed; routine
took 4m44s. Conditional rebase merge `2ddc069de` preserved sole parent
`d58c1cc1e` and tested tree `4af845dadac7c3e0d530e6b00898c687d96d89b8`.
Same-source dev `38326027664` passed in 4m43s. Browser/Electron screenshots were
inspected; the previously recorded React unknown-prop toast remains visible.
Read-only probe `38325868524` exercised the actual pinned release engine with
only `contents: read` in 45s, preserving the normal pending-version pause and
unchanged dev. Its owned branch/worktree were removed.

Replacement canary `38326028608` attempt 3 is reviewer-accepted: all ten lanes
passed, native jobs/signing stayed off and aggregate rejected the incomplete
matrix as intended. Draft `411096940` binds descriptor digest
`61b32eab46450676b09668fb85082ae8276dc770f877bd1f30b673fdddcf02ee` to
source/controller `2ddc069de` and policy
`df31931bfe307f883545a5e68e671cd9db44b1ac44dd7bdc8682e171ba2b3277`.
Downloaded grant `11780359492` matched its digest; authentication took 41s plus
4s scheduling. Public release/tag inventories remained unchanged.

Initial issuance hit a partial GitHub upload: descriptor asset `635364500`
remained `starter`, and the unchanged second attempt correctly rejected it.
The release's embedded asset list omitted that placeholder; recovery therefore
used the dedicated asset-list endpoint. After terminal-run, exact identity and
unadmitted-state checks, owner recovery removed only that unfinished asset,
preserved the draft and resumed the unchanged third attempt. Uploaded authority
assets are now `635376906` / `635376989`; no signed asset was deleted.
GitHub documents this [starter-asset recovery](https://docs.github.com/en/rest/releases/assets#upload-a-release-asset).
Production transport retains its no-delete, fail-closed behavior.

Full native retry `38327254656` reached all platform builds, then stopped at Android
SDK setup: mise's repository environment replaced the hosted SDK root with an
uninstalled local SDK path. The coordinator was canceled and native enablement
removed. All jobs are terminal; Linux product cleanup, Linux/macOS signing-key
cleanup and both Windows owned-process cleanup steps succeeded. The Android
controller repair captures the hosted SDK before mise and restores both SDK
variables afterward, in build and signing jobs. Focused hosted probe `38328588289`
passed in 27s: it reproduced the displaced path and verified restoration through
Node/Java setup plus exact SDK package and build/sign tool checks. Downloaded
Windows receipts confirm complete cleanup and zero active owned processes on
both architectures, including the canceled ARM install and x64 build.
SDK repair `a1527da59` passed PR/dev routine runs `38328727921` / `38329130836`
in 4m37s / 4m42s. Draft `411096940` was stopped and retired with both signed
assets preserved. Replacement native-disabled canary `38329589528` passed all ten
verification lanes and the expected aggregate rejection, binding draft `411121812`
to unchanged candidate source `2ddc069de`, controller `a1527da59` and policy
`ea22990b67c23aad7139f46d7ebea1e25b83b5b756a55deaef7843a2573551fa`.
Downloaded descriptor/signature and grant matched; public releases/tags stayed unchanged.

Same-draft full trial `38330411476` passed Android SDK setup but stopped when Linux
installed-stage validation compared the candidate SHA against the newer controller
SHA. Native enablement was removed and every job is terminal. Linux cleanup and
both Windows owned-process cleanup steps passed. The repair passes the explicit
candidate SHA into both Linux and Windows installed-stage adapters; controller
identity still governs authorization. A lightweight adapter-boundary regression
uses distinct controller/candidate values and rejects incorrect manifest or prior
receipt identity without launching a browser. These runtime helpers execute from
the authenticated candidate checkout, so a controller-only reissue cannot apply
this repair. Repair `73446c8e2` passed PR/dev CI in 4m31s / 4m21s. Authentic
replacement PR #86 merged as `531d4a018` after routine/deep checks; its dev CI passed
in 4m40s. Native-disabled canary `38334022673` attempt 2 passed all ten lanes and
the expected aggregate rejection after one unchanged retry for npm ECONNRESET.
Draft `411164284` retains the signed descriptor and signature.

Full trial `38335315439` proved Linux ARM AppImage migration and candidate-source
validation, then APT rejected the deliberate 0.11.0-to-0.1.0 DEB downgrade. All jobs
are terminal and native enablement is off. Windows and Linux ARM cleanup receipts
are complete; canceled Linux x64 has no state-cleanup receipt. The repair enables `--allow-downgrades`
only for the authenticated candidate's exact local DEB; predecessor installation,
manifest/hash validation and installed-version checks remain unchanged. A cheap
command-boundary test exercises the actual installation loop, including paths
with spaces. DNF already selects the explicitly supplied local RPM version;
NSIS replaces the prior installation and Nix selects exact store paths, so those
commands need no analogous change. This is the approved manual migration trial,
not a change to semver upgrade eligibility. Repair `f3234351e` passed PR/dev CI
in 4m04s / 4m11s. Authentic PR #88 superseded PR #86 while preserving all nine
stopped signed histories; its exact tested tree merged as `25d37896f` after
routine/deep verification. PR/dev CI passed in 4m03s / 4m24s. Native-disabled
canary `38339266748` passed all ten verification lanes and the expected aggregate
rejection. Draft `411209003` binds descriptor `abeba105…a6734` and policy
`09d5cccb…5737d`; downloaded descriptor/signature and grant matched.

Full trial `38340039982` passed x64 DEB migration/uninstall, then stopped on a
macOS Metro web-bundling failure. Native enablement is off and every job is
terminal. Windows and Linux x64 cleanup receipts are complete; canceled Linux
ARM cleanup remains unverified. Both Linux Nix and macOS signing-key removal
steps passed. The exact failed macOS derivation had built successfully in the
previous trial, so a source defect is not established. Isolated diagnostic
`38341915378` attempt 1 reached its 30-minute cap during the npm dependency
fetch, before Metro. Unchanged attempt 2 built the exact same derivation
successfully: dependencies took about 6m19s, desktop realization 5m33s and Metro
177s. Same-draft retry `38345764047` reached the existing 60-minute macOS
desktop-build timeout after dependencies completed in under a minute. All jobs
are terminal and native enablement is off. Linux products, both Linux Nix
profiles and Windows x64 have independently reviewed UI/state/cleanup receipts.
Windows ARM also completed its local lifecycle and speech proof, but its job
was canceled and trusted transfer skipped; this is not an accepted matrix cell.
Its candidate/predecessor npm installs took 25m01s / 22m33s, dominated by
unpacking (22m44s / 21m19s), rather than the optional workerd platform warning.
The original Metro failure and subsequent build stall remain unexplained.
Focused diagnostic `38352264504` reproduced production mise/Nix setup and passed:
dependencies took 65s, desktop realization 6m29s and Metro 184s; sampled swap
remained zero. Production now streams Nix build logs to stderr with `-L`, while
preserving stdout path validation and all deadlines. This observability repair
needs a new authentic candidate and fresh gates before another bounded full trial;
the two successful exact-derivation probes do not explain the failures. Neither diagnostic establishes
the complete candidate. Cache usage remains six entries and
5,306,868,709 bytes, with no installed-dependency caching introduced. The complete 14-cell
matrix, eight transfers, downloaded inventory and cleanup remain required before
G5. No public release or personal-device migration is authorized here.
Observability repair `2098f4244` passed PR/dev CI in 4m48s / 4m08s. Retirement
of draft `411209003` preserved all 22 assets (2,199,103,174 bytes), including
partial packages and the signed authority. Authentic replacement PR #90 merged
as `c19bfd380` with its sole parent and tested tree independently verified;
PR/dev CI passed in 4m53s / 4m28s and deep verification passed. Native-disabled
canary `38355037365` passed all ten lanes and the expected aggregate rejection.
Draft `411340922` binds descriptor `53fbe2ed…da3ee` and policy
`a2292d9c…a59e5`. Full trial `38355847969` reproduced the Metro failure at
218s / 5,477 modules without an underlying error message. All 51 jobs are
terminal and native enablement is off. Interrupted Linux ARM and Windows x64
cleanup failed closed on missing lifecycle receipts; their cleanup remains
unverified. Metro-catch diagnostic `38358357515` and three realizations in
`38359832983` passed but captured no failure. Same-host comparison `38362715678`
failed the original derivation and passed the instrumented derivation; this does
not establish a cause. Both attempts of `38364454451` passed the original build
(425s / 343s), so the unchanged retry comparison never ran and that probe series
stopped. Inspection of the integrity-verified Expo CLI 57.0.28 package found an
error-loss path: `exportApp.js` logs the bundle exception then exits directly,
bypassing the logger's fatal-exit handling for Metro's asynchronous output queue.
The corrected export-boundary diagnostic `38367240072` passed in 416s without
reproducing the failure (`38366689198` stopped before building on a diagnostic
Nix quoting error). Original/no-op comparison `38368794199` passed both builds
in 289s / 218s, so it establishes no derivation-path cause. Final bounded batch
`38370277303` passed on three fresh macOS 14 hosts (3 CPUs / 7 GiB each), taking
388s / 388s / 444s with 5,478 modules; no error was captured and sampling stopped.
The underlying build failure remains unexplained. A production Expo patch now
writes the fatal message/stack synchronously before the existing logger and
exit 1. Its child-process regression exercises the actual installed catch with
a queued logger: it failed with empty stderr before patching and passed after
the existing postinstall mechanism applied the pinned patch. Fifteen targeted
patch/routing checks passed in 0.98s. This repairs observability, not the
intermittent build failure. A focused build of the new production derivation is
required before reconsidering the full matrix. The 14-cell matrix, signed
inventory and lifecycle evidence remain pending.
The production logging repair `c787a2018` passed PR/dev CI in 4m43s / 4m41s.
Focused production realization `38373318286` passed in 462s, establishing build
compatibility only. Draft `411340922` was retired with both signed assets
preserved. Authentic replacement PR #92 passed routine/deep checks and rebased
to `d0637213f`, preserving the tested tree and sole parent `c787a2018`.
Canary `38375707181` passed all ten verification lanes and the expected disabled
native aggregate rejection. Draft `411499718` binds descriptor
`3a20908755f911126b1f20a6939cd3f0b304e15b773bd25d3ff48d09a22ec446`
and policy `85fb1f4674ea51bcd1035065b9d6132afe4827ae301139afca380d8c39dc574d`.

Full trial `38376865745` stopped when Windows ARM64 candidate installation hit
its 1,780-second owned-stage deadline during extraction, before lifecycle
scripts: 295s CPU, 2.56 GB written, two Node survivors terminated, zero active
processes afterward. Producer/runtime cleanup receipts passed. macOS Metro
emitted its start line at 09:45:57 UTC (05:45:57 EDT), then no progress before
cancellation at 10:11:56 UTC (06:11:56 EDT). The fatal-error patch cannot report
a promise that never rejects; this is not evidence of a particular root cause.
All 51 jobs are terminal: 36 succeeded, one failed, four were cancelled and ten
were skipped. Linux format groups, Linux Nix groups and Windows x64 passed
their identity, UI/state and lifecycle evidence checks; these five groups are
contributors, not a complete candidate. The unpublished draft retains 22 assets
totaling 2,199,112,221 bytes; no final manifest was issued. Native enablement is
off, public release/tag inventory is unchanged, and six caches still occupy
5,306,868,709 bytes. Existing stage and routine budgets are unchanged.
The next bounded diagnostic compares identical Windows archive extraction on
existing C:/D: volumes and captures verified macOS builder process stacks during
silence. It changes neither install semantics nor cache/security settings and
cannot itself close G5. Installed-dependency caching remains deferred.
Diagnostic `38383068904` found no D: volume on the Windows ARM host, so no
volume comparison ran. Its exact macOS derivation passed in 458s (Metro
201.536s / 5,478 modules); it never became silent long enough to sample. Further
isolated macOS sampling is stopped. The production build observer preserves the
existing build command, stdout, status and 60-minute deadline, reserving two
bounded stack-sampling rounds for silence after Metro starts. Process ancestry,
start identity and source/version build directory must match before inspection.
Its cheap fixtures cover selection/PID reuse, sampling bounds and real shell
success/failure cleanup. This remains an observability repair, not a stall fix.

Windows contention probe `38383685385` compared equal four-copy extraction
workloads on two native ARM hosts, reversing serial/concurrent ordering. Serial
versus four concurrent processes took 213.951s / 221.422s on one host and
242.959s / 255.137s on the other, including inventory hashing. All copies matched
the same 9,664-file, 29,752,437-byte inventory and cleanup passed. This supplies
no meaningful throughput improvement from throttling and does not directly test
Arborist's same-process scheduling. No concurrency change is adopted. A bounded
read-only storage-capability check `38385557837` found no existing secondary
volume, but confirmed support for an isolated dynamic ReFS VHD. The follow-up
`38386498182` compared identical extraction in C:/ReFS/ReFS/C: order: NTFS took
95.809s / 87.125s and ReFS 31.992s / 31.849s, about 65% less time. All inventories
matched, volume setup took 15.392s, and independent detach/image removal passed.
The empty volume was explicitly made untrusted before package writes, with fresh
trust and WdFilter checks; no antivirus exclusions or npm changes were applied.
Full locked-install probe `38388947633` completed the exact `d0637213f` install
in 792.869s, including the previously approved build-only VCTIP cleanup, with
zero active processes and an unchanged lock. It used ordinary lifecycle scripts,
pinned native Node/npm, the existing 1,780-second owned-process bound and a
run-local download cache on C:. Its 40-minute whole-job bound reserved cleanup
before admission. This improves on the prior 25m01s install and avoids the latest
1,780-second timeout, although these whole-install runs used different hosts.
The probe's worktree-removal check failed because Windows CRLF left carriage
returns in parsed Git registration rows; independent VHD detach/delete passed.
The install is contributor evidence only. Cleanup-only replay `38391142992`
passed with 1,000 untracked fixture files, a zero-process receipt, exact worktree
registration removal and independent VHD detach/delete. Reviewed production
routing is integrated at `3970fa5bc`: ARM candidate/predecessor source worktrees use
isolated untrusted ReFS; authenticated checkout, process monitors, run-local npm
cache, packages and evidence remain on their original volume. x64 and standalone
cache proofs retain their existing layout. Normal ARM builds reject missing or
foreign storage ownership. The transfer requires successful worktree/storage
teardown, and the 150-minute job cap is unchanged with a tighter internal cleanup
reserve. Full package/runtime proof remains the next candidate matrix.
PR #93 routine run `38392290901` passed in 4m17s (21m59s summed runner time),
and same-source dev run `38392987877` passed in 4m16s (22m58s summed), against
the unchanged 4m15s / 4m18s baseline. Twelve prior signed authorities are retired
and preserved. Authentic proposal #94 rebased to `b541c9377`, with sole parent
`3970fa5bc` and the exact tested tree. Canary `38394688960` verified all ten
routine/deep lanes, skipped native/signing work and rejected the incomplete
aggregate as expected; exact-source dev run `38394687727` also passed.
Active draft `411631985` binds descriptor
`7dcd6e153a7cffb456ab40e46b8cc23b7d591d70f10e21464ea09b66b2ccd833`
and policy `933470b98be96b3ba7f76af3e55434b6b61ed048accee31217a483b7dc9e8140`.
Full trial `38395756103` began at 12:13:47 UTC (08:13:47 EDT) on 2026-10-13;
the monitor cancelled on Windows ARM64 cleanup failure and removed native
enablement. All 53 jobs are terminal: 46 succeeded, one failed, one was cancelled
and five were skipped. ARM installs passed in 835s / 617s for candidate/predecessor,
with unchanged npm behavior; builds took 337s / 257s and the installed runtime
journey passed in 184s. Git worktree removal failed on `Filename too long` after
97s, while independent VHD detach/delete passed. The receipt correctly records
`complete=false`, `worktreesRemoved=false`, `imageRemoved=true`; no Windows ARM
package transfer or final manifest was admitted. The other seven producer groups
passed, and 27 draft assets totaling 2,500,830,346 bytes remain preserved.
The macOS build passed in 493s without a stall. Its prior intermittent failure
is not claimed fixed. A per-command `core.longpaths=true` override for exact owned
worktree removal passed hosted diagnostic `38402967816`: both source worktrees
contained 1,000 verified untracked files with 449–450-character paths, and the
production cleanup body proved zero owned processes, path/registration removal
and VHD removal. Repository long-path support was disabled in the disposable
fixture, so the per-command override supplied the fix. No global Git setting is
changed; complete native verification remains required after integration.
Earlier admission-failure canary `38290484353` observed Actions limits of 5,000
for both REST and GraphQL, with 4,939/4,990 remaining at failure. These partial
adapter counters are not full-matrix usage.

Reviewer design agreement covers A1–A3 and the approved B chunk boundaries. A1 closes feasibility and
interface decisions only; it does not establish package or release correctness.
A3's exact-tested-tree and atomic-publication fixtures passed; the shared rebase
gate remains complete and uses its existing 45-minute whole-job bound. The user's
under-five-minute requirement applies to blocking PR CI, now verified on PR/dev.

## Decisions and historical execution boundaries

The current boundary is G5 complete / stable 0.1.0 published / G6 personal migration pending. Earlier phase-specific
activation and verification limits below are historical; see the current snapshot.

- User selected **0.1.0**, **semver-only upgrade ordering**, and **clean break
  with manual migration**. The independent reservation/sequence design and
  legacy compatibility bridge are superseded. No installed client was changed.
- Shared fork version rules now drive Android configuration and both normal
  updater paths. Android's mandatory integer remains internal; C1 is reviewed,
  integrated and published at `e674ae2f5` through PR #60. Corrected PR run
  `38190475746` passed in 4m26s and same-SHA dev run `38191279639` in 4m16s.
  Summed runner time was 20m57s / 22m24s versus the unchanged baseline
  20m18s / 20m37s; these uncontrolled hosted samples do not establish a source
  regression. Continue cumulative comparisons in C2. Native migration remains D.
- Native Windows ARM64 packaging uses a custom binding built from pinned
  `sherpa-onnx@1.13.8` sources and upstream ARM64 core libraries because the locked
  npm distribution lacks that binding. The unchanged wrapper's local-addon route
  loads the physically unpacked addon and adjacent DLLs. Actual installed Electron
  STT/TTS, CLI/PTY, state-preserving upgrade, normal close and uninstall/cleanup
  passed on both ARM64 and x64 at `b065b31e5`.
- Actual Android shipped-ABI installation and upgrade are verified on a hosted ARM64 runner using
  distro Binder and a pinned ashmem compatibility module. The repaired trial
  booted Android 16, installed the signed ARM64 APK and retained its foreground
  process for 30 seconds in the feasibility probe, then B2 proved the signed
  candidate's UI/daemon/terminal and disposable-state upgrade. Hardware, GPU and
  Bluetooth fidelity remain unproven. No local
  emulator or physical-device operation is authorized or running.
- The user approved manual-only legacy packaging until step 9's candidate
  coordinator. Ordinary dev pushes stop producing Mac/Android candidates; the
  temporary test-path exceptions are removed. Manual packaging retains the
  trusted `dev`/`iExalt` guards. `dev` is the repository's default branch, so the
  dispatch definition is available there; B2 used approved bounded signing and
  hosted runtime trials. The ordinary-push integration audit found
  only routine CI triggered by the dev push. Baseline repairs include production
  import-boundary fixes as well as test fixtures.
- The dedicated `paseo-release[bot]` App (ID `5280233`, bot ID `341220930`,
  selected installation `170437913`) passed hosted identity, token minting and
  single-repository scope checks in `38194783635`, creating 0.1.0 PR #65.
  Production proposals remain disabled. Required current-head CI and the full
  proposal lifecycle remain G4; draft API proofs remain G5.
- The live proposal exposed a formatter mismatch: release-please owns
  `CHANGELOG.fork.md` formatting, so only that exact root file is excluded from
  oxfmt. Engine output, workspace/version consistency, bounded changelog history,
  bootstrap digest and rebase preservation checks remain required. PR #65's
  initial routine run `38194832028` correctly failed before this repair.
- The owner-created negative PR #64 matched the expected release branch names
  and pending label, but deep run `38194592551` rejected author ID `7889894`
  against pinned bot ID `341220930`; its deep matrix was skipped before expansion
  and no lane executed. Routine `38194592591` passed; PR #64 was closed unmerged
  and its exact temporary head deleted. Real bot open/label events raced on
  PR #65 (`38194831999` / `38194832043`); an explicit relabel produced a newer
  run, then the formatter failure stopped the trial before any merge.

## Performance and storage contract

The all-CI stretch goal is approved. Inventory below uses existing job/step API
receipts, not new benchmark dispatches. Durations exclude initial queue; summed
runner time counts parallel work. Failed/cancelled samples are not successful
baselines. These historical inputs differ from current code and must not be
treated as controlled before/after measurements.

| Workflow / callable lane              | Trigger and runner                                    | Observed timing and largest cost                                                                 | Current deadline / optimization gate                                             |
| ------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Routine CI                            | PR/dev; Ubuntu x64, seven lanes                       | PR 4m15s / dev 4m18s; runner work 20m18s / 20m37s at `72300136d`                                 | Complete gate <5m; 2m stretch, reduce setup duplication and expensive tests      |
| Legacy candidate coordinator          | Manual; Ubuntu x64 with parallel Mac/Android children | `38071895947` at `d04260338`: 23m41s critical path, 37m04s runner work, initial queue 3s         | Identity 5m; cross-check 10m; replacement in D                                   |
| macOS closure build / fresh import    | Reusable; macos-14 ARM64                              | Same run: build/sign/export 12m24s, fresh import 1m08s; Nix build 6m, export 4m26s, transfers 9s | 90m / 20m; B2 inspect compression/export before increasing parallelism           |
| Android APK build / signing           | Reusable; Ubuntu x64 builds ARM64                     | Same run: build 22m55s, sign 20s; Gradle 20m11s, npm 1m27s, transfers 10s                        | 60m / 10m; B2 inspect Gradle cache effectiveness and resource pressure           |
| Rebase dev                            | Manual; Ubuntu x64                                    | Old `38070392394` at `e399ee213`: 2m16s, install 53s; predates the complete routine gate         | 45m; current full-gate timing unmeasured, retain exact-tested-tree boundary      |
| Upstream sync                         | Schedule/manual; Ubuntu                               | `38063683920` at `585037fd8`: 3s job, 4s initial queue                                           | 5m; no measured bottleneck                                                       |
| Linux/Windows native feasibility      | Scoped work-branch push; Ubuntu ARM64 / Windows ARM64 | `38079931018` at `510974a2`: Linux 1m07s; Windows cancelled at 15m15s during install             | 15m; diagnostic only, Windows replaced by focused binding proof                  |
| Android ARM64 feasibility             | Scoped work-branch push; Ubuntu ARM64                 | `38081538748` at `def29fde5`: 2m, runtime setup/assertions 1m49s                                 | 15m; same-SHA APK deep proof in B2                                               |
| Windows ARM64 binding feasibility     | Scoped work-branch push; Windows ARM64                | `38082403349` at `268e5f8df`: 1m49s, focused build/runtime 1m01s                                 | 30m; packaged STT/TTS and lifecycle in B4                                        |
| Deep checks                           | Opt-in owned PR; three Ubuntu x64 lanes               | `03155ef58`: 5m15s critical, 12m19s runner work; CLI lifecycle 206.23s                           | 15m per lane; reduce repeated setup subprocesses, preserve journeys              |
| Candidate native runtime              | Manual; macOS ARM64 / Ubuntu ARM64 Android container  | Mac `38105941202` 4m58s; Android `38107787799` 5m37s                                             | 30m jobs; bounded install/upgrade journeys, immutable producer reuse             |
| Linux package evaluation preflight    | Manual; native Linux                                  | x64 `434bb96d4` 31s; substitutable Node avoids bootstrap                                         | 10m job / 8m evaluation; no product realization                                  |
| Linux Nix runtime                     | Manual; native Linux x64/ARM64                        | x64 `38109113388` 21m46s; ARM `38110354030` 16m55s                                               | 45m job / 35m build; source filtering avoids test-only invalidation              |
| Linux format prerequisite             | Manual; native Linux x64/ARM64                        | x64 `c790a0156` 6m04s; ARM `6be877f3a` 3m21s; different hosts/settings                           | 20m job; gzip parity, no extra benchmark-only runs                               |
| Linux product formats                 | Manual; native Linux x64/ARM64                        | x64 `38133587458`: native 17m16s, build/fan-out 11m56s, runtime 4m52s; additive cache proof 31s  | 45m job / 30m build / 10m runtime; verified predecessor cache avoids ~5m rebuild |
| Windows package prerequisite          | Manual; native Windows ARM64 first                    | `38155408446` passed in 5m04s; fixture lifecycle and owned process checks                        | 50m cap; small fixture graph avoids repeating root installation                  |
| Windows packages                      | Manual; native Windows ARM64 / x64                    | ARM `38173280275` passed in 65m28s; installs 23m32s + 20m55s, builds 5m28s + 4m43s               | 150m cap; immutable predecessor caching targets repeated old install/build       |
| Release-please / replacement proposal | Owner dispatch; Ubuntu x64                            | `38325326647`: 1m31s, fresh dependency hash 39.83s; read-only engine probe 45s                   | 5m job; hash before App mint, no added repository cache                          |

All current workflow files and callable lanes are represented. GitHub also lists
deleted Nix/cache probes as active historical workflow records; they have no
current trigger definition and are not recurring optimization targets. Historical
packaging cache-hit state and CPU model are not established by job timestamps;
inspect logs when validating B2's cache/resource hypothesis. Preserve A's accepted
comparison anchor below. Record setup/build/test/package/transfer splits and
tool/cache/concurrency conditions from each required B run before claiming gains.

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

On Phase B entry the user confirmed an account **$0 Actions budget with Stop
usage enabled**. This is user-confirmed billing-control evidence, not an API
observation: the budget API lookup returned 404. API checks confirm a public
repository, Pro plan, 10 GB cache ceiling and 22 current artifacts totaling
1,551,694,906 bytes. The first browser trial may upload at most 25 MiB with one-day
retention; storage rejection fails its retained-evidence gate. No unrelated
artifacts are deleted to make room.

The cache setting is an enforced ceiling. GitHub documents that cache overage
is charged only when the configured limit exceeds the included 10 GB
([billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)).
Keep this limit unchanged. Initial native probes use standard public runners,
logs/job summaries only, and no cache/artifact writes. The confirmed stop-spending
control permits bounded B uploads; zero net historical billing alone would not
establish this control.

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

Current sequence: D1/D2 verification and stable 0.1.0 publication are complete.
The old Mac app is removed and the Android download is delivered; personal-device
installation, state preservation/recovery verification and final G6 acceptance remain.
Preserve routine latency; deeper gates
do not join ordinary PR blocking work. ARM cache transport, full cache-hit upgrade
timing and the two-minute routine stretch remain unclaimed.

### Phase C checklist

- [x] C1: 0.1.0 reset, semver-only upgrades, clean-break migration and recovery fixtures.
  - [x] C1a: portable V2 inventory and shared version rules (reviewer-accepted `f8b156ee7`; local).
  - [x] C1b: Android discovery, receipts and native fork encoding (reviewer-accepted `a299c61b6`; local).
  - [x] C1c: Nix transactional recovery and desktop updater contract (reviewer-accepted `46a931497`; local).
  - [x] C1d: workspace/native version reset and rebase-preservation integration (accepted/published `e674ae2f5`; PR/dev green).
- [x] C2: release-please bootstrap and scoped App authentication.

#### C2 release App setup and implementation boundary

Source is reviewer-accepted and integrated at `121258cb6` through PR #61.
Full routine PR `38192206691` passed in 4m15s and same-source dev `38192511163`
in 4m01s; runner totals were 21m58s / 19m25s, retaining the original comparison
baseline. Hosted helper contracts took 6.44s, including the signed mapping fixture
at 0.49s and preflight at 0.80s. The uncached engine install/output added 2.78s.
The full local rebase suite took 188s during high host load; hosted evidence
does not show that slowdown as recurring CI cost.

The owner provisioned App `5280233` and installation `170437913`; authenticated
read-only inspection verified its client identity, selected repository and exact
permissions, and resolved bot `paseo-release[bot]` / `341220930`. All four
repository variables are configured and the owner supplied the private-key secret.
Hosted dispatch `38194783635` verified the usable secret, identity, minted-token
scope and token cleanup, and created authentic bot PR #65. After the generated
changelog formatting repair at `07b997d79`, dispatch `38195842720` updated that PR;
routine `38195889307` and all deep lanes in `38195889191` passed at head
`080a9325a89a2ed9bac6931527b4121cf755a89c`. The read-only verifier checked exact
run attempts, setup receipts, head/base and the tested merge tree. C2 is
reviewer-accepted; C3 owns the remaining lifecycle closure.
The workflow uses release-please 17.6.0 through pinned action v5.0.0,
with GitHub release creation disabled. The independent manifest starts at 0.0.0
and explicitly proposes 0.1.0. Explicit JSON selectors synchronize all workspace
versions, internal dependency ranges, lock entries and the fork version authority.
The actual pinned engine fixture produces both 0.1.0 and 0.1.1 without changing
external resolutions or replaying upstream release history. Its small separate
dependency install is uncached; it does not consume the repository cache budget.

An explicit release boundary records the immutable original commit and its
current signed-replay counterpart. Rebase maps exact commit identities and signs
the updated pointer with upstream provenance. Bootstrap also retains its source
version and exact changelog SHA256, so a fresh clone remains verifiable after
the original rebased object is no longer reachable. Published boundaries still
require the original release tag and original/current content agreement.
Missing/nonancestor boundaries
stop proposal generation. A merged proposal pauses further proposals until
publication supplies the next boundary. Only the fixed rehearsal branch
`ci/release-please-rehearsal` permits a simulated publication boundary; this never
creates a public release or tag.

The dedicated GitHub App setup is complete; its required configuration is:

- Install only on the selected `iExalt/paseo` repository, with repository
  **Contents: read/write**, **Issues: read/write**, **Pull requests: read/write**,
  and mandatory **Metadata: read**. No organization or other repository permission
  is needed; webhooks are not required.
- Set repository variables `PASEO_RELEASE_APP_ID`,
  `PASEO_RELEASE_APP_CLIENT_ID`, `PASEO_RELEASE_BOT_ID` (numeric user ID), and
  `PASEO_RELEASE_BOT_LOGIN` (the App slug followed by `[bot]`).
- Store the generated PEM private key directly in repository Actions secret
  `PASEO_RELEASE_APP_PRIVATE_KEY`; never paste it into chat or committed files.

Trusted base code verifies App identity, installation owner and permissions,
bot numeric identity and minted token scope before the pinned action runs.
The token is restricted to this single repository and revoked by the token
action's normal cleanup. A separate read-only deep-check gate revalidates bot PR
identity and captures its current head SHA. A forged label does not authorize
deep execution or signing. Real event delivery and current-head checks passed;
two successive unpublished proposals and final campaign cleanup belong to C3.
Production proposals additionally require repository variable
`PASEO_RELEASE_PROPOSALS_ENABLED=true`; leave it unset during C2/C3. Provisioning
credentials does not enable production. The owner-dispatched fixed rehearsal
branch provides the first bot-event proof and subsequent proposal lifecycle.
Production activation is a separately reviewed handoff after that proof.

C3 preparation adds checkout receipts to existing routine/deep setup logs, with
no extra job, artifact or cache. The read-only verifier distinguishes routine's
actual PR merge tree from deep checks on the authorized head, requires successful
latest attempts and rechecks PR head/base after collecting evidence. Fixture
proofs cover stale/rerun/missing checks and wrong merge parents. Real PR #65 also
rejected its previously green head and runs after refresh; fresh routine
`38196353860` and deep `38196353853` then passed at head `f26d06fbf`.
The second engine proposal is also exercised without any GitHub release,
matching the explicitly unpublished rehearsal.
The repository allows only rebase merges. The rehearsal therefore requires one
bot commit, conditionally merges its verified head using that method, and checks
the returned/final/branch SHA, single parent equal to the verified base, and tree
equal to the routine-tested merge tree. Repository merge policy is unchanged.
The conditional PR #65 merge returned `d0cc78574e1b794827479bdaebaac6fd254369d6`,
matching the closed PR and rehearsal branch tip, with sole parent
`6c1437e3611cb244ca449de8d8177f77087f8816` and verified tree
`a4a7222f793ef70fa9376779c338499e51f8f3c4`. This was an isolated rehearsal merge;
no simulated boundary or successor version was merged into `dev`.

- [x] C3: real bot PR events, two proposals, current-head and forged-label proofs.

The successor dispatch `38196770999` created bot PR #67 for 0.1.1 at
`c2ea39c00cb29cfb8b8a18bf91db2e7fb682caf4`, based on an explicitly simulated
publication boundary on the fixed rehearsal branch. Its root and 12 workspace
versions, internal dependency ranges and lock entries passed the shared checker.
Routine `38196829378` and deep `38196829432` passed; the unchanged verifier bound
their latest successful attempts and all setup receipts to that exact head/base.
PR #67 was then closed unmerged, pending labels removed, and both campaign
rehearsal refs deleted atomically with exact SHA leases. The release inventory
was unchanged and `dev` retained 0.1.0 with its real bootstrap boundary.

| Successful bot head             | Routine wall / summed runner | Deep wall / summed runner |
| ------------------------------- | ---------------------------- | ------------------------- |
| `080a9325a` (first green 0.1.0) | 4m21s / 23m28s               | 4m58s / 11m00s            |
| `f26d06fbf` (refreshed 0.1.0)   | 4m37s / 24m47s               | 4m54s / 12m08s            |
| `c2ea39c00` (0.1.1 successor)   | 4m36s / 22m49s               | 5m09s / 13m45s            |

The original routine baseline remains 4m15s / 20m18s (PR), 4m18s / 20m37s
(dev), using standard Ubuntu runners, seven routine lanes and no npm cache.
Bot trials additionally ran three separate deep lanes concurrently. Routine gates
remain below five minutes; two minutes is still unmet. The new checkout receipts
add no jobs, caches or artifacts. At `07b997d79`, hosted helper contracts took
9.37s and uncached engine install/output 2.18s / 2.39s; the formatter correction
adds no recurring test. These hosted samples do not isolate runner variation from
source cost, and the higher summed runner times are retained for the all-CI
performance review rather than becoming new baselines.

Proposed Phase D preserves three boundaries: D1 authentic merged-PR recognition
and immutable exact-SHA candidate coordination; D2 failure/retry fixtures and a
complete unpublished same-SHA 14-cell package/runtime rehearsal; D3 separately
authorized publication of those exact verified bytes and personal-device manual
migration/recovery. D1/D2 approval would include reviewed commits/pushes and
bounded free-runner signing, draft transfers and native trials under the confirmed
$0 stop control. Publication and personal-device actions still require a concrete
candidate review and explicit later authorization. Existing native deadlines,
cache admission limits and strict cleanup remain in force.

The final tag audit found an inherited upstream `v0.1.1` tag pointing to
`5181d715bf96ad11f731988ceac222f50ba094f5`, a historical workspace-version commit,
with no matching GitHub release. The rehearsal did not create it. D1a selects
`paseo-v<stable-semver>` across release-please, signed V2 manifests, discovery and
preflight; read-only inspection found no existing `paseo-v*` tags. The portable
tag builder/parser excludes inherited `v*` and legacy sequence tags. Offline
pinned-engine composition proves both `paseo-v0.1.0` and `paseo-v0.1.1`, while
production release creation stays disabled. Historical tags, product semver,
receipt identities and upgrade ordering remain unchanged.

D1a is reviewed and integrated through PR #69 at `9d253019c`. Corrected routine
PR run `38265781837` passed in 4m46s (23m57s summed runner time), and same-SHA
dev run `38266478579` passed in 4m34s (24m48s summed). Both retain seven standard
Ubuntu lanes, pinned tools and no npm cache. The unchanged baseline remains
4m15s/20m18s PR and 4m18s/20m37s dev; current app verification took 164s/161s
and installs 54–85s across lanes. These hosted samples stay within the five-minute
gate but leave little margin; cumulative timing and the two-minute stretch remain
open, without raising the budget or weakening checks.

### Phase D checklist

- [x] D1: exact-candidate coordination.
  - [x] D1a: shared collision-free tag contract and consumer/engine verification.
  - [x] D1b: authenticated merged-PR descriptor and immutable draft transport.
  - [x] D1c: exact-source routine/deep/native fanout, complete aggregate and legacy retirement.
- [x] D2: failure/retry fixtures, bounded real partial-upload recovery, then complete same-SHA draft proof.

D1b uses the actual merged commit's sole parent and tested tree, not the current
dev tip, and requires the merged source remain an ancestor of dev. Draft transport
identity includes version and full source SHA, separately from the canonical
publication tag. Attempt metadata cannot substitute for candidate identity;
retries reuse authenticated descriptors, and published history is immutable.

C1a introduces an exact 14-cell signed inventory, preserves explicit V1 recovery
exports, and moves fork version rules into the portable protocol package. The
normal consumers now use V2 while explicit legacy recovery remains V1;
no installed state or signing identity has changed. Source TypeScript, emitted
JavaScript and Node 26 CommonJS loading are checked separately. Contract cases
remain cheap unit fixtures; live packaging and device migration remain Phase D.

C1b changes Android discovery and persisted high-water to fork semver, with
separate V2 receipt keys. Historical sequence keys, receipts and staged APKs remain
untouched. Download and installer entry points reverify signed receipts and
current installed state; native verification also binds APK versionName. Native
versionCode remains the deterministic encoding and OS installation floor.
The settings row explains manual migration for incompatible installed builds.
Protocol, Android receipt/UI and native configuration fixtures pass in 2.05s;
app typecheck and actual Expo fork configuration evaluation pass. Kotlin runtime
and installed 0.1.0 migration are not claimed; those remain Phase D package/device
gates. Workspace reset is owned by C1d.

C1c separates retained V1 recovery from new semver discovery and state. Both use
the existing outer operation lock and active Nix profile; V2 receipts/journals
live under `nix-update/semver-v1`. The explicit `migrate` command records the
verified legacy generation before switching, and rollback can select that exact
retained generation without lowering the fork high-water version. Unexpected
profile movement and unresolved legacy journals fail closed. No migration was
run. Historical validation remains in the renamed legacy module; normal commands
cannot discover V1 releases. The desktop bridge and all existing translated
version labels no longer expose numeric release sequences.

Cheap transaction fixtures cover interruption before profile selection, failed
state writes, failed journal cleanup, repeated migration, downgrade rejection,
legacy rollback, second-version activation and exact reactivation. New fixtures take about 312ms locally;
the retained V1 suite passes with its existing opt-in real Nix signature fixture
still skipped. App/desktop typechecks, UI fixtures, standalone packaged-source
imports and Nix expression parsing pass. Actual installed migration and rebuilt
0.1.0 package/runtime evidence remain Phase D gates.

C1d resets the root and all 12 workspace versions, internal dependencies and
matching lock entries to 0.1.0 without changing external dependency resolutions.
`.github/fork-release.json` owns the fork version and exact incorporated upstream
base; `CHANGELOG.fork.md` keeps independent history. The routine contract checks
every workspace and lock identity. Rebase requires this metadata, preserves fork
version/history through replay and adds a separately signed provenance commit
only when the captured upstream SHA changes; validation binds the final HEAD.
An upstream version conflict or missing authority stops before publication.
The upstream version/tag writer is disabled for this fork. Source review and
hosted combined verification passed at `e674ae2f5`. The first PR run
`38189751183` exposed a source-only fixture import and plugin compatibility
regression; both were fixed before the accepted rerun. Plugin API compatibility
now explicitly remains at upstream API 0.11.2 while the product version is 0.1.0;
neither release automation nor rebase advances that API promise implicitly.
The old feasibility probe triggered unexpectedly once (`38189730636`), was
cancelled with container absence confirmed, and all completed feasibility probes
are now manual-only. Subsequent ordinary pushes launched routine CI only.

### Phase B evidence history

The following records preserve increment-time findings and their resolutions;
the current snapshot and outcome gates above own present status.

B3 has one bounded prerequisite investigation alongside B2: a manual Linux x64
evaluation-only preflight, capped at ten minutes. It records exact-source Node,
daemon and desktop derivations, substitution/build plans and runner resources;
import-from-derivation builds are disabled. It does not realize products, upload
artifacts, sign or write Actions caches. Costly Node compilation waits for a
reviewed reuse/retention contract so successful bootstrap work is not discarded.
The preflight at `434bb96d4` passed in 31 seconds: the pinned Node wrapper and
runtime are substitutable, seven product derivations need builds, and 479
substitutions total 566 MiB compressed / 1.7 GiB unpacked on a runner with 86 GiB
free. No Node bootstrap or seed archive is needed for the next x64 trial.
Linux product and format proofs remain pending B2 and subsequent B3 increments.

The next Linux x64 trial builds those exact native outputs in one job, bounded
to 45 minutes (35 minutes for realization, five for runtime), with two Nix jobs
and a two-core hint per builder. Metro independently chooses workers (three on
a four-CPU host); this setting is not a hard total CPU cap. It records builder environment and sampled resource
pressure, launches the canonical Nix desktop wrapper under Xvfb and the separately
evaluated daemon CLI, and verifies renderer/preload, built-in plugins, CLI/PTY,
the shipped wrapper's disabled-sandbox policy and owned-process shutdown. The
Nix layout adapter validates its actual app metadata and desktop entry; regular
Electron packages retain their ASAR checks. No closure archive, signing, Actions
cache or public release is produced; diagnostics retain the 25 MiB/one-day bound.
Installation/upgrade and the other formats/architecture remain separate G3 proofs.

Shared desktop review found that the prior PTY marker could match command echo.
The repair constructs output from separate marker halves and accepts only an
exact output line. Mac re-verification in `38103496947` at harness `4789f1d8d`
passed against the same `e506c1272` candidate, including the stronger PTY assertion,
matching workspace `wks_0e0aadf92e4274aa`, Pure black theme and owned shutdown.
Author and reviewer inspected its state and UI evidence; Mac acceptance is restored.

Android native run `38102420953` passed connection and permission handling but
failed before upgrade: the terminal showed two empty prompts and no injected
command. The harness now requires stable native-input focus, visible keyboard
and completed terminal attachment before typing, then checks rendered command
echo before Enter. The separate output marker remains mandatory. This repair
needs another bounded Android-only trial; native upgrade proof remains open.
That repair passed the predecessor journey in `38103496947`, exposing a real
candidate startup crash after replacement: xterm's platform detection calls
`navigator.userAgent.includes` before the late root-layout polyfill executes.
An isolated VM reproduces the same failure with the locked headless library and
React Native's incomplete navigator. The existing polyfill now initializes as
the entry's first side-effect import; an actual-entry ordering fixture passes
and rejects omission of that installer. The repaired product needs a new paired
same-source build and native verification; the old Android candidate remains failed.

The rebuilt pair at `842a70f0c` passed producer `38104597837` in 23m38s, including
fresh signed Mac import. Native Mac run `38105941202` preserved workspace
`wks_7113eea1d39bd6ee` and Pure black theme and passed strict PTY/cleanup checks;
review accepted its raw and UI evidence. Android's first attempt stopped at an
npm connection reset before installation. Its one unchanged retry `38106245869`
passed the predecessor journey and reached the candidate's preserved workspace,
but stopped on a second notification prompt whose denial ID differs from the
first prompt. The harness now recognizes that exact denial ID only for the
already allowlisted Paseo notification message. Candidate terminal/theme closure
still requires a successful native run; no additional product rebuild is needed.

Linux trials `38103498455` and `38103959904` stopped before product realization
on diagnostic assumptions: missing ripgrep, then Nix's v4 JSON envelope. Portable
filtering and strict v4-envelope fixtures repair these prerequisites. No Linux
product build/runtime success was established by those diagnostic trials. The next
trial, `38104599559` at `842a70f0c`, built both exact Linux outputs in 8m15s but
failed the first daemon CLI startup: the static package trace omitted RE2's
computed `re2.wasm` companion. The tracer now resolves that exact asset from its
actual importer, and the existing isolated-closure fixture exercises the copied
matcher without a second trace/copy. Native runtime acceptance remains open.
The fixed `5619b7d7e` predecessor source shares the omission; any packaging-only
repair used for its future Linux upgrade proof must be explicit in provenance.
Routine dev CI at `842a70f0c` passed in 4m37s; the stable baseline and
under-five-minute budget remain unchanged.

The repaired Linux x64 trial `38105829857` at `a1326cf3a` passed in 12m39s,
including 9m49s realization and actual canonical wrappers, renderer/preload,
built-in plugins, CLI/PTY, owned shutdown and retained workspace screenshot.
Review accepted current unsigned same-job package runtime; profile installation,
manual replacement, ARM64 and DEB/RPM/AppImage remain open. The difference from
the prior build's 8m15s is not a controlled regression measurement. PR/dev routine
checks at the repaired source passed in 4m30s/4m28s without changing the budget.

The next Linux increment installs both old and current outputs through a
task-owned Nix profile, launches its validated executable links, removes the
exact old entries before installing new ones, and checks retained workspace/theme,
CLI/PTY and final uninstall/owned-state cleanup. This is explicit two-step manual
replacement, not an atomic updater. The old `5619b7d7e` source is rebuilt with a
packaging-only RE2 asset override; its exact expression/digest, outputs and asset
hash remain in bounded diagnostics. It is not represented as a published Linux
artifact. Both builds share Nix dependency substitutions and the existing
35-minute build / 45-minute job limits. A separate native ARM64 evaluation-only
preflight must establish its Node substitution path before ARM64 realization.

ARM64 preflight `38107364661` at `2c09f759a` passed on the native hosted runner:
Node runtime/wrapper are substitutable, seven derivations need builds and 481
substitutions total 554.9 MiB compressed / 1.8 GiB unpacked. No product was built;
ARM package runtime remains open. The subsequent x64 profile result is recorded below.
Android `38106951818` passed the notification repair but ended on the New workspace
screen instead of the expected workspace header. Its text-only tap cannot prove
which control received the input; a drawer-animation/header collision is only a
hypothesis. The harness now selects the exact seeded workspace's native row ID,
requires a unique clickable row with stable bounds, and retains pre-tap XML/PNG.
The next bounded trial must distinguish input targeting from product navigation;
no workspace-preservation or terminal acceptance is inferred from this failure.

Android closure `38107787799` at harness `c2a5012fb` passed in 5m37s against the
signed `842a70f0c` pair. Author and reviewer inspected actual sidebar, terminal and
theme evidence: old/new code 200008/211002 retained the same server-qualified
workspace `wks_01c809966ebf12bd`, saved connection and Pure black theme; split-command
terminal output and owned cleanup passed. The exact native row identity supersedes
the earlier title-only assertion and closes its targeting failure. Together with
accepted Mac `38105941202` and the retained full deep/negative/restored evidence,
B1/G2 and B2 are complete. This is hosted ARM64 software-renderer proof, not
physical-device, voice or first-0.1.0 migration proof; Linux/Windows G3 remains open.

The native Nix runtime lane now accepts explicit x64/ARM64 choices with matching
host/runtime guards and architecture-specific concurrency/evidence names. ARM64
dispatch follows x64 profile acceptance and uses the same actual
profile lifecycle and unchanged 45/35/5-minute bounds. Preflight is not product proof.

The x64 profile trial `38107363053` built both versions and verified exact old
profile removal/new installation, then failed candidate theme preservation:
the same workspace opened, but Appearance showed System instead of Pure black.
Different renderer client IDs also suggest lost renderer storage; shared forced
userData and origin match, so the cause is not yet proven. The harness previously
terminated the whole process group. Its next trial requests the existing normal
window-close/app-quit path and requires exit within ten seconds, retaining forced
termination only for failed-run cleanup. It records selected persisted theme,
origin and observable storage file paths before shutdown/after replacement.
No candidate setting is rewritten.

The normal-close x64 trial `38109113388` at `b74c9822e` passed in 21m46s;
author and reviewer accepted the raw identity, profile, UI and cleanup evidence.
Both versions exited normally with code zero. The replacement opened the same
workspace `wks_5376e70df391f7e2` and already-persisted Pure black theme, using
the same observed LevelDB paths and `paseo://app` origin. Actual profile executable
links, built-in plugins, CLI/PTY, exact old/new membership and final empty-profile
uninstall passed. This proves normal-shutdown manual replacement, not crash
durability or a definitive diagnosis of the previous forced-termination failure.
Native ARM64 trial `38110354030` at the same SHA passed in 16m55s;
author and reviewer accepted exact profile identity, preserved workspace
`wks_ec327f839363df4d` and Pure black entry state, normal exits, built-in plugins,
CLI/PTY and uninstall/owned-state cleanup. Native Nix daemon/desktop lifecycle
is now verified on both architectures. The architecture timing difference is
not a controlled optimization result.
DEB/RPM/AppImage and Windows lifecycle proofs remain open.

The performance audit found the plugin service suite taking 58.59s in required
PR run `38108861492`. Three service-policy cases now use a controlled runtime
with real manifest/configuration/filesystem behavior; subprocess registration,
compilation, reload and cleanup contracts remain in their existing tests.
The provider-icon integration case now stops its service even on assertion failure.
Required PR `38110696695` at `5d9db4ec3` passed in 3m38s with unchanged
shards/workers; all 29 plugin cases passed in 28.57s. The observed suite decrease
is not a controlled attribution of the whole timing difference, and this test-only
PR correctly omitted the unrelated app lane. Full seven-lane dev verification
`38110952794` passed in 4m36s after the reviewed fast-forward. The stable baseline
and <5m budget remain unchanged.
Latest pre-change PR/dev gates passed in 4m31s/4m27s,
with dev runner work of 20m37s. Cache usage remains 4,109,654,256 bytes across
the three original entries under the unchanged 10 GB ceiling.

Both Nix package filters now exclude the same standard test/spec filename suffixes
while preserving ordinary e2e helpers and nested runtime assets. The tracked-file
audit found 27 `.test.mjs`, 61 `.test.tsx` and 230 `.spec.ts` files beyond the old
`.test.ts` rule, with no build/runtime imports of those newly excluded files.
The actual daemon and desktop filter predicates pass a tiny offline Nix identity
fixture: changing test content leaves both filtered store identities unchanged;
changing an e2e runtime helper or nested speech asset changes both. This proves
avoided test-only invalidation, not a timing gain for required builds. The check
remains an explicit native Nix workflow gate; no package realization is required.

B3's installer prerequisite is accepted on native
[x64](https://github.com/iExalt/paseo/actions/runs/38115901669) in 4m21s and
[ARM64](https://github.com/iExalt/paseo/actions/runs/38116204675) in 5m00s at
`96708bccc`. A tiny Electron 44.6.0 payload, locked builder 26.15.3 and the actual
production launcher/templates passed DEB/RPM installation, real FUSE AppImage
launch, renderer checks, normal exit and uninstall. All owned PID/mount sets
were empty; native package identities and hashes were retained. These are
environment prerequisites, not actual Paseo package or upgrade acceptance.

AppImage proof binds the live mounted executable and full generated AppRun hash;
its failed namespace probe selects the shipped fallback without harness-injected
flags. DEB renderers showed namespace mappings and NoNewPrivs=1/Seccomp=2.
Preload isolation is recorded separately from Chromium's OS sandbox switch, and
observer/inner PIDs are bound through NSpid. Navigation must finish before normal
close. Earlier trials exposed and repaired those fixture assumptions; cheap
mapping cases and an actual-source deferred-navigation probe cover the repairs.

Fedora 44 uses a pinned native image, 2 CPUs, 4 GiB, 512 PIDs and enforced
no-new-privileges. The default-container SUID route failed namespace creation in
`38115197241`; the accepted hardened configuration exercises the shipped fallback
without relaxing security. This proves Fedora userland on Ubuntu's kernel, not
default Docker SUID support or native Fedora host behavior. Container exit was
zero without OOM; diagnostics precede removal even on failure. Both trials stayed
within the 20-minute/five-minute-container bounds, used no caches and retained
at most 25 MiB of one-day diagnostics. Actual product format journeys are next.
The Nix filter increment `490c6eac0` passed seven-lane PR CI in 4m30s; the preceding
`5139c9514` full dev run passed in 4m34s. The stable latency baseline is unchanged.

Actual product format verification is reviewed and published at `56babf666`;
installed runtime proof remains pending. Each native runner builds predecessor
`5619b7d7e` and the exact candidate
once, then packages the same unpacked payload into DEB, RPM and AppImage. Separate
nonroot UI stages preserve owned workspace, theme, daemon home and profile across
the root-managed upgrade. Manifests bind source, lock, native payload and package
hashes; AppImage must retain the installed CLI symlink while replacing the stable
filename. A detached-child failure probe precedes expensive builds, and cleanup
requires verified process identities and empty mount sets before removing state.
The trial is x64 first, then ARM64 after x64 acceptance, bounded to 45
minutes per job with no cache and 25 MiB of one-day diagnostics. Fast fixture and
workflow checks pass locally; these do not establish installed product behavior.
The first [product trial](https://github.com/iExalt/paseo/actions/runs/38118342782)
stopped during package fanout: builder resolves relative hooks from its working
directory, so fanout must use `packages/desktop`, as the normal build does.
The detached-child negative probe and final cleanup passed; no product was
installed. A locked-builder probe verifies both hooks after the cwd repair.
PR #29 and full dev CI passed in 4m18s and 4m22s at `56babf666`.
The [retry at `ec2f19de2`](https://github.com/iExalt/paseo/actions/runs/38119044745)
built all six artifacts, then stopped in the first AppImage stage on an unreadable
process identity. Source review found that a process disappearing or reusing its
PID during the privileged scan remained falsely unclassified; the repair drops
stale identities and requires another capture for newly discovered IDs. The exact
race timing is not in the receipt. Verified cleanup left no owned processes or
mounts. PR/dev CI passed in 4m31s/4m30s.

This trial also measured 328s/298s of candidate/predecessor packaging, mostly
DEB/RPM xz compression; AppImage took about 19s per version. The next trial used
gzip for production DEB/RPM and an explicit identical compression override when
rebuilding the fixed predecessor. Its product source and payload checks remain
unchanged. At `b801126f2`, [the trial](https://github.com/iExalt/paseo/actions/runs/38120787401)
measured 121s/112s packaging, reducing combined packaging from 626s to 233s
under hosted-runner variation. Candidate DEB/RPM sizes are 172,456,942/172,431,299
bytes, close to the unchanged AppImage's 171,481,940 bytes; historical xz sizes
were not retained, so no size-change percentage is claimed. No duplicate xz
build is required. PR/dev CI passed in 4m23s/4m23s with the stable baseline unchanged.

The product trial failed after 12m57s because its long temporary path exceeded
Chromium's Unix singleton-socket limit, before the first AppImage renderer opened.
Its process/mount and final state cleanup passed. The reviewed repair uses a
short, exclusively created `/tmp` root with recorded path, UID and filesystem
identity; receipts remain in the evidence directory. Cleanup requires exact stage
paths and complete monitor receipts before deleting temporary state. The real
singleton lock, sandbox policy and normal-close proof are unchanged; installed
product upgrade acceptance and the ARM64 trial remain pending.

The short-path repair `d5ca50186` passed PR/dev CI in 4m33s/4m27s.
Its [product trial](https://github.com/iExalt/paseo/actions/runs/38122231438)
opened the real predecessor AppImage renderer and daemon, then exposed the
installed CLI link entering Chromium without a display. Cleanup again proved
empty owned processes/mounts and removed the short temporary root. The predecessor
will seed/stop through its verified live payload's bundled CLI, preserving the
installed symlink unchanged. Candidate acceptance still requires that retained
link's cold daemon, status and PTY journeys.

An early launcher repair routes the AppImage's `paseo` invocation to the bundled
Node shim before Chromium startup. AppImage's documented `ARGV0` identifies the
invoked symlink ([runtime environment](https://github.com/AppImage/docs.appimage.org/blob/master/source/packaging-guide/environment-variables.rst));
canonical mount context is also required. Only the reserved leading
`--no-sandbox` launcher flag is consumed. Before another full product build, the
tiny actual-runtime prerequisite must prove headless argument preservation and
delayed mounted-file access by a detached worker after the CLI parent exits.
That lifetime proof remains pending; immediate CLI success alone is insufficient.
The [tiny x64 trial at `76d9360fb`](https://github.com/iExalt/paseo/actions/runs/38123731406)
passed the first headless/argument assertions but failed after 4m08s because the
detached worker produced no delayed receipt. Its stderr was empty and owned
cleanup passed; this does not yet identify the worker's exit cause. The same
discriminator now waits for a worker-ready receipt before the CLI exits and
records subsequent mount state and worker exit/error diagnostics. Full product
and ARM64 trials remain stopped. PR/dev CI passed in 4m27s/4m21s.

The [ready-worker diagnostic at `326a482bd`](https://github.com/iExalt/paseo/actions/runs/38124448935)
confirmed that the original FUSE mount disappears after the CLI exits even when
a worker was already running. This proves mount teardown, not the worker's exact
exit mechanism. The next repair gives the supervisor its own AppImage invocation,
selects only its fixed bundled entry, and retains the verified installed CLI link
for later subprocesses. Ordinary package launch paths remain unchanged. Cheap
selector/shell checks and CLI typechecking pass; native lifetime acceptance is
still pending. The tiny fixture now uses the production selector, shell shim and
Node runner in an actual ASAR; it must prove the original mount disappears while
the supervisor's fresh mount survives, read a mounted file, invoke the stable CLI
link with inherited Node environment, and stop with empty owned process/mount
sets before another full product build is allowed.
The supervisor must retain the spawned PID to satisfy daemon readiness semantics;
its stop receipt is an acknowledgment, with termination independently observed
by PID/start identity and mount disappearance. Direct calls to the exact bundled
shim from a running GUI keep their existing GUI-owned mount lifetime; this repair
does not claim to make that separate launch mode independent of the GUI.

The [x64 lifetime prerequisite](https://github.com/iExalt/paseo/actions/runs/38126007548)
passed at `c790a0156` in 6m04s. Both argument modes preserved the spawned supervisor
PID, lost the original mount while retaining a distinct live supervisor mount,
read its payload after the CLI exited, invoked the stable CLI link, and stopped
with independently observed PID/start and mount disappearance. All four CLI/GUI
format monitors finished normally with complete discovery and empty owned sets;
the Fedora container exited zero without OOM. PR/dev CI passed in 4m40s/4m23s.
The reviewer accepted this prerequisite for one unchanged-source x64 product
trial; full product and ARM acceptance remain open.

The tiny fixture's DEB packaging interval was about 85 seconds in that run;
its two CLI lifetime cases took about six seconds. Its remaining default xz
settings now match production's DEB `gz` and RPM `gzip`, preserving all installed
runtime checks. The next required ARM prerequisite will validate that parity
change; differing hosted runs will not establish a controlled speedup. Repository
cache usage remains three entries totaling 4,109,654,256 bytes; these trials add
no caches.

The [real x64 product trial at `c790a0156`](https://github.com/iExalt/paseo/actions/runs/38126449316)
verified AppImage and DEB predecessor-to-candidate upgrades: retained workspace and
Pureblack preference, real renderer/plugins, cold CLI daemon startup, status and
PTY, normal shutdown and uninstall. The installed AppImage link's identity stayed
unchanged. All four native monitors completed with empty owned sets and final
cleanup removed state and the short temporary root. RPM stopped before install
because the pinned host Node could not load Fedora's missing `libatomic.so.1`;
the full matrix is not accepted. The 15m27s trial spent 12m25s before runtime.
The reviewed repair shares Fedora runtime dependency setup between the tiny and
product fixtures, installing `libatomic` before invoking the exact pinned Node.
The next ARM prerequisite mounts that same Node instead of installing a different
distribution Node, so its required run also checks this boundary and the gzip
fixture change before another full product build. The compression change at
`72c630741` passed PR/dev CI in 4m34s/4m19s.

The [ARM prerequisite at `6be877f3a`](https://github.com/iExalt/paseo/actions/runs/38128059566)
passed in 3m21s: both fresh-supervisor lifetime modes, actual gzip DEB/RPM
install/uninstall, and `/node-bin/node` version 26.11.0/architecture arm64 inside
the pinned Fedora container. All four monitors completed normally with empty
owned sets; the container exited zero without OOM. The reviewer accepted the
ARM lifetime, compression and copied-Node prerequisites. This is not full product
ARM proof or a controlled comparison with the earlier x64 timing. That source's
PR/dev CI passed in 4m37s/3m48s; the repaired x64 product retry remains open.

The [x64 product retry](https://github.com/iExalt/paseo/actions/runs/38128358878)
at `6be877f3a` ran for 16m17s, including 11m56s building both payloads and
their three formats. AppImage and DEB again preserved each workspace and Pure
black preference, closed normally and emptied their owned process sets. Fedora
now ran the pinned Node binary and seeded the old RPM successfully, but the RPM
upgrade removed `/usr/bin/Paseo` before the candidate could launch. The locked
builder's default removal script unconditionally deletes this link; the old
package's removal runs after the new package's install hook. Both RPM sessions
had complete process cleanup, and the owned container/state were removed. A
candidate transaction-end repair and a small two-version installer proof are
required before another full product trial; the predecessor must retain its
original removal behavior so the regression is not hidden. Full x64/ARM product
acceptance remains open.

Repair `a1fcb175b` installs the shared rendered package hook in the candidate
payload, hashes it in the manifest and invokes it from RPM `%posttrans`, after
the historical remover. New RPM removers skip upgrades and retain final erase
behavior. The [x64 installer trial](https://github.com/iExalt/paseo/actions/runs/38130136220)
passed in 3m39s: scriptlet inspection confirmed the legacy unguarded remover,
then an actual 0.9.0→1.0.0 fixture upgrade preserved the launcher and opened the
renderer. Final uninstall rejected dangling links as well as existing targets.
All four process monitors completed normally with empty owned sets, and Fedora
exited zero without OOM. The reviewer accepted this prerequisite; PR/dev routine
CI passed in 4m32s/4m21s. Full product x64 and ARM acceptance remains pending.

The [full x64 trial](https://github.com/iExalt/paseo/actions/runs/38130433226)
at that repair passed all three package upgrade journeys, including RPM's same
workspace/Pure black preference, candidate CLI/PTY checks and normal shutdown.
The reviewer accepted the RPM runtime contributor; its two monitors completed
with no owned processes or mounts. The run nevertheless failed after RPM removal
reported the package absent: one of the install-root/link absence assertions
failed, and the retained log does not identify which residual path remained.
Host cleanup completed. A strict tiny-fixture uninstall check with bounded
residual and package-ownership diagnostics precedes another full product build;
neither x64 lifecycle nor the Linux matrix is accepted yet.

The [small uninstall diagnostic](https://github.com/iExalt/paseo/actions/runs/38132064261)
at `ffba93b62` reproduced the failure with seven empty directories and an absent
binary link. The package ownership listing contained files and links but no
directories. The repair explicitly registers the candidate's `/opt/Paseo` tree
with FPM, preserving the old package and the strict absence checks; it does not
delete residual files to make the check pass. The
[small x64 trial at `9628b72a3`](https://github.com/iExalt/paseo/actions/runs/38132735694)
passed in 4m18s: RPM owns the install directories, and both the complete install
root and launcher are absent after uninstall. The RPM monitor completed normally
with no remaining owned processes or mounts; Fedora exited zero without OOM.
This closes the small-fixture check; full product lifecycle verification remains
pending. Routine PR CI passed in 4m40s, within the unchanged budget.

The predecessor-cache implementation passed its bounded hosted trial.
The previous full x64 run spent 188s building the fixed predecessor and 111.27s
packaging its three archives, totaling 516,275,604 bytes. Reusing these verified
archives can avoid that work without caching the changing candidate. Exact keys
bind the historical source/lock, native architecture, hosted image, tool versions
and producer scripts; restored archives and identity receipts are checked before
use. Each entry is capped at 650 MiB including receipts. New saves require current
repository usage plus that reservation to fit within 8 GB, leaving headroom under
the 10 GB ceiling; concurrent writers can race, so this is an advisory save guard.
No unrelated cache is evicted. The required x64 product run included one
additional fresh-runner transfer proof with a five-minute cap, requiring the
producer's exact key, an actual hit and the real validation/copy entry point. Save/restore costs
are reported separately from avoided build time below.
Hashing the entire producer workflow/scripts and hosted image version favors
safe invalidation over maximum reuse: orchestration edits and image rollouts can
cause misses. A successful save-action outcome alone does not prove persistence;
only the fresh restore establishes that. The fixed predecessor's size cap fails
closed if exceeded rather than silently bypassing the cache contract.

The [full x64 lifecycle and transfer trial](https://github.com/iExalt/paseo/actions/runs/38133587458)
at `db2316365` passed: all three formats preserved their workspace identity and
Pure black preference, candidate plugin/CLI/PTY checks passed, and all six app
sessions closed normally with empty owned process/mount sets. RPM's complete
install root and launcher were absent after removal; host state cleanup completed.
Author inspection of retained workspace/theme screenshots confirmed the UI
evidence. Native work took 17m16s, including 11m56s build/fan-out and 4m52s runtime.
The additional fresh-runner cache proof took 31s. Saving took 4s, restoring 3s,
and archive validation/copy 3.172s; the same run spent 188s plus 111.542s producing
the predecessor. This establishes useful transfer reuse, not an observed complete
warm product-run duration. The entry including receipts is 516,279,012 bytes;
repository usage is four entries totaling 4,624,462,030 bytes. Routine PR/dev
verification passed in 4m50s/4m36s (PR summed job time 21m08s). The app suite is
unchanged and took 149.31s versus the prior 142.68s observation; there is no
confirmed source regression or baseline reset. The reviewer accepted the x64
lifecycle and cache-transfer evidence. The same revision's
[full ARM trial](https://github.com/iExalt/paseo/actions/runs/38134751874) passed
in 14m47s, including 10m01s build/fan-out and 4m27s runtime. All three formats
preserved their workspace/theme, passed candidate CLI/PTY checks, closed normally
and completed installation/state cleanup. Six session monitors reported normal
exit and empty owned process/mount sets. The ARM cache entry is 525,596,032 bytes;
repository usage is five entries totaling 5,148,560,329 bytes. ARM cache creation
is proven; a fresh ARM restore is not separately claimed.

The reviewer accepted B3 across these format proofs and the earlier `b74c9822e`
Nix x64/ARM profile-upgrade proofs. Linux Nix packaging bypasses the later
electron-builder RPM hook, so that hook does not invalidate its contributor
evidence. This is closure across named contributors, not a claim that every
package was rebuilt and tested at one universal current SHA.

Approved execution checklist:

- [x] B1: bounded deterministic browser journey and broken-fixture proof, then
      Electron, relay, CLI and installed-provider contracts; Android closure
      depends on B2's same-SHA rebuilt APK.
- [x] B2: preserve Mac/Android candidate identities and signatures; prove fresh
      import/install and meaningful disposable-state upgrades.
- [x] B3: verify Linux x64/ARM64 Nix, DEB, RPM and AppImage journeys.
- [x] B4: verify Windows x64/ARM64 NSIS, speech and PTY lifecycle, then G2/G3 integration.
- [ ] Stretch: inventory every workflow/lane's timing and optimize avoidable work
      using existing receipts and required runs; preserve the routine baseline,
      account for parallel runner work, and retain unmeasured future gates.

B4's first increment is implemented locally and awaiting review/native proof: one native
Windows ARM64 prerequisite job, capped at 50 minutes, measures the complete locked
install with normal required lifecycle scripts (30-minute cap), then reuses that
install for ownership proofs (3 minutes), tiny NSIS packaging (5 minutes), and
installation/renderer/uninstall checks (5 minutes), with bounded cleanup. The
monitor creates its primary process suspended and assigns it to an anonymous,
non-breakaway Job Object before execution. Only the monitor owns the
noninheritable kill-on-close Job handle. Normal completion requires a zero exit
and zero active processes; failure cleanup and forced monitor death must also
empty the owned process set. The independent death verifier holds process
handles, never another Job handle. Silent current-user NSIS installation uses an
owned path containing spaces, verifies registry scope and absence of auto-launch,
then starts the installed EXE directly inside the Job. Node-only ownership tests
run before the install, so a broken monitor cannot launch a long install. Native
Electron nested-job compatibility is a required result. Full product, speech and
manual-upgrade proofs follow this prerequisite.

The first [ARM prerequisite](https://github.com/iExalt/paseo/actions/runs/38137270161)
at `47104afd7` proved normal descendant exit, detached-child failure cleanup and
forced monitor-death cleanup. Both monitored jobs reached zero active processes;
the death verifier observed both held process handles exit. Cleanup reconciled all
three stages. The workflow nevertheless stopped before installation because the
PowerShell runner propagated the intentional negative monitor's stale exit code.
The controller now explicitly returns success only after its phase assertions
finish. Locked-install timing and native NSIS/Electron behavior remain pending the
repaired trial. PR routine CI passed in 4m18s, preserving the existing baseline.

The exit-status repair is published at `4cf15d5ea`; PR/dev routine runs passed in
4m41s/4m37s. Its [bounded ARM retry](https://github.com/iExalt/paseo/actions/runs/38137789343)
completed npm successfully in 23m29s, but the monitor rejected a remaining child
after the unchanged ten-second exit grace. Job termination reached zero active
processes and final cleanup reconciled every stage; NSIS packaging never started.
Unpacking accounted for 21m14s, lifecycle builds for 2m08s; overlapping npm timers
do not distinguish network waits from filesystem costs. Peak Job memory was
1.68 GB and aggregate CPU time 6m12s. The next prerequisite retry retains bounded
Job-member identities before termination, complete bounded npm timing JSON and
fetch records; install semantics and cleanup acceptance remain unchanged.
The diagnostic amendment is published at `5239e2697` (PR #44); routine PR
verification passed in 3m50s. Dev attempt 1 of `38140033750` exceeded its deadline
after one checkout spent 136 seconds failing to connect to GitHub, then backed
off 18 seconds before succeeding. Its npm install took 72 seconds; the other six
lanes passed. This is an infrastructure-affected failure, not an accepted latency
sample. The unchanged full retry passed in 4m24s, preserving the
planner-to-aggregate measurement and existing baseline. ARM full-prerequisite retry
`38140033767` reached the 1,780-second install bound while compilation was still
active. Its verified Job members included CL/MSBuild and VCTIP; this does not
identify the earlier post-exit survivor. All processes were terminated and final
cleanup passed. npm did not flush its own timing files before termination, so the
harness now retains emitted HTTP/timing records from its owned stdout file too.
The next diagnostic is capped at ten minutes: one integrity-verified locked
tarball, local-file npm/native-tar extraction with matching content inventories,
and a tiny native compiler invocation. This temporary probe will be removed after
the diagnosis is resolved. It changes no install, cache, Defender or
cleanup policy and cannot satisfy the still-pending full installer prerequisite.
The small diagnostic `38142871112` at `eae043774` completed successfully: CL
created its object and exited zero, but the only remaining verified child after
ten seconds was VCTIP telemetry. The locked 2.29 MB tarball downloaded in 152 ms;
npm extraction took 50.76s versus native tar's 6.95s for identical 9,664-file,
29.75 MB inventories. Ordering/warming were uncontrolled; Defender queries timed
out, so no Defender attribution is established. All Job and final cleanup receipts
completed in the 2m25s job. PR/dev CI passed in 4m25s/4m31s. The next bounded diagnostic tests documented
VSCEIP opt-out with exact policy-value restoration and a strict normal compiler
exit, plus fresh-process extraction with filesystem worker counts 4/16/16/4.
The follow-up [diagnostic at `062701923`](https://github.com/iExalt/paseo/actions/runs/38144005005)
rejected the compiler stage: CL exited zero after 2.44s, but the exact verified
VCTIP child again survived the grace period. Policy restoration and final Job
cleanup passed. Extraction at 4/16/16/4 workers took 43.550/42.983/41.912/42.048s
with identical inventories; the 0.8% mean difference is smaller than within-setting
variation. Neither registry policy nor increased worker concurrency is adopted.
PR/dev CI passed in 4m27s/4m30s, without resetting the accepted baseline.
The user approved narrowly verified build-tool telemetry cleanup, distinct from
installed-product lifecycle acceptance. The implementation preserves truthful
termination receipts and accepts only exact compiler-adjacent VCTIP survivors
after successful primary exit and the normal grace. Held process identities and
unchanged Job creation counts through cleanup reject snapshot races; unknown
survivors, build failures and timeouts still fail. Local classifier checks pass;
native verification and full installer verification remain open.
Telemetry source was published in PR #47 (`aef8fff22`/`a344c482e`); its PR gate
passed in 4m00s. Concurrent `dev` commit `635a4e413` changed the CLI transport,
so the nonforce fast-forward was rejected. An accidental dispatch following that
rejection, `38149454202`, was cancelled during checkout before fixture setup or
the probe; it supplies no native proof. The merge `e8464a0af` preserves that work.
Its routine run `38149548928` exposed stale migration fixtures in nine files:
removed constructor arguments, new broker envelope fields, CLI launch context,
normalized configuration and automatic MCP removal. Test-only repairs preserve
the underlying assertions; fresh merged-source CI remains required before any
native dispatch. Future product proofs must bind the merged candidate source.
The fixture repairs passed final-source PR CI in 4m04s at `090a4a4dc`.
Further concurrent documentation changes were merged without changing prerequisite
code; PR CI at `96da1572f` passed in 4m36s before its verified fast-forward.
The [native telemetry proof](https://github.com/iExalt/paseo/actions/runs/38151438940)
then passed in 1m23s: compiler exit zero after 2.873s, one exact verified VCTIP
survivor, stable total-process count of two before/after termination, and zero
final active processes. Its receipt truthfully records termination and separate
build-telemetry success. Ownership negative/monitor-death checks and final cleanup
also passed. This proves the narrow cleanup rule, not the full installer gate.
Same-source dev CI passed in 4m32s. The [full ARM prerequisite](https://github.com/iExalt/paseo/actions/runs/38151801119)
completed the normal workspace install in 20m44s, with one verified VCTIP survivor
and stable 97-process accounting through successful cleanup. Two tiny NSIS packages
built in 1m51s. The first installation registered the exact current-user path and
version, but renderer launch returned `ENOENT` for the expected executable.
Recovery uninstall and all Job cleanup passed; renderer, replacement and normal
uninstall acceptance remain unproven. The next bounded rehearsal installs only
Electron44.6.0, electron-builder26.15.3 and Playwright1.63.0 from a separate locked
286-package fixture toolchain. It captures unpacked/installed inventories and
payload hashes before launch and recovery. Its distinct transitive dependency
graph does not replace the full-lock installation evidence or later product builds.
The rehearsal has a 25-minute job cap, eight-minute tooling install and unchanged
five-minute packaging/runtime limits; it creates no Actions cache or package upload.
The [isolated rehearsal](https://github.com/iExalt/paseo/actions/runs/38154576152)
at `79a3df1c6` confirmed that the main executable and seven top-level DLLs were
absent after installation, although present in the unpacked payload; recovery
cleanup passed. PR CI passed in 4m22s. This matches the locked builder's
[documented ARM64 extraction defect](https://github.com/electron-userland/electron-builder/issues/9983).
The next repair sets its supported `BCJ` filter only in the Windows builder child
environment and records it in installer provenance. Payload equality and the full
renderer, replacement and uninstall journey remain required; the repair awaits
native verification. The [repair trial](https://github.com/iExalt/paseo/actions/runs/38155408446)
at `9d8169e4a` passed in 5m04s: both versions' installed payloads matched their
unpacked hashes, native renderers launched and closed normally, replacement
succeeded, and uninstall removed the directory and registration. All thirteen
owned stages reconciled with zero survivors. Reviewer acceptance combines this
small fixture proof with `96da1572f`'s full normal workspace install; it opens
product implementation without claiming product or x64 lifecycle verification.
The failure-only native launch diagnostic is removed; regression inventories remain.
Independent Windows producer source is implemented and source-reviewed;
full native product verification remains open: old and candidate locked installs share only a
run-local npm download cache, each payload builds once, and Windows outputs are
NSIS-only. ARM reuses one hash-pinned binding assembly after verifying both locked
wrappers; the old package is explicitly a reconstruction. The assembly uses
Electron's import library and delay-load hook, preserves the wrapper's existing
local-addon fallback, and places pinned DLLs beside the installed executable.
Cheap PE/provenance/ASAR fixtures reject wrong architecture, incorrect Node linkage,
missing or changed assembly provenance, shadowed loaders and absent physical
unpacking. The controller enforces aggregate deadlines and reconciles every stage
receipt. Its optional start receipt binds Windows ownership mode to the actual
assigned primary process before resume; final zero-active Job evidence remains
mandatory. Handshake, installed loader selection, real speech,
state-preserving replacement and full cleanup remain required B4 gates.
The combined Windows workflow and runtime adapter passed integrated source review
and were published at `e731f231c` (PR #50). One ARM canary precedes x64. Its 150-minute absolute
job limit includes two separate 30-minute normal installs and builds, a 15-minute
binding budget, ten-minute pinned model preparation and a seventeen-minute
installed-runtime ceiling; these maxima are not guaranteed to fit together.
Controllers refuse new operations without their full timeout and cleanup reserve
remaining before the internal deadline. The runtime uses strict owned Jobs,
the installed Electron speech worker and actual loaded-addon/DLL provenance,
and preserves the predecessor-created CLI trampoline, workspace and theme.
No product package or cache is uploaded; diagnostics remain capped at 25 MiB for
one day. Native installed product correctness remains unverified.
The [first full ARM canary](https://github.com/iExalt/paseo/actions/runs/38157019140)
completed normal candidate installation in 25m34s and compiled the pinned Electron
binding in 32.8s. Its sole verified compiler telemetry survivor was cleaned under
the approved build-only rule; all owned stages ultimately had zero active processes.
Candidate NSIS creation completed, but the 5m26s build stage failed in verification:
the locked ASAR reader requires native Windows separators for nested lookups.
An isolated probe of the locked reader reproduced the exact error with forward
slashes and succeeded with native paths; package omission is not established.
The repair uses native paths at both lookup sites, runs the existing real-ASAR
fixture on Windows before compilation, and retains bounded relevant archive paths
before verification. Old installation, UI, upgrade and speech were skipped; cleanup
passed. Routine PR/dev CI passed in 4m37s/4m35s excluding initial queues, with
22m13s total runner work for the PR. The next ARM canary retains every product gate.
The [archive-path retry](https://github.com/iExalt/paseo/actions/runs/38160340090)
at `88882cdf5` ran for 57m51s and passed both native package inventories, installed
UI/CLI/PTY journeys, retained workspace/theme/trampoline and normal application
close. Author and reviewer inspected the candidate screenshots. Normal candidate
and predecessor installs took 20m54s/18m47s; package builds took 4m58s/4m06s.
The predecessor installer is 147,217,267 bytes; model preparation took 76s.
Speech failed after 829ms because the Node26 parent could not deserialize the
installed Electron worker's advanced IPC. A disposable local probe reproduced
that exact error and passed an ArrayBuffer round trip with both sides using the
locked Electron 44.6.0 (Node24.21.0); importing the existing TypeScript WAV and
transcript helpers also passed under that runtime. The repair makes installed
Electron the speech Job's primary process, preserving exact PID/executable/argv
authorization, advanced IPC, real worker loading and the 280-second ceiling.
Parent/worker runtime identities are retained and compared. Recovery uninstall,
registry/directory/state removal and all fifteen Job receipts reconciled with
zero active processes. Speech and x64 remain required; no cache is introduced.
Routine PR/dev verification passed in 4m40s/3m42s excluding initial queues;
dev used 19m44s total runner time. These measurements preserve the stable baseline.
The [matching-runtime trial](https://github.com/iExalt/paseo/actions/runs/38164959163)
at `59e9bb2df` passed IPC and repeated both installed journeys and cleanup, but
speech failed loading the ARM addon after 528ms. The unchanged upstream wrapper
suppresses individual native require errors, so its generic failure cannot yet
identify a missing DLL, export, initialization problem or archive-resolution issue.
No linker or search-path repair is inferred. The 66m05s run motivates a temporary
binding-only prerequisite before another full trial: normal locked fixture tools,
root-lock integrity-verified wrapper/hook inputs, the same pinned compilation,
and a copied native Electron distribution renamed to `Paseo.exe`. Pinned DLLs
remain beside that executable; collisions fail. A tiny ASAR uses the unchanged
wrapper and explicitly unpacked addon; its fixture writer is 3.4.1, while the
actual Electron 44.6.0 reader performs loading. A fresh wrapper process runs first;
on failure a separate physical-addon process records the underlying error without
turning the original failure into success. Strict runtime Jobs and loaded-module
hashes remain required. This diagnostic is capped at 35 minutes, with 900 seconds
for assembly and 90 seconds for runtime, bounded evidence and always-run cleanup.
It will be removed after diagnosis; installed STT/TTS and x64 remain mandatory.
Local extraction verified both root-lock SRI values and pinned wrapper/hook hashes.
Routine PR/dev checks at `59e9bb2df` passed in 4m33s/4m37s excluding initial queues,
using 21m54s/23m51s of runner work. No cache or install acceptance rule changed.
The [isolated binding probe](https://github.com/iExalt/paseo/actions/runs/38170355615)
at `038ecda08` reached native loading in a 3m51s job and exposed
`ERR_DLOPEN_FAILED: The specified module could not be found` from the physical
addon as well as the wrapper failure. All six owned stages reconciled with zero
active processes. [libuv 1.52.1's loader](https://raw.githubusercontent.com/libuv/libuv/v1.52.1/src/win/dl.c)
uses `LOAD_WITH_ALTERED_SEARCH_PATH`; [Windows documents](https://learn.microsoft.com/en-us/windows/win32/dlls/dynamic-link-library-search-order)
that this substitutes the loaded module's directory for the executable directory.
The next placement-only probe puts the exact DLLs beside the unpacked addon,
asserts executable-root copies are absent, and requires loaded paths and hashes
there. PATH, linker flags and loader bytes remain unchanged. This tests a concrete
dependency-search hypothesis; it does not yet establish which module was missing
or rule out an additional CRT dependency. Product assembly stays unchanged until
that result is reviewed. Routine PR/dev checks passed in 4m24s/4m41s, with
21m19s/22m49s total runner work and unchanged latency budget.
The [placement-only probe](https://github.com/iExalt/paseo/actions/runs/38171244555)
at `5d7b6a81b` loaded the unchanged wrapper successfully with ONNX Runtime 1.28.2;
the addon, C API and ONNX Runtime were all loaded beside the unpacked addon.
The 3m13s job then failed a path comparison because Windows reported the `\\?\`
namespace prefix on the loaded module, while the expected path lacked it. It
stopped before completing hash verification, so probe acceptance remains open.
The narrow repair canonicalizes both filesystem-resolved paths to namespaced,
case-insensitive keys; drive/UNC and distinct-location fixtures guard the comparison.
One cheap probe retry must complete hashes and strict success before production
relocation. Routine PR/dev checks passed in 4m40s/4m17s, using 24m09s/22m06s
of runner work; the stable baseline and under-five-minute budget are unchanged.

The [completed binding prerequisite](https://github.com/iExalt/paseo/actions/runs/38172099352)
at `2b40c197d` passed in 3m22s: unchanged wrapper, Electron 44.6.0 ARM64,
ONNX Runtime 1.28.2, exact addon-adjacent loaded paths and all required hashes.
The runtime exited normally in 2.33s; all six owned stages had zero active
processes. Author and reviewer accepted this prerequisite. Production assembly
now places every pinned DLL beside the physically unpacked addon and rejects
executable-root duplicates; installed inspection and speech checks require that
location. A 30-second load check using the actual candidate executable/archive
runs before the costly predecessor install. The temporary diagnostic is removed.
Installed STT/TTS and x64 remain open at the full product trial.
Routine PR passed in 4m41s (22m16s runner work); dev failed in 4m22s
(23m02s runner work) after 633 app files/5,650 tests passed with an unhandled
React `window is not defined` teardown exception. The attributed file-link suite
lacked explicit unmount/query cleanup with Vitest globals disabled, and its final
deferred lookup was not awaited through settlement. The scoped repair adds owned
cleanup and awaited settlement without weakening assertions or suppressing errors;
the next required hosted routine run is its integration gate.

The [full ARM product trial](https://github.com/iExalt/paseo/actions/runs/38173280275)
at `b065b31e5` passed in 65m28s and is reviewer-accepted. Both installed UI journeys
preserved workspace `wks_311f36b74ce62131`, Pure black theme and the original
295-byte CLI trampoline; CLI/PTY checks and normal close passed. Author and reviewer
inspected the retained screenshots. Installed Electron 44.6.0 loaded the exact
addon-adjacent native hashes, transcribed “This is a voice note.” with similarity 1,
and produced 68,834 bytes of 24 kHz PCM in 9.466s. All 15 owned Jobs completed
with zero active processes; installer, application, speech and uninstaller exits
were normal. Registry, install directory, shortcuts and owned state were removed.
Candidate installation/build took 23m32s/5m28s; predecessor took 20m55s/4m43s.
Npm timing attributes 21m18s/19m44s to unpacking, so a download cache alone does
not remove the dominant repeated work. Routine PR/dev passed in 4m42s/4m37s,
using 22m35s/23m36s runner work, including the repaired file-link lifecycle.

The next cache increment retains only the fixed predecessor NSIS and portable
identity/provenance, capped at 200 MiB per architecture (ARM installer measured
147,218,235 bytes). Candidate install/build always remains normal. Exact keys bind
source, lock, native architecture, tool/image versions, BCJ and producer/binding
recipes; no prefix restore or unrelated eviction is allowed. Restores validate
the exact regular-file inventory, hashes, binding provenance and relative installer
name before constructing a new owned absolute path. Save follows successful
installed verification and cleanup, and requires current repository usage plus
the full reservation to fit the advisory 8 GB ceiling under the 10 GB hard limit.
Oversize entries or unavailable usage skip saving. A necessary native miss run
and a separate small fresh-runner restore through the real consumer will prove
transport/integrity; full cache-hit upgrade and overall latency savings remain
unclaimed until a later necessary hit run. No extra long benchmark run is planned.
The first [cache-enabled x64 trial](https://github.com/iExalt/paseo/actions/runs/38179007301)
at `be8fadb30` repeated full installed verification and cleanup but failed cache
staging after 18m32s: Git's LF lockfile blob hashed differently from the physical
Windows CRLF checkout. Re-encoding that exact blob reproduced the observed hash;
no cache was saved. The repair records both hashes separately and reads the actual
fixed predecessor checkout. Its fresh-runner proof creates the same clean detached
worktree, then always removes it and verifies absence. Different checkout bytes
produce an exact-key miss; integrity checks are not normalized away. Routine
PR/dev at this source passed in 4m35s/4m14s, with 23m32s/22m51s runner work.

The [Windows x64 contributor](https://github.com/iExalt/paseo/actions/runs/38177868696)
at `b065b31e5` passed in 14m56s and is reviewer-accepted. The retained workspace
`wks_7566caf5d7e323ac`, Pure black theme and CLI trampoline survived replacement;
author and reviewer inspected the candidate screenshots. Real STT matched exactly,
TTS returned 68,808 bytes of 24 kHz PCM in 3.837s, and the three loaded native
hashes matched the installed package manifest. All 15 owned Jobs completed with
zero active processes; installation, registry, shortcuts and state cleanup passed.
Candidate install/build took 2m04s/3m56s; predecessor took 1m22s/3m17s.
Its 159,365,371-byte predecessor also fits the unchanged 200 MiB cache cap.
At the corrected cache source `c787e125c`, routine PR/dev passed in 4m24s/4m15s,
using 20m39s/21m20s runner work. These are additional observations, not a reset
of the accepted baseline or a controlled performance comparison.

The [corrected cache trial](https://github.com/iExalt/paseo/actions/runs/38180882993)
at `c787e125c` passed: full x64 product verification in 21m33s followed by a
40-second fresh-runner cache proof. The 159,368,932-byte entry contains the fixed
installer and two metadata files; its installer SHA-256 is
`553fb1594473776dd0f6bf06c3e3f8adfb608bd5a9b715e85b10f0c9f254819f`.
Both lockfile hashes and the exact recipe matched on the fresh runner; restore
took 3s, real validation/copy/absolute-identity reconstruction 1s, and clean
proof-worktree removal 1s. Save followed successful installed speech/upgrade and
all cleanup gates. Repository usage is now 5,306,868,709 bytes across six entries,
under the unchanged 10 GB hard limit; no unrelated entry was evicted.
This proves x64 cache transport/integrity, not an installed full-hit workflow or
ARM cache transport. Those may be measured on later necessary candidate runs.

The slower native run does not establish a cache regression: candidate and old
install/build commands were unchanged, with nearly identical recorded I/O but
higher charged CPU time. Candidate install/build took 3m04s/6m02s; predecessor
2m16s/4m31s. New native cache steps totaled 9s (prepare 1s, miss 0s, staging 3s,
save 5s); the optional 40s proof is separate. Preserve both observations and the
stable routine baseline; do not claim a controlled host comparison or overall
cache-hit speedup from this miss run.

B1's first [browser trial](https://github.com/iExalt/paseo/actions/runs/38094860337)
at `58a934af2` passed in 2m46s, including installation and evidence upload. One
worker runs one existing terminal-launch journey without retries: both prompt and
bare profiles execute real shell commands through the UI and daemon. Build took
11.52s, Chromium provisioning 22.46s and the journey/harness 68.87s. Author and
reviewer inspected the successful screenshot; the trace is retained and readable.
A React development-warning overlay is visible, so this is not a claim of
visually warning-free output. Daemon and Metro shutdown are logged. The
[negative trial](https://github.com/iExalt/paseo/actions/runs/38095078682) at
`c6d6b2f54` failed at the deliberately wrong output assertion; its screenshot
shows the correct `captured: fix the flaky test` output, and cleanup is logged.
The [restored trial](https://github.com/iExalt/paseo/actions/runs/38095688591)
at `8351fc536` passed the browser journey, daemon/Metro shutdown and all command
ownership checks; author and reviewer inspected its screenshot and retained trace.
B1a is accepted. Routine CI on that SHA passed in approximately 4m25s, within the
unchanged under-five-minute budget.

The expanded trial adds sequential CLI lifecycle, forced local relay E2EE
and three pinned provider `--version` contracts in one lane, plus real Electron
daemon-manager/renderer IPC under Xvfb in another. Provider dependencies have an
isolated integrity lock; no live model prompt is used. Each initial lane is bounded
to 15 minutes, one attempt before diagnosis, with at most 25 MiB/one-day retention
per UI lane. A unique command marker checks Linux same-UID process cleanup within
five seconds; this does not prove cleanup of children that deliberately strip
their environment or unrelated root package-manager helpers. Existing harness
shutdown receipts remain required. This Electron harness is not packaged-app
startup proof; that remains G3. G2 remains open until all deep gates including B2's
rebuilt Android journey pass.

The expanded integration lane passed at `8351fc536`: CLI lifecycle took 222.19s,
forced relay verification 3.13s, isolated provider installation 8.77s and pinned
version execution 0.74s, with command ownership checks passing throughout. Electron
passed its runtime assertions in 148.08s and retained screenshots, but failed final
temporary-directory removal on read-only DevTools cache directories. The reviewed
repair `03155ef58` makes only real directories in the stopped test's owned tree
owner-writable, without following symlinks; a fast fixture verifies external target
permissions and contents remain intact. Its hosted cleanup proof remains pending.
The [cleanup trial](https://github.com/iExalt/paseo/actions/runs/38096041627) at
`03155ef58` passed all three lanes: browser 2m41s, Electron 4m23s and integration
5m15s, totaling 12m19s of runner work. Electron temporary-tree deletion and final
process checks passed; its retained screenshots were inspected. B1a/B1b are
reviewer-accepted, with the Windows-only CLI case retained for B4 and rebuilt
Android still pending B2. Routine CI passed in 4m32s. The PR routing repeated all
three lanes for the cleanup source change; that repeated runner work is verification
cost, not a performance improvement.

B2a replaces run-number identity in the manual coordinator and callable Mac/Android
lanes with clean-source semver and its derived Android code. Candidate artifacts
use `kind: paseo-verification-candidate`, schema 2; they are distinct from the
published signed V2 inventory. The current source version 0.11.2 is disposable
verification only: no public release or personal installation is authorized, and
legacy schema-1 promotion deliberately rejects these candidates until C migrates
publication. Initial 0.1.0 artifacts must be rebuilt after C's source-version reset.
Source identity uses the hosted Node interpreter for builtin-only checks, not proof
of the packaged runtime. Read-only secret-name inspection confirms all four required
signing/configuration secrets exist; current key usability remains a live proof.
Candidate retention is one day, with APK transfers capped at 512 MiB and the Nix
archive at 2 GiB; quota rejection fails the gate. The first package trial at
`10591c783` stopped Android before compilation: WebView generation changed a tracked
file before the strict clean-source check. Reviewed repair `e506c1272` moves that
check before installation/generation; it does not weaken the guard. That trial's
Mac signing/export passed in 11m59s and fresh-runner signature/import verification
in 1m16s; Android failure still prevents paired acceptance. Reviewed `e506c1272`
passed routine CI and is integrated into dev. Repaired paired run `38097874209`
passed at that exact SHA: 23m43s critical path and 36m28s summed runner work,
including Mac build/export 11m44s, fresh import 1m10s and Android build 22m46s.
The reviewer accepted matching source/version, signatures and artifact pins.
Gradle still executed all 1,323 tasks in 20m16s despite a cache hit; this is not
evidence of useful compiled-output caching. Runtime/upgrade acceptance remains open.

The later required producer `38104597837` also exposes a memory bottleneck during
Hermes compilation: its sample at 02:35:37 UTC on 2026-10-11 (22:35:37 EDT on
2026-10-10) recorded `hermesc` RSS 14,081,668 KiB, only 505,532,416 bytes of available
RAM and 6,093,950,976 bytes of swap in use. This is not evidence that increasing
Gradle workers would help. Retain the sample for the next required Android build;
no extra benchmark, concurrency increase or compiled-cache benefit is claimed.

The shared candidate transport helper is locally verified and reviewer-accepted:
it checks explicit producer attempt/source, pinned artifact IDs and ZIP digests,
bounded streams and exact flat extraction. Tiny real-ZIP fixtures cover both
platform selections without downloading the other platform. Native metadata,
signatures, UI state preservation and runtime cleanup remain B2 consumer gates;
no transport-only workflow was dispatched.

The first native consumer implements a manual, read-only Mac verification job:
it verifies the pinned published 0.11.0 predecessor and the accepted candidate's
signed Nix closure in the canonical store, then uses their actual packaged binaries
against one disposable profile. The predecessor seeds a workspace and theme through
its CLI/UI; the replacement must show the same workspace identity and selected theme,
with its full plugin/CLI/PTY checks. Supervisor/descendant identities are captured
before and after runtime activity and must exit before replacement. Early launch
failures without a PID remain failed gates with hosted teardown as fallback, not
successful process-cleanup proof. Native Mac execution passed in run `38100022842`,
with harness `7b87e5ab6` and producer `e506c1272`: 4m28s including setup/import and
retained evidence. Author and reviewer inspected screenshots and state receipts:
both canonical signed app roots show the same workspace ID and Pure black theme.
Candidate plugin/CLI/PTY behavior and owned-process cleanup passed. The predecessor
only seeds state; its generic terminal-success log was inaccurate and is corrected
without changing behavior. This closes B2's Mac runtime/manual-upgrade portion,
not C's updater transition or G6's 0.1.0 user migration.

The Android consumer is implemented and reviewer-accepted for hosted verification.
It uses the proven pinned ARM64 container/kernel module, verifies both signed APKs,
and runs a fixture daemon built from the candidate's exact source. Real ADB controls
seed a saved connection/theme, open the unique fixture workspace, and exercise PTY
input/output before and after `install -r` without clearing app data. Output markers
are assembled by the shell and never appear in the typed command. Workspace proof
originally used its visible unique title; the accepted repair now requires its
exact server-qualified native row ID, as recorded in the closure receipt above.
Host/container/backend cleanup and screenshot retention are bounded. UI selectors,
rendered output accessibility and upgrade behavior remain unverified until the
accepted paired producer feeds the reviewed live consumer. The first trial stopped
before installation because the signer also emits an `.apk.idsig` sidecar. The
reviewed consumer repair includes that exact filename in its bounded allowlist;
local extraction of the actual artifact and ZIP/APK digest checks pass. No producer
rebuild is needed. An explicit platform selector permits an Android-only retry
without repeating accepted Mac proof; invalid selections enable neither lane.
The Android-only retry `38100824253` at `9a0dbaedc` passed transport, APK identity
and predecessor installation, then failed connection setup: retained UI evidence
shows the disposable AOSP keyboard's contacts-permission dialog. The harness now
handles only that exact denial, checks keyboard/focus readiness and verifies
separate host/port field values before submission. Android runtime/upgrade remains
unverified; this is a harness repair, with unchanged producer bytes and pins.
The next trial `38101632063` passed that connection setup and reached the app home,
then stopped on Paseo's first-use notification dialog. Its exact denial is added
for this disposable journey; unrelated permission requests still fail the gate.

The native consumer's process tracking repair `bfef0fca1` uses PID plus immutable
start time, excluding mutable process titles. Its PR run `38099238307` passed all
behavioral checks but failed the unchanged latency gate at 304s. Server shard 3 took 149.81s versus
137.32s on the preceding head, with unchanged tests and two workers. This exposed
insufficient latency margin rather than added test work on that shard. The reviewed
repair moves a 16-second supervisor heartbeat observation to virtual time, retaining
real IPC/logging and the real ten-second forced-termination journey. At `7b87e5ab6`,
PR run `38099694096` passed in 4m01s and dev `38100019453` in 4m31s; the logging
suite fell from 30.21s to 13.43s and virtual timing took 9ms on the PR. Host variation
also affects total duration. No deadline or concurrency increase was applied.

The [optimized integration lane](https://github.com/iExalt/paseo/actions/runs/38096508135)
at `18510758c` passed unchanged lifecycle cases, relay/provider checks and all process
cleanup checks. Direct validated configuration writes replace five setup-only CLI
invocations per home; real CLI mutation assertions remain. Lifecycle orchestration
fell from 206.23s to 130.55s with the same one worker, and integration from 5m15s to
3m40s. The observed 37% lifecycle reduction is not a controlled host comparison;
the removed setup subprocesses establish avoided work without weakening coverage.
Reviewer accepted this proof; no separate benchmark is needed. That SHA's routine
behavior lanes passed but quality rejected two misaligned status-table rows.
The formatting repair at `10591c783` passed deep CI in 4m35s and routine CI in
4m13s on the PR; its integrated dev run `38097200908` passed in 4m12s. These hosted
observations preserve the original accepted baseline and under-five-minute budget.

The user-confirmed $0 Actions budget with Stop usage enabled clears bounded B
artifact uploads; retention alone is not the no-overage proof. Same-job build/install/runtime proofs can proceed within B approval without
uploads. Cross-job draft Release transport needs explicit B authority and immutable
candidate/asset bounds. Retained UI screenshots/traces must have a verified free
transport. Android deep closure depends on B2's rebuilt same-SHA APK, not the
legacy feasibility APK. Missing signing access blocks dependent proofs only.
Each initial native trial needs a job deadline and explicit matrix cells, followed
by diagnosis before retries; no paid runners, personal devices or public releases
are included by default. Windows proof includes STT/TTS and PTY lifecycle beyond
A1's VAD smoke. Disposable upgrades must preserve meaningful state.

## Progress log

- 2026-10-11: Phase B/G2–G3 accepted across the contributor matrix above. Windows
  ARM/x64 installed upgrade, CLI/PTY, real speech and cleanup passed; x64 immutable
  predecessor save/fresh-runner transfer also passed. Final implementation routine
  PR/dev checks were 4m24s/4m15s; repository cache usage is 5.31 GB of 10 GB.
  The two-minute stretch, ARM cache transfer and full cache-hit upgrade remain
  unclaimed. The next step is Phase C approval, not public release or device migration.

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
