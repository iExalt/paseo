# Rebasing fork `dev` onto the upstream mirror

The `Rebase dev onto upstream mirror` workflow is a manual recovery tool for the `iExalt/paseo` fork. Dispatch it from `dev` as `iExalt`. It snapshots `dev`, `upstream/main`, and `rebase-resolutions` once at run start, rebases the captured `dev` tip onto the captured mirror tip, validates the result, then, by default, atomically creates a backup ref and updates `dev` with an exact force-with-lease. The backup is named `backup/rebase-dev/<run-id>-<attempt>` and points to the captured pre-rebase `dev` SHA.

Set the boolean dispatch input `validate_only` to `true` to run the same capture, replay, production-key signing, generated release-config commits, and full routine validation, including the final clean-tree assertion, without publishing. This mode never requests the write-capable App token, pushes, or updates remote refs. The job retains its read-only `contents` permission. Both modes report the captured inputs and original-to-signed replay mapping in the job summary; only successful validation adds the tested SHA and tree. `validate_only` defaults to `false`.

The workflow does not publish a partial rebase. Unknown conflicts, newly empty commits, partial supersession decisions, ledger key mismatches, failed tests, branch movement, a missing ref, or a failed atomic push stop the run. A failed run writes its starting SHAs and Git status to the bounded step summary. Reused `rerere` resolutions can still leave the rebase paused; the workflow continues only a merge-backend conflict stop where Git's C-locale output explicitly reports that it staged a previous resolution, the index has no unmerged entries, and the rebase makes progress. When a reused resolution settles on upstream's side, because upstream already made the change, the pick replays as an empty commit with its original author and message so retained commits still replay one-to-one. A pick that becomes empty without a conflict still stops. All other stops require a new manual resolution.

Every retained curated commit keeps its original author name, email address, timestamp and timezone, and exact message bytes. The workflow rebuilds the commits with their rebased trees and parents, signs each one with the dedicated SSH key in `PASEO_REBASE_SSH_SIGNING_KEY`, and verifies each signature against the pinned public key before tests or publication. The temporary private-key file is removed before dependency installation.

GitHub marks a signed commit verified only when its committer email is a verified email of the account that registered the key, so the committer decides what the replay may keep. `SIGNING_EMAILS` in `.github/scripts/rebase-dev.mjs` lists those emails, and a committer with one of them is kept exactly. A GitHub web merge commits as `GitHub <noreply@github.com>` under GitHub's own signature, which no replay can keep; its committer becomes the signing identity (`SIGNING_NAME` and `SIGNING_EMAIL`) at the original timestamp. Any other committer email stops the run. Add an email to `SIGNING_EMAILS` only after verifying it on the same GitHub account.

Like `git rebase`, the replay drops merge commits and replays the rest in topological order. A merge is accepted only when its tree is exactly Git's automatic merge of its two parents, so dropping it loses nothing; a merge with conflict resolutions or other hand edits stops the run, and you must linearize that history by hand. Apart from the reviewed ledger drops below, retained curated commits replay one-to-one. Replays fail closed if that mapping changes or metadata cannot be represented exactly.

After the replay the run may add up to three signed commits of its own: `chore(rebase): adapt incorporated upstream to the fork` applies a reviewed fixup patch (below), `chore(rebase): capture incorporated upstream` records the new upstream base in `.github/fork-release.json`, and `chore(rebase): point release-please at the rebased release` records the rewritten release commit for release-please.

## Pin publication to the reviewed target

`upstream-sync` defaults to the latest `getpaseo/paseo:main`. Its optional `ref` input resolves an upstream ref or SHA once, verifies that commit belongs to captured upstream main, then fast-forwards the mirror to that exact SHA. It refuses backwards or divergent movement; it cannot rewind a mirror that has already passed your target.

For the reviewed target `c1d7d56b71960bca17ce86f8d358445b6135b809`, dispatch `upstream-sync` on `dev` with `ref` set to that SHA. Check `origin/upstream/main` equals it, then dispatch `rebase-dev` with `validate_only: true` as the pre-publication gate. After it passes, dispatch with `validate_only: false` to publish. Both runs capture current refs independently; compare their captured inputs, since the second run does not publish the first run's objects. Confirm the rebase run's captured upstream equals the reviewed target. A scheduled sync can advance the mirror between those operations; if it does, stop and prepare reviewed receipts, resolutions and a fixup for the new captured target before publication. Never rename an old patch to a newer SHA.

