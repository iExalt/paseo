# Paseo fork automated builds and updates

Status: draft plan; implementation is not authorized. Updated 2026-10-09.

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
| Android migration      | Open: application ID and migration from `sh.paseo.debug`. A new key does not establish a seamless update path.                                                                                                        |
| Release cadence        | Open: automatic builds and release promotion are separate choices. Proposed: build `dev`, promote selected immutable fork tags.                                                                                       |
| Mac installation owner | Open: dedicated Paseo profile versus Home Manager-pinned package. Proposed: dedicated profile; HM provides stable integration only.                                                                                   |
| Update interaction     | No disruptive automatic restarts. Check/download cadence and explicit activation UX remain open.                                                                                                                      |
| Scope authority        | Planning and requested key creation/storage only. No workflow dispatch, installation, production restart, or campaign implementation.                                                                                 |

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

Recommended trust baseline: a dedicated fork application ID with the new private
signer and an explicit settings-transfer/re-pairing flow. Retaining the current
ID requires a separately proven migration; replacing the certificate alone fails
ordinary upgrade compatibility. Investigate signing lineage only if it materially
improves migration: the publicly shared old private key cannot establish exclusive
publisher trust. Do not uninstall the existing app before recoverable data has
been identified and the user has chosen the transition.

## Bounded closure feasibility probe

**Question:** can a release carry the complete runtime closure, preserve Nix
verification, and install the exact output without build fallback at acceptable
size and cost?

**Workload:** first use the retained output for transport measurements; then use
one clean canonical CI revision on a standard Apple Silicon runner. Export with
`nix copy --to file://...`, including runtime references, and archive the resulting
binary-cache directory. NARs may already be compressed; measure actual archive
size rather than assuming double compression helps.

**Proposed allowance:** one focused two-hour investigation, not yet authorized.
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

Human participation: choose installation ownership, release promotion, and
Android migration; provision scoped CI credentials and Nix trust; approve the
bounded probe; confirm Android installation prompts; approve any eventual
production app/daemon transition. Automate device observation where possible.
No present permission extends to a production restart.

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
- [ ] Settle Android migration, Mac ownership, and release promotion choices.
- [ ] Authorize and run the bounded closure probe; record the route decision.
- [ ] Implement paired builds and complete-release promotion.
- [ ] Implement platform update interfaces and recovery.
- [ ] Pass actual-device CI artifact install/update/recovery gates.

Next campaign action: decide the open product choices and authorize the closure
probe. This document does not authorize implementation. Reconsider the route if
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
