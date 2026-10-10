# Paseo fork automated builds and updates

Status: paired canonical CI and authenticated release publication verified;
actual Mac and Android installation, transfer, and recovery pending. Updated 2026-10-09.

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

| Topic                  | State and consequence                                                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Required targets       | Decided: macOS `aarch64-darwin` desktop and Android `arm64-v8a` APK. A macOS-only pipeline is incomplete.                                                                                                                                        |
| Mac distribution       | Decided: Nix; no Apple Developer membership or signed/notarized Electron updater. Real macOS launch behavior still needs proof.                                                                                                                  |
| Hosting                | Decided: GitHub Releases; Wasabi is not needed for this route.                                                                                                                                                                                   |
| Closure transport      | Decided: GitHub Release assets containing an archived signed file binary cache; canonical CI and fresh-store import passed. Actual user-store activation remains pending.                                                                        |
| Android key            | Decided: new ECDSA P-256 private key, unencrypted at the user's request, in private `iExalt/keychain` as `android-signing`; X.509 PEM certificate as `android-signing.pub`. Ed25519 is not supported for APK signing.                            |
| Android migration      | Decided: separate `sh.paseo.iexalt` app with the new signer and fresh pairing. The user uninstalled Debug before transfer; its migration gate is unavailable without a retained backup. Verify the new fork's settings through future updates.   |
| Release cadence        | Decided: automatic paired builds from `dev`, with explicit promotion of selected revisions. Promoted releases must bind immutable artifacts to one revision.                                                                                     |
| Mac installation owner | Decided: dedicated Paseo Nix profile owns app generations; Home Manager may provide a stable launcher. HM must not also pin the app version.                                                                                                     |
| Update interaction     | Decided: explicit check/stage/activation controls; Android system installer confirmation and manual Mac restart. No disruptive automatic restarts.                                                                                               |
| Scope authority        | The user authorized the campaign, selected release publication, separate fork installation, and full Mac transition with production daemon restart after verified backups. Execute assigned components and preserve cold-backup/installer gates. |

Restart the production daemon on port 6767 only within the explicitly approved
Mac transition after backup verification. Treat desktop activation and daemon
activation separately. Preserve the original Android debug key and APK
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

