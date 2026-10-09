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

| Topic                  | State and consequence                                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Required targets       | Decided: macOS `aarch64-darwin` desktop and Android `arm64-v8a` APK. A macOS-only pipeline is incomplete.                                                                                                                             |
| Mac distribution       | Decided: Nix; no Apple Developer membership or signed/notarized Electron updater. Real macOS launch behavior still needs proof.                                                                                                       |
| Hosting                | Decided: GitHub Releases; Wasabi is not needed for this route.                                                                                                                                                                        |
| Closure transport      | Preferred, not finalized: archive a signed file binary cache; retain a conventional signed substituter as the alternative.                                                                                                            |
| Android key            | Decided: new ECDSA P-256 private key, unencrypted at the user's request, in private `iExalt/keychain` as `android-signing`; X.509 PEM certificate as `android-signing.pub`. Ed25519 is not supported for APK signing.                 |
| Android migration      | Decided: separate `sh.paseo.iexalt` app with the new signer; retain `sh.paseo.debug` during settings transfer and fresh pairing. The transfer bridge is not implemented or device-verified.                                           |
| Release cadence        | Decided: automatic paired builds from `dev`, with explicit promotion of selected revisions. Promoted releases must bind immutable artifacts to one revision.                                                                          |
| Mac installation owner | Decided: dedicated Paseo Nix profile owns app generations; Home Manager may provide a stable launcher. HM must not also pin the app version.                                                                                          |
| Update interaction     | No disruptive automatic restarts. Check/download cadence and explicit activation UX remain open.                                                                                                                                      |
| Scope authority        | The user authorized the campaign, the initial bounded closure probe, and two separately bounded 45-minute seeded CI attempts. Execute assigned components; actual app transitions and production restarts require separate authority. |

