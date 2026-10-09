# Paseo fork automated builds and updates

Status: campaign authorized; local closure transport verified, canonical CI and
device delivery pending. Updated 2026-10-09.

## Outcome and first deliverable

Build macOS Apple Silicon and Android ARM64 releases of `iExalt/paseo` in
GitHub Actions. Install and update the Mac through Nix; let the Android app
download its APK and open the system installer for confirmation. Preserve
settings, pairing, and recovery on the user's Mac and Samsung S24 Ultra.

The first useful deliverable is evidence that a signed Nix runtime closure can
be transported through GitHub Releases and imported without rebuilding, together
with a verified private Android signing identity. A green build alone does not
complete this campaign. Keep later implementation provisional until the closure
probe and installation-ownership decision settle the route.

This plan follows the agentic-workflow sequence: establish outcomes, buy the
smallest useful evidence, choose a route, then authorize a bounded next item.

## Decisions and boundaries

| Topic                  | State and consequence                                                                                                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Required targets       | Decided: macOS `aarch64-darwin` desktop and Android `arm64-v8a` APK. A macOS-only pipeline is incomplete.                                                                                                             |
| Mac distribution       | Decided: Nix; no Apple Developer membership or signed/notarized Electron updater. Real macOS launch behavior still needs proof.                                                                                       |
| Hosting                | Decided: GitHub Releases; Wasabi is not needed for this route.                                                                                                                                                        |
| Closure transport      | Preferred, not finalized: archive a signed file binary cache; retain a conventional signed substituter as the alternative.                                                                                            |
| Android key            | Decided: new ECDSA P-256 private key, unencrypted at the user's request, in private `iExalt/keychain` as `android-signing`; X.509 PEM certificate as `android-signing.pub`. Ed25519 is not supported for APK signing. |
| Android migration      | Decided: separate `sh.paseo.iexalt` app with the new signer; retain `sh.paseo.debug` during settings transfer and fresh pairing. The transfer bridge is not implemented or device-verified.                           |
| Release cadence        | Decided: automatic paired builds from `dev`, with explicit promotion of selected revisions. Promoted releases must bind immutable artifacts to one revision.                                                          |
| Mac installation owner | Decided: dedicated Paseo Nix profile owns app generations; Home Manager may provide a stable launcher. HM must not also pin the app version.                                                                          |
| Update interaction     | No disruptive automatic restarts. Check/download cadence and explicit activation UX remain open.                                                                                                                      |
| Scope authority        | The user authorized the campaign and bounded two-hour closure probe. Execute assigned components; actual app transitions and production restarts require separate authority.                                          |

Do not restart the production daemon on port 6767. Treat desktop activation and
daemon activation separately. Preserve the original Android debug key and APK
for migration investigation. Firebase/Expo push setup is a separate workstream.
Nix signing keys, Android signing keys, and any metadata-signing key have separate
purposes; do not reuse them by default.

## Verified starting point

Repository inspection used clean `dev` at `0945b8d7`. The public fork's default
branch is `main`. Existing configuration and receipts establish:

- `.github/workflows/nix.yml` runs on `main`; it builds desktop but exports no
  signed release closure. Its Linux job refreshes dependency inputs before
  building; release builds must instead verify committed inputs without mutation.
- `desktop-release.yml` accepts broad upstream-style tags, uses Apple credentials,
  and allows checkout metadata to differ from the release tag. Audit all tag and
  release-triggered workflows before introducing a fork tag namespace.
- `android-apk-release.yml` delegates to EAS with `EXPO_TOKEN`; it is not a
  GitHub-runner Gradle build. The production profile does not match the installed
  development application ID.
- `packages/desktop/electron-builder.yml` points updater metadata at upstream.
  The packaged updater uses Electron updates without an explicit Nix ownership
  boundary. Changing only the publish URL is insufficient.
- `flake.nix` derives the desktop build number from `self.revCount`. Git depth
  and source transport can change the derivation for the same commit.
- The retained Nix output is
  `/nix/store/81x7bsbkgx4iaxrpa15ddz3pqy8xrjq1-paseo-desktop-0.11.0`.
  Its runtime closure is 793,652,024 bytes (about 757 MiB); the output NAR is
  498,939,280 bytes. Compressed export size has not been measured. The output has
  no store signatures. This is an older retained build, not current-head proof.
- `/Applications/Paseo.app` is a regular directory with build `0.11.0`, so moving
  to a managed profile requires an explicit installation transition.
- The retained APK is standalone `sh.paseo.debug`, version `0.11.0`, code `11000`,
  ARM64, and 140,344,227 bytes. Its certificate matches the preserved local key.
  That key has the same Git blob hash as Expo's public template key:
  `364e105ed39fbfd62001429a68140672b06ec0de`. It is not a private release identity.