The instrumented paired run
([37975774756](https://github.com/iExalt/paseo/actions/runs/37975774756),
`86fea77e907e81e0694fc47b749196a140ecbca1`, sequence 200002) passed the
canonical Mac build and fresh-runner closure verification. The pinned local-built
Node seed imported successfully; the desktop build ran from 18:50:14 to 18:58:18
UTC (2:50:14–2:58:18 PM EDT), about 8m04s. The producer finished at 19:02:30
UTC (3:02:30 PM EDT), about 14m17s total, and the separate verifier passed at
19:03:41 UTC (3:03:41 PM EDT), about 1m03s. This establishes the signed closure
route through GitHub-hosted assets for canonical CI build and fresh rooted-store
import, with explicit local dependency-cache provenance. The complete closure
travelled as an Actions artifact; only the dependency seed has been fetched from
a published Release so far. Select signed closure Release assets for future
delivery, with complete-release publication still pending.
Actual user-Mac store import and app launch remain unverified;
the rooted-store verifier cannot execute the logical system-store paths.
The Mac Actions artifact is `11638718757`, 160,757,839 bytes, with GitHub ZIP
digest `sha256:ae08406be0b69bd4adf1287abc7c31393339d6480a29497ea42cf28ebb855523`.
Android assemble was cancelled again at 19:09:38 UTC (3:09:38 PM EDT), after
19m18s, and the job ended at 19:09:41 UTC (3:09:41 PM EDT). Twenty resource
samples were captured. The last, at 19:09:25 UTC (3:09:25 PM EDT), showed
16.77 GB total memory, 16.33 GB used, and 438 MB available; `hermesc` used
9.70 GB RSS alongside two Java processes at 2.66 and 2.60 GB RSS (converted
from the `ps` KiB values). The wrapper
captured TERM and child/wrapper exit 143, with clean sampler shutdown. Cgroup
OOM counters were unavailable. This is evidence of severe memory pressure
coincident with cancellation, not proof of an OOM kill or its initiator.
Signing and paired completion were skipped. Stop blind Android retries and
diagnose Hermes/bundle and JVM memory inputs before proposing another build.
Read-only diagnosis found default Hermes optimization (`-O` plus source maps),
a 4096 MiB Gradle heap with 1024 MiB metaspace, and no explicit Kotlin daemon
heap limit. The retained `8bf821fea` standalone release used one Gradle worker
and completed in 8:55.92. Its bundle was 27,000,924 bytes; the current ignored
local bundle lacks matching CI revision provenance, so it does not establish
bundle growth. A one-worker constraint is a candidate based on that recipe,
not a verified memory fix. No additional build was run for this diagnosis.
The next build restores `--max-workers=1` and passes
`-Pkotlin.compiler.execution.strategy=in-process`, keeping parallel execution
disabled and the existing Gradle heap unchanged. The exact cached Kotlin Gradle
plugin 2.1.20 recognizes that property; [Kotlin documents the accepted value](https://kotlinlang.org/docs/compiler-execution-strategy.html)
and its loss of incremental compilation. The build is clean, and this constrains
compiler concurrency and a possible extra daemon without changing Hermes
optimization. The second captured JVM has not been identified conclusively.
Heartbeat evidence from one next paired build will test this hypothesis.

Follow-up paired run
[`37980068459`](https://github.com/iExalt/paseo/actions/runs/37980068459) used
`ab8b4367749551b01f97e5ce2c0fb8e867dc3f95`. Android reached the new module's
Kotlin compilation and failed at 19:45:08 UTC (3:45:08 PM EDT), after 17m53s,
with `PaseoForkUpdatesModule.kt:266:3 Missing return statement`. The child and
wrapper exited 1. The final captured sample at 19:44:19 UTC (3:44:19 PM EDT)
showed 5.73 GB used and 11.04 GB available; Java RSS was about 4.27 GB plus
289 MB, and Hermes was absent from the captured final top-five process samples.
This failure was source compilation rather than cancellation. The resource
change progressed beyond the earlier failure pattern, without proving all peak
memory behavior. The one-line repair returns the existing `try` expression;
native compilation remains a required next-build gate. Firebase plaintext
cleanup passed; no signed APK or complete candidate was produced.

The Mac build failed on the changed lockfile's fixed dependency hash. Its Nix
derivation specified `sha256-XTbk9VwrCHqjbHqvX5xTYPCw6ewCJ4R+M2+bALkrOos=` and
reported `sha256-tPxju2sUyUt1jE2cQ7CXUyglfvqD+VtMP7PAQwLzRjA=`. The reviewed
`nix/npm-deps.hash` correction uses that attested result; the lockfile remains
unchanged from this CI revision. Narrow streamed error excerpts resolved both
diagnoses. Batch these repairs after Electron integration is accepted before
the next paired build; no standalone probe or blind retry is needed.

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

The Android fork updater source is implemented in the existing Settings About
area. Manual actions check promoted stable fork releases, verify detached Ed25519
metadata against the protocol's independent public pin, download the ARM64 APK,
and open Android's installer after explicit confirmation and source permission.
The local Expo module streams a bounded HTTPS download through approved GitHub
hosts, checks exact size/SHA-256/package/version/single signer, and rechecks the
staged file before launch. It uses Expo FileSystem's existing private FileProvider
and adds `REQUEST_INSTALL_PACKAGES` only to the fork variant. APK bytes are never
buffered in JavaScript; byte progress is visible.

Signed staged metadata and the private APK survive restart. A small pending
receipt covers process death or receipt-promotion failure after atomic file
replacement; restore verifies both metadata and file before offering offline
installer retry. The installed sequence is recorded only after Android reports
the exact signed candidate code, including a new process after upgrade.
Installer cancellation and permission failure retain a retryable verified APK.
Pure release tests, mocked persistence tests, and a rendered Settings-row journey
cover the source contract; actual autolinking resolution discovers the module.
Kotlin compilation, real GitHub release consumption, installer behavior, and
S24 notification/device proof remain pending. The updater source was published
in `9c77c42d6dec3d64a17423b4d474bd2745fde461`; paired run
[`37980068459`](https://github.com/iExalt/paseo/actions/runs/37980068459) tests it
with the reviewed resource constraints at `ab8b4367749551b01f97e5ce2c0fb8e867dc3f95`.
Ten updater cases passed across the focused runs, with the existing i18n gate
also passing. The final serial repository batch passed lint (10.84 seconds),
formatting (1.32 seconds), and typecheck (13.50 seconds), against the retained
14.2-second typecheck baseline. No full local suite or native APK build was run.

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

## Installation contract and managed CLI

Expose check, stage, activate, status, and rollback operations; final command
names are implementation details. Stage downloads and verifies all required data
before changing the active generation. Import known store paths directly; do not
run a source build as a hidden fallback. Reject wrong platforms, malformed paths,
unsafe archive entries, stale release sequences, and partial manifests.

A dedicated profile owns the app version and retains its generations as GC
roots. Home Manager may provide an optional stable launcher, but must not also
pin the app version. Determine Nix daemon trust configuration during bootstrap;
do not disable `require-sigs` or grant broad trusted-user privileges as a shortcut.

Activation must preserve launch identity and settings paths, retain the old app
until migration succeeds, and report staged versus running versions. Keep the
running generation rooted until its processes exit. Nix installations expose
their update method and never contact or offer upstream Electron updates.
Rollback includes data compatibility or a tested backup/restore contract;
switching the executable alone does not roll back settings migrations.

The managed CLI source is implemented in `scripts/paseo-nix-update.mjs` and
packaged on Darwin as `$out/bin/paseo-nix-update`, with its own pinned Node 26
runtime and the shared release contract in the signed closure. Initial bootstrap
invokes this absolute path from a verified CI output; subsequent use may invoke
the dedicated profile's `bin/paseo-nix-update`:

```sh
PASEO_UPDATER="<verified-output>/bin/paseo-nix-update"
"$PASEO_UPDATER" check
"$PASEO_UPDATER" stage
"$PASEO_UPDATER" activate
"$PASEO_UPDATER" status
"$PASEO_UPDATER" rollback
```

The profile and private updater state live under
`~/Library/Application Support/Paseo/nix-update/`. Stage verifies the independent
Ed25519 release pin, archive/metadata size and SHA-256, safe streaming extraction,
and recursive Nix signatures plus exact closure paths/NAR hashes/sizes. The
per-command Nix public pin is
`paseo-nix-release-1:hOc4RkmgnDMh/+aZWDdwQKuZHDVvVPh0Fya+DNAA+b8=`.
An administrator may need to append that exact public key to the daemon's
`extra-trusted-public-keys` during a later approved bootstrap, preserving existing
keys. The approved bootstrap appended this public key and reloaded the daemon;
readback retained signature enforcement and root-only trusted users.

The isolated two-existing-output fixture proved that `nix-env --set` creates a
profile generation linked directly to the exact store output, retains the prior
generation, and rolls back to it. No user-environment derivation was needed;
builders, substitutes, and local builds are disabled. All generations remain
rooted, including any running version; no automatic GC or process restart occurs.
Rollback does not restore app data. Use the retained C helper for mapped rollback
and status, including after the active profile returns to B:

```sh
PASEO_UPDATER=/nix/store/60qjh1c1i9pv588xckd0pxhizxm98hbg-paseo-desktop-0.11.0/bin/paseo-nix-update
"$PASEO_UPDATER" status
# When C is active, validates B's signed receipt before the native rollback:
"$PASEO_UPDATER" rollback
```

The highest activated sequence survives rollback; staging requires a higher
sequence, so rollback does not immediately offer reactivation of the same release.
A pending activation references a verified signed receipt and survives a
durable-state failure for retry.
Non-help commands serialize with an exclusive private lock. After a crash, remove
a stale lock only after confirming no updater command is running. Six focused
tests, scoped lint/format/syntax checks, and Nix expression parsing passed.
Real promoted-release consumption, unprivileged user-store import/activation,
managed launch, and offline binary rollback have passed below. A direct native
profile switch is not a supported workaround for updater receipt invariants.

Electron integration now marks the Darwin app resources with the Nix ownership
contract and resolves the fixed updater CLI from that same immutable store output.
Missing CLI or malformed/copied markers fail closed. Nix mode blocks direct
Electron update APIs, catalog requests, updater imports, and update-on-quit;
unmarked desktop builds keep their existing behavior, with the fork release owner.
About exposes check, stage, explicit confirmed activation, and rollback through
fixed IPC commands, with bounded child output and no shell interpolation. It shows
running, active profile, and staged versions separately; activation leaves the app
and daemon running, and tells the user when a manual restart is needed. Tests cover
the emitted packaging marker, ownership gate, fixed CLI arguments/errors, and the
rendered controls. Required formatting passed (0.71 seconds) and full repository
lint passed after bounded refactoring (1.28 seconds). The initial serial workspace
typecheck took 16.43 seconds and found four integration errors; after correction,
only the affected app and desktop workspace typechecks were rerun and passed.
Other workspace results remain valid. Keep the accepted 14.2-second baseline;
this failed aggregate run does not establish a new baseline. The affected rendered
UI and CLI tests passed, along with ownership/bridge tests and the emitted-marker
regression. No production app was launched or activated. Actual Android native
compilation and a complete paired candidate remain required before promotion.

The integrated revision `41a5325d34f80a4f11194769d8e30ff56958e67a` was pushed at
20:15:23 UTC (4:15:23 PM EDT). Paired run
[37985740284](https://github.com/iExalt/paseo/actions/runs/37985740284), attempt 1,
used shared sequence `200004`. The Mac build passed in 6m29s, including the new
CLI and ownership-marker packaging. Its producer uploaded artifact `11643731453`
(160,781,391 bytes; GitHub digest
`3b175ceab6e1816579f38cedb3d85ab53efffe48e24a9e4829ed83194288cf06`). A separate
fresh runner passed signed import/verification at 20:29:27–20:29:47 UTC
(4:29:27–4:29:47 PM EDT). This proves CI packaging and transport; real promoted
release consumption, user-store activation, and Mac launch remain unverified.
Android assemble was again cancelled at 20:34:58 UTC (4:34:58 PM EDT), after
18m04s of Gradle and 19m28s overall, before the 30-minute job limit. The structured
annotation reports only “The operation was canceled”; it establishes neither
OOM nor a compiler failure. Signing and complete-candidate checks were skipped,
so no APK or paired release candidate exists. Stop further blind builds; compare
the existing bounded heartbeat/exit evidence before choosing the next remedy.
That permitted evidence records Hermes at 1,461,664 KiB RSS with 9,488,801,792
bytes available at 20:33:57 UTC (4:33:57 PM EDT), then 13,463,484 KiB RSS
(13,786,607,616 bytes) with only 393,822,208 bytes available at 20:34:57 UTC
(4:34:57 PM EDT). The wrapper forwarded TERM and exited 143; its child also
exited 143. The one-worker/in-process change did not bound Hermes memory.
This is severe contemporaneous memory pressure, not proof of an OOM kill or
the cancellation initiator. No cgroup OOM counters were emitted.

Paired run [37989881874](https://github.com/iExalt/paseo/actions/runs/37989881874)
passed at 21:25:01 UTC (5:25:01 PM EDT) for immutable source
`385be0adbf127e1de542c7b5ba9cca4303bcb389`, attempt 1, shared sequence/code
`200005`. The Mac build took 7m48s; the separate fresh runner imported and
verified its signed closure in 19 seconds. Mac artifact `11644648746` is
160,783,951 bytes, with GitHub artifact digest
`e14386b6e38b765683be062a6a4912527d5c6332d4b3b684841e0e6a6132115c`.
Android assemble passed in 28m08s, including the updater native module and
preference receiver. The task-owned swap cleanup passed; its last safe sample
showed 9,708,441,600 bytes available RAM and 1,827,794,944 bytes used swap.
The separate signing job produced artifact `11646280827` (53,725,273 bytes;
GitHub digest `3934cc3e4aef7d2660c72a52044c87428c7049286e6072df5ecbe0056b9b5352`).
Its APK digest is
`f39d5f49f855505e70faad2ba35425bb1ee4b7cfbc2e48d185c3a28d7ffb7040`;
verified identity is `sh.paseo.iexalt`, code `200005`, arm64-v8a, non-debuggable,
with the approved fork signing certificate. Complete-candidate artifact
`11645952229` binds both verified lane outputs. These are CI proofs; installation,
preference transfer, notifications, and actual updater/rollback journeys remain
separate device gates.

Promotion preparation exposed two producer-contract mismatches: prefixed versus
bare artifact digests, and the signer-generated APK `.idsig` sidecar. The tool
now validates and normalizes both digest forms and accepts only the exact optional
sidecar without extracting or publishing it. Before another prepare, an offline
audit of the actual downloaded candidate and lane files passed all identities,
hashes, and checksums. The user authorized explicit promotion of candidate
`200005` and the full Mac transition after recoverable backups, including the
production daemon maintenance window. The final prepared receipt passed review,
and the selected release is now public:
[candidate 200005](https://github.com/iExalt/paseo/releases/tag/paseo-fork-v0.11.0-r200005-385be0adbf127e1de542c7b5ba9cca4303bcb389).
Its six published assets retain the reviewed identities and byte digests. Both
actual consumer verification paths accepted the independently downloaded manifest
and detached signature with their pinned key. The manifest SHA-256 is
`a509d01032dde25a6cbc34fe9410ec19d2e72605500cd622c3ded395e4a397bb`.
Later releases and actual host/device transitions are recorded below.

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
decided. The user explicitly authorized the full Mac transition and production
daemon restart after verified recoverable backups, and the separate fork's initial
phone installation. Automate device observation where possible; retain the human
Android installer confirmation and the final cold-backup gate before Mac launch.

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
- [x] Complete canonical CI/fresh rooted-store closure proof and select signed closure assets.
- [x] Prove notification permission, token registration, and Expo delivery on the S24.
- [x] Implement paired build and explicit complete-release promotion source contracts.
- [x] Implement and test the Android fork update interface source contract.
- [x] Implement and test the Mac managed Nix CLI source and isolated profile lifecycle.
- [x] Integrate and test Nix ownership and managed update controls in Electron source.
- [x] Implement preference-only Android transfer with a recoverable import journal and startup gate.
- [x] Produce both verified CI artifacts from one immutable paired candidate.
- [x] Publish and verify its authenticated complete release.
- [x] Activate the backed-up managed Mac installation and verify its daemon and native terminal.
- [x] Pass the S24's A-to-B in-app update, installer cancellation/retry, and settings/connection preservation.
- [x] Implement and test distinct signed release identity and native Nix generation handling.
- [x] Implement platform update interfaces and tested signed recovery state handling.
- [x] Pass managed Mac B-to-C launch and offline binary rollback to usable B.
- [x] Pass S24 B-to-C in-app higher-code recovery with installed-byte, theme, and permission preservation.
- [x] Acknowledge the S24's live saved connection after C recovery without re-pairing.
- [x] Pass actual-device CI artifact install/update/recovery gates, with visual/reactivation limitations below.

The earlier preference-only migration design left drafts and attachments in
Debug; the subsequent user uninstall made that device transfer unavailable.
The optional source bridge is an explicit `APP_VARIANT=development`
`PASEO_PREFS_MIGRATION_BRIDGE=1` build of `sh.paseo.debug`, code 11001, using the
existing Debug signer. It exports allowlisted settings through the Android share
sheet; the fork previews selected sections and requires confirmation before
replacement. Files can contain personal paths. Credential registries, client
identities, push tokens, arbitrary plugin values, and volatile agent/session state
are excluded. Imports retain before-images and recover before store hydration.
Bridge packaging, installation, and transfer of real device settings remain
unverified; that device task is retired after the user uninstalled Debug.
The focused migration tests passed (13 cases in 2.42 seconds); a subsequent
cleanup-failure regression passed with the affected four-case UI suite in 1.25
seconds. Runner lifecycle/workflow tests passed (16 cases in 1.08 seconds), with
ShellCheck and actionlint. Repository format and lint passed. The serial aggregate
typecheck took 13.36 seconds against the accepted 14.2-second baseline and found
only new migration types; after correction, the app-only typecheck passed in
3.51 seconds and other workspace results were reused. No full local suite or APK
build was run.

The connected S24 Ultra initially ran API 36 and
Debug 0.11.0/code 11000 with the preserved Debug certificate; the fork was absent.
The user confirmed the Android system installer, and the installed fork matches
the public release's bytes, signer, code 200005, and ARM64 identity. Its own-app
screen rendered the normal welcome/pairing interface. Automatic pairing then
succeeded through the app's Paste Link and Connect controls. The normal Android
notification prompt was accepted, and the daemon acknowledged the fresh
registration at 22:40:48 UTC (6:40:48 PM EDT). One direct Expo test targeted only
that registration, returned an `ok` ticket, appeared on the phone, and opened the
fork when tapped. This proves Expo-to-fork delivery, rather than agent-attention
policy. The ticket ID was not retained, so no receipt query was performed. The
visible app baseline is Theme = System, with notification permission granted;
screen timeout is restored to 300000 ms and stay-awake remains 0. Debug's bridge
upgrade was not performed. At 21:54 UTC (5:54 PM EDT), Debug was absent from
user 0; the 20:43 UTC (4:43 PM EDT) inventory had found it installed. The user
confirmed uninstalling Debug. Without a retained settings backup, its original
preference-transfer gate is unavailable. The bridge artifact task is retired;
the optional source utility remains. Future device gates must preserve the new
fork's settings and pairing through updates, rather than claim old Debug transfer.

Private preliminary backups retain the full Electron userData and `~/.paseo`,
including all unique state and models, plus the exact root Nix custom config.
Archive extraction and representative comparisons passed; six extracted SQLite
databases passed `quick_check`. The live app profile stayed byte-stable, and only
`daemon.log` appended during the daemon-state capture. This is preliminary
recoverability evidence. The approved graceful app quit and daemon shutdown
subsequently left zero app/daemon processes, listeners, and open state handles.
The separate final cold backup includes the new phone registration, preserves
112 userData files and 1530 daemon-home files with exact source/extraction parity,
and passes six extracted SQLite checks. Direct restored-file byte comparisons
also passed for selected settings and identities. No LevelDB semantic checker
was run; its recovery evidence is the quiescent byte-identical archive. Original
and current root Nix configs are both retained. The old `/Applications/Paseo.app`
remains intact.

The user completed the approved root Nix public-key append and daemon reload;
readback preserves root-only trusted users and signature enforcement. Real staging
exposed an unescaped `Application Support` file-cache URI. The reviewed bootstrap
source now uses `pathToFileURL`, with its focused argument regression passing.
Published 200005's bundled CLI retains this defect and must be replaced by a
future CI-built release; its immutable assets are unchanged. Staging then reached
signature enforcement during copy and stopped on untrusted paths. The daemon
reload and root signature were verified; the 69-path closure has 65 stock-cache
signatures, the durable fork signature on its root, and three pre-existing Node
paths without local signatures. Their cache signatures use the earlier seed key.
The correction must sign every exported path with the durable key and merge valid
cache signatures for existing consumer paths, proved with an isolated store and
only the durable public key. That source correction is reviewed: its real
111,400-byte input-addressed fixture starts unsigned, imports only the ephemeral
new signature, accepts that key, and rejects the other key in 1.12 seconds. The
producer runs this required gate after importing its pinned Node runtime. Seven
fast updater unit cases passed in 104 ms; scoped lint, formatting, shell syntax,
ShellCheck, and diff checks passed. Candidate 200006 carries the correction
and URI fix; release 200005 remains unchanged. A partial root import occurred,
but no staging profile, app activation, shutdown, or production daemon restart
occurred.

After the latest Hermes growth, the user authorized one build with a task-owned
16 GiB swapfile and a 60-minute Android job cap. The workflow requires measured
24 GiB free before allocation and 8 GiB remaining afterwards, preserves existing
swap, and always attempts cleanup. It retains the file if active-state verification
or `swapoff` fails. This changes runner resources without changing Hermes
optimization or app behavior. The selected paired run passed with this resource
configuration and verified swap cleanup.

The corrected paired run
[37999220097](https://github.com/iExalt/paseo/actions/runs/37999220097) passed from
22:26:25 to 22:49:52 UTC (6:26:25 to 6:49:52 PM EDT): Android build 22m31s,
signer 32s, Mac producer 9m17s, and fresh verification 1m9s. Both artifacts bind
source `390532322bf21ec5c243608f58cf63cb851ef664` and sequence/code 200006.
The Mac verifier accepted all 69 runtime paths under the durable key alone.
After explicit user selection,
[release 200006](https://github.com/iExalt/paseo/releases/tag/paseo-fork-v0.11.0-r200006-390532322bf21ec5c243608f58cf63cb851ef664)
was published and independently verified through both actual manifest consumers.
Its six public asset sizes and digests match the prepared files; the APK SHA-256
is `28803d5977a982918050cb699689bd9dc8a18489c0532f38215daf52326fc8c8`
and closure archive SHA-256 is
`b2f91d181f59f5ea85dbc31cf6f330236179b16d903eae75a6e3dd1bd9705536`.
Local-built Node seed provenance remains explicit.

Actual Mac staging imported release 200006 through the unprivileged Nix daemon;
all 69 paths contain the durable signature and match the signed NAR hashes/sizes.
After cold-backup acceptance, activation selected the dedicated profile and an
absent-only `~/Applications/Paseo.app` link. The exact release store executable
is running with the Nix marker, packaged updater CLI, and reachable production
daemon. Selected settings, daemon identities, and fresh phone registration remain
equal to the cold baseline. One temporary terminal produced the expected literal
output and was removed. About-row visual observation is blocked by macOS
assistive-access permission; no permission was changed.

The S24's in-app updater downloaded and staged B, then opened the system installer.
Cancelling once retained code 200005 and the staged download; retrying the same
stage installed code 200006 with the pinned signing certificate. Theme = System,
notification permission, and a positive connected-host indicator persisted without
re-pairing. The app's install-source permission returned to its original off state;
`screen_off_timeout=300000` and `stay_on_while_plugged_in=0` were restored and read back.

The reviewed updater source now separates signed release identity from the native
Nix generation. Its atomic local state records receipt identities and the highest
activated sequence; every receipt is independently signature-verified and bound
to its exact identity and output. The local mapping is not itself cryptographically
authenticated. Same-root activation and explicit metadata rollback leave the binary
generation unchanged, and rollback never lowers the sequence high-water mark.
Native rollback validates the mapped target before switching. Interrupted operations
recover an exact completed switch or leave an unchanged profile retryable; an
unexpected profile fails closed. Legacy migration precedes new receipt storage and
rejects ambiguous identities. A harmless two-output profile fixture confirmed that
Nix reuses a retained generation after rollback; activation uses the observed
generation rather than predicting its number. Thirteen focused tests passed with
the existing opt-in signature fixture skipped; formatting, lint, and diff checks
passed. The correction is committed as
`9948430607b1e09fee11a702af9bcedce4d52135`.

Paired candidate 200007 passed
[run 38007082250](https://github.com/iExalt/paseo/actions/runs/38007082250), attempt 1,
from 00:00:03 to 00:17:41 UTC on October 10 (8:00:03 to 8:17:41 PM EDT on October 9).
The Mac producer took 15m17s and fresh verification 1m00s; Android build took
16m40s and signing 28s. Its prepared receipt selects authenticated release 200006
as `rollbackOf`. The Mac output
`/nix/store/60qjh1c1i9pv588xckd0pxhizxm98hbg-paseo-desktop-0.11.0`
differs from B, with 69 signed runtime paths. Android retains the package, signer,
and application source from B with increasing code 200007. After explicit user
selection, [C was published](https://github.com/iExalt/paseo/releases/tag/paseo-fork-v0.11.0-r200007-9948430607b1e09fee11a702af9bcedce4d52135)
and independently verified through both pinned manifest consumers, including its
exact signed `rollbackOf` reference to B. All six public asset sizes/digests match
the staged files; APK SHA-256 is
`8f790e3e45e1f1fd25fc118b430cd050d5c2779d9befb858462077fbcbdf134d`
and closure archive SHA-256 is
`d09d45f49a0231f2929d4cf002053db39771fa3d4115bbce1d4822b43aecc119`.
Actual Mac staging verified C through the unprivileged daemon without compilation.
Refreshed preliminary and final quiescent backup deltas preserve all changed unique
state over the retained full backup; extraction comparisons and six SQLite checks
passed before launch. Activation selected native generation 2/C, and the exact C
store executable launched with the production daemon. Selected settings and five
daemon identity/pairing/client/push files stayed equal; one window geometry field,
`state.x`, changed while the other five fields and field set remained equal.

The retained C helper then performed a real offline rollback to generation 1/B
under a process sandbox denying outbound IP connections while permitting the local
Nix daemon Unix socket. It validated B's signed receipt, reported a binary change,
and kept high-water 200007. The running C process and daemon remained alive until
the separately authorized graceful restart. A refreshed cold backup again passed
extraction and SQLite checks before the exact B executable relaunched. B's daemon
returned HTTP 200 from its supported status endpoint. B's status-only helper left
the atomic mapping unchanged; both helpers report active B200006, high-water
C200007, no staged release, and no pending operation. Both native roots remain
retained. This proves binary rollback and launch/state preservation; it does not
claim data-schema rollback or the blocked About visual observation.

Current Mac: usable B with latest C retained. The supported commands cannot
reactivate that exact highest sequence after rollback: stage rejects sequences at
or below high-water, and the prior stage is consumed. Use the retained C helper for
status; avoid B's mutating updater commands and do not bypass mapping with a manual
profile switch. Explicit reactivation needs a separately reviewed implementation;
a future higher-sequence release can follow the ordinary stage/activate path.
The packaged script is
a derivation input; a sequence-only metadata change remains outside the derivation.
Same-root metadata changes will not count as binary rollback proof. Android forward
recovery must use a higher code with the same package and signer, with signed
`rollbackOf` identifying the selected known-good published release; cancellation
and retry alone do not prove recovery. The S24 completed B-to-C through in-app
Check, verified Download, Install, and Android's standard Update confirmation.
The installed APK is exactly 140,620,645 bytes with the public C SHA-256 above,
binding it to the CI-verified signing certificate. Actual package metadata reports
`sh.paseo.iexalt`, code 200007, ARM64, and no debuggable flag. Theme = System and
notification permission remain unchanged. Saved connection rows are visible, but
the welcome view did not show a positive live acknowledgement. No re-pair or
data clearing was performed. One source-informed normal selection of the sole
saved Mac connection reached the open-project/workspace view, consistent with the
route for a host without a restorable workspace. About showed the Connected hosts
heading, but neither a daemon-version row nor an Offline label was observable.
That About observation remains inconclusive. In the already-inspected host-picker
image from the same post-C attempt, the sole saved Mac host displayed a small
circular green status dot, distinct from a selection checkmark. Source review binds
that dot to runtime `online`, which requires the client's completed
`HELLO_SERVER_INFO` handshake and rejects authentication failures. This proves live
reconnection without re-pairing; saved rows or registered notification tokens alone
would not. Screen timeout 300000 ms, charging stay-awake 0, and the fork's
install-source permission off were restored and read back after both phone tests.
Temporary UI captures were removed; the visual observation is first-hand evidence,
not a retained screenshot. Final device state is Mac B200006 and phone C200007.
The old Debug transfer gate is unavailable after the confirmed uninstall.
No lock/security setting was disabled during phone automation.
Standalone closure probe runs are stopped.
Remaining actual-device gates retain their assigned acceptance boundaries.
Reconsider the route if
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
