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
| Current chunk                | D: editing on mobile                                                     |
| Overall state                | A, B1 and C1 accepted; C2, C3 and D1 wait for the device batch           |
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

Evidence state: accepted on code review and unit tests; the device checks wait
for the batch session.

- Line positions come from wrapped rows of a measured monospace cell, which
  also fixes opening a file at a line far down (rows were assumed 20 px).
- Pending on the device: a link to line ~1000 lands centred; in a file of
  long wrapping lines, line ~1000 and a match near the end land centred within
  a few rows; a tab-indented file draws 4-column indents and a deep line lands
  centred; "N of M" matches the tints, every match is tinted and the current
  one strong, Next and Previous wrap, É finds é, typing stays responsive in a
  ~5 MB file, the bar sits above the keyboard; Back and switching tabs close
  it; Find is absent for a too-large file and a non-source preview.
- Not modelled: line breaks at punctuation other than hyphens, and characters
  wider than one cell (CJK, emoji).

### C3: terminal find on mobile

Evidence state: accepted on code review and unit tests; the device checks wait
for the batch session.

- The native renderer searches its headless buffer like web terminal find:
  literal, without case, across soft wraps, capped at 20,000. Next and
  Previous step from the selected match's position, so scrollback trimmed by
  new output does not shift them.
- Pending on the device: in a busy terminal with scrollback, a term deep in
  history is found, Next and Previous wrap, and the count matches the
  highlights; a match across a soft wrap and one ending on a wrapped row's
  last column paint on both rows; output arriving while scrolled to a match
  does not move the view; after scrollback trims, Next lands on the right
  match; the current match is not under the bar; with the keyboard up the bar
  shows above the key bar, typing in it sends nothing to the shell, and
  closing it gives input back; Back closes it. Time a full scan of a full
  scrollback: above about 50 ms, scan in chunks.
- Not handled, as on web: a wide character pushed to the next row leaves a
  blank cell, so a match across that wrap is not found.

### D1: file editing on mobile

Evidence state: the bridge, page and native host are accepted on code review,
unit tests and a browser test; the device checks wait for the batch session.

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
- Pending on the device: type and see autosave in the bar; Gboard composition,
  autocorrect replacing a word mid-line, and emoji; selection handles, copy and
  paste; rotate with the keyboard up and the cursor stays visible; an external
  change while clean reloads, and while dirty raises the conflict, where
  Overwrite keeps the last keystrokes; a deleted file; vim normal, insert and
  visual mode; type then close the tab at once, and the text survives;
  backgrounding the app saves; one renderer kill recovers to an editable view,
  and three before ready show the notice and the read-only view; start time on
  a 1 MB file.
- Find in the editor runs the web FileFindModel in the page, replace included,
  under a native bottom bar. Pending on the device: find, replace and replace
  all on a long file, and the edit saves; the current match stays above the bar
  with the keyboard up; Back closes find; typing a query and tapping Replace
  all at once uses the new query; after a renderer kill with find open, Back
  still works and the bar is closed once the editor is back; Mod-f from a
  hardware keyboard opens it (keyboard only).

### E: tablets

Evidence state: E0 spike done; E2a implemented with unit tests.
Device checks wait for a tablet emulator batch.

- Wide native means a window at least 576 dp wide: tablets and unfolded
  foldables. Android 16 ignores the portrait lock at 600 dp and wider, so
  these layouts rotate; C2's and D1's rotation cases join the tablet batch.
- E2a: side-by-side diff was gated to web by two checks the manifest did not
  list (`panels/diff-panel.tsx`, `git/diff-pane.tsx`). Both now follow width
  only. Pending on the tablet: the layout toggle shows, split columns scroll
  and select.
- E3: native gets a touch outline rail under the web rule: a wide layout and a
  chat panel at least 918 dp wide, so landscape tablets show it and portrait
  ones do not. A finger on the rail previews the prompt under it and lifting
  jumps there; nothing magnifies, since touch has no hover. Pending on the
  tablet: the rail shows in landscape only, scrubbing previews, lifting jumps
  (also to a prompt outside the loaded window), the active tick follows
  scrolling, and a vertical scrub does not scroll the transcript.

## Current boundary

- Chunks E and F are not implemented. C2, C3 and D1 wait for the device batch.
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
