# Desktop and mobile parity status

Last updated: 2026-10-16

## Purpose

This links the [parity plan](PLATFORM_PARITY_PLAN.md), which holds the chunk
checklist, to current evidence. It is not a second checklist.

## Current snapshot

| Field                        | Status                                                                   |
| ---------------------------- | ------------------------------------------------------------------------ |
| Baseline                     | `e63be054f` (`chore(dev): release 0.5.0`)                                |
| Branch                       | `feat/platform-parity`                                                   |
| Current chunk                | F: browser tabs and copy                                                 |
| Overall state                | C–F device-checked on the phone; E accepted on review only (user choice) |
| Product or release readiness | No chunk is released                                                     |
| Routine CI budget            | Under 5 min per lane (`docs/GITHUB_WORKFLOWS_STATUS.md`); baseline below |

### Routine CI baseline

Dev push run `38954179690` at `e63be054f`, hosted runners:

| Lane         | Wall time |
| ------------ | --------- |
| app-1        | 137 s     |
| app-2        | 132 s     |
| quality      | 165 s     |
| workspaces   | 213 s     |
| integration  | 187 s     |
| server-1/2/3 | 160–199 s |

Report any app or quality lane growth above 10 s per chunk.

## Accomplishments with evidence

The Android sidebar update icon that started this campaign shipped before it,
in 0.5.0 (`feat(app): show Android fork updates in the sidebar and remember
them`).

### A1: platform differences are classified

Evidence state: verified.

- Every module that resolves to different files on web and native, every
  gated settings section and the known runtime gates are classified in
  `packages/app/src/platform-parity/manifest.ts`.
- `platform-parity/check.test.ts` fails on unclassified, stale or reasonless
  entries. The repo-level check walks `src` in well under a second.
- Limit: the test cannot find new runtime gates (`isWeb`, `isNative` and
  similar checks inside shared files), or a gap closed while its split
  remains; chunk reviews check that entries flip.

### A2: sidebar notices on mobile

Evidence state: verified on Paseo Debug with a temporary notice: it renders
in the drawer above the footer, its action and dismiss leave the drawer open,
and the list reclaims the space. Phones are portrait-locked
(`packages/app/app.config.js` `orientation`), so landscape does not apply.
No notice source runs on native yet.

### B1: notification and permission settings on mobile

Evidence state: verified on Paseo Debug, except "Sent to host".

- Deny, then relaunch: no prompt on resume. Request shows the OS prompt;
  after a second denial the row offers Open settings. Granting in settings
  and returning refreshes the row without a prompt.
- Sound and alerts opens the push channel's settings page. Microphone
  request works.
- Paseo Debug has no Firebase config, so its host row reads "Failed"
  (`Default FirebaseApp is not initialized`). "Sent to host" moves to the B2
  release gate in the plan.

### B2: test notification

Evidence state: accepted on code review and unit tests; its push checks wait
for the first fork release that contains it.

- `push.send_test.request` sends to the token this connection registered and
  returns Expo's answer: `accepted` (a ticket, not proof of delivery),
  `no_token` or `failed` with Expo's reason. Event pushes keep logging their
  errors as before.
- Each host row has Send test. A host without `pushTest` says to update it.
  Test notifications show while the app is open and do nothing when tapped;
  other notifications stay silent in the foreground.
- Paseo Debug cannot receive push, so its row shows the failure Expo or
  Firebase reports.

### C1: chat find on mobile

Evidence state: verified on Paseo Debug, with the limits below.

- Find in the tab menu opens a full-width bar above the composer and the
  keyboard; Back closes it.
- The selected occurrence is marked in plain and bold text, inline code, code
  blocks and user messages, and the count matches the marks. Path-link code
  and auto-linked code are marked too; diagrams count nothing.
- Next and Previous step within a message and across messages. A visible
  match does not scroll; one off screen or behind the bar is centred, by its
  line: a match on the third line of a wrapped bullet and on the second line
  of a code block land on that line, not the block's top.
