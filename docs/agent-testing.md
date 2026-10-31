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

`npm run build:apk:arm64` builds `production`. `npm run build:apk:arm64 -- --fork` builds `fork`,
the only variant with the fork updater, into `artifacts/paseo-fork-arm64.apk`; pass
`GOOGLE_SERVICES_FILE_FORK` (an absolute path to a Firebase JSON for `sh.paseo.iexalt`; a
placeholder is fine without push) and `FIREBASE_PROJECT_ID_FORK=paseo-18157`. All three register
`paseo://`, so always name the package:
`adb shell am start -a android.intent.action.VIEW -d '<url>' <package>`. Without it, a device with
two variants shows a chooser.

Grant notifications before the first launch, or the permission prompt takes focus:
`adb shell pm grant <package> android.permission.POST_NOTIFICATIONS`. In a build with
[debug switches](#debug-switches), `--es paseo.notifications skip` also keeps it away.

### Deep links

Checked on the Android 17 tablet with `sh.paseo` 0.16.0 on 2026-10-30, and again on a build of
`dev` at `89889fa6d` on 2026-10-31. Builds without upstream #7918 (the workspace-route hydration
fix, on `dev` since 2026-10-30) ignore `?open=` on cold start. Cold means `am force-stop` first;
warm means the app is already open.

| Link                                                                                                       | Cold        | Warm | Notes                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------- | ----------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `paseo://settings/<section>` (`about`, `appearance`, …)                                                    | yes         | yes  |                                                                                                                                                                                                                                                                                                                  |
| `paseo://h/<serverId>/agent/<agentId>`                                                                     | yes         | yes  | Opens the agent's workspace with the agent tab selected                                                                                                                                                                                                                                                          |
| `paseo://h/<serverId>/workspace/<workspaceId>`                                                             | not checked | yes  |                                                                                                                                                                                                                                                                                                                  |
| `paseo://h/<serverId>/workspace/<workspaceId>?open=terminal:<id>`, `agent:<id>` or `file:<base64url path>` | yes         | yes  | Selects the tab, also after another intent on the same workspace                                                                                                                                                                                                                                                 |
| `paseo:///#offer=…` or `paseo://pair#offer=…`                                                              | yes         | yes  | Attempts the import and logs `link import` (checked with invalid offers: `status=failed`), then shows the startup route. `pair#` needs a build from 2026-10-30 or later; older builds show "Unmatched Route". Real pairing was not checked on the tablet (no relay); earlier phone sessions paired through `///` |

`?open=` is upstream compatibility code marked `COMPAT(workspace-open-url)` for removal after
2027-01-22; no fork test guards it.

### Android helper

`scripts/android/agent-adb.py` (Python 3, standard library only) wraps the steps below, on a phone
or on the tablet. It reads the adb command from `AGENT_ADB`, default `adb`; on the tablet run it
inside the pod with `AGENT_ADB="/home/dev/cuttlefish/cf-tablet adb"`.

```sh
A="python3 scripts/android/agent-adb.py"   # --package <package> for another variant
$A dump                        # id | text | desc | x,y | flags (selected, focused, checked, disabled)
$A tap direct-host-input       # refuses (exit 2) unless the package has focus
$A type 127.0.0.1; $A key ENTER
$A wait add-host-modal --gone  # or wait for an id to appear; exit 5 on timeout
$A open --cold 'paseo://settings/general?addHost=1'
$A switch clock=frozen notifications=skip
n=$($A turns <agentId>) || n=0   # unknown (exit 3): no line yet; 0 only if the chat was open since launch
paseo agent send --no-wait <agentId> "…"; $A wait-turn <agentId> --after "$n"
$A lock /tmp/t3/LOCK-<name> <owner>; …; $A unlock /tmp/t3/LOCK-<name> <owner>
```

- `tap`, `type` and `key` send input only while the package has focus, so they never reach the
  launcher, Settings or a permission dialog.
