# Firebase credentials

These files contain SOPS-encrypted binary copies of the Firebase client
configuration and Admin SDK service account. Binary input keeps the original
JSON bytes encrypted, including field names. SOPS metadata and the age recipient
remain public.

The fork Android build consumes only the Google services client config. Decrypt
it to a per-build protected path, then provide that absolute path and the public
Firebase project ID as build environment variables:

```sh
umask 077
google_services_file=$(mktemp "${RUNNER_TEMP:-/private/tmp}/paseo-google-services.XXXXXX")
trap 'rm -f "$google_services_file"' EXIT
SOPS_AGE_KEY_CMD=/Users/clliaw/Projects/analogsea-kubernetes-engine/scripts/age-key.sh \
  mise x sops@3.13.1 -- sops --decrypt --input-type json --output-type binary \
  --output "$google_services_file" \
  secrets/firebase/google-services.sops.json

export APP_VARIANT=fork
export GOOGLE_SERVICES_FILE_FORK="$google_services_file"
export FIREBASE_PROJECT_ID_FORK="${FIREBASE_PROJECT_ID_FORK:?set the expected public Firebase project ID}"
export PASEO_ANDROID_VERSION_CODE="${PASEO_ANDROID_VERSION_CODE:?set the explicit fork Android version code}"
```

The app config checks that the file contains an Android client for
`sh.paseo.iexalt` and that its nonempty `project_id` matches
`FIREBASE_PROJECT_ID_FORK`. Decrypted output must stay outside the repository,
must not be printed, and should be removed after the build.

The separate Admin SDK service account is used for Expo Push FCM V1 delivery. It
must stay server-side and be assigned in Expo project `@iexalt/paseo`
(`3a777534-569c-47e5-81ad-1a4e47d5127c`) to Android app `sh.paseo.iexalt`; never
bundle it into the app. That remote credential setup is separate from decrypting
the client config and is not performed by this build wiring.
