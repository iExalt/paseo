# Smaller Android updates status

Last updated: 2026-10-29

## Purpose

This links the [plan](ANDROID_UPDATE_SIZE_PLAN.md), which holds the checklist,
to current evidence. It is not a second checklist.

## Current snapshot

| Field          | Status                                                                    |
| -------------- | ------------------------------------------------------------------------- |
| Baseline       | `de1cd5fef` (`chore(dev): release 0.13.1`)                                |
| Branch         | Phase 1 merged as `390a128bd` (#246); Phase 2 on `feat/android-size-cuts` |
| Current phase  | Phase 2 (diff prototype, size report); G-live waits for two releases      |
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

- `release-android-delta.mjs` at `d07627215` run on dev-station for `VERSION=0.13.1` against
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

- Release dry run 40966280437 at `390a128bd` ran the `android-delta` job in
  CI (6 min 26 s) and uploaded deltas from 0.13.0, 0.12.1, 0.12.0 and 0.11.1
  of 6.4, 10.0, 10.1 and 10.2 MB against a 57.4 MB `.gz`. They are larger than
  the rehearsal's because that build adds this campaign's own native and Kotlin
  code to 0.13.1. The draft was deleted.

- The installed `base.apk` on the phone hashed identically to the 0.13.1
  release asset, so the installed APK is a valid base.

### Smaller APK

Evidence state: implemented; measured on a local dogfood build.

- Deleting `paseo-diff-prototype` took native libraries from 74.5 to 69.8 MB
  (net of zstd-jni's 0.63 MB); the arm64 dogfood APK built on dev-station at
  `37a015749` is 165,324,625 B against 0.13.1's 170,062,966 B. The first CI
  measurement is the size table of the next release or dry run.

## Current boundary

- G-live has not run: the zstd-jni `.so` has not loaded on a device, and no
  phone has installed an update from a delta. The Cuttlefish tablet was
  unreachable (k0s API timeout) when the device probe was attempted.
- Phase 3 (R8) has not started. The unbundled barcode model was declined.

## Risks

- A broken delta falls back to the `.gz` without telling the user, so only the
  `PaseoForkUpdates` logcat lines prove the delta path at G-live.
- R8 renaming would churn the dex between releases and inflate deltas; Phase 3
  keeps `-dontobfuscate`.
- zstd-jni ships no consumer ProGuard rules and its JNI reads Java fields such
  as `nativePtr`. Under R8 without `-keep class com.github.luben.zstd.** { *; }`
  every update would fall back to the `.gz` without an error the user sees.

## Progress log

- 2026-10-29: Phase 1 chunks A–C implemented and reviewed; real-release
  rehearsal produced a 1.96 MB delta from 0.13.0. Merged as #246; a release
  dry run published deltas from CI.
- 2026-10-29: Phase 2 deleted the diff prototype and added the release size
  table; the barcode change was dropped to keep QR working without Play
  Services.
