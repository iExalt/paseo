# Dev commits superseded by upstream

An audit of every fork `dev` commit for work that upstream Paseo now provides,
so `dev` can be simplified. It is read-only: nothing here has been applied yet.

Snapshot: `origin/dev` 5faba853f, `upstream/main` d0fd2e532, merge-base
b8bb335c5 (2026-10-25). Each rebase of `dev` changes commit IDs and may change
verdicts; recheck an item against current refs before acting on it.

## Result

Of 478 non-merge `dev` commits, upstream fully replaces 5 and partly overlaps 3 (S1–S3).
Everything else is fork-only behaviour, fork infrastructure, or code that
upstream gates off or stubs. Upstream overlap had mostly been absorbed already:
the rebase empties commits upstream duplicated, and the two `chore(rebase): adapt
incorporated upstream to the fork` commits (1160b8b74, fab7425bd) removed about
2,400 lines of 0dfb58612 (#161) while reconciling it with upstream. What is left is
mostly small and listed below.

The audit also found two live bugs on `dev`; fix those first.

## Bugs found

| ID  | Bug                                                                                                                                                                                                                                                                                                                                                                                                                  | Fix                                                                                                                                                                                                                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S4  | Dragging a tab onto a pane to split it fails on web and desktop. `components/split-drop-zone.web.tsx` (0dfb58612) shadows upstream's `split-drop-zone.tsx` under web resolution and does not export `resolveSplitDropPosition`, which upstream's `workspace-tab-drag-scope.web.tsx:22,137` (adf27de7d, #7424) calls. TypeScript resolves the `.tsx` file, so typecheck passes; the import is `undefined` at runtime. | Delete the dead E2b leftovers `components/split-dnd.tsx`, `split-dnd.types.ts`, `split-dnd.web.tsx`, `split-drop-zone-position.ts`, `split-drop-zone.web.tsx` and `platform-parity/manifest.ts:58-65`. Add a web-resolution test that the drag scope's import exists. |
| S6  | Settings → Editor shows on native, though its only setting, Vim keybindings (`settings/editor-section.tsx:13,21`), applies only to the web editor. Upstream has marked the section `webOnly` since ff6424fa4 (`screens/settings-screen.tsx:183-187`); dev's `isSettingsSectionAvailable` gate table has no `editor` entry.                                                                                           | Add a `"web"` gate for `editor` and a case in `section-availability.test.ts`.                                                                                                                                                                                         |

S4 is proven by source reading, a web-first esbuild bundle that fails with
`No matching export … resolveSplitDropPosition`, and a vitest probe under web
resolution where the import is `undefined`. Electron falls back to `.web.*`, so
desktop is affected too. The drag failure itself has not been reproduced in a
running app.

## Simplify

Line references are at 5faba853f unless they name d0fd2e532.

| ID  | Commit                   | Upstream now provides                                                                                     | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ------------------------ | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | 71489f1af                | adf27de7d (#7424) inlines reanimated and worklets (d0fd2e532 `packages/app/vitest.config.ts:112-113`)     | Delete the duplicate entries at `packages/app/vitest.config.ts:116-118`. Keep the commit's test edits in `switch.test.tsx`, `plugins-page.test.tsx` and `markdown-parser.test.ts`: with upstream's versions restored, 11 cases fail under dev's dependency versions.                                                                                                                                                                                                       |
| S2  | abf561d82                | e0de0fdf6 (#7074) scopes replica-cache read invalidation to the rows being read                           | Replace dev's change-sequence bookkeeping (`runtime/replica-cache/index.ts:936-939,1078-1109,1359-1410`) with upstream's `ReplicaRead`, `activeReads` and `invalidateRowReads`. Keep what upstream lacks: skipping `syncPending` when no requested row is pending, the `MAX_READ_ATTEMPTS` miss result, and `readRowsOrMiss`, which 675361070, f78d1b5df and 70ab80812 build on. Acceptance: abf561d82's cases in `index.test.ts` and `directory-sync/index.test.ts` pass. |
| S3  | 097c903fc                | 69ef741a7 (#7423) keeps hidden status rings off the shared clock (d0fd2e532 `status-ring/clock.ts:58-72`) | Revert to upstream's names and assignment; keep only the `active` parameter that f35a6af23's reduced-motion change needs. Keep `clock.test.ts` only for dev-owned behaviour. Small saving.                                                                                                                                                                                                                                                                                 |
| S5  | 0dfb58612 (D1 leftovers) | Upstream originals of `file-panels/source/editor/extensions.web.ts` and `find/model.web.ts`               | Native editing follows upstream and stays off, so restore both files to upstream, delete `editor/visual-theme.ts`, point `readonly/view.web.tsx:7` back at `../editor/extensions.web`, and drop the unused `nativeEditor` i18n key in all nine locales.                                                                                                                                                                                                                    |
| S7  | 0dfb58612 (C2 leftover)  | none; native file find stays off                                                                          | Delete the unused `file:` find target at `screens/workspace/workspace-tab-menu.ts:180-181`.                                                                                                                                                                                                                                                                                                                                                                                |

S4, S5 and S7 remove leftovers of the native features E2b, D1 and C2 from
0dfb58612, which `dev` keeps disabled like upstream. S6 restores a gate that
dev's `section-availability.ts` lost.

## Drop from history

These leave no line at the tip, so dropping them cleans history without changing
the tree.

| Commit    | Why                                                                                                                                                             |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 83387d6ca | Upstream e86777393 (#6734) initializes the navigator polyfill in `install-early.ts`; dev's file was deleted by 1160b8b74 and its CI parts by later dev commits. |
| 0959d34fb | Upstream 6376f2bf4 (#7639) removed the WebView terminal renderer and its source hash; fab7425bd removed all seven lines.                                        |
| ccd1576fe | Already empty after rebase (upstream made the same change).                                                                                                     |
| 79336b7f4 | Already empty after rebase.                                                                                                                                     |
| 4db10f49f | Already empty after rebase.                                                                                                                                     |

Dropping 83387d6ca or 0959d34fb also requires removing the matching deletion
hunks from the commits that later removed their lines (1160b8b74, 5ee6eaf6a,
e4fd73d77 and 431665c62 for the first; fab7425bd for the second), then checking
that the rewritten tip has the same tree. The empty release markers 472b2ca4c
and 4ebf3e3d5 are intentional and stay.

## Patch upkeep

Neither is a supersession.

- `patches/react-native-enriched-markdown+…766fc0e67.patch`: upstream 4845e1da5
  (#7859, above the merge-base) rewrote the md4c autolink hunk that dev also
  changes, so the next rebase conflicts there. Upstream's version adds
  trailing-punctuation trimming and may cover dev's; keep dev's `AccessibleMarkdownTextView.kt` focus hunk (067e4c0e8).
- `patches/@expo+cli+57.0.28.patch` applies to the locked 57.0.32 with a
  patch-package version warning; rename it to match.

## Not superseded

Every other product commit was checked against d0fd2e532 code. The main reasons
they stay:

- Fork-only features: workspace notification policy and reply rules, queue/steer
  sends, session cost and API spend, in-place Claude rewind, the MCP-to-CLI
  migration (c29ae24b9), native chat and terminal find, native outline rail,
  native diff selection and review, hardware-keyboard terminal keys, the bundled
  terminal font.
- Upstream stubs or gates the same surface off on native (chat find, outline,
  browser pane, keyboard shortcuts, side-by-side diff, selection copy).
- Fork release, Nix updater, Android update, relay performance and desktop
  packaging work, none of which upstream has.
- Dependency patches and toolchain pins: upstream has not bumped or patched the
  same packages (react-native-svg, unistyles, reanimated, webview, @opencode-ai/sdk).

Upstream PRs that would supersede fork work if merged: #6466 (Claude streamed
blocks; 7af3c8fe1), #4398 and #5756 (Linux launcher; 52aef2027 and the RPM
fixes). Recheck those commits when they land.

151 fork CI/release commits leave no line at the tip because later fork commits
replaced them. They are squash candidates for history size only and do not bring
`dev` closer to upstream.

## Out-of-scope findings

- Agents on `dev` lost upstream #7343's input-mode-aware terminal keys: c29ae24b9
  moved agents from the MCP `send_terminal_keys` tool to `paseo terminal
  send-keys`, which uses the shared client's fixed key table
  (`packages/client/src/terminals/index.ts:152-182`). Upstream's own CLI has the
  same limit, so the fix belongs in the shared client.
- `packages/server/src/server/agent/archive-discovery.e2e.test.ts:54` (upstream
  #7532) connects to `/mcp/agents`, which `dev` no longer serves. Routine CI
  does not run it; it would fail, since only upstream registers that route
  (`bootstrap.ts:272`).

## Applying the results

`rebase-dev.mjs` replays commits one-to-one and has no drop list, so the two
routes differ in cost:

- **Forward fixes (recommended for S1–S7):** ordinary conventional-commit PRs to
  `dev`. They shrink the tree's diff from upstream now, carry their own tests,
  and need no history rewrite.
- **History drops:** only tidy history. Do them during a manual rebase, with the
  matching deletion hunks removed and the tip tree compared, or skip them.
  Revert commits on top would replay both sides on every rebase and add
  conflicts for no tree change.

## Method and limits

- Forward `git blame` over `b8bb335c5..5faba853f` attributed every surviving
  line to its `dev` commit; reverse blame named the commit that removed each
  lost line. Lines removed by the adapt commits pointed at upstream overlap.
  Lockfiles and binaries were excluded; forward and reverse blame differ by up
  to a few dozen lines per commit.
- Six read-only auditors judged the 121 product commits, seven package-touching
  CI/docs commits, both adapt commits and the dependency patches against
  d0fd2e532 code and the 687 upstream commits since 2026-09-20. A peer reviewer
  checked the non-keep verdicts against source, except S5 (partly checked) and
  S7 (not checked).
- No simplification was applied or tested as a rewrite; S2's acceptance test is
  defined but not run. S4's runtime failure is derived, not observed.
