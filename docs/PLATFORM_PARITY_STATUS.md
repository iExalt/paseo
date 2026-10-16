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
| Current chunk                | A: stop silent gaps and show sidebar notices                             |
| Overall state                | A and B1 accepted; B2 and C next                                         |
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

### C1: chat find on mobile (first increment)

Evidence state: the bar, search and jump verified on Paseo Debug; in-text
highlighting and scrolling to the occurrence are still to come.

- Find in the tab menu opens a bottom-anchored bar above the composer and the
  keyboard. a two-match search found 1 of 2, Next jumped, and Back closed the bar.
- Perfetto, same chat, two runs each, frames over 33 ms: before C1 8 and 8;
  C1 with the bar closed 9 and 11; with it open 9 and 10. Max frame and longest
  JS busy are unchanged. This chat is not the 0.4.2 baseline chat.
- Not verified on the device: streaming not pulling the view back after a
  jump. The reviewer accepted it from the code.

## Current boundary

- B2, the rest of C1 and chunks C2 to F are not implemented.
- B2's push checks wait for the first fork release that contains it.
- Native behaviour is checked on Paseo Debug on the user's Android phone. iOS
  and physical tablets are not available.

## Progress log

- 2026-10-16: plan written from the desktop/mobile survey; baseline recorded.
- 2026-10-16: A and B1 accepted after device checks; B2 push proof moved to a
  release gate because Paseo Debug cannot receive push.
- 2026-10-16: C1's first increment accepted: native chat find with jump to
  the message.
