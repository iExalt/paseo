# Fork updates across desktop platforms

Status: implementation verified at the approved code-only boundary; final integration review and required PR checks pending.
Baseline: `4ed3b1cb5`. Prepared 2026-11-06 UTC.
Progress record: [workflow status](GITHUB_WORKFLOWS_STATUS.md#desktop-fork-updates).

## Outcome and scope

Show one **Fork updates** row in About, with no Stable/Beta selector. Check,
download, verify and apply fork releases through the app on every currently
shipped desktop target: macOS ARM64, Windows x64, and Linux Nix x64/ARM64.
Preserve Android ARM64's signed APK and system-installer flow.

The user selected: "Expand to automatic Windows/Linux updates; prepare a larger
plan and estimate first." Implementation approved 2026-11-07 UTC: "OK, I'm good with the implementation." The user also directed execution on the designated remote development host with keep-me-in-the-loop.
Release publication remains excluded. Autonomy is medium.
Implementation baseline: `4a3a8be53` on the Linux development host; the local checkout belongs to another task.

Automatic updates means background discovery and an in-app update flow. Applying
or restarting remains explicit. Active agent work must not be terminated to apply
an update. Missing, invalid or incompatible metadata produces an actionable state,
never an unsupported claim that the app is current.

The scope follows the current release inventory. It does not add Windows ARM64,
AppImage/DEB/RPM releases, macOS Intel, an iOS updater, a daemon-fleet updater, or
publisher certificates. Browser clients continue to update through their host;
iOS distribution remains owned by its store or device-management channel.

## Why the implementations differ

The fork initially implemented managed macOS Nix updates and Android APK updates.
Linux and Windows were deliberately released with manual upgrades. The desktop
About renderer still falls back to the upstream Stable/Beta interface outside the
Nix-managed path. That product distinction should disappear; installation adapters
remain because Nix generations, NSIS installers and Android installers have
different ownership, permission and process-lifetime rules.

Read evidence at the baseline:

- `packages/app/src/screens/settings-screen.tsx`, `renderAboutDesktopUpdateRow`
  and `DesktopAppUpdateRow`: Nix versus original desktop UI routing.
- `packages/app/src/android/fork-updates/updater.ts`, `isForkUpdaterShown`:
  Android-only fork row.
- `packages/desktop/src/features/auto-updater.ts`: the dynamic import reads a
  missing named CommonJS export. A local Node probe reproduced the screenshot's
  exact `autoDownload` error; the getter exists on the default export.
- `.github/workflows/release.yml` and `.github/scripts/release-manifest.mjs`:
  Windows/Linux assets are published separately from the signed schema-3 inventory.
- `packages/protocol/src/release-manifest-v2.ts`: installed schema-3 readers require
  exactly macOS and Android. Changing that inventory would break those readers.
- `nix/desktop-package.nix`: only macOS ships the updater helper and marker.
- `scripts/paseo-nix-update.mjs`: artifact selection, state paths and activation
  assume macOS. Its transaction/recovery model can be reused.
- `packages/desktop/src/daemon/daemon-upgrade.ts`: Windows file locks prevent
  leaving install-directory workers alive during replacement.

## Proposed design

Keep `paseo-release-manifest.json` and its signature unchanged for existing
macOS/Android readers. Publish a separately named signed desktop inventory for
Windows/Linux, using the existing Ed25519 key and pinned public key. Bind it to
the release version, tag, source, repository, lineage and original manifest hash.
Require exactly the three supported target cells and their immutable asset names,
sizes and digests. Windows also needs a signed SHA-512 digest for the existing
Electron download cache. Publication validates both inventories against the actual
upload set; a partial inventory must not publish.

For Windows, use a small custom metadata provider with the installed
`electron-updater` NSIS adapter. It consumes only verified fork metadata; it does
not fall back to unsigned upstream channel files. Correct the CommonJS import,
force fork release semantics at the native boundary so a saved Beta preference
cannot redirect the feed, and verify cached downloads as well as fresh ones.
Start with full installer downloads; differential updates are outside this phase.
The existing unsigned installer remains unsigned by Authenticode: the fork's
signed metadata authenticates its bytes, but does not remove SmartScreen warnings.

For Linux, generalize the existing Nix update transaction and receipt handling for
the published x64/ARM64 closures, XDG state paths and Linux launchers. Preserve
the existing macOS state root and receipts. Include the helper and an installation
marker in the closure. Resolve Linux installation identity from the trusted app
root or wrapper: `process.resourcesPath` belongs to shared Electron on Linux and
cannot identify the Paseo output. Validate the signed union closure for both the
CLI/daemon and desktop outputs, then activate the desktop profile.
Use a dedicated user-owned Paseo profile, with retained generations and recovery.
Do not rewrite Home Manager or a system-owned profile; make installation ownership
explicit at bootstrap and report conflicting ownership before activation.
Bootstrap also checks effective Nix permissions and trust configuration. A
multi-user Nix daemon may require an administrator to trust the existing release
key; report that prerequisite without changing system configuration or elevating.

Windows apply waits for a safe daemon shutdown and for processes using the install
directory to exit. Active agents or terminal work keep the update pending with a
clear explanation. Linux preserves the existing app/daemon lifetime separation.
Revalidate the selected release before apply; failure must leave a usable installed
version and a retry path. Seed version ordering from the running fork version;
confirm successful installation on new-version startup. A canceled or failed
installation must allow retrying the same verified target.

Old Windows/Linux clients cannot gain an updater retroactively. They need one
manual installation of the first release containing this implementation, with Linux
profile ownership established there. Later releases use the in-app flow. The new
client must tolerate older releases without the new inventory and explain that
the automatic-update channel is unavailable for that release.

## One proposed implementation phase

The main agent owns implementation and shared checks; one persistent reviewer
shapes and reviews each increment. A material finding affects feed trust, version
ordering, install/recovery correctness, state preservation, requested UI parity,
or a distinct required proof. Optional cleanup does not prolong the review loop.

- [x] **A. Compatible signed release metadata.** Add the strict desktop inventory,
      producer, asset catalog and publication checks. Prove that existing Mac/Android
      readers still accept unchanged schema-3 fixtures and ignore the new sidecars;
      reject changed signatures, assets, identity, target cells and digests. Windows
      and Linux adapters depend on acceptance of this contract.
- [x] **B. Working platform adapters.** Implement and review Windows and Linux as
      separate increments. Exercise the real NSIS provider/download/configuration
      entry point and Nix command/transaction entry point with controlled fixtures.
      Cover wrong architecture, stale releases, cached tampering, interrupted download,
      activation failure, lock contention and retry. Linux proof includes the wrapper
      identity, stable launcher and preservation of external profile ownership;
      Windows proof includes refused shutdown and daemon/terminal/installer ordering.
      Add native runner upgrade-smoke
      coverage where it can run without publishing or changing the user's machine.
- [ ] **C. Consistent UI and integration.** Show Fork updates for Mac, Windows,
      Linux and Android, with appropriate check/download/ready/waiting/error/retry
      states. Remove the channel selector and prevent legacy background checks and
      quit handlers from bypassing the new policy. Verify the rendered UI and actions,
      run combined checks, obtain final integration acceptance, then open and merge
      one PR to `dev` under the user's personal-repository policy.

Approval covers autonomous execution of these chunks, reports between chunks,
reviewed commits/pushes and PR merge. It does not cover release publication,
installation on the user's machines, disruptive restarts, paid credentials, or
changes to externally managed Linux profiles. A design failure or a material scope
change returns to the user before affected work continues.

## Verification and evidence boundary

Fast checks precede full affected suites. Baseline updater probe:
`mise exec -- npx vitest run src/features/auto-updater.test.ts
src/features/auto-updater-nix-mode.test.ts src/features/app-update-service.test.ts`
from `packages/desktop`: 43 tests passed in 6.52 seconds on this Mac, warm dependency
tree. Those mocks did not catch the real import failure, so the new regression
proof must exercise Node's actual CommonJS import behavior.

Use signed fixture releases and injected platform/filesystem/process adapters for
deterministic cross-platform proofs. Browser automation verifies the actual About
screen and actions for each bridge mode; Android's existing updater tests remain
required. Run full affected app/desktop/protocol/script suites once at the end,
plus type, formatting, workflow and required PR checks. Routine CI retains its
existing five-minute target and deep checks their fifteen-minute target; compare
against a current comparable baseline before adding native upgrade coverage.

Real Windows/Linux installation cannot be claimed from mocked adapters. Add
upgrade-smoke harnesses where feasible and report exactly which ran; native proofs
that cannot run stay explicitly unverified. A later, separately approved release
is needed for the first published-sidecar and real installed-client update proof.
Failure there blocks an operational-readiness claim, not the agreed code-only PR
acceptance boundary. Preserve pairing, settings and unrelated `.qa/` material.

## Estimate and risks

Proposed implementation: **2–4 hours of agent wall-clock, 7–9 review rounds**,
excluding user-response time, release publication and unavailable-device testing.
This starts from the calibrated 0.4–1.1-hour anchor for an existing-code component
with concurrent review, across the release contract, Windows adapter, Linux adapter
and UI/integration. The principal bounds are Linux profile/launcher adaptation,
Windows process locks, reviewer repair rounds and CI. Count overlapping work once;
do not add implementation agents or parallelize shared builds to meet the estimate.

Stop and re-plan if Linux ownership requires a new installation architecture,
Windows cannot apply safely without terminating active work, or the installed
NSIS provider cannot enforce signed metadata through cache/install. No new package
format or release target is silently added to work around such a failure.

At completion, compare actual wall-clock, review counts and compactions with this
estimate and record the calibration result in `~/.local/state/agent-estimates.md`.

## Progress

2026-11-07 UTC: A is verified and reviewer-accepted. Release fixtures: 9/9 pass
in 0.46 s on the Linux development host, warm dependencies (baseline 7/7 in 0.47 s).
Protocol typecheck and scoped lint pass. Review: A1 1 material/1 total;
A2 0/0, closing the producer-entrypoint proof gap. Windows/Linux installation
and UI remain unimplemented; no release was published.

2026-11-07 UTC: Windows adapter is verified at the code-only boundary and
reviewer-accepted. Five updater/safety suites: 57/57 in 0.38 s; worker lifecycle
fixture: 4/4 in 1.42 s; read-only blocker query: 1/1; existing manager checks: 10/10.
Root typecheck and scoped lint pass. BW1 2 material/2 total; BW2 0/0. The repairs
serialize apply/checks, block app-owned daemon starts through handoff, and
revalidate the native installer path after safe shutdown. Pending-create fixture
proves disconnect/create survival, without a deterministic scheduling barrier.
Actual Windows installation and late-error app survival remain unverified.
Linux and UI are next.

2026-11-07 UTC: Linux adapter is verified at the code-only boundary and
reviewer-accepted. Helper suites: 14/14 in 2.40 s; native marker/updater suites:
13/13 in 0.14 s. Scoped lint, desktop types and Nix syntax pass. BL1 2 material/2
total; BL2 0/0. Actual CLI fixture rehearses signed dual receipts, both closure
roots, failed bootstrap cleanup, interrupted activation replay, retention and
Linux/Mac recovery. Retained recovery now selects its existing Nix generation;
signed Linux CLI roots use an explicit daemon-profile guard. Hard process exits
retain the existing manual stale-lock recovery policy. Native Windows install,
Linux import/activation and Mac/Android installed-client upgrades remain unrun.
The station's untrusted Nix daemon lacks the release key; no configuration changed.

2026-11-07 UTC: UI and integration checks pass. About shows Fork updates without a
channel selector; refused installs retain their reason and retry action in About
and the sidebar. App updater/i18n/row checks: 72/72; Android compatibility and
related updater checks: 57/57; native service: 28/28; sidebar resolver: 11/11.
Browser bridge journeys: 6/6 in 58.2 s, followed by the extended Windows
sidebar/About journey: 1/1 in 24.6 s. Desktop, tablet and phone browser dogfood
reported no defects; native installers and device UI remain unverified. Root
typecheck, lint and formatting pass. C1 1 material/1 total; C2 0/0. Final
integration acceptance and required CI remain publication gates. No release
or installation on the user's devices was performed.
