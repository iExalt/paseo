# Desktop and mobile parity status

Last updated: 2026-10-25

## Purpose

This links the [parity plan](PLATFORM_PARITY_PLAN.md), which holds the chunk
checklist, to current evidence. It is not a second checklist.

## Current snapshot

| Field                        | Status                                                                   |
| ---------------------------- | ------------------------------------------------------------------------ |
| Baseline                     | `e63be054f` (`chore(dev): release 0.5.0`)                                |
| Branch                       | Merged to `dev` as `669d95cd2` (#161)                                    |
| Current chunk                | F: browser tabs and copy                                                 |
| Overall state                | C–F device-checked on the phone; E device-checked on a virtual tablet    |
| Product or release readiness | Released in `paseo-v0.6.0`                                               |
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

Evidence state: verified on the installed 0.6.0 app by the user, with waivers.

- The user checked: the host row reads "Sent to host"; the test notification
  arrives with the app in the foreground and in the background; tapping it
  does not navigate, from a cold start too.
- Waived by the user: the update prompt for a host without `pushTest`, the
  no-token row with notifications denied, and the daemon log check for
  `InvalidCredentials`.

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

Evidence state: verified on Paseo Debug, and re-checked for assistant marks
after the rebase onto upstream's enriched-markdown renderer (below).

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
- iOS is unverified.
- After the rebase onto upstream's enriched-markdown renderer (`dev` at
  `fa16ee402`), Paseo Debug on the phone: the count, marks in a paragraph, a
  code block and a match spanning text and inline code, Previous wrapping past
  the first match, scrolling to each, and Close clearing marks and the frame
  all pass. Prose is drawn by the library, which reports no lines, so reveal
  measures the occurrence's block and estimates its line from where it starts
  in the block's source; code blocks still measure the line.
