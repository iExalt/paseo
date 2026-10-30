# Smaller Android updates status

Last updated: 2026-10-30

## Purpose

This links the [plan](ANDROID_UPDATE_SIZE_PLAN.md), which holds the checklist,
to current evidence. It is not a second checklist.

## Current snapshot

| Field          | Status                                                                   |
| -------------- | ------------------------------------------------------------------------ |
| Baseline       | `de1cd5fef` (`chore(dev): release 0.13.1`)                               |
| Branch         | Merged: `390a128bd` (#246), `b2db9a9cd` (#249), `b267f1890` (#250)       |
| Current phase  | Complete: every phase merged and both live checks passed                 |
| Overall state  | The phone updated 0.14.0 → 0.15.0 from a 1.0 MB delta                    |
| Release claims | 0.14.0 is the first R8 release with the delta client; 0.15.0 used deltas |

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

### R8

Evidence state: implemented; device-checked on the tablet without network.

Local arm64 builds on dev-station (dogfood variant, unsigned, same machine):

| Build                    | Dex     | APK           | `.gz -9`     | Delta 0.13.0 → 0.13.1 |
| ------------------------ | ------- | ------------- | ------------ | --------------------- |
| 0.13.0/0.13.1 without R8 | 59.7 MB | 169,959,832 B | 57,004,799 B | 2,101,619 B           |
| 0.13.0/0.13.1 with R8    | 27.9 MB | 137,813,721 B | 46,467,049 B | 2,093,422 B           |

- R8 left the dex unchanged between the two releases (4 dex files, none
  changed), so `-dontobfuscate` with optimization on does not inflate deltas.
  Without R8, `classes6.dex` changed.
- Resource shrinking removed 21 library drawables and raw keep files; all 7
  drawables bundled from JS assets survived.
- The R8 build keeps all 39 `com.github.luben.zstd` classes, their native
  methods and `nativePtr` (dexdump).
- Build time and peak memory matched the builds without R8 (8–16 min, about
  1.2 GB, with other builds running).
- Cuttlefish tablet, `sh.paseo.debug` release build with R8 at `b2db9a9cd`:
  launch, connect, chat markdown with highlighted code, sending a message,
  terminal, Skia diff view, the QR camera, and a cold restart all worked, with
  no `ClassNotFound`, `NoSuchMethod`, `NoSuchField` or JNI errors in logcat.
  The update check could not reach GitHub (no network in the guest), so the
  updater under R8 is first exercised after release.

- Release dry run 40979129503 at `b267f1890` (fork variant, CI): the Android
  build passed in 12 min 54 s with R8 (`BUILD SUCCESSFUL in 9m 57s`, no
  out-of-memory), against 10 min 33 s for the dry run at `390a128bd`. The
  signed fork APK is 133,269,220 B with 4 dex files (28.0 MB) and a
  44,579,802 B `.gz`, against 170,767,561 B and 57,403,319 B before R8. Its dex
  still holds the 39 zstd-jni classes and the 51 `sh.paseo.forkupdates`
  classes. Its deltas are 9.8 MB from 0.13.0 and 13.3–13.4 MB from older
  releases: every dex file is new in the first R8 release, so its deltas are
  large; the local pair above shows R8 releases after it stay small. The draft
  was deleted.

### Live releases

Evidence state: verified on the phone (Android 16, prod `sh.paseo.iexalt`).

| Release | Fork APK      | `.gz`        | Delta from the previous release |
| ------- | ------------- | ------------ | ------------------------------- |
| 0.14.0  | 133,269,220 B | 44,580,986 B | 9,730,764 B (from 0.13.1)       |
| 0.15.0  | 133,269,220 B | 44,580,558 B | 1,016,071 B (from 0.14.0)       |

- 0.14.0 (run 40983963926): the phone updated from 0.13.1 by the `.gz`, since
  0.13.1 predates the delta client. Under R8 the update check reported "up to
  date", FCM delivered a push to the open app, and a push sent with Paseo in
  the background was posted.
- 0.15.0 (run 41054837850): one DownloadManager transfer, no `.gz`:

  ```
  08:46:08.844 I/PaseoForkUpdates: Fetching 0.15.0 as zstd-patch (1016071 bytes)
  08:46:10.447 I/PaseoForkUpdates: Verified 0.15.0 from zstd-patch
  ```

  This also proves the zstd-jni `.so` loads in a release build and that the
  installed APK maps as the base. The install prompt and relaunch worked.

- Building the four deltas in parallel (#252) cut the `android-delta` job from
  7:07 (dry run 40979129503) to 3:27 (0.14.0) and 2:43 (0.15.0).

## Remaining limits

- Only the order of the fallback after a rejected delta is tested
  (`TransferChainTest`); no device has fallen back to the `.gz`.
- Deltas from releases before 0.14.0 stay 9.7–13.4 MB, because R8 rewrote
  every dex file in 0.14.0.
- The unbundled barcode model was declined.

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
- 2026-10-29: Phase 3 turned on R8 (#250); the delta job builds its bases in
  parallel (#252).
- 2026-10-30: 0.14.0 passed the R8 phone check; 0.15.0 updated the phone from
  a 1.0 MB delta, closing G-live. The campaign is complete.
