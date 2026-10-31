# Question images status

Last updated: 2026-10-31

## Purpose

This links the [question images plan](QUESTION_IMAGES_PLAN.md), which holds the increments, to
current evidence.

## Current snapshot

| Field           | Status                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------ |
| Baseline        | `dev` at `923ea18bc`                                                                       |
| Current phase   | One phase, three chunks: A (steps 0–1), B (steps 2–3), C (steps 4–6); approved by the user |
| Overall state   | Chunks A and B verified on web and Android, B's push on a phone; C not merged              |
| Immediate focus | Chunk C: agent instruction, docs, live Claude check                                        |

## Accomplishments with evidence

### A — Images in question text and descriptions

Evidence state: verified.

- Question text and option descriptions draw Markdown images: workspace-relative, absolute and
  HTTP(S). Relative paths resolve against the asking agent's cwd, as its replies do, not the
  workspace root.
- Images in a question dialog are capped at 240 px tall without stretching. Chat keeps 560 px.
- Tapping a description image opens the lightbox and does not answer. This already held before
  the chunk; the spec now guards it.
- A missing image settles to its alt text after the image query's retries (about 7 s).

Evidence:

- Commit: `a0af3bd31` feat(app): show question images against the agent cwd, capped for dialogs.
- Web: `packages/app/e2e/browser/question-images.spec.ts`, 2 passed (44.6 s) on dev-station. With
  `view.tsx` reverted to `dev`, the agent-cwd test fails; before the cap, the 300×600 hero drew
  at 280×560.
- Regression: `question-prompt-pagination.spec.ts`, 10 passed with the agent-cwd resolver.
- Android: Cuttlefish tablet, APK built at `fc15fe046` (contains A), branch daemon on the pod.
  The 300×600 hero draws at 120×240 dp; 48 px swatches are not scaled up; a missing image shows
  its alt text; tapping a description image opens the lightbox and leaves the option unchecked.
  Capture: [android-hero-cap.png](qa-evidence/question-images/android-hero-cap.png).

### B — Image-only previews and notification placeholders

Evidence state: verified.

- An option preview that is exactly one Markdown image draws as that image under the dialog cap.
  Any other preview, ASCII mockups included, stays monospace text.
- Tapping an image preview opens the image without answering; a text preview still answers.
- Notification text shows images as `[image: alt]` or `[image]`. Linked images (badges) give
  `[image: alt]`, and `![chart](c.png)(note)` keeps its parenthesis.

Evidence:

- Commits: `5c8abbad6` feat: draw image-only option previews and show images as notification
  placeholders; `d7df190cc` folds the preview checks into the root-cwd spec journey.
- Unit: `agent-attention-notification.test.ts` 11 passed; `question-form-card-core.test.ts` 8
  passed.
- Web: `question-images.spec.ts` 2 passed (56.1 s, with an APK build running alongside). With
  the web click filter limited to descriptions, the preview test fails (the option answers).
- Android (Cuttlefish, APK at `fc15fe046`): a preview image tap opens the lightbox and leaves the
  option unchecked; a text preview tap checks its option. Capture:
  [android-previews.png](qa-evidence/question-images/android-previews.png).
- Push (the user's S24U, Paseo Debug built at `d7df190cc` with the debug Firebase config, branch
  daemon on dev-station over the relay, app backgrounded with `am kill` and quiet for over
  180 s), read from `dumpsys notification`: a finished reply `![](x.png)` showed `[image]`; a
  question titled `Which hero? ![Hero banner](…)` showed `Which hero? [image: Hero banner]`.
  An agent that had already finished a turn while the phone was active sent no second finished
  push; a fresh agent did.

### Spike findings (step 0)

- Everything in question text and descriptions already loaded when the agent ran at the
  workspace root, on web and Android, including an absolute `/tmp` path: the daemon reads it.
- The daemon ignores a create request's `cwd` when it names a workspace, and places the agent at
  the workspace root (`session.ts` `resolveSessionCreateAgentIntent`). An agent's cwd differs from
  its workspace only through `runtimeCwd`, as agent-launched agents get. The seed helper's
  `cwdSubdir` uses it.
- Inline images (`Blue theme ![Blue](blue.png)`) draw at line height. Agents are told to put
  images on their own line (step 4) rather than changing renderer sizing.
- The tablet's older APK (`ab8dafbe5`) scaled small images up to the column width; `efb823a20`
  (#270) fixed that before this work.

## Current boundary

- Chunk C (agent instruction, docs, live Claude check) has not started.
- iOS and Electron are not captured. Electron uses the web renderer.

## Parked

- An image without alt text gets a generated id, or a long base64 string while pending, as its
  web `alt` attribute. This affects all Markdown, not only questions.
- A missing image shows its pending placeholder for about 7 s before the alt text.
