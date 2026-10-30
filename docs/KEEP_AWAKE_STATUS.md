# Keep the Mac awake for the relay

Goal: a MacBook on AC power with its lid closed stays reachable through the
relay. Without a qualifying power assertion, macOS cycles DarkWake and
5-minute "Maintenance Sleep" naps (`rtc/Maintenance`); the daemon is paused
during each nap and the relay control socket goes stale. Relay recovery after
wake already works (`relay_control_stale_terminating`, reconnect in ~1 s); the
gaps are the problem.

User docs: [configuration](../public-docs/configuration.md#keep-a-mac-awake-for-the-relay).

## Decisions

| Decision  | Choice                                                                              | Why                                                                                                                                                                                                                                                             |
| --------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mechanism | Daemon spawns `/usr/bin/caffeinate -s -w <daemon pid>`                              | The daemon runs as plain Node (`ELECTRON_RUN_AS_NODE`), so `powerSaveBlocker` is unavailable, and CLI daemons have no Electron at all. `-w` releases on daemon crash or SIGKILL. A native IOPMAssertion module adds packaging cost for no gain unless A2 fails. |
| Hold when | Relay effectively enabled (including launch overrides) and `daemon.relay.keepAwake` | "A remote client is connected" can't trigger it: the phone can't connect while the Mac sleeps. Keeps holding while the relay reconnects. An "agents running" trigger is deferred until needed.                                                                  |
| Default   | Off (opt-in), user decision 2026-10-30                                              | A Mac that won't sleep on AC is a heat risk, for example in a bag on a charger.                                                                                                                                                                                 |
| Battery   | No power-source detection; `-s` only applies on AC per `man caffeinate`             | Pending A3 proof.                                                                                                                                                                                                                                               |
| App state | Config-derived switch gated on a darwin-only `server_info.features` flag (chunk C)  | Live "holding" status needs a new protocol message and still can't see battery state.                                                                                                                                                                           |

Risk: Apple's `IOPMLib.h` marks `PreventSystemSleep` (what `-s` creates) as
deprecated since 10.9 and "not supported", though powerd still counts it
(WindowServer takes it today). If A2 shows it doesn't keep a lid-closed Mac
awake, the fallback is a small native helper holding `NetworkClientActive`,
which needs a packaging decision from the user before it replaces caffeinate.

## Chunks

| Chunk                       | Status   | Evidence                                                                                                                                                                                                                                                                                       |
| --------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1 assertion lifecycle      | verified | On AC, `caffeinate -s -w <pid>` shows `PreventSystemSleep 1`; SIGKILL of the watched pid drops it to 0 within 2 s (2026-10-30, M4, macOS 27.0.1).                                                                                                                                              |
| A2 lid closed on AC         | next     | Needs the user at the Mac. Pass: `pmset -g log` shows no Clamshell Sleep, or DarkWake without Maintenance Sleep, and no `relay_control_stale_terminating` in that window.                                                                                                                      |
| A3 battery                  | next     | Unplug with the lid open; `pmset -g` must not list caffeinate under "sleep prevented by".                                                                                                                                                                                                      |
| B daemon setting/controller | verified | `keep-awake.test.ts`, config and store tests. Live check on a separate home and port with the real binary: held at boot, released on setting/relay off, reacquired, held from boot under `PASEO_RELAY_ENABLED=1`, released on stop and on worker SIGKILL, reacquired after supervisor restart. |
| C settings switch           | planned  |                                                                                                                                                                                                                                                                                                |
| D overnight on the real app | later    | After the user updates the installed app: a lid-closed night with zero Maintenance Sleep and no relay stale events in `~/.paseo/daemon.log`.                                                                                                                                                   |

`daemon start` (managed) strips `PASEO_*` setting overrides
(`config-environment.ts`), so test launch overrides with `daemon run`.
