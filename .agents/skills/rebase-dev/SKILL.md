---
name: rebase-dev
description: Plan, prepare, rehearse, execute or verify an upstream rebase of iExalt/paseo dev. Use for fork upstream rebases and rebase-dev workflow operations; production publication requires a separate user go.
---

# Rebase fork dev

Run the requested stage: **plan**, **prepare**, **dry run**, **execute**, or **verify**.
One agent can run them all; a new worker can start at any stage from the evidence
record. Read [the engine contract](../../../docs/upstream/rebase-dev.md),
`.github/scripts/rebase-dev.mjs` and both `rebase-dev.yml` and `upstream-sync.yml`
workflows at the captured dev revision. Resolve paths from the repository root.
Use a disposable dev instance for rehearsal and checks. Keep one evidence record
outside the checkout with the frozen inputs, approvals, commands, results and next
stage. Record each SHA in full.

A request to prepare or rehearse does not authorize production publication. Never
push dev directly, move backup refs, publish a release, or merge a release PR as
part of this skill. Stop after two failed attempts at the same outcome and walk
the whole procedure and its dependencies before another attempt. Report a refused
action and continue independent work; never change routes to bypass it.

## Plan

Entry: the repository and proposed upstream target are known. Read the previous
rebase's evidence and open follow-ups. Inventory incoming commits and fork
supersession decisions. Check upstream main for fixes newer than the target,
especially fixes for failures found during the last rehearsal. Record whether
each relevant fix is already included, needs a reviewed backport, or changes the
target decision. A moving upstream main is discovery input, never the target.

Record the scope, active-time cap, review/check ownership, approvals for pausing
sync, pinning the mirror and updating resolutions, and the production go gate.
A plan-only request stops before changing workflow state unless those operations
are separately authorized. Check active upstream-sync and rebase-dev runs before changing workflow state.
Pause upstream-sync with `gh workflow disable upstream-sync.yml -R iExalt/paseo`
and read back `disabled_manually`. Disabling the workflow also disables manual
dispatch: to pin by its authorized `ref` input, dispatch once while enabled, then
pause it immediately and wait for that run to finish. Never cancel another run.
Read back `refs/heads/upstream/main`; require the exact chosen target. If the
mirror has passed it, stop for a separately authorized rewind or target change.

Exit: the target and scope are settled, sync is paused, and the mirror is pinned.
Hand off the sync's original state, run ID and readbacks with the evidence path.

## Prepare

Entry: the plan's approvals and mirror pin still hold. Freeze remote dev, mirror
and rebase-resolutions with `git ls-remote origin` and record all three SHAs,
including the old resolutions SHA for rollback. Require no active sync/rebase
run. A later stage must reject changed inputs instead of silently refreshing them.
Pausing sync freezes only the mirror; other approved work can still advance dev.
Dry runs need no writer hold. Review and replay a changed input before re-freezing it.

Run preflight from a clean checkout whose effective origin fetch and single push URL
point at GitHub iExalt/paseo, before switching rehearsal to a frozen local origin.
In the instance's exact shell/tool environment, run:

```sh
mise exec -- node .github/scripts/rebase-preflight.mjs "$UPSTREAM_SHA" "$DEV_SHA" "$RESOLUTIONS_SHA"
```

It reports all environment problems together: GitHub origin binding, paused/idle workflows, mirror pin,
Git, signing, GitHub auth, candidate push, clean tree, Mise nounset startup, Node
and npm pins. Run it from a clean committed checkout; keep logs outside it. Fix
all reported problems before a hosted validation. A signed throwaway commit must
show `G cman101202@gmail.com` in that environment. Keep signing and hooks enabled.

Use Git 2.55 or newer and install declared tools/dependencies. If platform proofs
are in scope, resolve Playwright from the selected runner package and check OS
support; on Linux run `ldd` on Electron and its bundled libraries before launch.
Those checks are conditional on the requested proof, not extra platform scope.
Inspect test scripts before adding file arguments: an existing `src` selector
still runs the whole tree. Use an invocation with only the intended test paths.

Exit: frozen SHAs, preflight JSON, tool versions and evidence path are recorded.

## Dry run

Entry: prepare passed for the same frozen inputs. Make a fresh isolated clone;
fetch only those inputs and the release-boundary tags needed by the engine.
Point its origin at an isolated bare repository holding the frozen branch refs
so `rebaseDev()` snapshots the approved inputs. Do not reuse a checkout's rr-cache.
Use the captured dev engine, reviewed rerere pairs and exact-stage deletion
records described in the engine contract. Run `rebaseDev()` with diagnostics and
a deadline; record stops and the count of conflicted paths. The instance signing
key can differ from production: pass its public key explicitly for local replay
and label the result as instance-signed. Never copy private keys into evidence.

Before the first shared-system or expensive attempt, walk the whole path: check
real tools, resources, permissions, mutable inputs, leftover files and final-only
gates. Record any human or device dependency and fix blockers together.

