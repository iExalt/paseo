# GitHub workflows

How the fork's CI and releases work today and what to do when they fail. The
fork has one user, so releases are "builds plus smoke": macOS Nix closure,
Android APK, Linux x64/arm64 Nix closures and a Windows x64 installer,
smoke-tested, signed and published. There is no attestation, candidate
authority, Windows arm64 build or native Windows/Linux upgrade proof. The retired
candidate pipeline and the campaign that built it live in git history (before
`ci: delete the retired release candidate pipeline`) and in
[complete-campaigns](complete-campaigns/GITHUB_WORKFLOWS_PLAN.md).

CI stays free: hosted runners only, no paid services. Routine PR CI targets
under five minutes; this latency budget is advisory and does not block merges.

## Workflows

| Workflow             | Trigger                                     | What it does                                                                                                                                         |
| -------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`             | Every PR and `dev` push                     | Plans lanes from `.github/ci-paths.json`, runs `mise run ci:routine` per lane, then the `Routine CI required` gate                                   |
| `ci-deep.yml`        | Every PR to `dev`, owner dispatch           | Reports `Deep verification required`; release PRs run browser, integration and Electron journeys at the exact release PR head                        |
| `release-please.yml` | `dev` push                                  | Keeps the one release PR (`chore(dev): release X`) current and its Nix hash fresh; its merge tags `paseo-vX` with a draft and dispatches the release |
| `release.yml`        | Dispatch on `dev` (release-please or owner) | Builds, smoke-tests, signs and publishes the macOS closure, Android APK, Linux Nix closures and Windows installer                                    |
| `rebase-dev.yml`     | Owner dispatch                              | Rebases `dev` onto the `upstream/main` mirror, runs routine CI on the result, then pushes a backup and the new `dev` atomically                      |
| `upstream-sync.yml`  | Daily 07:23 UTC, dispatch                   | Fast-forwards the `upstream/main` mirror branch                                                                                                      |

Routine CI details live in `.github/scripts/ci-routine.mjs`: lanes `quality`,
`workspaces`, `app-1..2`, `server-1..3` and `integration`. Each step declares
its lane group where it is planned, and `laneGroups` holds each group's shard
count and prerequisite, so renaming a step cannot move it. App unit shards run
three Vitest workers, the other units four. Server shards balance by
`packages/server/test-durations.json`; when one server lane runs well ahead of
the others, regenerate it from a dev push with
`npx tsx scripts/refresh-test-durations.ts` in `packages/server`; it takes the
server lane names from the planner. The `required` job requires planner
and routine lane success, then reports the five-minute latency budget from the
`plan` job's start. Latency overruns and reporting errors do not fail the job.
Partial reruns retain the old `plan` start time, so their latency can include
time between attempts. Use **Re-run all jobs** for a fresh latency measurement;
**Re-run failed jobs** remains sufficient to retry failed checks.

The `dev` ruleset requires both `Routine CI required` and `Deep verification
required`. The deep gate requires all three deep lanes to succeed on release PRs;
ordinary PRs pass with the lanes skipped. Repository auto-merge is enabled, but
must be selected per PR. Merging a release PR starts publication, so enable its
auto-merge only after approval for that release.

Dev pushes refresh the installed dependency cache (`install-cache`); PR lanes
only restore it. `.github/scripts/dependency-fingerprint.mjs routine-key`
prints its key from the same dependency fingerprint as the Android
`<inputs>` below, so the release PR's version bump restores dev's entry instead of running `npm ci` in
every lane, which pushes the critical path about 50 s over budget.

## Release procedure

1. Merge conventional commits into `dev`. `release-please.yml` keeps one
   release PR current, authored by the `paseo-release` App so its pushes start
   checks. Deep CI runs on it. The version follows the commits: a `feat` bumps
   the minor. A `Release-As: X.Y.Z` footer in a conventional commit on `dev`
   sets the version of the next release.
2. The `nix-hash` job checks `nix/npm-deps.hash` on the release PR. The Nix
   npm fetch reads only the lockfile's registry entries, so a version bump
   leaves the hash alone and the job pushes nothing. It pushes
   `chore(nix): refresh the npm dependency hash` only when a dependency change
   landed without running `scripts/update-nix.sh`, and that push restarts the
   PR's checks.
3. Merge the release PR. On that push release-please tags `paseo-vX` at the
   merge commit, opens a draft release with the changelog as its notes and
   dispatches `release.yml` on `dev` with that tag.
   - A commit that adds nothing to the changelog (`test`, `ci`, `docs`) leaves
     the release PR untouched, so its checks still test the old `dev`. Closing
     and reopening it reuses the stale merge ref. Run
     `gh pr update-branch <N> --rebase` and wait for the new checks.
4. `release.yml` builds every artifact, smoke-tests the
   macOS and Linux closures on fresh runners and the Windows app in its build
   job, signs the APK and the manifest, uploads everything to the draft,
   re-downloads and re-hashes each asset, then publishes the draft as latest.
   Any failed platform blocks the release.
   - The closure tar is a zstd-compressed `file://` binary cache. The
     installing host's own `nix` decompresses it, so the device's Nix must
     read `.nar.zst`; the client's tar extractor ignores the format.
   - The smoke installs only `playwright`, `@electron/asar` and `ws` at their
     lockfile versions (`release-mac-smoke-deps.mjs`). Its built-in plugin
     check uses the client and server builds packed in the closure's own
     `app.asar`, so the job builds nothing.

