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
   Deep CI runs on it. The version follows the commits: a `feat` bumps the
   minor. A `Release-As: X.Y.Z` footer in a conventional commit on `dev` sets
   the version of every proposal until a release containing that commit is
   published; a newer footer overrides it. Rebase-merge it, since the footer
   must be in the commit message.
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
   - The closure tar is a zstd-compressed `file://` binary cache. The
     installing host's own `nix` decompresses it, so the device's Nix must
     read `.nar.zst`; the client's tar extractor ignores the format.
   - The smoke installs only `playwright`, `@electron/asar` and `ws` at their
     lockfile versions (`release-mac-smoke-deps.mjs`). Its built-in plugin
     check uses the client and server builds packed in the closure's own
     `app.asar`, so the job builds nothing.

**Dry run:** dispatch with `publish=false` (the default) from any `dev` commit.
It uploads all six assets to a draft tagged `paseo-dryrun-<run_id>`, never
tags and never marks latest. Delete the draft when done. A dry run restores the
latest release's pinned caches and saves its own entries, but its draft pin is
never read, so those entries expire unused; delete them after a dry run if the
cache budget is tight.

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

- **Android caches are pinned by the release that wrote them.** Any job on
  `refs/heads/dev` can save cache entries, so a release build restores only the
  two entries named in the latest published release's
  `paseo-X-android-cache-pin.json` asset, and only after each tar matches its
  pinned sha256 (`.github/scripts/android-cache-pin.mjs`). Writing that asset
  needs `contents: write`. Someone can create a pinned key first, but not with
  the pinned bytes, so a squatted, missing or corrupted entry builds that cache
  cold instead of failing.
  - `paseo-android-build-v2-<sha256>`: ccache plus the Gradle build cache,
    about 190 MB.
  - `paseo-gradle-deps-v2-<inputs>-<sha256>`: `~/.gradle/caches` and
    `wrapper`, about 2.3 GB. `<inputs>` hashes `package-lock.json`, which also
    fixes the Gradle wrapper Expo generates. The pinned entry is restored even
    when the inputs changed, because Gradle only downloads what is missing.
    With unchanged inputs the run re-pins the same entry instead of saving
    2.3 GB again.
  - `paseo-node-modules-v1-<inputs>-<sha256>`: `node_modules` and
    `packages/*/node_modules` as a zstd tar, packed straight after `npm ci`. It
    replaces `npm ci`, so it is restored only when `<inputs>` match: routine
    CI's install inputs (lockfile, postinstall patches, runner image, arch,
    Node and npm). Never restore routine CI's `routine-modules-*` instead; any
    dev push writes those.
  - `<inputs>` uses the lockfile without the root and workspace versions and
    the workspaces' specs for each other, so a release commit's version bump
    keeps both entries. A restored `node_modules/.package-lock.json` therefore
    names the older workspace versions; nothing reads it.
  - GitHub evicts entries unused for seven days. A release that follows a week
    with no release or dry run restoring the pinned entries builds cold, about
    10 minutes slower (accepted).
- **Routine dependency cache:** `routine-modules-v1-*`, one rolling entry
  written by `dev` pushes.

## Android build time

A warm APK build spends about 100 s configuring Gradle, then runs Metro and
`hermesc`. `hermesc` peaks near 14.7 GB on the 16 GB runner and swaps up to
10 GB for 2–4 minutes, so its time varies by about 2 minutes with the runner's
disk. ccache already hits every native compile on a warm run. The 0.2.1 dry
runs showed that neither more Gradle workers (2 or 4) nor dropping
`-output-source-map` helps: workers saved 30 s at most, and dropping the
source map left the memory unchanged but grew the bundle by 4.5 MB. Gradle
stays at `--max-workers=1`.

Gradle's configuration cache would cut configuration from about 110 s to 10 s,
but no release could reuse an entry: the React Native plugin reads
`packages/app/package.json` while configuring, and every release commit bumps
its version. It also reports 7 problems, all `node` path lookups run with
`.execute()` in the generated `app/build.gradle`,
`modules/paseo-diff-prototype` and `react-native-keyboard-controller`. Measured
in October 2026 (W9 experiments); revisit only if the RN plugin stops reading
that file.

## Toolchain

Node is 26.11.1 and npm 11.20.0 everywhere: workflows, `.tool-versions` and
the Nix packages. Nix takes `nodejs_26` from the pinned nixpkgs, which cache.nixos.org
serves, so there is no seed release; `release-mac.sh` fails if the build would
compile Node from source. When nixpkgs moves Node, bump every pin together.