- Native version math ignores beta suffixes. Repeated publications of the same
  base version collide; define an increasing code policy before release automation.
- The newer source configures the fork's Expo project. The installed/retained APK
  lacks Firebase configuration; prior successful push proof used the Play Store
  app. These are separate facts.

Existing build provenance, timings, and artifact locations are in the
[completed notification status](complete-campaigns/CONFIGURABLE_NOTIFICATIONS_STATUS.md).
The existing standalone recipe is in [Android documentation](upstream/android.md).

## Key storage and migration

`android-signing` is an unencrypted PKCS#8 PEM private key; `.pub` contains its
self-signed X.509 certificate, not an SSH public key. For `apksigner --key`, derive
a temporary PKCS#8 DER copy. Never include private key bytes in this public
repository, build receipts, logs, or release assets. Private keychain readers can
sign APKs. CI should receive only the required signing material through scoped
secrets, rather than checking out the whole keychain repository. Define backup,
access, and recovery before relying on the key for regular releases.

Validate the key/certificate pair and sign a temporary copy of the retained APK;
verify its signature and signer using the installed Android SDK. This proves
tool compatibility, not installation compatibility. Do not install that probe.

Validation completed: OpenSSL 3 checked the key, and Android SDK 36 `apksigner`
signed and verified a disposable copy of the retained APK using APK signature
scheme v3. The certificate SHA-256 fingerprint is
`943626cd89e2d0b763d432db9100110b878953356db9d3e46497be2179989459`.
Use named P-256 curve parameters and an X.509 v3 certificate; macOS LibreSSL's
initial output was incompatible with the Java signer. Temporary key conversions
and the signed probe were removed. No installation or existing-key change occurred.
The pair is published in private `iExalt/keychain` commit
`93bf183eb47f2f7a540ffc6ed97e1122e4c1e35d`; the remote branch was verified to match.

Use the chosen `sh.paseo.iexalt` application ID and private signer. Preserve the
existing app until settings transfer and fresh pairing pass. Source discovery found
no existing user-facing export/import workflow. A private, one-time bridge build
can keep `sh.paseo.debug` and its original signer, with a code above `11000`, to
export allowlisted preferences for explicit import into the new app. The old
signer is publicly shared and must not become the fork's release identity. Bridge
source compatibility and the actual transfer round trip remain unverified.

Preserve app preferences and local workspace/sidebar/layout choices, filtering
references to matching daemon identities after pairing. Exclude credentials,
passwords, client identity, push tokens, and regenerable caches. Host registry
schemas contain passwords, so do not transfer the whole registry. Drafts, review
comments, and their attachments need an explicit content-transfer decision.
Daemon-owned work stays on the daemon; new-app notification permissions and push
registration require device verification. Do not uninstall the existing app before
the actual transition is authorized and preservation succeeds.

## Bounded closure feasibility probe

**Question:** can a release carry the complete runtime closure, preserve Nix
verification, and install the exact output without build fallback at acceptable
size and cost?

**Workload:** first use the retained output for transport measurements; then use
one clean canonical CI revision on a standard Apple Silicon runner. Export with
`nix copy --to file://...`, including runtime references, and archive the resulting
binary-cache directory. NARs may already be compressed; measure actual archive
size rather than assuming double compression helps.

**Authorized allowance:** one focused two-hour investigation, with a 45-minute
local transport component before the canonical CI component.
Record setup, build, export, download, import, and analysis time separately.
Reassess after the local transport measurement and first clean-runner attempt,
or earlier if a new subsystem or paid runner becomes necessary. Do not turn a
failing probe into an updater implementation.

**Proof:** sign the complete exported closure; import on a fresh supported Nix
store with signature checks enabled and a separately provisioned trusted public
key. Verify exact paths and contents. Disable local and remote builder fallback;
missing paths must fail. Compare the canonical source revision, lock hash,
architecture, build metadata, and evaluated output path. Remove dependence on
checkout depth or define one canonical source identity before claiming a match.

Measure compressed bytes, extraction/import disk peak, first-install download,
and repeated-update cost. Reject tampered NARs, unknown signing keys, incomplete
closures, and mismatched metadata. Imported data alone is not activation.

**Route choice:** keep closure assets if the complete transfer and verification
work economically. If archive limits, repeated full downloads, or import
complexity dominate, compare a conventional signed cache with explicit storage
costs. Do not silently split assets or introduce another service. Signatures
authenticate store objects; separately authenticate the manifest binding revision,
channel, sequence, architecture, hashes, and output paths.

### Verified local transport result

