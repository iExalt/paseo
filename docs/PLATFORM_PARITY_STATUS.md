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
| Overall state                | A1 implemented and tested; A2 next                                       |
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

Evidence state: implemented; reviewer acceptance pending.

- 40 platform-split modules, 6 gated settings sections and 4 runtime gates
  are classified in `packages/app/src/platform-parity/manifest.ts`.
- `platform-parity/check.test.ts` fails on unclassified, stale or reasonless
  entries. The repo-level check walks `src` in well under a second.
- Limit: the test cannot find new runtime gates (`isWeb`, `isNative` and
  similar checks inside shared files).

## Current boundary

- Chunks A2 to F are not implemented.
- Native behaviour is checked on Paseo Debug on the user's Android phone. iOS
  and physical tablets are not available.

## Progress log

- 2026-10-16: plan written from the desktop/mobile survey; baseline recorded.
