# Smaller Android updates

Evidence and progress: [status](ANDROID_UPDATE_SIZE_STATUS.md).

## Why

The 0.13.0 to 0.13.1 update downloaded the whole app on the phone: a 57 MB
`.apk.gz` of a 170 MB APK. Only 8 of 1,727 APK entries changed, and a
`zstd --patch-from` delta of the APK is 1.9 MB. The APK is also larger than it
needs to be:

| Part                   | Size    | Cause                                                              |
| ---------------------- | ------- | ------------------------------------------------------------------ |
| dex                    | 60 MB   | R8 off                                                             |
| EnrichedMarkdown `.so` | 24.8 MB | tree-sitter grammars for 19 highlight languages (kept by decision) |
| `paseo_diff_prototype` | 5.3 MB  | unused layout experiment that statically links a second Skia       |
| `barhopper_v3`         | 4.9 MB  | expo-camera bundles the ML Kit barcode model for QR pairing        |

## Decisions

- Keep all 19 highlight languages.
- Delete `packages/app/modules/paseo-diff-prototype`.
- QR scanning moves to the unbundled Play Services barcode model.
- Deltas stay unsigned sidecars outside the manifest, like the `.gz`: the
  device checks the rebuilt APK against the signed cell.
- The decoder is zstd-jni 1.5.7-12 (1.5.7-13 and later need compileSdk 37),
  decoding in one pass into the mapped output file (38 MB peak on 0.13.1).
- R8 runs with `-dontobfuscate`, so renamed members don't churn every dex and
  inflate each delta.

## Phases

### Phase 1: APK deltas

- [x] A. zstd patch applier with JVM tests (`ZstdPatch.kt`).
- [x] B. The updater tries delta, `.gz`, APK in order; JS offers the delta from
      the installed version; each attempt is logged under `PaseoForkUpdates`.
- [x] C. `android-delta` release job writes deltas from the last four releases;
      the publish asset check accepts them.
- [ ] G-live. Release N ships the delta client; release N+1 updates the phone
      with logcat showing `Verified <N+1> from zstd-patch` and no `.gz`
      transfer. This also proves the zstd-jni `.so` loads in a release build
      and that the installed APK can be mapped.

### Phase 2: cheap size cuts

- [ ] Delete the diff prototype module.
- [ ] Config plugin swapping `com.google.mlkit:barcode-scanning` for
      `play-services-mlkit-barcode-scanning`, plus the model-download
      manifest entry; F-Droid builds skip it.
- [ ] Release job summary with per-group APK sizes and the delta size.
- [ ] Device check: QR pairing still scans.

### Phase 3: R8

- [ ] Enable minify and resource shrinking through `expo-build-properties`,
      with `-dontobfuscate` and keep rules: `-keep class com.github.luben.zstd.** { *; }`
      (the AAR ships none, and its JNI reads Java fields) and `modules/paseo-*`.
- [ ] Device check of chat markdown, diff view, terminal, camera and the
      update flow; compare the next delta's size.