The retained output's 69-path closure exported to a file binary cache using an
ephemeral per-copy `secret-key` setting. This signed outgoing cache entries without
changing signatures in the shared source store. The source output remained unsigned.
An archive of that cache imported into an empty rooted local store with
`require-sigs=true`, only the ephemeral public key trusted, and empty builders and
substituters. Recursive `nix store verify --sigs-needed 1` passed; all imported
logical paths and NAR hashes matched the cache.

| Measurement                                 |                Local result |
| ------------------------------------------- | --------------------------: |
| Complete closure / root NAR bytes           |   793,652,024 / 498,939,280 |
| Binary-cache files / archive asset bytes    |   160,612,698 / 160,657,108 |
| Export / archive / extraction               |  134.95 s / 2.78 s / 0.46 s |
| Import / recursive verification             |           10.06 s / 10.18 s |
| Imported store / retained stages allocation | 798,356 KiB / 1,327,656 KiB |

Measurements used Determinate Nix 3.19.0 / Nix 2.34.6 and default xz-compressed
NARs. The gzip archive added 44,410 bytes over cache contents; plain tar remains
a reasonable alternative. Allocation is a staged local measurement, not a measured
OS-wide peak. This archive is about 153 MiB; first staging also needs space for
the extracted cache and imported closure. Later-update download cost is unmeasured.

A separate 2-path SQLite/zlib fixture rejected an unknown trusted key and a missing
dependency. Recompressing a NAR after changing one regular-file payload byte kept
valid XZ data but failed import with a hash mismatch. Ephemeral private keys and
disposable caches/stores were removed; raw probe logs are not committed.

This verifies local archive transport, signature enforcement, closure completeness,
and content integrity. The rooted destination retained logical `/nix/store/...`
identities with separate physical files/state; macOS cannot execute programs in
that chroot store. It does not prove canonical source identity, a fresh host's
system-store import, GitHub download, runner headroom, app launch, or activation.
The next probe must build one clean canonical `aarch64-darwin` revision with
committed inputs, transport its signed closure, and verify that exact output on a
separate supported Nix host with builder fallback disabled.

### Canonical CI probe boundary

The probe workflow runs only for changes to its workflow/helper on `dev`; it does
not use upstream release tags. It builds the immutable event revision on standard
`macos-14` ARM64 runners with Nix 2.34.7. Before building, it requires equal
derivation and output paths from the clean Git checkout and the same revision
through GitHub's source-archive transport. Electron's numeric build version now
uses the package's semantic-version core; revision count no longer changes the
derivation. The manifest records the full source revision and lock hash separately.

The producer exports a signed cache and uploads its tar archive to a draft
`nix-closure-probe-<revision>` GitHub Release. A separate runner downloads that
asset and imports the exact producer-pinned paths into an isolated rooted store
with builders and substituters disabled. Its public trust pin lives in the reviewed
workflow; the private one-use key lives only in the probe-specific repository
secret and a temporary signing file. Remove that secret and file after the probe,
including failure. Never upload a private signing key as an artifact.

The content-addressed manifest is pinned by trusted producer-job outputs. That
same-run provenance and Nix content-hash verification bind its bytes across the
Release download; ordinary runtime paths require the pinned Nix signature.
This does not establish standalone release-manifest authentication for an updater.
The first clean CI attempt remains pending, including cold duration, disk headroom,
actual Release transport, and verification on the separate runner.

## Proposed installation contract

Expose check, stage, activate, status, and rollback operations; final command
names are implementation details. Stage downloads and verifies all required data
before changing the active generation. Import known store paths directly; do not
run a source build as a hidden fallback. Reject wrong platforms, malformed paths,
unsafe archive entries, stale release sequences, and partial manifests.

A dedicated profile would own the app version and retain active and previous
generations as GC roots. Home Manager may install the updater and stable launcher
integration, but must not also pin the app version. The alternative is full HM
ownership: download/import first, then update its pin and switch HM. Do not mix
these ownership models. Determine Nix daemon trust configuration during bootstrap;
do not disable `require-sigs` or grant broad trusted-user privileges as a shortcut.

Activation must preserve launch identity and settings paths, retain the old app
until migration succeeds, and report staged versus running versions. Keep the
running generation rooted until its processes exit. Nix installations expose
their update method and never contact or offer upstream Electron updates.
Rollback includes data compatibility or a tested backup/restore contract;
switching the executable alone does not roll back settings migrations.

## Later milestones and acceptance gates