Do not restart the production daemon on port 6767. Treat desktop activation and
daemon activation separately. Preserve the original Android debug key and APK
for migration investigation. The user added Firebase/Expo delivery to the campaign:
use native GitHub builds, configure the fork's Firebase client through a controlled
decrypted build input, and prove notification permission, token registration, and
actual delivery on the S24. Expo is the notification delivery service, not the
native build service. The earlier Play Store delivery proof does not satisfy this gate.
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
existing app until settings transfer and fresh pairing pass. The fork identity
and required explicit version-code contract are implemented and verified by unit
and Expo configuration checks in the uncommitted tree; native APK building and
new-key signing remain unverified. See [Android variants](upstream/android.md#app-variants).
Source discovery found
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
The first clean [CI attempt](https://github.com/iExalt/paseo/actions/runs/37952615096)
used revision `119dda15072d5af0f4083a23eaf411587f621f95`. On the
`macos-14-arm64` image (macOS 14.8.9), execution reached `nix build` after the
architecture, clean-checkout, lock, checkout/archive path-equality, and pre-build
disk guards. The producer was canceled by its experimental 55-minute cap at
16:28:55 UTC (12:28:55 PM EDT) on 2026-10-09, after 55 minutes 21 seconds.
The last logged derivation start was `nodejs-slim-26.11.0` at
15:35:45 UTC (11:35:45 AM EDT); that does not establish the active process at
cancellation. No desktop output, closure archive, draft Release, or verifier proof
was produced. The exact free-space readings were not emitted before cancellation;
only the enforced minimum of 2,500,000 KiB is established.

This is a bounded cold-build blocker, not a closure-transport route failure. The
55-minute probe cap is below Actions' standard six-hour job limit. Inspect the
missing Darwin dependency's derivation and cache metadata before choosing a
separately bounded dependency build or a longer clean-run allowance. A conventional
cache would not remove the need to produce the first cold output. The probe-specific
GitHub signing secret and local private key were removed after cancellation.

Read-only diagnosis reproduced the exact CI Node derivation and output. The locked
nixpkgs revision supplies Node 26.10.0; `nix/runtime-overrides.nix` selects 26.11.0
and changes its source and Darwin patches. The custom 26.11.0 output
`/nix/store/3vd5kgvc7l4hcg5mlr21f09inywmfnd6-nodejs-slim-26.11.0` had no
`cache.nixos.org` narinfo (HTTP 404), while the same locked input's stock 26.10.0
output had one (HTTP 200). The exact custom output already exists locally with the
matching CI deriver and NAR hash, and appears in the previously verified export
and fresh-import maps. It is a locally built dependency, not canonical CI provenance.

The user authorized one 45-minute attempt that seeds only the exact signed local
dependency closure before the clean CI project build, preserving Node 26.11.0.
Setup started at 16:46:33 UTC (12:46:33 PM EDT) on 2026-10-09; the hard cap is
17:31:33 UTC (1:31:33 PM EDT). Required outputs and references must be enumerated,
and fresh CI must enforce the pinned signing key and exact identities before using
the seed. Missing required local outputs are a blocker, not permission for a local
dependency build. This experiment does not claim that every dependency was built
in canonical CI.

The single seeded [CI attempt](https://github.com/iExalt/paseo/actions/runs/37963272142)
used revision `580da1779385adebff15ec3df249cecc88f7a009` and failed after 49 seconds
at 17:02:07 UTC (1:02:07 PM EDT). Downloaded seed asset size and SHA-256 matched
the reviewed pins. BSD tar had included 146 AppleDouble `._*` sidecars of 163 bytes
each: extraction produced 289 files / 68,855,898 bytes instead of the signed cache's
143 / 68,832,100. Local extraction reproduced the exact 23,798-byte difference.
The cache count guard rejected this before Nix import, signature verification,
canonical parity, build, or export. The correction below preserves signed NAR contents.
The probe-specific GitHub secret was deleted and verified absent, local private
material was already removed, and diagnostic extraction was cleaned up.

The user authorized one correction and retry with a fresh 45-minute cap. Setup
started at 17:09:43 UTC (1:09:43 PM EDT); the hard stop is 17:54:43 UTC
(1:54:43 PM EDT) on 2026-10-09. Local preflight validated every tar member before
excluding only basenames beginning `._`; the resulting 143 files / 68,832,100 bytes
matched every original cache file's size and SHA-256. The immutable seed and its old
public signing pin remain unchanged; final closure export uses a separate new
one-use key. New tar creation disables macOS copyfile metadata, while both import
paths retain strict path/type checks and the narrow metadata filter.

The corrected [CI run](https://github.com/iExalt/paseo/actions/runs/37965411965)
used `762280fc1b473eb7187ca0fd1f7741d9e9374ade` and ended after 48 seconds at
17:20:04 UTC (1:20:04 PM EDT). Asset hashes and the filtered file/byte counts
passed. Fresh standard macOS CI imported 71 paths from the seed and completed
recursive signature/NAR verification before an extra `path-info --derivation`
assertion failed: runtime closures contain output paths without requiring their
derivation objects. That assertion was an erroneous gate added during review;
canonical source evaluation remains the correct derivation-identity check.
The source correction removes only that imported-store assertion while retaining
the pinned manifest, output/hash/signature checks, evaluated expected Node derivations,
and checkout/archive derivation/output equality. It is held uncommitted for an
integrated workflow publication that disables or removes the standalone probe.

The user accepted fresh CI seed import as additional feasibility evidence and
stopped standalone probe attempts. The GitHub probe secret was removed and verified
absent; local private material had already been removed. No canonical application
build, full-closure Release export, or separate fresh-runner full-closure verification
has completed. Continue the route provisionally; those gates remain required in
the paired pipeline, and actual Mac launch remains a later gate.

Firebase client and admin credentials are stored as binary SOPS envelopes under
`secrets/firebase/`; exact-byte decryption was verified before removing the two
original Downloads files. The user's replacement client config was likewise
encrypted and verified before removing that exact redownload. Safe metadata checks
confirmed a `sh.paseo.iexalt` client and matching nonempty client/admin project IDs.
Fork Firebase app wiring is implemented: configuration requires an absolute
decrypted client path and an expected public project ID, and rejects missing or
invalid files and mismatched project/package metadata. Eight focused tests, scoped
lint, a synthetic Expo config projection, and missing/unreadable/invalid JSON smoke
checks passed. Read-only EAS project info
confirmed `@iexalt/paseo`, project `3a777534-569c-47e5-81ad-1a4e47d5127c`.
Native builds and actual fork-device delivery remain unverified.

The required root formatting, lint, and typecheck gates passed for these source
changes. The serial typecheck took 24.91 seconds versus the retained 14.2-second
baseline. A read-only host snapshot showed load 10.31 and recording/window processes
using substantial CPU; this run does not establish comparable idle-host latency.
Keep the baseline and compare the next required run under comparable conditions.
The next required serial batch passed lint (26.99 seconds), formatting (1.34 seconds),
and typecheck (21.23 seconds); the typecheck baseline remains unchanged.

The native Android workflow is implemented for trusted `iExalt` pushes to `dev`.
It builds only arm64 on Ubuntu 24.04, uses code `100000 + GITHUB_RUN_NUMBER`,
and passes the candidate to a separate checkout-free signing job. Ten workflow
contract tests passed. Three absent-only repository secrets were provisioned for
the matching fork Firebase client and durable PKCS#8 signer/certificate; the client
project/package and approved certificate fingerprint were verified before upload.
The Firebase Admin SDK and age private key are excluded. Actual native build,
final artifact, and device proof remain pending.

The first standalone Android CI run at `a5fa7f93bfc513db5e16dcac1f9e0b93e7705f95`
([run 37968851061](https://github.com/iExalt/paseo/actions/runs/37968851061))
ended at 18:08:15 UTC (2:08:15 PM EDT), after 19m53s, with only
`The operation was canceled` during Gradle. The job's timeout was 30 minutes,
there was no step timeout, and concurrency cancellation was disabled.
Kotlin compilation and Metro bundling had progressed; 81 GB remained free after
SDK setup. No source error, OOM, process exit code, or cancelling actor was
reported. The cause is unknown; no arbitrary source repair or replay was made,
and the signer never ran.

The canonical Mac build lane is implemented locally as the callable
`macos-closure.yml` workflow and `nix-release-closure.sh` helper. It replaces the
standalone push-triggered probe and uses the fixed, explicitly local-built Node
seed. A distinct durable Nix key is preserved in the private Keychain repository
and provisioned as `PASEO_NIX_RELEASE_SIGNING_KEY`; the public pin is fixed
in source and the secret reaches only the export/sign step. The producer allows
60 minutes for building within a 90-minute job; a separate 20-minute verifier
imports the exact artifact into a rooted store with builders and substituters
disabled. Source/lock/derivation/output identity and closure NAR metadata remain
required. Bash, ShellCheck, actionlint, sequence-boundary checks, and cheap archive
fixtures passed, including rejecting unsafe AppleDouble members before filtering.
This callable lane has not been invoked; full canonical build proof remains pending.
Producer-pinned manifest hashes prove same-run transport, not independent release
authentication, and a rooted-store import does not prove application launch.

The first paired run
([37971783372](https://github.com/iExalt/paseo/actions/runs/37971783372),
`03f9654109b82023e2bd0682381023a7fb9793b8`, sequence 200001) exposed a seed
transport prerequisite: the existing seed Release was still a draft and could
not be fetched with the lane's read-only token. It failed before a desktop build.
The unchanged dependency cache Release is now a published prerelease, excluded
from latest-app promotion; target, both asset sizes/digests, and anonymous HTTP
200 tag visibility were verified. Its local-built provenance and signing pins
are unchanged. Application release discovery must exclude this seed namespace
and prereleases. Android then ended at 18:33:54 UTC (2:33:54 PM EDT): its
assemble step was cancelled after 18m10s, before the 30-minute job cap. Logs
again report only cancellation, with no initiator, timeout, Gradle failure, OOM,
or disk-full evidence. Signing and artifact verification did not run. The two
similar cancellations require bounded diagnosis before another build; no rerun
has been made.

The next approved paired run adds a bounded Gradle resource wrapper without
changing the two-worker command or 30-minute Android job budget. It records
once-per-minute UTC memory/disk/process-name snapshots and readable cgroup OOM
counters, then preserves actual child exit and INT/TERM statuses. No arguments
or environment values are logged. One fast regression covers success, failure,
signal forwarding, and sampler cleanup; all fourteen workflow tests, Bash syntax,
ShellCheck, actionlint, and scoped lint/format checks passed. The prior serial
repository checks remain valid for unchanged application/TypeScript sources.
If another run yields only an undifferentiated cancellation, stop Android CI
retries and investigate external cancellation/runner causes rather than adding
more wrappers.

The paired BUILD entry point is published in `fork-builds.yml` at
`03f9654109b82023e2bd0682381023a7fb9793b8`.
Build-relevant trusted `dev` pushes pass one immutable source SHA and
`200000 + GITHUB_RUN_NUMBER` sequence/code to both callable lanes. Attempt-specific
artifacts retain retry identity; paired completion downloads exact artifact IDs,
checks trusted content hashes and platform metadata, and emits only a candidate
manifest. A reviewed follow-up records each lane's artifact attempt and permits
an earlier successful lane when the other is retried, while retaining the same
source, sequence, and exact artifact IDs. Thirteen workflow contracts passed,
including mixed-attempt and upstream-only website deployment guards. The first
integrated run failed as recorded above; full paired artifact proof remains pending.
The required serial pre-publication batch passed lint (19.53 seconds), formatting
(0.87 seconds), and typecheck (19.91 seconds); the retained 14.2-second typecheck
baseline is unchanged.

Complete-release promotion is implemented as a local, explicit CLI in
`scripts/promote-fork-release.mjs`, with a portable manifest contract in
`packages/protocol/src/release-manifest.ts`. `prepare` validates a selected
successful paired run, immutable source, lane attempts, artifact IDs, GitHub
digests, and both platforms' metadata and file hashes. `publish` revalidates
those inputs, signs the manifest, atomically claims its tag, and verifies the
draft's exact assets before publication. Existing tags/releases are rejected;
ambiguous partial publication preserves its claim for manual recovery rather
than overwriting assets. Authenticated prior fork releases must have lower
sequence and Android code; dependency caches and prereleases are excluded.
Promotion operations must be serialized: the final prior-release check is not
a repository-wide atomic publication lock.

A distinct Ed25519 manifest key is preserved in the private Keychain repository
as `paseo-release-manifest-ed25519.pem` and `.pem.pub`, with private mode 0600.
Only its public pin and key ID `paseo-release-manifest-1` are retained here;
no manifest-signing GitHub secret is needed. Existing TweetNaCl verifies Node
Ed25519 signatures, providing a feasible Android verifier without assuming
native Ed25519 availability on every supported API level. Eight fast promotion
tests and four protocol tests cover signature tampering/wrong keys, producer-shaped
metadata, incomplete/mismatched targets, monotonicity, collisions, and rollback
references. These are source/fixture proofs; no complete candidate was prepared
and no application release was promoted. Publishing a fork release cannot
deploy the upstream website.

From a reviewed checkout, prepare the selected candidate with explicit IDs:

```sh
mise exec -- node scripts/promote-fork-release.mjs prepare \
  --run-id RUN_ID --attempt ATTEMPT --source-sha FULL_SHA \
  --candidate-artifact-id CANDIDATE_ID --macos-artifact-id MACOS_ID \
  --android-artifact-id ANDROID_ID
```

Review the resulting receipt under `.dev/fork-auto-update/promotions/` before
invoking the separate publication operation:

```sh
mise exec -- node scripts/promote-fork-release.mjs publish \
  --receipt .dev/fork-auto-update/promotions/run-RUN_ID-attempt-ATTEMPT/promotion-receipt.json \
  --private-key-file /Users/clliaw/Projects/Keychain/paseo-release-manifest-ed25519.pem
```

These commands have not been run against a complete candidate.

The user subsequently authorized notification-only Expo onboarding. A minimal
`fork` EAS profile selects `APP_VARIANT=fork`; explicit Android code and protected
Firebase build inputs are supplied in the credential command's environment.
Authentication and project info confirmed account `iexalt` and the expected Expo
project; the interactive flow resolved `sh.paseo.iexalt`. After source review and
an evidence-based retry of the same FCM V1 flow, the CLI offered an existing Expo
account credential matching the verified Firebase project. It was reused, and EAS
confirmed FCM V1 assignment to `sh.paseo.iexalt`; the post-assignment metadata
showed the matching project. No new service-account key was uploaded or generated,
and no keystore or submission credential was assigned. Protected temporary files
were removed and their absence verified. This proves remote delivery-credential
association, not notification permission, token registration, or S24 delivery.

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
- [x] Implement and verify the Android fork identity/version-code source contract.
- [x] Encrypt and verify Firebase credentials, including the replacement fork client config.
- [x] Wire the fork Firebase build input and associate its matching Expo FCM V1 credential.
- [ ] Complete canonical CI/fresh-host closure proof and record the route decision.
- [ ] Prove notification permission, token registration, and Expo delivery on the S24.
- [x] Implement paired build and explicit complete-release promotion source contracts.
- [ ] Produce both verified CI artifacts and exercise complete-release promotion.
- [ ] Implement platform update interfaces and recovery.
- [ ] Pass actual-device CI artifact install/update/recovery gates.

Next campaign action: diagnose the repeated Android cancellation, then use the
reviewed integrated revision to finish canonical full-closure and signed APK
proof in the paired pipeline. Promotion waits for both real verified artifacts.
Standalone closure probe runs are stopped.
Platform updater implementation and actual transitions still need
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
