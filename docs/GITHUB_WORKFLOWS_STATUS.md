# GitHub workflows

How the fork's CI and releases work today and what to do when they fail. The
fork has one user, so releases are "builds plus smoke": macOS Nix closure and
Android APK, smoke-tested, signed and published. There is no attestation,
candidate authority, Windows/Linux packaging or upgrade testing. The retired
candidate pipeline and the campaign that built it live in git history (before
`ci: delete the retired release candidate pipeline`) and in
[complete-campaigns](complete-campaigns/GITHUB_WORKFLOWS_PLAN.md).

CI stays free: hosted runners only, no paid services. Blocking PR CI must finish
in under five minutes.

## Workflows

| Workflow             | Trigger                                           | What it does                                                                                                                    |
| -------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`             | Every PR and `dev` push                           | Plans lanes from `.github/ci-paths.json`, runs `mise run ci:routine` per lane, then the `Routine CI required` gate              |
| `ci-deep.yml`        | Release PRs (labeled/synchronize), owner dispatch | Browser, integration and Electron journeys at the exact release PR head                                                         |
| `release-please.yml` | `dev` push, owner dispatch                        | Opens or refreshes the one release PR (`chore(dev): release X`); publishes nothing                                              |
| `release.yml`        | Owner dispatch on `dev`                           | Builds, smoke-tests, signs and publishes the macOS closure and Android APK                                                      |
| `rebase-dev.yml`     | Owner dispatch                                    | Rebases `dev` onto the `upstream/main` mirror, runs routine CI on the result, then pushes a backup and the new `dev` atomically |
| `upstream-sync.yml`  | Daily 07:23 UTC, dispatch                         | Fast-forwards the `upstream/main` mirror branch                                                                                 |

Routine CI details live in `.github/scripts/ci-routine.mjs`: lanes `quality`,
`workspaces`, `app-1..2`, `server-1..3` and `integration`. App unit shards run
three Vitest workers, the other units four. The `required` job also enforces
the five-minute latency budget from the `plan` job's start. Because that budget
covers the whole attempt, use **Re-run all jobs**, not "Re-run failed jobs",
when a lane flakes: a partial rerun keeps the old `plan` start time and fails
the latency gate.

Dev pushes refresh the installed dependency cache (`install-cache`); PR lanes
only restore it.

## Release procedure

1. Merge conventional commits into `dev`. With `PASEO_RELEASE_PROPOSALS_ENABLED`
   set, `release-please.yml` keeps one bot-authored release PR current.
   Deep CI runs on it.
2. Merge the release PR. Merging publishes nothing.
3. **Immediately** dispatch `release.yml` on `dev` with `publish=true`. It must
   run while `dev`'s head is the release commit: the `resolve` job refuses any
   HEAD whose subject is not `chore(dev): release X` (or
   `chore(dev): replace pending release X`), and dispatch only targets the
   branch head. If something lands on `dev` first, recover as below. Starting
   the run from the merge is a TODO.
4. The run builds both artifacts, smoke-tests the closure on a fresh macOS
   runner, signs the APK and the manifest, uploads everything to a draft,
   re-downloads and re-hashes each asset, then publishes the draft as latest
   and tags `paseo-vX` at the release commit.

**Dry run:** dispatch with `publish=false` (the default) from any `dev` commit.
It uploads all five assets to a draft tagged `paseo-dryrun-<run_id>`, never
tags and never marks latest. Delete the draft when done.

While a merged version is unpublished, `release-please.yml` proposes nothing
and logs "Merged version X awaits publication".

### When the release commit cannot ship

If the release commit fails to build, or `dev` moved before you dispatched,
land one non-empty commit on `dev` (the fix, or any small change) whose subject
is exactly `chore(dev): replace pending release X`, then dispatch `release.yml`
with `publish=true` while it is the head. The subject must stay unique on
`dev`. Release and boundary both accept it (`paseo-v0.1.1` shipped that way).
There is no tooling for this; the old replacement record only served the
candidate pipeline.

## Recovery

- **Publish job failed before publishing:** the draft is deleted. Rerun the
  workflow, or dispatch again; the same version is fine because no tag exists.
- **Publish step failed after the PATCH** (tag or latest check): the release is
  public. Check on GitHub that `paseo-vX` points at the release commit and that
  the release is marked **Latest**; fix the flag by hand if not. Do not rerun,
  since the tag now exists and `resolve` will refuse.
- **Dry-run drafts** are never cleaned up automatically.

## Secrets and variables

| Name                                                                        | Used by                                           |
| --------------------------------------------------------------------------- | ------------------------------------------------- |
| `PASEO_NIX_RELEASE_SIGNING_KEY`                                             | `release.yml` `macos-build`: signs the closure    |
| `PASEO_FORK_GOOGLE_SERVICES_JSON`                                           | `release.yml` `android-build`: Firebase config    |
| `PASEO_FORK_SIGNING_KEY_PKCS8_PEM`, `PASEO_FORK_SIGNING_CERT_PEM`           | `release.yml` `android-sign`: APK signer          |
| `PASEO_RELEASE_MANIFEST_PRIVATE_KEY`                                        | `release.yml` `publish`: signs the manifest       |
| `PASEO_RELEASE_APP_PRIVATE_KEY`                                             | `release-please.yml`: mints the release bot token |
| `PASEO_REBASE_SSH_SIGNING_KEY`                                              | `rebase-dev.yml`: signs rebased commits           |
| Variables `PASEO_RELEASE_APP_ID`, `_APP_CLIENT_ID`, `_BOT_ID`, `_BOT_LOGIN` | `release-please.yml`, `ci-deep.yml` bot identity  |
| Variable `PASEO_RELEASE_PROPOSALS_ENABLED`                                  | `release-please.yml` push trigger                 |

Each secret is scoped to the one job that needs it (`scripts/ci-workflow.test.mjs`
pins this for `release.yml`). `PASEO_CANDIDATE_NATIVE_ENABLED` is no longer read.

## Release manifest

`paseo-release-manifest.json` plus its Ed25519 `.sig` are what the in-app
updaters trust. Schema 3 (`packages/protocol/src/release-manifest-v2.ts`)
carries exactly two cells, `macos/arm64/nix-desktop` and `android/arm64/apk`,
with the version, source SHA, upstream base and release tag. Clients also
accept schema 2, the 14-cell manifest releases before 0.2.0 used. Clients
older than 0.2.0 reject schema 3: install 0.2.0 by hand once (sideload the APK;
run `scripts/paseo-nix-update.mjs` from a checkout on macOS). Until then an old
Android client reports "No signed published Paseo fork release could be
verified". `.github/fork-release.json` holds the version and upstream
base that `release.yml` reads.

## Release boundary

release-please needs the last release commit, but `rebase-dev` rewrites `dev`,
so the published tag may name a commit that is no longer on `dev`.
`scripts/release-boundary.mjs` derives it on every proposal:

1. Take the newest published, non-prerelease `paseo-v<semver>` release and
   verify its signed manifest; the tag must name the manifest's source SHA.
2. The tag commit's subject must be a release subject (see above).
3. Exactly one commit on `dev` may carry that subject. If the tag commit is not
   on `dev`, the match must have the same full message and the same stable
   patch-id as the tag commit.
4. That commit's `.github/fork-release.json` and `.release-please-manifest.json`
   must name the released version.

Any mismatch fails closed and release-please proposes nothing. There is no
override. Typical causes and fixes:

- **Subject not unique on `dev`** (a revert, cherry-pick or second commit reused
  `chore(dev): release X`): reword or drop the duplicate in `dev`'s history.
- **A rebase changed or dropped the release commit** (conflict resolution
  touched a version line, or the commit was squashed): restore the original
  release commit's message and patch in `dev`'s history.
- **Tag missing or moved:** re-tag `paseo-vX` at the manifest's signed source
  SHA. Re-tagging anywhere else cannot pass step 1.

## Caches

- **Android build cache:** `release.yml` restores and saves ccache plus the
  Gradle build cache with plain `actions/cache` under
  `paseo-android-release-v1-`. Only release runs save it, so after seven idle
  days GitHub evicts it and the next release builds cold (accepted). The
  entries carry no provenance: any job running on `refs/heads/dev` can save
  under that prefix, and their objects feed the signed APK. Accepted for a
  one-user audience.
- **Gradle dependency cache:** `release.yml` only restores the
  `setup-java-Linux-x64-gradle-*` entry. No job saves it any more, so it misses
  once the old entry expires (accepted).
- **Routine dependency cache:** `routine-modules-v1-*`, one rolling entry
  written by `dev` pushes.

## Toolchain

Node is 26.11.1 and npm 11.20.0 everywhere: workflows, `.tool-versions` and
the Nix packages. Nix takes `nodejs_26` from the pinned nixpkgs, which cache.nixos.org
serves, so there is no seed release; `release-mac.sh` fails if the build would
compile Node from source. When nixpkgs moves Node, bump every pin together.
