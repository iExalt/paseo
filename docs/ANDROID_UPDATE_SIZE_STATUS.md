# Smaller Android updates status

Last updated: 2026-10-29

## Purpose

This links the [plan](ANDROID_UPDATE_SIZE_PLAN.md), which holds the checklist,
to current evidence. It is not a second checklist.

## Current snapshot

| Field          | Status                                                                    |
| -------------- | ------------------------------------------------------------------------- |
| Baseline       | `de1cd5fef` (`chore(dev): release 0.13.1`)                                |
| Branch         | `feat/android-apk-delta`                                                  |
| Current phase  | Phase 1 code complete; G-live waits for two stable releases               |
| Overall state  | Delta path implemented and verified off-device; not yet proven on a phone |
| Release claims | No release ships deltas yet; no on-device delta install has happened      |

## Accomplishments with evidence

### Delta applier and transfer chain

Evidence state: implemented; verified on the JVM.

- `ZstdPatch.kt` rebuilds the APK from a delta against the installed APK in one
  mapped pass, at exactly the signed size.
- `TransferChain.kt` tries delta, `.gz`, APK; a cancel stops the chain, a live
  transfer resumes it at its position, and transfer names are validated before
  they reach DownloadManager.

Evidence:

- `:paseo-fork-updates:testReleaseUnitTest` on dev-station: `ZstdPatchTest`
  4/4, `TransferChainTest` 7/7, `BoundedGunzipTest` 3/3.
- `packages/app/src/android/fork-updates` vitest: 22/22.
- Reviewer probe on the real pair with zstd-jni 1.5.7-12: 0.13.0 plus the
  0.13.1 delta (162 MiB window) decoded to the 0.13.1 sha `e126de3e…` at a
  38.7 MB peak footprint.

### Release deltas

Evidence state: implemented; rehearsed against real releases.

- `release-android-delta.mjs` run on dev-station for `VERSION=0.13.1` against
  the published releases (zstd 1.5.5, as on the CI runner), each delta
  re-applied to the signed sha:

| Base   | Delta       |
| ------ | ----------- |
| 0.13.0 | 1,957,610 B |
| 0.12.1 | 7,546,666 B |
| 0.12.0 | 7,719,573 B |
| 0.11.1 | 7,904,190 B |

Four bases took 3:07 wall time at a 1.84 GB peak RSS. The `.gz` is
57,110,026 B.

- The installed `base.apk` on the phone hashed identically to the 0.13.1
  release asset, so the installed APK is a valid base.

## Current boundary

- G-live has not run: the zstd-jni `.so` has not loaded on a device, and no
  phone has installed an update from a delta. The Cuttlefish tablet was
  unreachable (k0s API timeout) when the device probe was attempted.
- The `android-delta` job has not run in CI; the first release after merge is
  its first run.
- Phases 2 and 3 have not started.

## Risks

- A broken delta falls back to the `.gz` without telling the user, so only the
  `PaseoForkUpdates` logcat lines prove the delta path at G-live.
- R8 renaming would churn the dex between releases and inflate deltas; Phase 3
  keeps `-dontobfuscate`.

## Progress log

- 2026-10-29: Phase 1 chunks A–C implemented and reviewed; real-release
  rehearsal produced a 1.96 MB delta from 0.13.0.
