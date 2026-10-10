# Rebasing fork `dev` onto the upstream mirror

The `Rebase dev onto upstream mirror` workflow is a manual recovery tool for the `iExalt/paseo` fork. Dispatch it from `dev` as `iExalt`. It snapshots `dev`, `upstream/main`, and `rebase-resolutions` once at run start, rebases the captured `dev` tip onto the captured mirror tip, validates the result, then atomically creates a backup ref and updates `dev` with an exact force-with-lease. The backup is named `backup/rebase-dev/<run-id>-<attempt>` and points to the captured pre-rebase `dev` SHA.

The workflow does not publish a partial rebase. Unknown conflicts, newly empty commits, failed tests, branch movement, a missing ref, or a failed atomic push stop the run. A failed run uploads its starting SHAs and Git status as an artifact. Reused `rerere` resolutions can still leave the rebase paused; the workflow continues only a merge-backend conflict stop where Git's C-locale output explicitly reports that it staged a previous resolution, the index has no unmerged entries, and the rebase makes progress. All other stops require a new manual resolution.

Every replayed commit keeps its original author and committer names, email addresses, timestamps and timezones, and exact message bytes. The workflow rebuilds the commits with their rebased trees and parents, signs each one with the dedicated SSH key in `PASEO_REBASE_SSH_SIGNING_KEY`, and verifies each signature against the pinned public key before tests or publication. The temporary private-key file is removed before dependency installation. Replays fail closed if history contains merges, commit mapping changes, metadata cannot be represented exactly, or a committer email is not the verified `clliaw@nvidia.com` account. GitHub has accepted this registered signing key for commits with that committer email.

## Resolution branch format

The `rebase-resolutions` branch may start with only `schema.json`; that is a valid empty cache, and unknown conflicts still stop with diagnostics. The file must contain these exact UTF-8 bytes:

```text
{"version":1,"format":"git-rerere-cache-v1"}
```

Completed Git `rerere` records live under `resolutions/<40-character-lowercase-hex-id>/`. Commit only regular files named `preimage` and `postimage`, plus complete matching numbered variants such as `preimage.1` and `postimage.1`. Do not commit `thisimage`, `preimage.N` without its matching `postimage.N`, symlinks, executable files, or other files. The importer validates Git tree modes, paths, schema, and pairs before copying blobs into the fresh checkout's `.git/rr-cache`; paths from the branch are never used directly as filesystem paths.

To add a record, reproduce the conflict locally from the run's captured starting SHAs, resolve it manually, and complete that rebase. Run the exporter below into the separate resolution-branch checkout, review the added files, then commit and push that branch. Retry the workflow from current `dev`. If a record is adapted to changed context, native Git `rerere` decides whether the result applies; the workflow does not overwrite that result with a saved postimage.

For an exact reproduction, copy the three SHAs from the failed-run artifact and use an isolated clone:

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

The exporter creates the schema when needed and writes only complete regular-file pairs. It ignores `thisimage` and incomplete active records, rejects symlinked completed variants, and refuses to overwrite different content in the destination. Review the exported diff before committing. Retry the workflow from current `dev` after the resolution branch update.

Validation uses the retained Git fixture tests, the existing upstream-sync workflow contract test, package typechecking, and the protocol workspace tests. The workflow uses the repository's `GITHUB_TOKEN` for its atomic Git push; actual token publication and branch-protection behavior have not been live-tested. If the platform rejects the push, the run reports that failure and leaves the backup/dev refs unchanged because the update is atomic.