| Milestone                | Observable acceptance                                                                                                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity and feasibility | Private Android key validated; migration decision recorded; closure probe chooses transport and canonical identity.                                                                                                                   |
| Paired CI builds         | Clean committed inputs produce macOS closure and ARM64 APK on standard GitHub runners. No EAS build or Apple credentials required. Measure cold/warm duration and disk/memory use.                                                    |
| Complete release         | One immutable revision, increasing Android code, authenticated manifest and both verified targets. Publish only after both pass; retries cannot silently replace a published identity. Signing secrets never reach untrusted PR jobs. |
| Mac updater              | Real release download, verified import, explicit activation, preserved settings, and offline rollback. Failed staging leaves current app unchanged.                                                                                   |
| Android updater          | Real app check/download opens system installer; permission denial, cancellation, resume/retry, and success are visible and recoverable.                                                                                               |
| Device delivery          | Actual user Mac and S24 Ultra install/update CI-produced artifacts through intended interfaces, preserve state, and demonstrate recovery.                                                                                             |

The final device gate requires two identified releases, A and B, plus a recovery
candidate. On Mac, prove A to B without compilation, retain prior roots through
GC, and roll back offline without an unsolicited daemon restart. Rehearse GC and
failure injection in an isolated environment rather than disrupting unrelated
user store paths. Verify terminal/native helpers and daemon connectivity as well
as opening the window.

On S24 Ultra, test the app-to-installer path, including first-time install-source
permission and cancel/retry. `adb install` alone is insufficient. Verify installed
package, signer, version code, architecture, pairing, notification preferences,
and workspace settings before and after upgrade. Reject corrupted/incompatible
artifacts. Android recovery should rebuild known-good source with a higher code
and the durable signer; ordinary installer downgrade is not assumed. Validate
data compatibility for that recovery build.

Human participation: provision scoped CI credentials and Nix trust; confirm
Android installation prompts; approve any eventual production app/daemon
transition. Installation ownership, release promotion, and Android identity are
decided, and the bounded probe is authorized. Automate device observation where
possible. No present permission extends to a production restart.

## Economical verification

Use fast unit cases for manifest validation, release selection, version ordering,
and updater state transitions. Use a small number of integration tests for Nix
import/profile transactions and Android download/installer contracts. Keep actual
device journeys to install, upgrade, and recovery. Reuse existing suites rather
than adding a feature-specific parallel test system.

Run scoped checks before expensive builds. Preserve the repository's accepted
timing baselines from the completed campaign; measure new updater gates separately
under comparable cache/concurrency conditions. Do not run the full suite locally;
use CI for broad coverage. Record only a few durable receipts with revision,
artifact digest, signer, result, and timing; exclude secrets and bulky logs.

## Checklist and next action

- [x] Inspect fork workflows, updater, Nix inputs, and retained receipts.
- [x] Verify runner availability and release asset limits.
- [x] Identify shared debug key and select ECDSA P-256 without password protection.
- [x] Create and validate the new Android signing material.
- [x] Publish the validated pair to the private keychain repository.
- [x] Settle Android migration, Mac ownership, and release promotion choices.
- [x] Authorize the bounded probe and verify local signed closure transport.
- [ ] Complete canonical CI/fresh-host closure proof and record the route decision.
- [ ] Implement paired builds and complete-release promotion.
- [ ] Implement platform update interfaces and recovery.
- [ ] Pass actual-device CI artifact install/update/recovery gates.

Next campaign action: run the canonical CI/fresh-host component of the authorized
closure probe. Platform updater implementation and actual transitions still need
their assigned acceptance boundaries. Reconsider the route if
fresh-store import needs weakened verification or compilation, standard runners
cannot build within resource limits, Android migration cannot preserve required
state, or the probe exceeds its agreed effort without resolving the question.
Report capabilities and remaining uncertainties alongside checklist progress.

## External references

Checked 2026-10-09. Standard public-repository runners are free; macOS ARM64
runners currently provide 3 cores, 7 GB RAM, and 14 GB storage. Standard hosted
jobs have a six-hour limit; Free accounts have 20 concurrent jobs including five
macOS jobs. Release assets must each be under 2 GiB; a release supports up to
1,000 assets, with no stated total-size or bandwidth limit. Release asset storage
is separate from Actions artifact storage.

- [GitHub runner specifications](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- [GitHub Actions limits](https://docs.github.com/en/actions/reference/limits)
- [GitHub Release limits](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)
- [Nix copy and file binary caches](https://nix.dev/manual/nix/2.34/command-ref/new-cli/nix3-copy)
- [Nix store signing](https://nix.dev/manual/nix/2.34/command-ref/new-cli/nix3-store-sign)
- [APK signing algorithms](https://source.android.com/docs/security/features/apksigning/v2)
- [Android app signing and update identity](https://developer.android.com/studio/publish/app-signing)