A release's asset names and its exact upload set come from one catalog,
`.github/scripts/release-assets.mjs`. Naming and checking a new asset kind is
one edit there; release.yml still spells its build paths. The publish job's checks fail on any file the catalog does not name. Desktop delta
names stay with the shipped updater (`scripts/paseo-nix-update-delta.mjs`).

**Dry run:** dispatch `release.yml` on `dev` with no tag. It uploads every
expected asset to a draft tagged `paseo-dryrun-<run_id>`, never tags and never marks
latest. Delete the draft when done. A dry run restores the latest release's
pinned caches and saves its own entries, but its draft pin is never read, so
those entries expire unused; delete them after a dry run if the cache budget is
tight.

## Recovery

- **`release.yml` failed before publishing:** fix the cause on `dev` if it is
  in the workflow, then dispatch `release.yml` on `dev` with `tag` set to
  `paseo-vX`. It
  builds the tag again, replaces the draft's assets and publishes. It refuses a
  tag that is not newer than the latest release.
- **The tagged commit cannot ship** (the build itself is broken): land the fix
  on `dev` and let the next release PR carry it. Delete the stale draft and
  `paseo-vX` tag so they do not linger.
- **GitHub refused the publish PATCH** (assets uploaded and verified, the
  release still a draft): the log shows GitHub's response. A rerun of the failed
  job uploads and verifies again, then sends the same PATCH, so it fails the same
  way unless the response named a rate limit. Publish the draft with your own
  token instead, with the same fields `publish()` in
  `.github/scripts/release-publish.sh` sends, then run its tag and latest checks
  by hand. 0.13.0 needed this: `GITHUB_TOKEN` got HTTP 403 twice.
- **Publish step failed after the PATCH** (tag or latest check): the release is
  public. Check on GitHub that `paseo-vX` points at the release commit and that
  the release is marked **Latest**; fix the flag by hand if not.
- **Dry-run drafts** are never cleaned up automatically.
- **`rebase-dev` stops on an upstream workflow:** the fork keeps only the
  workflows on `dev`, so a workflow upstream adds stops the run. Delete it in
  `fixups/<upstream sha>.patch` on `rebase-resolutions` and dispatch again.
- **`rebase-dev` stops on upstream docs:** a doc upstream adds lands at the top
  of `docs/`, or an upstream edit leaves a dead relative link. Move the doc to
  `docs/upstream/` and fix the links in the same fixup patch; see
  [Rebasing dev](upstream/rebase-dev.md).

## Secrets and variables

| Name                                                              | Used by                                                              |
| ----------------------------------------------------------------- | -------------------------------------------------------------------- |
| `PASEO_NIX_RELEASE_SIGNING_KEY`                                   | `release.yml` `macos-build`, `linux-build`: signs the closures       |
| `PASEO_FORK_GOOGLE_SERVICES_JSON`                                 | `release.yml` `android-build`: Firebase config                       |
| `PASEO_FORK_SIGNING_KEY_PKCS8_PEM`, `PASEO_FORK_SIGNING_CERT_PEM` | `release.yml` `android-sign`: APK signer                             |
| `PASEO_RELEASE_MANIFEST_PRIVATE_KEY`                              | `release.yml` `publish`: signs both inventories                      |
| `PASEO_RELEASE_APP_PRIVATE_KEY`, variable `_APP_CLIENT_ID`        | `release-please.yml`: mints the `paseo-release` App token            |
| `PASEO_REBASE_SSH_SIGNING_KEY`                                    | `rebase-dev.yml`: signs rebased commits                              |
| `PASEO_SYNC_APP_PRIVATE_KEY`, variable `_APP_CLIENT_ID`           | `upstream-sync.yml`, `rebase-dev.yml`: `iexalt-paseo-sync` App token |