## Carry supersession decisions forward

The run reads version 2 of `docs/upstream-rebase-inventory.json` from captured `dev`, before changing the worktree. Each `fork` row identifies a curated commit by its exact subject and stable binary patch ID; `sha` is a hint for detecting stale decisions. The same patch under a rewritten SHA still matches. A known subject or SHA with a different key stops for review. New commits absent from the ledger retain the default one-to-one replay. A branch without a ledger also retains that default; an unsupported or malformed ledger stops.

The ledger's `refs.target` must be an ancestor of captured upstream. An exact `fully superseded` or `empty/history-only` match is dropped and recorded with its current SHA, identity, category and reason in diagnostics and the command result. A `partially superseded` match retains one-to-one replay only with a `review_receipt` containing `upstream` equal to the exact captured upstream SHA, `patch_id` equal to the computed commit patch ID, `decision: "retain"`, and a nonempty immutable `evidence` reference to the reviewed replay. Missing or mismatched receipts stop before replay with the row's reasons. A receipt authorizes replay of the reviewed partial outcome; it does not establish passing integration or platform checks. A newer upstream requires new review and receipts, even when it contains the earlier target. Duplicate or ambiguous identities stop. A tagged or configured release boundary cannot be dropped. Resolve partial entries in a reviewed change before retrying; do not relabel mixed commits as fully superseded to get past the gate.

When curating history again, aggregate direct constituents and contributors to shared-file hunks: all fully superseded becomes fully superseded; all empty/history-only becomes empty/history-only; any partial or mixed categories becomes partially superseded; otherwise keep. Carry the source reasons and retained outcomes. Recompute identities after a reviewed patch changes. Keep old provenance reachable through the archived history rather than copying the old SHA mapping into each ledger row. [The current ledger](../DEV_UPSTREAM_SUPERSESSION.md) records the curated capture and evidence limits.

## Resolution branch format

The `rebase-resolutions` branch may start with only `schema.json`; that is a valid empty cache, and unknown conflicts still stop with diagnostics. The file must contain these exact UTF-8 bytes:

```text
{"version":1,"format":"git-rerere-cache-v1"}
```

Completed Git `rerere` records live under `resolutions/<40-character-lowercase-hex-id>/`. Commit only regular files named `preimage` and `postimage`, plus complete matching numbered variants such as `preimage.1` and `postimage.1`. Do not commit `thisimage`, `preimage.N` without its matching `postimage.N`, symlinks, executable files, or other files. The importer validates Git tree modes, paths, schema, and pairs before copying blobs into the fresh checkout's `.git/rr-cache`; paths from the branch are never used directly as filesystem paths.