- Perfetto, same chat, two runs each, frames over 33 ms: before C1 8 and 8;
  C1 with the bar closed 9 and 11; with it open 9 and 10. Max frame and longest
  JS busy are unchanged. This chat is not the 0.4.2 baseline chat.
- Accepted from the code, not seen on the device: streaming not pulling the
  view back after a jump; the offset restart after a hard line break.
- Not seen on the device: a match deep in a code block taller than the
  screen. It moves to the chunk C end-to-end pass.
- iOS is unverified. Its Markdown spans report no lines, so a jump stops at
  the row, and Next inside a visible block jumps that row to the top.

### C2: find in the file view on mobile

Evidence state: verified on Paseo Debug at the batch build, after two fixes.

- Since D1, the read-only view shows files over the editor's 1 MiB limit and
  editable files until the editor is ready. The batch found its bar hidden
  by the keyboard (an absolute bar ignores its parent's padding) and the last
  match hidden under the bar. Now the view ends above the keyboard while find
  is open and leaves half a screen past the last line. Seen: a 5.3 MB file
  finds its last line, typing stays responsive, the bar sits on the keyboard
  and Back closes it. Opening that file takes about 15 s before find can run.
- Line positions come from wrapped rows of a measured monospace cell, which
  also fixes opening a file at a line far down (rows were assumed 20 px).
- Not seen on the device, since small files now open in the editor: a link
  to line ~1000, long wrapping lines and tab indents in the read-only view.
- Not modelled: line breaks at punctuation other than hyphens, and characters
  wider than one cell (CJK, emoji).

### C3: terminal find on mobile

Evidence state: verified on Paseo Debug at the batch build.

- The native renderer searches its headless buffer like web terminal find:
  literal, without case, across soft wraps, capped at 20,000. Next and
  Previous step from the selected match's position, so scrollback trimmed by
  new output does not shift them.
- Seen on the device, over 3,000 rows: a term at the start of history is
  found; 11 matches count and paint, Next and Previous wrap; a match across a
  soft wrap and one ending on the last column paint on both rows; the current
  match stays clear of the bar; with the keyboard up the bar sits above the
  key bar, typing in it sends nothing to the shell, and closing it gives input
  back; Back closes it.
- After the app restarts, find covers only the scrollback the host replays on
  reattach, so early rows are no longer found.
- Not seen: output arriving while scrolled to a match, Next after scrollback
  trims, and the full-scan timing.
- Not handled, as on web: a wide character pushed to the next row leaves a
  blank cell, so a match across that wrap is not found.

### D1: file editing on mobile

Evidence state: verified on Paseo Debug at the batch build, with the limits
below.

- Native runs the web CodeMirror editor in a WebView page built by
  `npm run build:webviews`. The page sends ChangeSets; the host keeps
  `FileEditorModel` as the source of truth, checks a checksum before saving
  and asks for the whole document when the copies drift. Edits go across at
  once below 100,000 characters and every 100 ms above.
- The read-only view shows the file until the editor reports ready. Three
  renderer crashes or start timeouts, or a protocol mismatch, leave the file
  read-only.
- The committed editor page is 1.4 MB (minified, all highlight languages). A
  unit test fails when it is older than its sources or bundled package
  versions.
- CodeMirror 6.43.14 uses Android's EditContext input on Chrome 126 and later,
  so the keyboard checks below exercise that path.
- Seen on the device: typing autosaves and the cursor stays above the
  keyboard; paste; an external change while clean reloads, and while dirty
  raises the conflict, where Overwrite keeps the last keystrokes; a deleted
  file keeps the open copy; vim normal, insert and visual mode; backgrounding
  the app saves at once; a 980 KB file is editable within about 6 s of
  opening.
- Not seen: Gboard composition, autocorrect and emoji (adb input bypasses the
  keyboard), closing the tab before autosave, and renderer kills (the shell
  cannot kill the WebView renderer). Phones are portrait-locked, so rotation
  belongs to the tablet checks.
- Find in the editor runs the web FileFindModel in the page, replace included,
  under a native bottom bar. The batch found two bugs, now fixed: the bar sat
  under the keyboard, and Replace all right after typing did nothing, because
  the previous query's zero count disabled it. Seen: matches fold accents,
  replace all saves, a query typed and replaced at once uses the new query,
  and Back closes find. Opening the replace row can leave the current match
  under the taller bar until the next step.

### E: tablets

Evidence state: accepted on code review, unit tests and an Android release
build. The user chose to skip the tablet checks: dev-station has no KVM, so an
emulator there would be unusable, and running one on the Mac was declined.
The pending cases below stay unverified.

- Wide native means a window at least 576 dp wide: tablets and unfolded
  foldables. Android 16 ignores the portrait lock at 600 dp and wider, so
  these layouts rotate; C2's and D1's rotation cases join the tablet batch.
- E2a: side-by-side diff was gated to web by two checks the manifest did not
  list (`panels/diff-panel.tsx`, `git/diff-pane.tsx`). Both now follow width
  only. Pending on the tablet: the layout toggle shows, split columns scroll
  and select.
- E2b: wide native layouts split panes like web. Split right and Split down
  come from the tab menu; the divider resizes by touch; touching a pane
  focuses it. Drag-to-split and tab drag stay web-only by design: dnd-kit is
  DOM-only, and touch drags compete with scrolling and swipe gestures. Every
  visible pane now streams its agent, as on web. Pending on the tablet: split
  right and down from the tab menu; resize by touch without fighting either
  pane's scroll; close a split; the layout survives a restart and rotation;
  no drag-to-split or tab drag; a tap on a button in an unfocused pane fires
  once and focuses it; two agent panes stream while the other scrolls
  (record frame stats as for C1); the explorer pane opens files beside it,
  and a split-screen resize to compact and back keeps it reachable.
- E1: with a hardware keyboard on a wide native layout, the shortcut registry
  runs as on web. `paseo-hardware-keyboard` now covers Android through a
  `MainActivity` plugin. JS publishes which combos fire while typing and
  which only outside a field, from web's focus-scope rules; the composer and
  both terminal renderers claim their scope. Native consumes a combo only
  when that allows it, so text editing keeps its keys. Enter submits the
  composer on Android as on iPad. Settings lists shortcuts on native
  read-only; rebinding stays a gap, deferred past this campaign, since
  capture reads DOM key events. Also deferred: shortcut badges while a
  modifier is held, and Electron's browser shortcuts (Mod+L focuses the
  address bar, Mod+R reloads); on native a focused browser tab counts as a
  text field, so Mod+L focuses the composer. Known limits: the second key of a two-key shortcut is
  also typed into a focused field; the system may take some combos first.
  Pending on the tablet with a keyboard: Ctrl+K from the composer; Alt+arrow
  and Ctrl+Backspace still edit in it; Ctrl+F in the file editor opens one
  find; Enter submits and Shift+Enter adds a line, and neither submits
  during composition or from the find bar; Ctrl+D reaches the shell in both
  terminals; after the WebView terminal, Cmd+Shift+Left in the find bar
  selects text (iPad); Escape and Back still work; a keyboard connected after launch
  enables shortcuts and unplugging it hides the section.