Each secret is scoped to the one job that needs it (`scripts/ci-workflow.test.mjs`
pins this for `release.yml`).

The mirror and `dev` pushes use the `iexalt-paseo-sync` App because
`GITHUB_TOKEN` cannot push commits that change workflow files, and upstream
edits its workflows often. App pushes trigger workflows, so a rebased `dev`
runs `ci.yml` and `release-please.yml`. The App key is SOPS-encrypted in
`secrets/github-app/`; decrypt it with `--output-type binary` to rotate the
secret.

## Release manifest

`paseo-release-manifest.json` plus its Ed25519 `.sig` are what the in-app
updaters trust. Schema 3 (`packages/protocol/src/release-manifest-v2.ts`)
carries exactly two cells, `macos/arm64/nix-desktop` and `android/arm64/apk`,
with the version, source SHA, upstream base and release tag. Clients also
accept schema 2, the 14-cell manifest releases before 0.2.0 used. Clients
older than 0.2.0 reject schema 3: install 0.2.0 by hand once (sideload the APK;
run `scripts/paseo-nix-update.mjs` from a checkout on macOS). Until then an old
Android client reports "No signed published Paseo fork release could be
verified". The release also carries unsigned Android sidecars. Keep them out
of the manifest: changing the schema breaks installed clients.
`paseo-X-android-arm64.apk.gz` is about a third of the APK's size. The
`android-delta` job writes up to four `.apk.delta-from-Y.zst` files with
`.github/scripts/release-android-delta.mjs`: `zstd --patch-from` deltas against
the signed APKs of the last four stable releases, a few MB each, kept only when
they are under half the `.gz`. The job never blocks `publish`. The Android
updater tries the delta from its installed version against the installed APK,
then the `.gz`, then the APK, and checks each result against the signed APK
cell. Logcat tag `PaseoForkUpdates` records which transfer verified; a delta
that fails falls back without telling the user.
The macOS tar has unsigned sidecars too, written by
`.github/scripts/release-mac-index.mjs`. `paseo-X-macos-arm64-nix-desktop.index.json`
lists the tar's member ranges and narinfos. Up to four `.delta-from-Y.zst`
files patch the desktop NAR from the last four stable releases. The macOS
updater fetches only the store paths it lacks, by delta or by tar range. Nix
still checks each path against the release key, and the updater checks the
closure against the signed manifest. On any failure it downloads the full tar.
A failure to build a delta is a warning, so the release still ships without it.
`.github/fork-release.json` holds the version and upstream
base that `release.yml` reads.

### Linux and Windows assets

`paseo-desktop-manifest.json` and `.sig` cover Windows x64 and Linux Nix
x64/ARM64 separately. They reuse the Ed25519 release key and bind the original
manifest bytes and release identity; the primary schema-3 inventory stays unchanged
for installed Mac/Android readers. Publication requires all three desktop targets.
Windows verifies signed SHA-256, SHA-512 and size, including cached installers.
Linux verifies the signed union closure and roots both CLI and desktop outputs.
No new signing secret or paid publisher certificate is required.

Existing Windows/Linux clients need one manual installation of the first release
with this updater. Later checks, downloads and explicit apply/restart run in-app.
Windows waits for active agents and terminals; ordinary quit does not install.
Linux uses a dedicated user-owned profile, leaving system and Home Manager profiles
untouched. An old release without the desktop sidecars reports an unavailable
update channel rather than claiming the app is current.

- `paseo-X-linux-{x64,arm64}-nix.tar` is a `file://` binary cache holding the
  CLI/daemon (`.#paseo`) and the desktop (`.#desktop`), signed with the Nix
  release key like the macOS tar. Its `.json` lists both store paths in
  `outputPaths` and the closure. To install, add the release key
  (`release_public_key` in `.github/scripts/release-nix.sh`) to
  `trusted-public-keys` in the effective Nix daemon configuration, extract the
  tar, and import its paths with `nix copy --from file://<dir> <paths>`.
  From the imported desktop output, run `bin/paseo-nix-update bootstrap` once.
  It verifies that exact running release, adopts it into a dedicated profile,
  and installs an owned `~/.local/bin/paseo-desktop` launcher. Switch to that
  launcher explicitly if another manager owned the previous installation.
  Conflicting launchers are preserved. Missing Nix trust is reported before
  import; the app never changes system configuration or adds trusted users.
  The release smoke imports both outputs and launches the desktop under xvfb;
  the command rehearsal uses signed fixtures and fake Nix/network boundaries.
