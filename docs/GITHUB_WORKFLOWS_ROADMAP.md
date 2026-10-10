# GitHub workflows roadmap

Status: **Phase A / G0–G1 complete; Phase B approved and active, 2026-10-10**.
Current evidence: [project status](GITHUB_WORKFLOWS_STATUS.md).
The [plan](GITHUB_WORKFLOWS_PLAN.md) owns scope, decisions and gates. The
[script](GITHUB_WORKFLOWS_SCRIPT.md) groups these steps into execution threads.
When a step passes, tick it and its plan gate in the same scoped commit with a
small inline evidence receipt. Do not mark a gate complete from source review
alone when it requires a live result. Execution creates one shared status doc
through `maintain-project-status`; do not create per-run committed reports.

## Progress and resources

| Phase                       | Steps | Completed | Exit   |
| --------------------------- | ----- | --------- | ------ |
| A Foundations               | 1–3   | 3         | G0, G1 |
| B Verification and packages | 4–6   | 0         | G2, G3 |
| C Release preparation       | 7–8   | 0         | G4     |
| D Integration and delivery  | 9–11  | 0         | G5, G6 |

| Live activity             | Steps | Resources and lifetime                                                                   | Cost boundary                                                                               |
| ------------------------- | ----- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Feasibility and baseline  | 1–2   | Standard runners, one representative probe per unknown lane; one cold/warm baseline pair | Verify free allowance/enforcement first; no paid fallback                                   |
| Deep/package proofs       | 4–6   | Native standard runners and approved Android proof environment; one candidate            | Bound evidence and draft lifetime; stop on unavailable free capacity                        |
| Bot event rehearsal       | 8     | Scoped bot credential, test PR, no public release                                        | User access may be required; clean only owned test state                                    |
| Failure rehearsal         | 9–10  | One candidate, controlled failed/missing lanes, draft-only assets                        | No public release; retain compact receipts, remove owned abandoned drafts                   |
| First release and devices | 11    | GH release plus user's existing Mac/Android installations                                | Explicit publication and device action authorization; preserve releases and recovery assets |

## Phase summaries

- [ ] **Performance stretch across all phases:** review every CI workflow and
      reusable lane, preserve comparable timing receipts, and optimize measured
      bottlenecks without weakening proof or exceeding free limits. Use required
      runs; future C/D lanes remain unmeasured until their approved gates. The
      ordinary PR requirement stays under five minutes, with two minutes preferred.

- **A:** settle migration/storage/ABI contracts (1), establish measured routine
  CI (2), and reuse it for rebase publication (3). Exit: G0/G1.
- **B:** critical deep journeys (4), preserved Mac/Android delivery (5), and
  Linux/Windows packages (6). Exit: G2/G3; unresolved ABI proof blocks G3.
- **C:** independent fork version migration (7), then actual release-please PR
  creation and event verification (8). Exit: G4.
- **D:** complete exact-SHA coordination (9), failure/retry rehearsal (10),
  first approved release and operational handoff (11). Exit: G5/G6.

## Testing and latency contract

Step 2 establishes `mise run ci:routine` (proposed name) as the single routine
entrypoint, backed by existing npm scripts. CI and rebase invoke this entrypoint
against their actual working tree. Run platform-independent logic at the cheapest
reliable layer, selected OS-specific contracts on native runners, and a small
set of end-to-end journeys at release gates. Existing suite names do not establish
their fidelity; audit tests that hide integration or network work in unit suites.

Baseline: the measured `63315404a` cold/warm pair is recorded in
[project status](GITHUB_WORKFLOWS_STATUS.md). The user rejected 15 minutes and
requires the complete blocking PR gate in under five minutes, with two minutes
preferred; parallel optimization is authorized, with total runner work reported.
Step 2 records one cold and one warm
required run with fixed runner label, tool versions, CPU/concurrency, dependency
cache state, source revision, setup/build/test timings and total wall time. Derive
a low-latency budget from those observations and seek user agreement before
substantial coverage expansion. Compare each subsequent required run to that
stable accepted baseline; investigate material or cumulative growth within the
same step. Report routine checks over one minute. Do not reset the baseline each
change, hide growth with more parallelism, or weaken required gates.

Use targeted failing tests during repair, then the relevant combined gate once
at completion. Broad suites run on GH, not the user's workstation. Follow repo
typecheck/lint/format requirements for edits. Deep and packaging gates remain
explicitly required before publication, even if absent from routine CI.

## Steps