Unknown conflicts stop unattended replay. Review every manual resolution and
supersession with the reviewer, complete rehearsal, then export the completed
rerere pairs into a separate rebase-resolutions checkout. Review deletion records
and target-specific fixups separately. Sweep callers and mocks of every adapted
interface, including tests that import the changed operation indirectly; checking
only its matching test filename can miss a stale module mock. Inspect each complete resolved blob and
net deletions, including bytes outside conflict markers; a helper can silently
truncate an unchanged suffix. Prove exported resolutions with a fresh unattended
replay against the reviewed source tree. Include nontextual breaks: new upstream
docs, inherited workflows, toolchain changes and generated output paths. The
routine workflow's filename inventory rejects temporary workflow files; use the
existing validate-only dispatch instead of adding a proof workflow.

If updates are authorized, publish only the accepted resolution diff as a normal
signed descendant of the frozen resolutions SHA. Read back its SHA and tree.
Retain the old SHA for a separately approved rollback. Update the frozen resolutions
SHA to the accepted pushed commit, then rerun preflight on that intentional new tuple. Run validate-only once even when resolutions did not change, and after **every**
resolutions change:

```sh
gh workflow run rebase-dev.yml -R iExalt/paseo --ref dev -f validate_only=true
```

Compare remote dev, mirror and resolutions with the frozen tuple immediately before
dispatch. After every run, verify the captured tuple in its summary or logs, even
when the run is green. A mismatch is an input change, not a failed validate-only
attempt: review and replay the delta, re-freeze, then redispatch. Missing capture
evidence leaves the gate unverified. Before the stdout capture change is on dev,
use the repository activity API for any SHA available only in the job summary:
`gh api --paginate 'repos/iExalt/paseo/activity?ref=refs/heads/rebase-resolutions&per_page=100'`.
Read every page covering the full run interval. Require the last push before the
run to end at the frozen SHA and no ref change through completion. Preserve the
activity response and interval as the binding evidence; current refs alone do not
prove the captured input. Capture the run ID and its starting SHAs. Require the rebase job and actual
validation step to run successfully with a tested SHA; skipped jobs do not pass. Watch with a deadline and stop on first
failure. Require the actual `validateRebase()` entry point: it runs routine checks
and asserts the exact tested tree stays clean afterward. Running only the checks
misses generated `.artifacts/diff-subscription/` files. Do not ignore a new dirty
path globally; identify its writer and fix the owning rule or producer. Check
newer upstream fixes before treating a failed test as an unexplained flake.

Reassess scope and forecast after the first validate-only result. Two failed
validate-only attempts require a whole-procedure dependency walk before a third.
A green run proves production signing, replay and validation. It does not exercise
the publication App token or atomic push permissions; those remain a known
production-only gap. Unpublished commits also have no GitHub verification
records; verify those after publication. Report any additional production-only
gap immediately.

Exit: reviewer-accepted resolutions, a clean replay ref/tree, and green
validate-only on the exact frozen dev/target/resolutions. Record platform proofs
separately; this gate does not establish app behavior on every platform. Stop here
unless the user explicitly authorizes production publication.

## Execute

Entry: the user gave a production go naming this repository and target, decided
production writer coordination separately, and dry run passed. Read back dev, mirror, resolutions, sync state and active runs. Require
the same inputs as the accepted validate-only run. Any movement invalidates this
gate. Record the user's go and exact dispatch command before running it.

Dispatch `rebase-dev.yml` on `dev` with `validate_only=false` only under that go.
Record the run ID, attempt, captured refs, tested SHA and resulting backup ref.
Use a bounded fail-fast watcher; a failure is not permission to rerun. Never
repair publication by directly pushing dev or moving its backup.

Exit: the workflow published atomically and its backup names the frozen dev.
Pass the published SHA, backup ref, clean replay SHA and evidence path to verify.

## Verify

Entry: execute passed, or immutable historical publication inputs are supplied.
The verifier reads immutable SHAs and checks the backup remotely; historical
verification does not require the current dev tip to equal an older publication.
Run from a clone with origin pointing at iExalt/paseo:

```sh
mise exec -- node .github/scripts/rebase-verify.mjs \
  "$BACKUP_REF" "$PUBLISHED_SHA" "$CLEAN_REPLAY_SHA"
```

It compares the ordered commit chains and each intermediate tree, binds the
release boundary to the original backup history, permits only the final
`last-release-sha` byte substitution, verifies signatures with the pinned
production key, and checks the corresponding GitHub verification records. Keep
its JSON output. Any mismatch stops adoption; preserve refs and diagnostics and
report the exact mismatch. Restoring dev is a separate authorized operation.

For a live publication, also read back dev at the published SHA. After a successful
verification, re-enable upstream-sync with `gh workflow enable upstream-sync.yml
-R iExalt/paseo` and read back `active`. A bounded dry run that never publishes
also re-enables sync on completion or abort after saving its frozen inputs; later
execution must repin and revalidate if the mirror moved. A failed production
verification leaves sync paused until the recovery owner decides how to proceed.
Record which rule applied. Never dispatch an unpinned sync as cleanup.

Carry the ledger forward after every publication: sweep every subject/patch-ID
key in `docs/upstream-rebase-inventory.json` against the published history and
refresh its owning documentation through a reviewed PR. Preparation runs the
engine replayPlan ledger check before rehearsal so stale records fail locally.

Exit: verifier output, live ref readback when applicable, restored sync state,
remaining limits and cleanup are in the evidence record.
