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

Checked on the Android 17 tablet with `sh.paseo` 0.16.0 on 2026-10-30. Cold means
`am force-stop` first; warm means the app is already open.

| Link                                                                              | Cold | Warm | Notes                                                                                     |
| --------------------------------------------------------------------------------- | ---- | ---- | ----------------------------------------------------------------------------------------- |
| `paseo://settings/<section>` (`about`, `appearance`, …)                           | yes  | yes  |                                                                                           |
| `paseo://h/<serverId>/agent/<agentId>`                                            | yes  | yes  | Opens the agent's workspace with the agent tab selected                                   |
| `paseo://h/<serverId>/workspace/<workspaceId>`                                    |      | yes  |                                                                                           |
| `paseo://h/<serverId>/workspace/<workspaceId>?open=terminal:<id>` or `agent:<id>` | no   | yes  | Cold start ignores `?open=`. A `file:` intent breaks later warm intents on that workspace |
| `…?open=file:<base64url path>`                                                    | no   | no   | Creates the file tab but does not select it                                               |
| `paseo:///#offer=…`                                                               | yes  | yes  | Use this form. Stays on the current screen; pairing through it worked on the phone        |
| `paseo://pair#offer=…`                                                            | no   | no   | Imports the offer, then shows "Unmatched Route"                                           |

To reach a terminal, open the agent route to land in the workspace, then send the warm
`?open=terminal:` link. `?open=` is upstream compatibility code marked
`COMPAT(workspace-open-url)` for removal after 2027-01-22.

### Reading state

- `testID` surfaces as `resource-id`. The selected tab carries `selected="true"` in a raw
  `uiautomator dump`; summary helpers that print only id, text and description lose it.
- Terminal rows are in the dump as `terminal-row-<n>` with their text. Diff code is drawn with
  Skia and is not; take a screenshot.
- App logs are on the `ReactNativeJS` logcat tag: `adb logcat -s ReactNativeJS`.
- `uiautomator dump` succeeded 15 of 15 times with the app idle on the tablet (chat, settings,
  sessions). Agents on the phone have hit `ERROR: could not get idle state` while lists load or
  an agent runs; wait and retry, or fall back to a screenshot.

The shared Cuttlefish tablet's harness guide is `/home/dev/cuttlefish/HARNESS.md` in the dev pod.

## Desktop and web

| Variable                               | Effect                                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| `PASEO_ELECTRON_USER_DATA_DIR`         | Electron `userData`. `npm run dev:desktop` sets it to `<dev root>/.dev/user-data`        |
| `PASEO_DISABLE_SINGLE_INSTANCE_LOCK=1` | Run beside another instance                                                              |
| `PASEO_ELECTRON_REMOTE_DEBUGGING_PORT` | Fixed CDP port; see [development.md](upstream/development.md#desktop-renderer-profiling) |
| `PASEO_TEST_APP_NAME`                  | Electron app name                                                                        |
| `EXPO_DEV_URL`                         | Metro URL Electron loads; defaults to `http://localhost:8081`                            |

Launching Electron directly (Playwright `_electron.launch`) skips `dev.sh`. Without
`PASEO_ELECTRON_USER_DATA_DIR`, a worktree gets `Paseo-<worktree>` userData, but the main checkout
gets the default `Paseo` userData, which the installed app also uses. Always set it.

For a browser-only check, serve the web UI from an isolated daemon:
[daemon-served web UI](upstream/development.md#daemon-served-web-ui) and
`PASEO_CORS_ORIGINS` for a separate origin.

## Isolated daemons

- `paseo daemon start` (managed) drops `PASEO_*` setting overrides such as `PASEO_LISTEN` and
  `PASEO_CORS_ORIGINS` (`DAEMON_SETTING_ENV_KEYS` in
  `packages/server/src/server/config-environment.ts`). Put settings in `<home>/config.json`, or use
  `paseo daemon run` in the foreground, which keeps them.
- `PASEO_NODE_ENV=development` enables development-only providers such as the mock provider.
- `paseo daemon status --json --home <home>` reports `workerPid` when the daemon is reachable.
  Stop a test daemon with `paseo daemon stop --home <home>`, never by process name: the
  user's daemon has the same name.