- [x] **1. Resolve feasibility and candidate interfaces.** Run plan S1 and S3
      within the approved phase bounds; verify zero-cost storage/transport and token
      event strategy before live probes. Define candidate SHA, independent fork
      version, upstream base, deterministic Android versionCode, artifact matrix and
      new signed metadata. Initial version is 0.1.0 with manual migration. Inspect native dependencies
      and exact ARM64 Android runtime proof. No new workflow-number identity source.
  - Needs: nothing; phase authorization for probes.
  - Proof: stable semver/Android-encoding boundary fixtures and explicit source/retry/rebase
    contracts (full coordinator fixtures in steps 7–10); one native
    representative proof per unknown lane, or a recorded blocker requiring
    explicit scope resolution. Free-only execution controls verified.
  - Ticks: G0; W1.
  - Evidence: [A1 native receipts and contracts](GITHUB_WORKFLOWS_STATUS.md);
    Windows requires the custom ARM64 binding and colocated DLL layout; hosted
    Android requires the pinned ashmem module and software-rendered container.
    Full candidate packages and lifecycle/upgrade checks remain G3.
  - Human: before probes, supply any unavailable billing/access evidence; after
    S1, preserve the selected 0.1.0/manual-migration route. Unsupported
    requirements pause affected work while independent investigation continues.

- [x] **2. Establish shared routine CI and its baseline.** Implement entrypoint,
      PR/dev triggers, least privilege, cancellation, stable aggregate checks and
      tested change routing. Reconcile workflow inventory tests with the new design.
      Measure S2 and remove avoidable duplicate installation/build/test work.
  - Needs: 1's zero-cost and event contracts; G0.
  - Proof: real PR and dev-push results at known SHAs; failed test fails aggregate;
    no secret required for fork PRs; cold/warm receipts and accepted ceiling.
  - Ticks: W2; contributes to G1.
  - Human: after baseline, accept numeric runtime ceiling or choose a scope
    tradeoff; this is not permission to silently remove correctness checks.

- [x] **3. Integrate rebase and preserve upstream sync.** Remove duplicated
      rebase validation commands in favor of step 2's direct shared entrypoint on
      the rebased tree. Retain Git-resolution regression tests in routine CI, key
      cleanup, metadata/signature rules, backup, atomic push and exact lease.
  - Needs: 2.
  - Proof: isolated Git fixture with a valid rebase but failing routine check
    leaves dev/backup unpublished; success publishes precisely the tested tree;
    branch movement fails closed. Sync contract still passes; bot-trigger
    suppression cannot omit required validation. No production rebase trial needed.
  - Ticks: G1; W3.

- [ ] **4. Implement bounded deep verification.** Select browser/Electron/native
      Android critical journeys and platform contracts. Use isolated daemon state,
      deterministic fixtures, assertions and bounded screenshots/traces. Make checks
      callable by SHA and prove routing with a safe test PR.
  - Needs: 1, 2; approved native proof strategy from G0.
  - Proof: positive journey assertions and intentional broken-fixture failure;
    headless runtime, cleanup and trace review; no live model API charges. Label
    emulator-only results explicitly; actual release-please event proof is step 8.
    Run the local relay E2EE journey with `FORCE_RELAY_E2E=1`; routine Node 26
    collection skips its three cases and does not establish relay runtime proof.
    Build the CLI and execute `packages/cli/src/commands/daemon/lifecycle.e2e.test.ts`
    explicitly; routine CLI units exclude E2E files.
    Verify installed provider executables report their versions; routine Claude
    version resolution uses a deterministic command fixture, not a machine installation.
  - Ticks: G2; W4.

- [ ] **5. Preserve Mac/Android candidate packages.** Adapt existing reusable
      lanes to the candidate interface. Preserve keys, production identities,
      monotonic codes, closure verification and fresh-store import. Phase A's
      approved amendment makes legacy packaging manual-only until step 9.
  - Needs: 1, 2; uses step 1 contract, not unimplemented step 7 behavior.
  - Proof: same-candidate closure and APK, independent digest/signature checks,
    clean import and actual shipped-ABI runtime/install evidence, plus disposable
    old-to-new upgrade/state-preservation checks. Verify a
    wrong key/version/source is rejected. Existing updater transition is step 7/11.
  - Ticks: W5 Mac/Android portion; contributes to G3.
  - Human: before signing, provision missing free manifest-key access if needed;
    secret names alone do not establish usable key material. Any unavoidable
    personal-device test waits for explicit user presence/authorization.

- [ ] **6. Add Linux/Windows packages and manual-upgrade checks.** Build native
      x64 and ARM64 Nix daemon/desktop, DEB/RPM/AppImage and NSIS. Exclude unselected
      tarball/ZIP outputs. Exercise actual installation or import, app launch,
      daemon/terminal operation, uninstall where applicable and state-preserving
      manual upgrade. Keep platform fixture setup small and reusable.
  - Needs: 1, 2 for implementation; 5 additionally for G3 closure. Not alongside
    5 when editing shared package configuration.
  - Proof: every required matrix cell passes on its native platform; package
    metadata, checksums and absent publisher signing match scope. No inferred
    success from cross-compilation alone. Combine with step 5 for G3.
  - Ticks: G3 after 5 and 6; W5 remainder.