Upstream code can break the fork with no textual conflict, for example a new upstream file written for an older toolchain than the fork pins. Fix those breaks in the optional regular file `fixups/<captured-upstream-sha>.patch`: a patch over the replayed tree that `git apply --index` must apply exactly. The run applies only the patch named for the captured upstream, after the replay and before validation; a patch that does not apply stops the run. The fork release check (versions and the lockfile's workspace entries) runs after the patch, so the patch can also bring `package-lock.json` up to date with a `package.json` both sides changed. Build it from the reproduction checkout below after the rebase finishes: make the fixes, check them with the routine checks, and save `git diff --no-ext-diff --binary HEAD`. A mirror sync to a newer upstream needs a new patch.

Docs are the same kind of silent break. The fork moved upstream's `docs/*.md` into `docs/upstream/` once, so a doc upstream adds later replays at the top of `docs/`, where fork docs live, and an upstream edit to a moved doc can carry a link written for `docs/` (such as `../public-docs/`). The run stops when the rebased tree adds a top-level `docs/*.md` file or a relative link in `docs/**` or `CLAUDE.md` that `dev` did not already have dead. In the fixup, `git mv` each new doc to `docs/upstream/`, fix its links and the links pointing at it, and add it to the `CLAUDE.md` docs table. When you prepare a rebase by hand, check the same two things: `git diff --name-status --diff-filter=A <old upstream> <new upstream> -- docs/` lists the docs upstream added.

Git `rerere` cannot record rename/delete or modify/delete resolutions. For a reviewed deletion, the optional regular file `deletions.json` holds an array of records with `upstream` (captured upstream SHA), `commit` (original `REBASE_HEAD` SHA), `path`, and `stages`. Capture `stages` from `git ls-files -u -- <path>` before resolving: each entry contains the exact `mode`, `oid`, and numeric `stage`. Only mode `100644` is accepted. A modify/delete conflict leaves stage 1 and exactly one of stages 2 or 3, and the record deletes that path. A rename/rename conflict leaves each name at a single stage: record the base and the losing name for deletion, and the winning name with `"action": "keep"`, which stages its exact blob. Keep accepts only a single stage 2 or 3 entry. Replay requires both captured commits and every index entry to match exactly; a changed conflict stops for manual review. A commit whose only changes were to deleted paths replays as an empty commit with its author and message, so retained commits still map commit for commit. These records are reviewed separately from the rerere exporter, which leaves existing deletion records intact.

To add a record, reproduce the conflict locally from the run's captured starting SHAs, resolve it manually, and complete that rebase. Run the exporter below into the separate resolution-branch checkout, review the added files, then commit and push that branch. After every change to the resolution snapshot (rerere pairs, deletion records, or fixups), run the workflow from current `dev` with `validate_only: true` before a publishing run. If a record is adapted to changed context, native Git `rerere` decides whether the result applies; the workflow does not overwrite that result with a saved postimage.

For an exact reproduction, copy the three SHAs from the failed run's step summary and use an isolated clone. Use git 2.55 or later, as the runners do: Apple Git 2.54 stops at the first pick that reuses a resolution with `Unable to create '.git/MERGE_RR.lock': File exists`, and `rebaseDev()` refuses older versions.

```sh
git clone https://github.com/iExalt/paseo.git paseo-repro
cd paseo-repro
git fetch origin "$DEV_SHA"
git fetch origin "$UPSTREAM_SHA"
git fetch origin "$RESOLUTIONS_SHA"
git checkout --detach "$DEV_SHA"
mise exec -- node .github/scripts/rebase-dev.mjs import "$RESOLUTIONS_SHA"
git -c rerere.enabled=true -c rerere.autoupdate=true rebase --merge --keep-empty --reapply-cherry-picks --empty=stop "$UPSTREAM_SHA"
```

Resolve each conflict by hand, stage only the resolved paths with `git add -- <resolved-paths>`, record the completed resolution with `git rerere`, and finish with `git -c core.editor=true rebase --continue`. Then create or clone a separate checkout of `rebase-resolutions`, checked out on that branch, and run the exporter from the reproduction checkout:

```sh
git clone --branch rebase-resolutions https://github.com/iExalt/paseo.git ../paseo-resolutions
mise exec -- node .github/scripts/rebase-dev.mjs export ../paseo-resolutions
git -C ../paseo-resolutions add schema.json resolutions
git -C ../paseo-resolutions commit -m "chore: add rebase rerere resolution"
git -C ../paseo-resolutions push origin HEAD:refs/heads/rebase-resolutions
```

The exporter creates the schema when needed and writes only complete regular-file pairs. It ignores `thisimage` and incomplete active records, rejects symlinked completed variants, and refuses to overwrite different content in the destination. Review the exported diff before committing. After the resolution branch update, run the validate-only gate from current `dev` before a publishing run.

## Validate rewritten history

Validation runs `mise run --skip-tools ci:routine` against the exact rebased tree. The workflow installs locked dependencies once, checks that the worktree stays clean, and binds publication to the tested SHA. The routine budget is under 300 seconds excluding the initial queue and including job scheduling; compare the same lanes, runner and cache conditions with the [captured baseline](../DEV_UPSTREAM_SUPERSESSION.md#reproduction-and-evidence-boundary). The workflow's 45-minute job limit is separate from that budget. A failure writes starting refs and bounded diagnostics to the step summary.

Use validate-only as the recommended gate after changing a resolution snapshot. A draft PR checks its merge tree; it does not exercise production signing, the generated release boundary, or the final clean-tree assertion in this workflow. A passing validate-only run permits a separate publishing run after you confirm its captured inputs still match the reviewed target.

The atomic Git push uses an `iexalt-paseo-sync` App token minted after validation only when `validate_only` is false, because `GITHUB_TOKEN` cannot push commits that change workflow files. If the platform rejects the push, the run reports that failure and leaves the backup/dev refs unchanged because the update is atomic.