- Follow-up after the campaign: the compact explorer dock
  (`NativeExplorerSidebarDock`) is now reachable only from a test override;
  remove it.
- E3: native gets a touch outline rail under the web rule: a wide layout and a
  chat panel at least 918 dp wide, so landscape tablets show it and portrait
  ones do not. A finger on the rail previews the prompt under it and lifting
  jumps there; nothing magnifies, since touch has no hover. Pending on the
  tablet: the rail shows in landscape only, scrubbing previews, lifting jumps
  (also to a prompt outside the loaded window), the active tick follows
  scrolling, and a vertical scrub does not scroll the transcript; with the
  soft keyboard up the first touch previews the right prompt; with the
  sidebar collapsed and gesture navigation on, a scrub does not trigger
  Back; TalkBack steps through prompts.

### F: browser tabs and copy

- F1, verified on Paseo Debug except a service link: native opens browser tabs in a WebView pane with an address bar, back,
  forward and reload; Android Back steps back through its history. Service
  links open in a tab on native and Electron, and externally in a plain
  browser. Over relay a native device gets only a service's public URL, since
  loopback and `*.localhost` targets point at the phone itself; a LAN host
  stays reachable. Top-level loads allow http, https and about:blank; mailto:
  and tel: go to the system; other schemes show the unsupported-protocol row.
  react-native-webview never told Android's guard which frame loads, so a
  patch passes `isForMainFrame`; a frame it cannot name gets the top-level
  rule without the system hand-off. On Android the guard is defence in depth:
  it fails open when JS misses its 250 ms answer, and the hard limits are
  `allowFileAccess={false}` and WebView's own refusal of unknown schemes.
  Popups open as new tabs without `window.opener`, so OAuth flows that need
  the opener fail. Native asks before opening a link each time, since the
  setting that remembers the answer is Electron-only. A direct connection
  through a loopback tunnel such as `adb reverse` gets no local service link.
  Browser data settings clear every in-app WebView's cookies, storage and
  cache through `paseo-webview-data`. HTTP error statuses show the server's
  page without an error row, as on Electron. Devtools, annotation,
  automation, viewport presets and downloads stay Electron-only. Seen: a tab
  from the workspace menu; typed URLs, back, forward; Android Back steps
  through the tab's history; a popup opens a tab; title and favicon; mailto:
  opens the system chooser; an iframe with a tel: source does nothing;
  intent: shows the blocked row; clearing data signs the page out and reloads
  it. Chromium itself drops a page's top-level data: link, so it shows no
  row. The batch fixed two bugs: unstyled pages drew black text on the dark
  theme (the page base is now white, as in Electron), and a failed load showed
  a blank pane (Android starts its error page as a load, which cleared the
  row; the pane now says what failed). Not seen: a workspace service link,
  which needs a project with a service script.
