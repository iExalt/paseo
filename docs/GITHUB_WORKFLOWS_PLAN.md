# GitHub workflows plan

Status: **Phase A approved, 2026-10-10; implementation active**.

Current evidence and remaining gates: [project status](GITHUB_WORKFLOWS_STATUS.md).

This is the decision ledger for a clean-slate fork CI and release campaign. The
[roadmap](GITHUB_WORKFLOWS_ROADMAP.md) and [script](GITHUB_WORKFLOWS_SCRIPT.md)
derive implementation steps and thread boundaries from this tier. The
user's latest decisions override older campaign documents and upstream guidance.

## Summary

Build a single-branch workflow around `dev` and release-please. Every PR and
`dev` push gets routine checks. Release-please PRs get deeper verification;
their exact merged candidate commits get deeper verification again, packaging,
and package smoke tests. Publish to GitHub Releases only after the entire
required matrix succeeds for the candidate revision.

The user approved Phase A in a sibling worktree, including reviewed commits and
pushes, a test PR and bounded free probes. Later phases, public releases and
personal-device changes retain their explicit approval gates. CI performance
and the repository's 10 GB cache ceiling are requirements.

**Revised by the user during A1:** start the fork at **0.1.0**, order upgrades
solely by fork semver, and make a **clean break with manual migration**. Remove
the independent numeric release sequence and automatic legacy-client bridge.
Android retains its mandatory internal versionCode as a deterministic semver
encoding, not a second release identity. Preserve application IDs, signing
identities, installed user data and recovery assets during manual migration.

## 1. North star and scope

The first useful implementation outcome is a verified event/check contract and
working routine CI on `dev`, followed by release automation that cannot expose
an incomplete or unverified release. Reuse useful tests and signing primitives;
do not reproduce inherited workflow structure merely because it existed.

| Platform | Architecture  | Required deliverables                      |
| -------- | ------------- | ------------------------------------------ |
| macOS    | ARM64         | Signed Nix closure                         |
| Android  | ARM64         | Signed APK                                 |
| Linux    | x64 and ARM64 | Nix daemon and desktop, DEB, RPM, AppImage |
| Windows  | x64 and ARM64 | Unsigned NSIS installer with checksums     |

Exclude iOS, Intel Mac delivery, conventional macOS DMG/app delivery, Windows
portable archives, Linux tarballs, Docker distribution, package registries,
Cloudflare deployments, and trusted Windows publisher signing. Existing native
signing identities, installed application identity, user state, and Mac/Android
upgrade continuity must be preserved. Paid provider tests are not part of the
settled deterministic CI scope.

## 2. Background and evidence

### 2.1 Decision history

The user first requested an inventory of inherited workflows, then asked for a
clean-slate menu. They chose all four platforms, the formats above, broad CPU
coverage, and focused integration plus critical browser, desktop, and Android
UI journeys. They accepted unsigned Windows installers with checksums.

**Changed (the user, 2026-10-10):** use only `dev`, replacing the previously
selected `dev` to `release` promotion branch. The reason is simpler release
management without a separate stabilization branch. Release-please prepares a
version/changelog PR into `dev`; there is no promotion PR or `release` branch.

**Agreed (the user, 2026-10-10):** verify the exact merged candidate as well as
the release PR. PR success alone is not proof of the final packaged revision.

### 2.2 Verified starting point

- Source baseline: `7a9291ae43c7aabb892812cffd86b65b244cf72d`,
  `ci: remove inherited upstream workflows`. Five fork workflow files remain:
  `fork-builds.yml`, `fork-android-apk.yml`, `macos-closure.yml`,
  `upstream-sync.yml`, and `rebase-dev.yml` under `.github/workflows/`.
- GitHub reports a public repository with default branch `dev`. No live
  configuration was modified during planning. `docs/PASEO_WISHLIST.md` has an
  unrelated local edit and must not be included in campaign commits.
- [Completed delivery campaign](complete-campaigns/PASEO_FORK_AUTO_UPDATE_PLAN.md)
  records prior signed Mac/Android delivery and recovery evidence. Those are
  historical proofs, not validation of the new matrix.
