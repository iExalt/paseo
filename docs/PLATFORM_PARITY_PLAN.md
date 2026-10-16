# Desktop and mobile parity plan

The desktop and mobile apps should offer the same features and look alike,
adapted to screen size and touch. A survey on 2026-10-16 found features that
mobile drops without a platform reason. This plan closes them. Progress and
evidence live in [PLATFORM_PARITY_STATUS.md](PLATFORM_PARITY_STATUS.md).

## Deliberate differences

These stay desktop-only. The parity manifest
(`packages/app/src/platform-parity/manifest.ts`) records each one with its reason.
Settings sections hidden in a plain web browser (not Electron) are out of scope.

| Difference                                                                  | Reason                                                |
| --------------------------------------------------------------------------- | ----------------------------------------------------- |
| iOS update notice                                                           | The App Store and TestFlight deliver iOS updates      |
| Browser automation tools                                                    | They drive Electron's browser; recorded when F1 lands |
| Interface font family                                                       | Native cannot load arbitrary system fonts             |
| Remote SSH host onboarding                                                  | Needs a local SSH client                              |
| Open in editor or file manager, CLI install, open location, built-in daemon | Need the local filesystem or Electron                 |
| Window chrome, favicon status, quitting overlay                             | Desktop window concepts                               |

## Chunks

Each chunk is pushed to `feat/platform-parity` after its checks and review pass.
Tick a box in the same commit that delivers it.

### A. Stop silent gaps and show sidebar notices (P0, P1)

- [x] A1. Every per-platform module split and gated settings section is
      classified in the parity manifest as equivalent, a gap owned by a chunk,
      or deliberate with a reason. `check.test.ts` fails on an unclassified or
      stale entry. Runtime gates inside shared files are listed by hand; the
      test cannot find new ones.
- [x] A2. The sidebar notice slot is one cross-platform component and renders
      in the mobile drawer as well as the desktop sidebar.

Acceptance: the pure check fails on synthetic unclassified, stale and
reasonless entries; a notice shown through `callouts.show()` renders on
Paseo Debug through a temporary, uncommitted trigger, since no notice source
runs on native today.

### B. Notification settings on mobile (P2)

- [x] B1. Settings → Notifications on native: permission status, request or
      open system settings, a link to the push channel's sound settings, and
      per-host push registration with re-register. Settings → Permissions on
      native shows microphone permission status.
- [ ] B2. A test notification that travels from the daemon to the phone
      (`push.send_test.request`), shown even while the app is open.

Acceptance: unit tests for the status model; on Paseo Debug the sections show
status. A new RPC follows the protocol compatibility rule: optional fields,
and an old daemon still works.

Paseo Debug has no Firebase config, so push cannot reach it. The push checks
move to the release gate below.

**Release gate (first fork release containing B1 and B2, on the installed
app):** the host row reads "Sent to host"; a test notification arrives with
the app in the foreground and in the background; tapping it does not
navigate; "Send test notification" is hidden for a host without `pushTest`.
If Expo lacks FCM credentials for the fork package, the first push revokes
the token; that goes to the user.

### C. Find on mobile (P3)

- [x] C1. Chat find on native: header-menu entry, host-backed search, scroll to
      the match and highlight it.
- [ ] C2. Find in the read-only file view.
- [ ] C3. Terminal find in the native grid renderer with an on-screen trigger.

Acceptance: model tests per surface; on Paseo Debug find steps through matches
in a long chat, a file and a busy terminal. Perfetto frame stats for the
scroll-up journey stay at the 0.4.2 level (2–4 frames over 33 ms), with the
find bar closed and open.
The end-to-end pass also covers a match deep in a code block taller than the
screen, which no reachable chat had when C1 closed.

### D. File editing on mobile (P4)

- [ ] D1. CodeMirror hosted in a WebView, bridged to the shared
      `FileEditorModel`; Editor settings shown on native.

Acceptance: bridge tests; on Paseo Debug edit, save, conflict and rotation
work with the soft keyboard.

### E. Tablets (P5)

- [ ] E0. Spike: hardware key events on native, which React Native does not
      deliver without a native module, and a touch drag stack for pane
      splits, since dnd-kit is DOM-only. E1–E3 follow the spike's findings.
- [ ] E1. Keyboard shortcuts with a hardware keyboard on wide native layouts.
- [ ] E2. Pane splits and side-by-side diff on wide native layouts.
- [ ] E3. Chat outline rail on wide native layouts.

Acceptance: unit tests for the gating; an Android tablet emulator on
dev-station shows each feature.

### F. Browser tabs and copy (P6)

- [ ] F1. Browser tabs on native through a WebView, without automation tools.
- [ ] F2. Copying part or all of an assistant reply keeps its Markdown.

Acceptance: unit tests for the tab model; on Paseo Debug a browser tab opens
a workspace service URL and a reply copies as Markdown.

## Verification limits

There is no iOS device or physical tablet. iOS rests on unit tests and review;
tablets on an emulator.