- F2: copying a whole reply already copies its Markdown source on native. A
  new Select text action under each native reply opens the reply's Markdown
  in a read-only input, so a selection of any part keeps its syntax. Very
  long replies show their first 50,000 characters there, and Copy turn copies
  all of it. Selecting the rendered text directly still copies plain text,
  since React Native exposes no selection range. Android shows the source as
  selectable Text: the batch found the read-only input there disabled, so it
  could neither select nor scroll. Seen on the device: a selection across a
  bold heading and a list item pastes with its markers; no keyboard; the
  sheet scrolls. iOS keeps the read-only input, unverified. Not seen: a reply
  over 50,000 characters.

## Current boundary

- All chunks are implemented. C2, C3, D1, F1 and F2 passed the phone batch
  with the limits in their sections; F1 stays open for a service link. E is
  accepted without device checks, by the user's choice.
- Device checks are batched: the user asked for one phone session per large
  chunk instead of a check per increment. Plan boxes stay open until then.
- B2's push checks wait for the first fork release that contains it.
- Native behaviour is checked on Paseo Debug on the user's Android phone. iOS
  and physical tablets are not available.

## Progress log

- 2026-10-16: plan written from the desktop/mobile survey; baseline recorded.
- 2026-10-16: A and B1 accepted after device checks; B2 push proof moved to a
  release gate because Paseo Debug cannot receive push.
- 2026-10-16: C1's first increment accepted: native chat find with jump to
  the message.
- 2026-10-16: C1 accepted after device checks: marks and scrolling to the
  occurrence. B2's push proof deferral to its first fork release confirmed by
  the user.
- 2026-10-16: phone batch on Paseo Debug for C2, C3, D1, F1 and F2. It found
  six bugs, fixed and re-checked on the device. The tablet checks were
  skipped by the user.
