This fork uses the Expo project `@iexalt/paseo`. For local push-enabled builds,
place the Firebase Android configuration for `sh.paseo.debug` at
`packages/app/.secrets/google-services.debug.json` (already ignored), or set
`GOOGLE_SERVICES_FILE_DEBUG`. Keep the separate Firebase service-account private
key outside the repository and upload it to that Expo project's FCM V1
credentials for `sh.paseo.debug`. It is not the APK signing key and must never be
bundled into the app. Preserve `android/app/debug.keystore` when rebuilding an
installed local APK; use the non-clean prebuild command above.