- `paseo-X-windows-x64.exe` is the unsigned NSIS installer; there is no
  publisher certificate, so SmartScreen warns. The build smoke-tests the
  unpacked app (`PASEO_DESKTOP_SMOKE`), then installs silently and runs the
  installed CLI. There is no arm64 build: `npm ci` alone took 22 minutes on
  `windows-11-arm`.

## Release boundary

release-please finds the last release by walking `dev` back to the commit the
newest release's tag names, and the changelog is every commit it passes.
`rebase-dev` rewrites that commit, so the walk would never find it and would
stop at its 500-commit limit. After a rebase that rewrites the newest release
commit, `rebase-dev` adds a signed `chore(rebase): point release-please at the
rebased release` commit that sets `last-release-sha` in
`release-please-config.json` to the rewritten copy. The walk stops at whichever
of the two it reaches first, so the value can stay after the next release.

## Caches

- **Android caches are pinned by the release that wrote them.** Any job on
  `refs/heads/dev` can save cache entries, so a release build restores only the
  three entries named in the latest published release's
  `paseo-X-android-cache-pin.json` asset, and only after each tar matches its
  pinned sha256 (`.github/scripts/android-cache-pin.mjs`). Writing that asset
  needs `contents: write`. Someone can create a pinned key first, but not with
  the pinned bytes, so a squatted, missing or corrupted entry builds that cache
  cold instead of failing.
  - `release.yml` runs only on `dev`, never on the tag. A cache entry belongs
    to the ref that saved it, and a run reads only its own ref's entries and
    `dev`'s, so entries a `paseo-vX` tag run saved are invisible to the next
    release. Releases 0.7.0 and 0.8.0 ran on their tags; 0.8.0 built cold.
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
    dev push writes those. Expected input changes or older pins without a
    node_modules entry emit a notice and run npm ci; fetch, parse and integrity
    failures remain warnings.
  - `<inputs>` is the dependency fingerprint
    (`.github/scripts/dependency-fingerprint.mjs`): the lockfile without the root and workspace versions and
    the workspaces' specs for each other, so a release commit's version bump
    keeps both entries. A restored `node_modules/.package-lock.json` therefore
    names the older workspace versions; nothing reads it.
  - GitHub evicts entries unused for seven days. A release that follows a week
    with no release or dry run restoring the pinned entries builds cold, about
    10 minutes slower (accepted).
- **Routine dependency cache:** `routine-modules-v2-*`, one rolling entry
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
its version. The October 2026 W9 experiments also logged 7
configuration-cache problems: `node` path lookups run with `.execute()` in the
generated `app/build.gradle` and `react-native-keyboard-controller`, and one in
the diff prototype module, deleted since. That count is historical; recount it
before acting on it. Revisit only if the RN plugin stops reading that file.

## Desktop fork updates

[Approved implementation plan](FORK_UPDATES_PLAN.md). A is verified: a separate
signed desktop inventory covers Windows x64 and Linux Nix x64/ARM64, binding
both Linux outputs and installer SHA-512 to the unchanged primary Mac/Android
manifest. The release producer and asset catalog require both new sidecars.
Nine fixture checks pass on the Linux development host; protocol typecheck and scoped lint pass.
Review A1: 1 material/1 total; A2: 0/0. Windows adapter code and safety fixtures
now pass (57 updater/safety checks, root types and scoped lint); BW1 2/2, BW2 0/0.
Linux adapter fixtures now pass (14 helper checks, including the real command
controller with fake Nix/network boundaries; BL1 2/2, BL2 0/0). Shared Fork updates
UI and waiting/retry behavior pass unit and browser-bridge checks (six journeys,
plus an extended sidebar/About Windows journey). Desktop, tablet and phone browser
dogfood reported no defects. C1 1/1, C2 0/0; final integration I1 0/0 accepted.
Root typecheck, lint and formatting pass. [PR #381](https://github.com/iExalt/paseo/pull/381)
records required-check and merge evidence; initial CI found and the reviewed repair
corrected a stale producer-test message expectation without changing its rejection
invariant.
No release publication or native-client upgrade has run.

## Toolchain

Node is 26.11.1 and npm 11.20.0 everywhere: workflows, `.tool-versions` and
the Nix packages. Nix takes `nodejs_26` from the pinned nixpkgs, which cache.nixos.org
serves, so there is no seed release; `release-nix.sh` fails if the build would
compile Node from source. When nixpkgs moves Node, bump every pin together.