- While find marks a code block, the block is drawn in JS with the native
  block's header, divider, insets and line height, in a pane that scrolls
  sideways to the match. On the phone (#181) a match past the right edge
  scrolled into view, and the content below the block moved 1 px against the
  native block, where it had moved about 150 px.

### C2: find in the file view on mobile

Evidence state: dropped. The 2026-10-24 rebase removed it, and the fork follows upstream in keeping it web-only (see Current boundary). The notes below describe the removed implementation.

Previously verified on Paseo Debug at the batch build, after two fixes.

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

Evidence state: dropped. The 2026-10-24 rebase removed it, and the fork follows upstream in keeping it web-only (see Current boundary). The notes below describe the removed implementation.

Previously verified on Paseo Debug at the batch build, with the limits
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

Pane splits on wide native layouts (E2b) were removed by the 2026-10-24 rebase
and dropped, following upstream (see Current boundary); the rest of E stands.

Evidence state: Android is device-verified on a Cuttlefish Android 17 virtual
tablet (arm64, 2560x1600 at 320 dpi, sw800dp) on a KVM-capable Linux arm64
host, with the limits below. iOS rests on code review and unit tests.

- Device: `aosp_cf_arm64_only_phone` at tablet geometry, with a virtio
  hardware keyboard. The image has no TalkBack or Gboard. The guest network is
  off and the app reaches a daemon through `adb reverse`. Airplane mode avoids
  a guest `system_server` crash loop.

- Wide native means a window at least 576 dp wide: tablets and unfolded
  foldables. Android 16 ignores the portrait lock at 600 dp and wider, so
  these layouts rotate.
- E2a: side-by-side diff was gated to web by two checks the manifest did not
  list (`panels/diff-panel.tsx`, `git/diff-pane.tsx`). Both now follow width
  only. Verified on the tablet: the layout toggle shows, two columns render,
  and both scroll, horizontally together.
  - Text selection works on native (#207, `fa29317de`): a long-press selects
    within one side, handles extend, and Copy, Select all and edge
    auto-scroll work. Android verified, iOS unverified. Select all matches
    web: it covers all files. Select all and range copy leave out `@@` hunk
    headers in unified and split on both platforms (#219). Known limit:
    a long-press drag that auto-scrolls more than about 2 screens past the
    file where it began ends; dragging a handle can still extend the
    selection.
  - The split comment editor is full width when columns are narrower than
    280 dp (#208, `fae6324b1`). Two threads on the same row then stack, on
    native and web (#213).
  - Review comments (#213): Back cancels an open comment editor instead of
    leaving the app, and Cancel and Comment work on the first tap with the
    soft keyboard up, then hide it. Known limit: an editor opened low in the
    Explorer diff sits behind the soft keyboard until it closes.
- E2b: dropped. Wide native layouts show one pane, as upstream does, and
  only the focused pane streams its agent.
- E1: with a hardware keyboard on a wide native layout, the shortcut registry
  runs as on web. `paseo-hardware-keyboard` now covers Android through a
  `MainActivity` plugin. JS publishes which combos fire while typing and
  which only outside a field, from web's focus-scope rules; the composer and
  both terminal renderers claim their scope. Native consumes a combo only
  when that allows it, so text editing keeps its keys. A hardware
  keyboard's Enter submits the composer on Android as on iPad; the soft
  keyboard's Return still inserts a newline. Settings lists shortcuts on native
  read-only; rebinding stays a gap, deferred past this campaign, since
  capture reads DOM key events. Also deferred: shortcut badges while a
  modifier is held, and Electron's browser shortcuts (Mod+L focuses the
  address bar, Mod+R reloads); on native a focused browser tab counts as a
  text field, so Mod+L focuses the composer. Known limits: the second key of a two-key shortcut is
  also typed into a focused field; the system may take some combos first.
  Verified on the tablet with the virtual hardware keyboard: Ctrl+K opens
  the palette; Alt+arrow and Ctrl+Backspace edit in the composer; Enter
  submits and Shift+Enter adds a line; Escape and Back work. In the Android
  native terminal, Ctrl+D exits `cat`, Ctrl+C interrupts `sleep` and Ctrl+U
  clears the line. The native terminal now receives hardware Enter,
  Backspace, Tab, Escape, arrows and Ctrl and Alt chords (#206, `c9820c294`),
  and Escape goes to the shell when the terminal is focused. Ctrl+F in the file editor is scoped to web and
  desktop, since native file editing stays web-only (2026-10-24 decision).
  Not verified: a keyboard attached or detached after boot (the virtual
  keyboard is fixed at boot), IME composition, and the iPad case. Known gap:
  the iPad terminal lacks Ctrl, arrow, Tab and Escape.
- Wide layouts: the Settings sidebar clears the bottom system inset (#204,
  `96ccbd19f`). When an open Explorer leaves the sidebar no room, as in
  portrait at 800 dp, the menu button and Cmd/Ctrl+B show the sidebar over it
  (#217).
- E3: native gets a touch outline rail under the web rule: a wide layout and a
  chat panel at least 918 dp wide, so landscape tablets show it and portrait
  ones do not. A finger on the rail previews the prompt under it and lifting
  jumps there; nothing magnifies, since touch has no hover. Verified on the
  tablet:
  - The rail shows only with a chat at least 918 dp wide: landscape with one
    side panel collapsed, never portrait at 800 dp.
  - Scrubbing previews and lifting jumps, including to a prompt outside the
    loaded window. A vertical scrub does not scroll the transcript, and a
    scrub with gesture navigation does not trigger Back.
  - With the keyboard up, the first touch previews the right prompt. The rail
    is mostly clipped then: only about the last 11 prompts are reachable.
  - The active tick follows scrolling on native (#203, `afe7be557`) and uses
    web's reading line 8 dp below the top, so a sliver of the previous turn
    no longer holds it (#215).
  - The reading position survives rotation after a rail jump (#205,
    `9d065a8b2`).
  - Not verified: TalkBack, which the image lacks.
  - The transcript hole after an outline jump to older history fills on web
    as the reader scrolls toward it (#209, `9b38c3f65`; e2e-covered).
  - Known bug on native: scrolling newer from a jumped-to older prompt skips
    the rows between the jump window and the loaded tail (e.g. 14 to 62 in a
    70-prompt chat). Native gap filling was withdrawn because inserting those
    rows into the inverted list pushed the jump target past the measured rows
    and broke jump landing. Jumps themselves land correctly, and
    scroll-to-index retries re-resolve the target by row id.

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

- C2, D1 and E2b are dropped. The 2026-10-24 rebase onto upstream b8bb335
  took upstream's rebuild of the same areas over #161, by the user's choice.
  Upstream disables each on native on purpose: `file-panels/source/panel.tsx`
  opens the editor only on web, `source/editor/view.tsx` shows "Source editing
  is available on web and desktop", and `supportsDesktopPaneSplits()` in
  `constants/layout.ts` returns `isWeb`. The user chose to follow upstream
  rather than port them back, and the parity manifest lists them as
  deliberate. If that changes, a port would move:
  - D1: the WebView CodeMirror editor and bridge
    (`file-panels/source/editor/webview/*`, `editor/find.tsx`,
    `find-messages*`, `view-contract.ts`, `scripts/build-webview-html.mjs`,
    `webview-source-hash.mjs`) onto `file-panels/source/editor/view.tsx`,
    which shows "Source editing is available on web and desktop" on native.
  - C2: native literal find and wrapped-row layout
    (`file-panels/source/find/index.native.tsx`, `line-matches*`,
    `readonly/line-layout*`) onto `readonly/view.native.tsx`.
  - E pane splits: touch split, divider resize and pane focus onto
    `workspace-tab-drag-context` and upstream's Explorer dock on every
    non-compact layout (upstream #7424).
  - The pre-rebase implementation is on `backup/rebase-dev/40088158235-1`,
    under `packages/app/src/file-pane/`.
- C3, F1 and F2 passed the phone batch with the limits in their sections; F1
  stays open for a service link. E passed on the virtual tablet for Android
  with the limits in its section. Not verified: iOS, the iPad, TalkBack,
  IME composition, and keyboard attach and detach.
- Device checks are batched: the user asked for one phone session per large
  chunk instead of a check per increment. Plan boxes stay open until then.
- Everything shipped in `paseo-v0.6.0`. B2 passed its release gate on the
  installed app, with three checks waived by the user.
- Native behaviour is checked on Paseo Debug on the user's Android phone, and
  E on a virtual Android tablet. iOS and physical tablets are not available.

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
- 2026-10-17: merged as #161 and released in `paseo-v0.6.0`. The user ran
  B2's release gate on the installed app: Send test, foreground and background
  delivery, and tapping all pass; the other three checks are waived.
- 2026-10-17: `dev` rebased onto upstream 88a7aec, which replaced the native
  Markdown renderer. C1's assistant marks were ported and re-checked on Paseo
  Debug.
- 2026-10-24: `dev` rebased onto upstream b8bb335, which rebuilt file panes,
  split drag-and-drop and the Explorer dock. C2, D1 and E's pane splits were
  removed pending a port; C3 survived in the native grid renderer.
- 2026-10-24: C2, D1 and E2b dropped by the user's choice, following
  upstream, which keeps them web-only.
- 2026-10-25: E checked on a Cuttlefish Android 17 virtual tablet (arm64,
  2560x1600 at 320 dpi, sw800dp) on a KVM-capable Linux arm64 host. Fixes
  from the pass: native diff text selection (#207), the narrow split comment
  editor (#208), the outline rail's active tick (#203) and reading position
  across rotation (#205), terminal hardware keys (#206) and the Settings
  sidebar inset (#204). The transcript hole after an outline jump now fills
  on web (#209); on native it remains a known bug.
- 2026-10-25: #213, #215, #217 and #219 checked together on the virtual
  tablet, each against a `dev` build. With `show_ime_with_hard_keyboard` set
  to 1 the AOSP keyboard renders and the two-tap Cancel reproduces, so no
  phone was needed. The pass found that one-tap Cancel left the keyboard up;
  #213 now blurs the input first.