- [Release manifest](../packages/protocol/src/release-manifest.ts) validates
  a Mac/Android pair and tags containing package version, sequence, and source
  SHA. [Promotion](../scripts/promote-fork-release.mjs) already validates
  monotonic releases, artifact provenance, drafts, and publication. Preserve
  its useful guarantees while replacing manual orchestration.
- GitHub's latest three releases inspected during grounding were fork sequences
  200008, 200007, and 200006. Sequence 200008 is a historical floor, not a value
  to hardcode; implementation must inspect current published state.
- [Electron packaging](../packages/desktop/electron-builder.yml) declares NSIS
  for both Windows architectures and Linux formats, but also unselected ZIP and
  tarball outputs. Configuration presence does not prove these builds work.
- [Nix flake](../flake.nix) declares both Linux architectures; each still needs
  real build/import/runtime evidence.
- [Mobile testing](upstream/mobile-testing.md) has native scripts and harnesses,
  including terminal and keyboard flows. Headless CI setup and the shipped
  ARM64 APK's install/runtime proof remain unverified. An x86 emulator test
  artifact must never be reported as proof of the shipped ARM64 APK.

### 2.3 External references

- [Release-please action](https://github.com/googleapis/release-please-action):
  manifest configuration, explicit target branch, release/PR separation, and
  credential-driven event behavior need an integration rehearsal.
- [Release-please manifest configuration](https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md)
  informs version strategy; select the actual configuration after S1/D13.
- [GitHub runner matrix](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
  provides standard native Linux/Windows x64 and ARM64 and macOS ARM64 runners.
  Standard compute is free for this public repository. Compatibility, artifact
  storage, credentials, and external services are separate constraints.

## 3. Decisions

Decided means the user's choice; Agreed means an accepted proposal; Open names
the decision or evidence still needed. All recorded conversation decisions below
were made by the user on 2026-10-10.

| ID  | Decision                                                                                 | State                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Single `dev` branch with release-please PRs                                              | Decided; replaces two-branch promotion                                                                                                      |
| D2  | Routine CI for every PR and `dev` commit                                                 | Decided; no silent path-based omission of the required aggregate gate                                                                       |
| D3  | Deep verification on release PR and exact merged candidate                               | Agreed; both gates retained                                                                                                                 |
| D4  | Formats and architectures in §1                                                          | Decided; no architecture silently dropped for feasibility                                                                                   |
| D5  | GitHub Releases is the sole publishing destination                                       | Decided                                                                                                                                     |
| D6  | Unsigned Windows installer plus checksums                                                | Decided; publisher signing deferred                                                                                                         |
| D7  | Focused integration and critical browser/Electron/Android UI journeys                    | Decided; most behavioral cases belong in fast unit tests                                                                                    |
| D8  | Independent fork semantic versions                                                       | Decided; explicit versioning/updater migration, upstream version recorded separately                                                        |
| D9  | Linux/Windows manual upgrades initially                                                  | Decided; verified Windows/AppImage in-app updates are stretch only; DEB/RPM/Linux Nix stay manual                                           |
| D10 | CI must be free; prioritize low routine latency                                          | Decided; no paid compute, storage overage, provider APIs, device farms, or publisher credentials                                            |
| D11 | Preserve existing cryptographic signatures, exclude Apple/Windows publisher verification | Decided after the user clarified that paid publisher credentials are what they lack; configured secret names are verified, usability is not |
| D12 | Rebase automation uses new routine CI directly                                           | Decided; one entrypoint, evaluated against the rebased candidate before publication                                                         |
| D13 | Initial fork version and migration                                                       | Decided during A1: 0.1.0, clean break, manual migration, semver-only upgrade ordering                                                       |
| D14 | Numeric runtime budget                                                                   | Open; S2 records comparable baseline and proposed ceiling; user confirms before suite expansion                                             |
| D15 | Execution grouping                                                                       | Agreed; four serial threads, script in docs; current checkout by default, no parallel worktrees without user request                        |

## 4. Proposed design boundaries

Separate read-only verification of untrusted PR code from trusted signing and
publication. A label or PR title alone must not authorize secret access or
identify a release candidate. Verify release-please PR provenance, merge SHA,
and repository/branch identity. Pin source revisions throughout; never package
the moving `dev` tip in place of a selected candidate.

Every published artifact must belong to one candidate and required matrix entry.
Keep releases draft or absent until tests, signatures, checksums, manifests,
package installation/import, and matrix completeness pass. Exercise failures,
partial uploads, reruns, stale candidates, and concurrent candidates. Never
overwrite an already published immutable release to repair a failed attempt.

The existing `fork-builds.yml` currently builds on relevant ordinary `dev`
pushes. The campaign must deliberately migrate that trigger to release-candidate
packaging, preserving monotonic identity across workflow renames and reruns.
Retain and audit upstream sync and manual rebase workflows; they must not bypass
the new CI or cause recursive releases. Rebased history and release-please's
last-release discovery need explicit regression/rehearsal cases.

### 4.1 Workflow responsibilities

Names are proposed implementation names, not a requirement to create one file per
row. Keep orchestration thin and shared behavior directly callable.

| Responsibility        | Event/input                                                        | Required outcome                                                                                                    |
| --------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Routine CI            | All PRs and every `dev` push; local/rebase entrypoint              | Format, lint, types, unit suites, focused integration; stable aggregate result                                      |
| Deep verification     | Authenticated release-please PR updates and exact merged candidate | Critical browser, Electron, native Android journeys and deeper integration                                          |
| Release-please        | Trusted `dev` changes                                              | One maintained fork release PR with version, manifest, lockfile, and changelog updates; no premature public release |
| Candidate coordinator | Recognized merged release PR, explicit same-candidate retry        | Pin SHA/fork semver; invoke routine, deep, packaging; collect required results                                      |
| Mac packaging         | Candidate identity                                                 | Nix closure signatures, clean import, app/daemon smoke                                                              |
| Android packaging     | Candidate identity                                                 | Production APK, original certificate, monotonic versionCode, native ABI and manifest checks                         |
| Linux packaging       | Candidate identity and x64/ARM64                                   | Nix daemon/desktop and DEB/RPM/AppImage build and runtime/install smoke on each native architecture                 |
| Windows packaging     | Candidate identity and x64/ARM64                                   | Unsigned NSIS install, launch, daemon/terminal, upgrade/state-preservation smoke                                    |
| Publication           | Complete verified candidate                                        | One GH release containing all required artifacts and authenticated/checksummed metadata                             |
| Upstream sync         | Existing daily/manual event                                        | Preserve mirror behavior; no unintended build/publication cascade                                                   |
| Rebase dev            | Existing manual event                                              | Rebase, call routine CI on candidate, preserve exact lease and atomic backup/publication                            |

Routine CI also covers release-please PRs. Changed-path routing may avoid
irrelevant expensive work only when its dependency rules are tested and the
required aggregate check still runs; candidate gates never silently skip a
required platform. Exclude marketing-site deployment and dedicated website E2E;
workspace-wide static checks may still cover that source.

Use one shared routine command, proposed `mise run ci:routine`, backed by npm
scripts. A composite action or same-job entrypoint lets the rebase job validate
its local candidate directly. If jobs must be split, prove exact-SHA transport
and trust before replacing this simpler route. A passing check on origin/dev
does not validate the candidate. Token-created pushes may not trigger follow-on
workflows, so rebase success must not depend on that side effect.

### 4.2 Release-please and migration

Bootstrap fork release state explicitly; do not interpret all upstream history
as new fork changes. Record the upstream base separately from fork semver and
keep all workspace/native/version consumers consistent. Establish behavior for
upstream rebases, non-ancestor previous release SHAs, upstream version edits,
failed candidates, and repeat release-please invocations.

Release-please's PR-creation credential must actually trigger PR workflows.
Prefer a narrowly scoped GitHub App installation token; a scoped PAT is an
alternative if existing access makes it simpler. Credential creation may need
the user; no token values enter docs or logs. Repository workflow approval and
permissions must be tested with an actual bot-created PR, not assumed.

Default release-please behavior may create a public release immediately. Use
draft/release separation or a compatible coordinator adapter so only the final
verified publisher makes a release public. Rehearse the selected mechanism,
including tag creation, discovery of previous releases, and reruns.

Fork stable semver is the only upgrade ordering and release identity. Use
canonical `v0.1.0` tags and a new signed manifest schema with explicit fork
lineage, source SHA, upstream base and the complete artifact inventory. Legacy
`paseo-fork-*` tags and exact-key V1 manifests remain historical recovery assets;
new clients must not compare their upstream-derived versions against fork semver.
There is no compatibility release or alias. Installed clients move to 0.1.0
through the explicitly approved manual migration gate in G6.

Android requires an integer versionCode. For stable `major.minor.patch`, use
`200000 + major * 1000000 + minor * 1000 + patch`, with minor/patch below 1000
and result at most 2100000000. The fixed offset makes 0.1.0's code 201000 exceed
the currently published 200008, allowing same-certificate manual installation
without uninstalling data. Recheck the installed floor before G6. Reject beta,
build metadata and out-of-range versions rather than introducing collisions.
No run number, persistent counter or failed-candidate reservation is involved.

Retries retain semver, source SHA and immutable attempt artifacts. An unpublished
replacement source gets a distinct draft identity after the earlier candidate
is stopped; do not overwrite its receipts. A published version is immutable:
changed bytes require the next semver. The publisher rejects stale versions.
Keep signing identities, application IDs, state directories and Nix trust.
Manual Mac migration must account for old updater receipts and recovery state;
changing a comparator alone does not migrate those records. Device actions wait
for explicit user presence/authorization.

### 4.3 Zero-cost operation and test fidelity

Only standard runners in the public repository are allowed. Before any CI probe,
verify current account/repository storage entitlements, current usage, and a
hard no-overage mechanism. Short retention alone cannot establish zero cost.
If free capacity or enforcement cannot be proved, skip optional uploads/cache
writes or stop the affected run; never purchase capacity automatically.

Evaluate GitHub release assets for large trusted candidate transport rather
than assuming Actions artifact allowance can hold every Nix closure. Respect
current asset limits, bound draft lifetime, scope cleanup to campaign-owned
drafts, and never delete published releases or shared cache indiscriminately.
Untrusted PR evidence stays read-only/within verified free storage; PR code never
gets a release write token. Logs and compact job summaries are the first evidence
channel. Failed-run diagnostics retain bounded screenshots/traces where free
capacity allows. Preserve necessary evidence through an approved zero-cost path.

Maintain the testing pyramid by cost as well as count. Run shared logic tests
once where OS independent; use native platforms for process, watcher, terminal,
installer, and native dependency contracts. Use fixtures instead of paid model
calls for deterministic journeys. An emulator x86 build can prove shared Android
UI behavior but cannot prove ARM64 production-APK execution. G3 cannot claim full
artifact verification until that gap has an actual zero-cost proof or an explicit
user-approved scope revision. Manual DEB/RPM/Nix/Windows upgrades must preserve
state; installer success alone is insufficient.

## 5. Work items

| ID  | Required work                                                                                    | Milestone |
| --- | ------------------------------------------------------------------------------------------------ | --------- |
| W1  | Semver, Android encoding, manual migration, bot-event, ARM64 and zero-cost feasibility contracts | G0        |
| W2  | Shared routine command, stable checks, baseline and runtime budget                               | G1        |
| W3  | Rebase consumes W2 before atomic publish; upstream sync retained and tested                      | G1        |
| W4  | Deep browser/Electron/native Android journeys and platform integration                           | G2        |
| W5  | All selected package formats/architectures, fresh install/import/manual upgrade proofs           | G3        |
| W6  | Independent semver, new signed manifest/updater, release-please config and PR event chain        | G4        |
| W7  | Exact-SHA coordinator, complete matrix, retries, drafts and publication gates                    | G5        |
| W8  | First release, installed-client migration/recovery proof, runbooks and cleanup                   | G6        |

## 6. Milestones and gates

- [ ] **G0: Resolve feasibility contracts.** Gate: concrete semver/Android encoding and
      metadata interface, bot event route, zero-cost transport, and native-architecture
      proof strategy are recorded. Remaining unsupported requirements are reported
      for a decision, not represented as green. Initial version is selected.
- [ ] **G1: Establish shared routine CI.** Gate: real PR/dev events and rebased
      candidate use one entrypoint; injected failure blocks rebase publication;
      measured command/baseline/budget are accepted, stable checks are visible.
- [ ] **G2: Verify critical journeys.** Gate: selected deep checks run on a safe
      test PR and are callable by exact SHA; G4 proves real release-please PR routing.
      Deterministic fixtures, assertions,
      bounded diagnostics and native-vs-emulator limits are explicit.
- [ ] **G3: Verify every package.** Gate: each format/architecture in §1 is built
      from the candidate and passes installation/import, startup, terminal/daemon
      and disposable-state upgrade checks appropriate to it; installed legacy-client
      migration and recovery remain G6. Mac/Android signing identities
      remain unchanged. Actual shipped-ABI proof is accounted for.
- [ ] **G4: Prepare compatible releases automatically.** Gate: a real bot-created
      release PR triggers required checks; independent semver, workspace versions,
      new-client semver ordering and manual-migration fixtures pass; no public release is created.
- [ ] **G5: Enforce complete publication.** Gate: a missing/failed platform,
      stale SHA, wrong signature, partial upload, concurrent or retried attempt cannot
      publish. The all-green same-SHA rehearsal succeeds without making assets public.
- [ ] **G6: Deliver and operate the first release.** Gate: explicit publication
      authorization, complete GH assets, download verification, and actual legacy
      Mac/Android manual migration/state/recovery evidence; all selected platform proofs,
      routine latency and zero-cost controls recorded; user accepts final result.

## 7. Spikes and open decisions

Allowances below are proposals for phase approval, not permission to run them
now. Stop at the reassessment point and report a falsified assumption honestly.

| Spike                 | Workload and allowance                                                                                                                                           | Success/failure and decision                                                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| S1 Version/identity   | Offline stable-semver and Android-encoding boundary fixtures; source/retry/rebase invariants specified for C/D                                                   | 0.1.0 clean break selected; encoding has no collisions, fork ordering excludes legacy lineage; full migration/coordinator fixtures remain C/D |
| S2 Baseline           | One required cold and one warm routine run on pinned standard Linux runner; record setup/build/tests and concurrency                                             | Establish stable baseline and proposed low-latency ceiling; user settles ceiling before adding coverage                                       |
| S3 Native feasibility | One representative install/build/runtime probe per previously unproved Linux/Windows ARM64 lane and Android shipped-ABI path; one attempt per lane, then analyze | Working dependency/package proof or precise blocker; no blind retry campaign or architecture omission                                         |
| S4 Bot/publication    | One isolated bot PR and one draft-only candidate rehearsal after zero-cost/access gates                                                                          | PR events fire; merge SHA selected; incomplete matrix stays unpublished; credentials and draft behavior verified                              |

Draft releases are a publication boundary, not a secret-storage mechanism.
Candidate artifacts must contain no credentials or private runtime state.

Initial fork version and clean-break migration are settled by the user. Measured
latency ceiling and technical spike results remain open with these gates;
implementation mechanics belong to the agent/reviewer. Credential access and any
unavoidable physical-device proof are explicit human interventions. There is no
requirement for the user to be continuously present during implementation.

## 8. Reassessment triggers

Return material changes to the user: unsupported native dependencies, inability
to test a shipped architecture, incompatible updater/version semantics, need
for paid infrastructure, substantial routine-runtime growth, or an unexpected
credential/manual-device dependency. Preserve completed work and the selected
acceptance criteria while considering alternatives.

## 9. Rejected approaches and stretch scope

- A separate `release` branch and automatic promotion PRs: replaced by D1.
- Reusing every upstream workflow: the user removed them to design from outcomes.
- Assuming successful packaging replaces behavioral tests: rejected; both gates
  are required.
- Treating free compute as proven support or unlimited free storage: rejected.
- Treating an existing updater or declared ARM64 target as verification: rejected.
- Independent fork semver replaces the initially proposed upstream-version-plus-
  revision presentation; compatibility and monotonic native upgrade identity remain.
- **Stretch only:** verified in-app updates for Windows and Linux AppImage.
  Start only after G6 and an explicit scope extension. Linux DEB/RPM/Nix remain
  manual. Paid Apple/Windows verification is outside this campaign.
