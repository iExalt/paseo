# Ad hoc agent testing

How an agent checks a change or reproduces a bug in the running app without a committed test.
Committed suites live in [mobile-testing.md](upstream/mobile-testing.md) (Maestro, agent-device)
and [testing.md](upstream/testing.md); an in-process daemon for scripts is in
[ad-hoc-daemon-testing.md](upstream/ad-hoc-daemon-testing.md). The plan behind this doc is
[AGENT_TESTING_PLAN.md](AGENT_TESTING_PLAN.md).

Never drive, quit or restart the user's own app or the daemon on port 6767. Test against an
isolated daemon and app instance.

## Android

### Packages

| Variant       | Package           | Launch component                |
| ------------- | ----------------- | ------------------------------- |
| `production`  | `sh.paseo`        | `sh.paseo/.MainActivity`        |
| `development` | `sh.paseo.debug`  | `sh.paseo.debug/.MainActivity`  |
| `fork`        | `sh.paseo.iexalt` | `sh.paseo.iexalt/.MainActivity` |

`npm run build:apk:arm64` builds `production`. All three register `paseo://`, so always name the
package: `adb shell am start -a android.intent.action.VIEW -d '<url>' <package>`. Without it,
a device with two variants shows a chooser.

Grant notifications before the first launch, or the permission prompt takes focus:
`adb shell pm grant <package> android.permission.POST_NOTIFICATIONS`.

### Deep links

Checked on the Android 17 tablet with `sh.paseo` 0.16.0 on 2026-10-30; `?open=` rows on builds
from `dev` with the workspace-route hydration fix (upstream #7918, 2026-10-30); older builds ignore
`?open=` on cold start. Cold means
`am force-stop` first; warm means the app is already open.

| Link                                                                                                       | Cold           | Warm           | Notes                                                                                                             |
| ---------------------------------------------------------------------------------------------------------- | -------------- | -------------- | ----------------------------------------------------------------------------------------------------------------- |
| `paseo://settings/<section>` (`about`, `appearance`, …)                                                    | yes            | yes            |                                                                                                                   |
| `paseo://h/<serverId>/agent/<agentId>`                                                                     | yes            | yes            | Opens the agent's workspace with the agent tab selected                                                           |
| `paseo://h/<serverId>/workspace/<workspaceId>`                                                             | not checked    | yes            |                                                                                                                   |
| `paseo://h/<serverId>/workspace/<workspaceId>?open=terminal:<id>`, `agent:<id>` or `file:<base64url path>` | yes            | yes            | Selects the tab, also after another intent on the same workspace                                                  |
| `paseo:///#offer=…`                                                                                        | no route error | no route error | Use this form. Checked with an invalid offer only; earlier phone sessions paired through it after tapping Connect |
| `paseo://pair#offer=…`                                                                                     | no             | no             | "Unmatched Route" (invalid offer); earlier phone sessions report the pairing still happened                       |

`?open=` is upstream compatibility code marked `COMPAT(workspace-open-url)` for removal after
2027-01-22; no fork test guards it.

### Reading state

- `testID` surfaces as `resource-id`. The selected tab carries `selected="true"` in a raw
  `uiautomator dump`; summary helpers that print only id, text and description lose it.
- Terminal rows are in the dump as `terminal-row-<n>` with their text. Diff code is drawn with
  Skia, so it is likely absent (unverified); take a screenshot.
- App logs are on the `ReactNativeJS` logcat tag: `adb logcat -s ReactNativeJS`. For state, read
  the [agent log lines](#agent-log-lines) instead of screenshots.
- `uiautomator dump` succeeded 15 of 15 times with the app idle on the tablet (chat, settings,
  sessions). Agents on the phone have hit `ERROR: could not get idle state` while lists load or
  an agent runs; wait and retry, or fall back to a screenshot.

The shared Cuttlefish tablet's harness guide is `/home/dev/cuttlefish/HARNESS.md` in the dev pod.

## Agent log lines

The app logs state changes as one line each, on logcat's `ReactNativeJS` tag and in the web
console: `[paseo-agent] <area> <event> key=value …`. Values with spaces are JSON-quoted.
`adb logcat -s ReactNativeJS | grep '\[paseo-agent\]'` follows them.

| Area and event               | Fields                                                                                     | When                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `link import`                | `status` (`connected`, `cancelled`, `password_required`, `failed`), `serverId` or `reason` | A `#offer=`, `#connect=` or `relay://` link arrives            |
| `connection status`          | `serverId`, `status`, `transport`, `error`                                                 | A host's connection status changes                             |
| `connection bootstrap-probe` | `endpoint`, `status=failed`, `reason`                                                      | No daemon on this device's `localhost:6767`, as on every phone |
| `push received`              | `id`, `test`, `shown`                                                                      | A notification arrives while the app is open                   |
| `push register`              | `status=unavailable`, `reason=firebase-not-configured`                                     | Once per session in builds without Firebase                    |
| `update status`              | `status`, `version`, `downloadedBytes`                                                     | The fork updater changes state                                 |
| `update failed`              | `status` (the stage), `reason`                                                             | A check, download or install fails                             |

Link bodies after `#`, `relay://` URIs and Expo push tokens are redacted. A `reason` can still
quote a fragment of a malformed offer's decoded JSON (server ID and public key only).

## Desktop and web

| Variable                               | Effect                                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| `PASEO_ELECTRON_USER_DATA_DIR`         | Electron `userData`. `npm run dev:desktop` sets it to `<dev root>/.dev/user-data`        |
| `PASEO_DISABLE_SINGLE_INSTANCE_LOCK=1` | Run beside another instance                                                              |
| `PASEO_ELECTRON_REMOTE_DEBUGGING_PORT` | Fixed CDP port; see [development.md](upstream/development.md#desktop-renderer-profiling) |
| `PASEO_TEST_APP_NAME`                  | Electron app name                                                                        |
| `EXPO_DEV_URL`                         | Metro URL Electron loads; defaults to `http://localhost:8081`                            |

Launching Electron directly (Playwright `_electron.launch`) skips `dev.sh`. Without
`PASEO_ELECTRON_USER_DATA_DIR`, an unpackaged launch uses `Paseo-<worktree>` userData when its cwd
is a linked git worktree, and Electron's default userData otherwise. Whether that default collides
with the installed app is unverified, so always set the variable.

For a browser-only check, serve the web UI from an isolated daemon:
[daemon-served web UI](upstream/development.md#bundled-daemon-web-ui) and
`PASEO_CORS_ORIGINS` for a separate origin.

## Isolated daemons

- `paseo daemon start` (managed) ignores setting overrides such as `PASEO_LISTEN`, `PORT` and
  `PASEO_CORS_ORIGINS`, and names the ones it ignores on stderr. Put settings in
  `<home>/config.json`, or use `paseo daemon run` in the foreground, which keeps them.
- `PASEO_NODE_ENV=development` enables development-only providers such as the mock provider.
- `paseo daemon status --json --home <home>` reports `workerPid` when the daemon is reachable.
  Stop a test daemon with `paseo daemon stop --home <home>`, never by process name: the
  user's daemon has the same name.
- `paseo daemon pair --home <home> --app-url paseo:// --json` prints a pairing link and QR that
  open the app directly (`paseo:///#offer=…`). With no daemon running, it builds the offer from
  `<home>/config.json` without contacting the relay; `daemon.relay.enabled` must be true there.