- `tap`, `type`, `key`, `open` and `switch` refuse the user's own app, `sh.paseo.iexalt`, unless
  `--allow-user-app` is passed with the user's go-ahead, or `AGENT_ADB_ALLOW_PACKAGES` names it
  (comma-separated); set the variable only on a device where the fork is a test install. `tap`
  checks focus again just before it taps. Reading commands (`dump`, `focus`, `wait`, `turns`) work on any package.
- `type` sends ASCII only: `input text` drops other characters on most Android builds.
- `turns` prints `unknown` (exit 3) when the agent has no line left in the log buffer, rather
  than 0. `wait-turn` follows the agent's latest line, as described in
  [Waiting for the app](#waiting-for-the-app). The helper never clears logcat; on the shared
  tablet that would erase other sessions' evidence. Read your own window with
  `adb logcat -d -T '<MM-DD hh:mm:ss.000>'` instead.
- A dump that fails with "could not get idle state" exits 4 with the
  [motion recipe](#motion-and-screen-dumps).
- Lock files live on the machine running the helper: run it inside the pod for the tablet's
  locks.

### Reading state

- `testID` surfaces as `resource-id`. The selected tab carries `selected="true"` in a raw
  `uiautomator dump`, and in the helper's flags column; other summaries lose it.
- Terminal rows are in the dump as `terminal-row-<n>` with their text. Diff code is drawn with
  Skia, so it is likely absent (unverified); take a screenshot.
- App logs are on the `ReactNativeJS` logcat tag: `adb logcat -s ReactNativeJS`. For state, read
  the [agent log lines](#agent-log-lines) instead of screenshots.
- Find on a phone-width layout: `workspace-tab-switcher-trigger`, then
  `workspace-tab-menu-<tabId>-trigger`, then `workspace-tab-menu-<tabId>-find`. The bar is
  `pane-find-input`, `pane-find-status` (`1 of 2`), `pane-find-next`, `pane-find-previous` and
  `pane-find-close`. Wide layouts have no native Find entry point.
- Settings rows are `settings-section-<section>` and `settings-host-section-<section>`. The
  direct connection form is `direct-host-input`, `direct-port-input` and
  `direct-password-input`; Enter in the host field moves to the port, and both select their text
  on focus. Open it with `paseo://settings/general?addHost=1`, then tap `add-host-method-direct`.
- The fork updater's row in About is `fork-android-update-row`, with `fork-android-update-status`
  and `fork-android-update-action`, in fork builds only. The tablet guest has network, so a fork
  build there checks and downloads real releases; boot it with `CF_NET=0` for the offline error
  state. A failed background check leaves the row idle.
- To check a phone-width layout on the tablet, run `adb shell wm size 1080x2400` and
  `adb shell wm density 420`; undo with `wm size reset` and `wm density reset` before releasing the
  device.

### Motion and screen dumps

`uiautomator dump` fails with `ERROR: could not get idle state` while the screen keeps changing.
It waits for about a second without accessibility events, so a running agent blocks it:

- The status ring and the turn loader animate. Set `transition_animation_scale`,
  `window_animation_scale` and `animator_duration_scale` to 0 with `adb shell settings put global
  <name> 0`, then `am force-stop` and relaunch. Reanimated's reduce motion reads only
  `transition_animation_scale`, and only at startup, so without the relaunch nothing changes.
  Read the three values with `settings get global <name>` first and put them back afterwards;
  `settings delete global <name>` restores one that was `null`.
- The open chat of a running agent still fails at scale 0. Its turn footer's elapsed time
  (`turn-working-elapsed`) changes every second. In a build with
  [debug switches](#debug-switches), such as the tablet harness, launch with
  `--es paseo.clock frozen` as well as the scale recipe. Otherwise dump from another screen, wait
  for the turn to end (`paseo wait`), or take a screenshot.

On the phone-width tablet, dumps succeed at default scales with the app idle, during a cold start,
and with an agent running while no status ring is on screen. A visible running ring (sidebar open,
or any wide layout) needs the scale recipe above. The phone was not measured; results are in
[AGENT_TESTING_STATUS.md](AGENT_TESTING_STATUS.md#e-motion-and-dumps).

The shared Cuttlefish tablet's harness guide is `/home/dev/cuttlefish/HARNESS.md` in the dev pod.

## Agent log lines

The app logs state changes as one line each, on logcat's `ReactNativeJS` tag and in the web
console: `[paseo-agent] <area> <event> key=value …`. Values with spaces, `=` or quotes are JSON-quoted.
`adb logcat -s ReactNativeJS | grep '\[paseo-agent\]'` follows them.

| Area and event                | Fields                                                                                     | When                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `link import`                 | `status` (`connected`, `cancelled`, `password_required`, `failed`), `serverId` or `reason` | A `#offer=`, `#connect=` or `relay://` link arrives              |
| `connection status`           | `serverId`, `status`, `transport`, `error`                                                 | A host's connection status changes                               |
| `connection bootstrap-probe`  | `endpoint`, `status=failed`, `reason`                                                      | No daemon on this device's `localhost:6767`, as on every phone   |
| `push received`               | `id`, `test`, `shown`                                                                      | A notification arrives while the app is open                     |
| `push register`               | `status=unavailable`, `reason=firebase-not-configured`                                     | Once per session in builds without Firebase                      |
| `push prompt`                 | `status=skipped`, `reason=debug-switch`                                                    | The `notifications=skip` switch held back the permission prompt  |
| `update status`               | `status`, `version`, `downloadedBytes`                                                     | The fork updater changes state                                   |
| `update failed`               | `status` (the stage), `reason`                                                             | A check, download or install fails                               |
| `timeline state`              | `agentId`, `state` (`loading`, `running`, `settled`, `error`), `turns`                     | The open chat's readiness or closed-turn count changes           |
| `debug set`, `debug rejected` | `key`, `value` or `reason`                                                                 | A [debug switch](#debug-switches) is applied, cleared or refused |

Link bodies after `#`, `relay://` URIs and Expo push tokens are redacted. A `reason` can still
quote a fragment of a malformed offer's decoded JSON (server ID and public key only).

## Waiting for the app

On web, the open chat carries one marker for its readiness: `agent-timeline-loading`, `-running`,
`-settled` or `-error`, with `data-agent-id` and `data-turns` attributes. On Android the marker is
not in `uiautomator dump` output, so use the log line. `turns` counts the
chat's closed turns (completed, failed or cancelled) since the app started, so a turn that ends
between two checks still shows up. Before the chat is ready, `agent-loading` means loading, and
`agent-load-error` and `agent-not-found` mean error.

To wait for a prompt to finish, read `turns` first, send, then wait for `settled` with a larger
`turns`. Waiting for `settled` alone passes before the turn starts; waiting for `running` first
misses short turns. Keep the chat open while you wait: turns that end while no pane shows the
agent are not counted.

- **Web:** read `data-turns` from `[data-testid^="agent-timeline-"][data-agent-id="<id>"]`, then
  `page.waitForFunction` until that element's `data-testid` is `agent-timeline-settled` and its
  `data-turns` is larger, or wait for the console line below. Always include `data-agent-id`: with
  two chats open, a bare `getByTestId('agent-timeline-settled')` matches both and fails Playwright's
  strict mode.
- **Android:** `agent-adb.py turns` and `wait-turn` (above) do this. By hand, follow
  `adb logcat -s ReactNativeJS` for
  `[paseo-agent] timeline state agentId=<id> state=settled turns=<n+1>`, where `n` is the last
  `turns` logged for that agent. Once it appears, the chat's elapsed clock has stopped and
  `uiautomator dump` works again, unless another running agent's status ring is on screen.

Host readiness is the `connection status … status=online` line.

## Debug switches

Builds made with `EXPO_PUBLIC_PASEO_AGENT_SWITCHES=1 npm run build:apk:arm64` read switches at run
time; the tablet harness APK is one. Other builds carry the code but never read a switch, and the
native module that hands them over ships inert in every Android build.

- **Android:** `adb shell am start -n <package>/.MainActivity --es paseo.<key> <value>`, at launch
  or while the app runs (the activity is `singleTask`, so a running app receives them). `off`
  clears a key. Switches last until the process ends, but a relaunch from recents after the
  process died replays the extras it was started with.
- **Web:** set `sessionStorage["paseo.agentSwitches"]` to a JSON object of keys and values before
  the page loads, for example with Playwright's `addInitScript`. It lasts for the tab.

Each applied switch logs `[paseo-agent] debug set key=<key> value=<value>`; an unknown key or value
logs `debug rejected` and changes nothing. Code reads a switch when it next runs, so a change sent
to a running app applies at the next use: the trace at the next keystroke, a frozen clock within a
second, and clearing `clock` at the label's next render, such as a new turn or a tab switch.

Switches set at launch apply before the app connects, so `--es paseo.notifications skip` on a cold
start keeps the permission prompt away. Once the app has asked for the permission, Android only
shows the prompt again after `adb shell pm clear <package>`. That wipes the app's hosts and
settings: on the shared tablet, hold the lock, re-add `127.0.0.1:6790` and note it in HARNESS.md.

| Key             | Values                                  | Effect                                                                                                                                           |
| --------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `trace`         | `terminal-input`, `terminal-input:full` | Native terminal input trace as `[paseo-terminal-trace]` lines; `:full` logs typed text, passwords included, so don't use it on the shared tablet |
| `clock`         | `frozen`                                | The running turn's elapsed time stops ticking, so a running chat can be dumped (with the scale recipe)                                           |
| `notifications` | `skip`                                  | The notification permission prompt is never shown; logs `push prompt status=skipped`                                                             |

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
is a linked git worktree, and `Paseo-dev` otherwise, never the installed app's `Paseo`. Its log
is `<userData>/logs/main.log`, also with the variable set. Set the variable anyway when you need a
clean profile, or use the [desktop sandbox](#desktop-sandbox).

Playwright's `reducedMotion: 'reduce'` context option stops the web app's animations: the status
ring, the turn loader and switch thumbs. Only the running turn's elapsed time keeps changing, once
a second.

For a browser-only check, write a [browser probe](#browser-probes), or start a daemon with
[`npm run qa:web`](#isolated-daemons).

## Desktop sandbox

`npm run desktop:sandbox` runs the unpackaged desktop app against a fresh
[`qa:web`](#isolated-daemons) daemon and prints one JSON line with `cdpUrl`, `url`, `serverId`,
`home`, `electronPid` and the `stop` command:

```sh
npm run build:main --workspace=@getpaseo/desktop   # once, and after desktop main changes
npm run -s desktop:sandbox -- --seed heavy
npm run desktop:sandbox -- --stop <home>
```

- To launch Electron yourself from a directory outside the repo, call
  `node_modules/electron/dist/electron` directly: `node_modules/.bin/electron` goes through the
  mise `node` shim, which has no version outside the repo.
- It runs on Linux under `xvfb-run`, so no window opens; run it on dev-station. On macOS it
  refuses unless `--allow-window`. Without a setuid-root `chrome-sandbox` it adds `--no-sandbox`.
- The renderer is the daemon-served web UI (`EXPO_DEV_URL=<url>`); `--metro <url>` uses a Metro
  server instead, for development builds and React warnings (not yet tried).
- Electron gets the scratch home, `userData` under it, no inherited `PASEO_*` variable, and remote
  debugging on 127.0.0.1 only. Start fails unless the app's `desktop_daemon_status` reports the
  sandbox's own home and server and the daemon was adopted, not replaced.
- Attach with `connectToPaseoRenderer(cdpUrl, { origin })` from
  `packages/desktop/e2e/support/connect-renderer.mjs`. It retries `connectOverCDP` until a page
  from that origin has drawn the app, instead of returning DevTools or blank pages.
- `--stop` only stops a home the sandbox started (`.desktop-sandbox`), ends Electron and Xvfb by
  their recorded process group, then stops the daemon.

## Browser probes

Throwaway Playwright checks go in `.dev/probes/<name>.probe.ts` (gitignored) and run with
`npm run probe -- <name>`. Copy `packages/app/e2e/probe/examples/example.probe.ts` and import
from `../../packages/app/e2e/probe/fixtures`, which gives:

- `qa`: a `qa:web --seed heavy` daemon for the worker, also the `baseURL`, stopped afterwards even
  when a probe fails. `probe.use({ qaSeed: false })` skips the seed; `PROBE_URL` (and
  `PROBE_SERVER_ID`) use a server you run instead, which the fixture never stops. A failure
  restarts the worker, so the next probe starts a fresh daemon.
- `desktop`: `probe.use({ desktop: "local-daemon" })` installs a fake `window.paseoDesktop` that
  presents `qa` as the desktop app's own daemon, so desktop-only UI renders in Chromium;
  `"daemon-starting"` keeps the desktop daemon starting. The fake is typed against
  `DesktopHostBridge`, so the app typecheck catches drift. The desktop app's startup redirect wins
  over a typed `/settings` URL; navigate from `/` instead.
- `consoleLines`: every console message with its arguments substituted (`%s`, `%d`, `%o`).
  When a probe fails, the last 200 lines are written to `console-tail.txt` beside Playwright's
  screenshot and trace in `.dev/probes/artifacts/<test>/`.

Probes run against the daemon-served production web UI, so React's development warnings don't
appear; use Metro (`PROBE_URL=http://localhost:8081`) when you need them.

## Isolated daemons

`npm run qa:web` starts a scratch daemon that serves the web UI and prints one JSON line:

```sh
npm run -s qa:web -- --seed heavy
# {"url":"http://127.0.0.1:36505/","serverId":"srv_…","home":"<repo>/.dev/qa-web/36505",
#  "pid":…,"workerPid":…,"readyMs":3534,"providers":["mock"],
#  "seed":{"agents":[{"title":"Realistic turn","id":"…"},…],"missing":[],"ms":11652},
#  "stop":"npm run qa:web -- --stop <home>"}
npm run qa:web -- --stop <home>
```

- It needs `npm run build:server` and `npm run build:daemon-web-ui` first, and names whichever is
  missing. After `npm ci --ignore-scripts` it also asks for `npm rebuild node-pty`, without which
  the daemon exits at start. Build the web UI with `EXPO_PUBLIC_PASEO_AGENT_SWITCHES=1` for
  [debug switches](#debug-switches); that changes the web UI every daemon in the worktree serves.
- The home defaults to `<repo>/.dev/qa-web/<port>`. It refuses `~/.paseo`, an inherited
  `PASEO_HOME` and a home that already has a config (unless `--reuse`), and never copies from
  `~/.paseo`.
- The relay, usage sources, plugins and speech are off. Only the mock provider is on: every other
  provider, including those that built-in plugins register, is disabled in config before the
  daemon starts, so it never probes their CLIs or accounts. Built-in plugins still load;
  `pluginsEnabled` only covers configured plugins.
- Every child process gets the scratch home and `PASEO_NODE_ENV=development`, and no inherited
  `PASEO_*` variable, so it is safe to run from inside a Paseo agent.
- `--seed heavy` creates a git workspace and three finished mock agents through the CLI: a
  realistic turn (reads, searches, an edit with a diff, shell commands), 60 tool calls, and an
  image. A browser that has loaded `/` once can open `<url>h/<serverId>/agent/<id>`.
- Drive it with the built CLI and `--home`: `node packages/cli/bin/paseo agent send <id> "…" --home
  <home>`. Mock models run for a fixed time; `ten-second-stream` is the seed's. Don't use
  `npm run cli` here: it runs through `scripts/dev-home.sh`, which points at the worktree's own
  `.dev/paseo-home` when `PASEO_HOME` is unset.
- `--stop` only stops a home that qa:web started (it writes `.qa-web` there), and exits non-zero
  if the supervisor, the worker or the port is still alive afterwards.

For a daemon set up by hand:

- Set `daemon.relay.enabled: false` explicitly. A config that omits it keeps the old relay-on
  default until 2027-01-31 (`COMPAT(relayOptInDefault)`), so the scratch home registers with the
  real relay.
- To serve the web UI, see [daemon-served web UI](upstream/development.md#bundled-daemon-web-ui);
  `PASEO_CORS_ORIGINS` allows a separate origin.
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