- [ ] **7. Implement independent versioning and updater transition.** Apply
      step 1's settled interface and initial 0.1.0 version. Synchronize workspace,
      lockfile/native/new-manifest consumers. Preserve signing identities;
      gate new-client upgrades by fork semver and exclude the legacy lineage.
  - Needs: 1, 5, 6; complete candidate artifacts available for compatibility tests.
  - Proof: new updater fixtures reject tampering/downgrades and legacy-lineage
    confusion; rebase, deterministic Android encoding and manual-migration fixtures pass. Recovery
    retains usable previous release. Actual installed-device proof remains step 11.
  - Ticks: W6 migration portion; contributes to G4.

- [ ] **8. Configure release-please and verify its real PR event chain.** Add
      pinned action, manifest/config, fork changelog/bootstrap, bot permissions and
      PR identity detection. Keep public release creation disabled/gated. Test
      release PR updates, merge SHA recognition and two consecutive version proposals.
  - Needs: 2, 4, 7.
  - Proof: bot-created and updated PR triggers routine/deep checks; forged label
    cannot authorize signing; exact merge SHA chosen; upstream rebase doesn't
    reset fork version or replay whole changelog; no public release yet.
  - Ticks: G4; W6 remainder.
  - Human: before live event test, provide/install narrowly scoped bot access if
    unavailable; never print credentials. Phase approval includes test PR and
    draft-only scope, not user-facing publication.

- [ ] **9. Coordinate exact-candidate verification and packaging.** Wire routine,
      deep and package lanes to recognized merged release PRs; remove old redundant
      trigger. Await full matrix and metadata, bind all results to SHA/identity,
      handle retries/concurrency and prevent out-of-order feed regression.
      Replace Phase A's manual-only legacy trigger with candidate coordination;
      the temporary test-path exclusions were removed during Phase A.
  - Needs: 3, 4, 5, 6, 7, 8.
  - Proof: exact SHA flows end-to-end; ordinary dev pushes never publish or run
    release packaging inadvertently; partial candidates cannot pass aggregate;
    updated permissions admit intended trusted actor without weakening PR isolation.
  - Ticks: W7 implementation; contributes to G5.

- [ ] **10. Rehearse release failure and recovery.** Inject a missing/failed
      platform, wrong source digest/signature, partial upload and interrupted rerun;
      check competing candidate ordering and published-release immutability. Then
      run one all-green same-SHA draft-only rehearsal with download verification.
  - Needs: 9.
  - Proof: no failed/incomplete case becomes public; successful draft contains
    exact complete inventory; retries neither mix attempts nor allocate a
    replacement identity accidentally; free-only controls hold under failure.
  - Ticks: G5; W7 verification.

- [ ] **11. Publish first approved release and hand off operation.** Publish
      the reviewed candidate without rebuilding different bytes. Verify downloads
      and actual manual Mac/Android migration, state preservation and recovery. Document
      release retries, branch-rebase interactions, version overrides, manual package
      upgrades, cost controls and routine baseline. Remove only owned abandoned
      drafts/probes; preserve releases, installed state and historical recovery assets.
  - Needs: 10, G0–G5.
  - Proof: complete GH release, all matrix receipts, device migration/recovery
    evidence, measured zero-cost/latency checks and user acceptance of G6.
  - Ticks: G6; W8.
  - Human: at phase approval select candidate/publication authority; mid-step
    approve and attend personal-device update/restart/recovery; after proof
    accept final gate. Independent runbook work continues while devices wait.

## Coverage and dependencies

W1 → 1; W2 → 2; W3 → 3; W4 → 4; W5 → 5/6; W6 → 7/8;
W7 → 9/10; W8 → 11. Every plan gate has an explicit proof above. Needs are acyclic;
numerical ordering is a convenient serial execution order, not an implicit dependency.
Later implementation details remain provisional until step 1; revise all tiers
when evidence changes a contract. Stretch Windows/AppImage updates are excluded.

## Human interventions

| Point              | Kind                   | User action                                                                   | Boundary                                                          |
| ------------------ | ---------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Each script thread | Approval               | Approve its bounded chunks and live operations                                | Before execution; planning confirmation is not execution approval |
| Step 1             | Access/decision        | Supply unavailable zero-cost evidence; initial 0.1.0/manual migration settled | Before affected live probes/implementation                        |
| Step 2             | Decision               | Accept measured runtime ceiling                                               | Before suite expansion                                            |
| Steps 5/8          | Access                 | Provision missing signing/bot access, using existing free identities          | Before signing or bot event rehearsal                             |
| Steps 5/11         | Presence               | Device installation/update/restart if required for native proof               | At named test; no surprise disruption                             |
| Step 11            | Publication/acceptance | Select first real candidate, authorize publication, accept final gate         | Before publication and after delivery proof                       |

No paid operation is offered as an automatic fallback. A requirement that cannot
be met for free returns as a feasibility finding and scope decision.
