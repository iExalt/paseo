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
| Overall state   | Complete: A and B verified on web and Android, B's push on a phone; C verified live on web |
| Immediate focus | None; archived. Remaining limits are under Current boundary and Parked                     |

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
  Capture: [android-hero-cap.png](../qa-evidence/question-images/android-hero-cap.png).

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
  [android-previews.png](../qa-evidence/question-images/android-previews.png).
- Push (the user's S24U, Paseo Debug built at `d7df190cc` with the debug Firebase config, branch
  daemon on dev-station over the relay, app backgrounded with `am kill` and quiet for over
  180 s), read from `dumpsys notification`: a finished reply `![](x.png)` showed `[image]`; a
  question titled `Which hero? ![Hero banner](…)` showed `Which hero? [image: Hero banner]`.

### C — Agent instruction and docs

Evidence state: verified on web.

- Agents with Paseo tools are told, beside the Paseo CLI instructions, that question dialogs show
  Markdown images in question text, option descriptions and image-only previews, one image per
  line with alt text, as a workspace PNG or an absolute path.
- The durable rules moved to [Markdown renderer](../markdown-renderer.md#links-and-images).

Evidence:

- Commit: `d684c2207` feat(server): tell agents question dialogs show images.
- Unit: `agent-manager.test.ts` pins the sentence (`question dialogs show Markdown images`).
- Live (Mac branch daemon at `d684c2207`, own home, port 6796, agent tools on, Claude Opus 5.5):
  attempt 1 of at most 3, workspace with `icons/compass.png`, `leaf.png` and `sunrise.png`,
  prompt `Pick an app icon for me from icons/ — ask me which one I want.` Claude transcript
  `446a63d1-79e9-451f-8d3f-6f92912ef137`, Paseo agent `8bf5eece-ec14-49a1-92d5-df3491b0667b`.
  The agent opened the PNGs, then asked with each option's preview set to
  `![Sunrise icon](icons/sunrise.png)` (and Compass, Leaf). Headless Chromium on the daemon's web
  UI found 3 preview images, each loaded and 240 px tall. Asked afterwards, the agent quoted the
  instruction sentence verbatim. Capture:
  [web-live-claude.png](../qa-evidence/question-images/web-live-claude.png).
- The live agent used previews only. Images in question text and descriptions are covered by the
  mock agent on web and Android (A, B), not by a live agent.

### Spike findings (step 0)

- Everything in question text and descriptions already loaded when the agent ran at the
  workspace root, on web and Android, including an absolute `/tmp` path: the daemon reads it.
- The daemon ignores a create request's `cwd` when it names a workspace, and places the agent at
  the workspace root (`session.ts` `resolveSessionCreateAgentIntent`). An agent's cwd differs from
  its workspace only through `runtimeCwd`, as agent-launched agents get. The seed helper's
  `cwdSubdir` uses it.
- A question notification's title is the agent's title, not the first question; the question
  goes in the body (B's push: title `❓️ Push question`, text `Which hero? [image: Hero banner]`).
- Inline images (`Blue theme ![Blue](blue.png)`) draw at line height. Agents are told to put
  images on their own line (step 4) rather than changing renderer sizing.
- The tablet's older APK (`ab8dafbe5`) scaled small images up to the column width; `efb823a20`
  (#270) fixed that before this work.

## Current boundary

- The live check ran on web only, not on the tablet; Android rendering of the same Markdown is
  covered by A and B.
- iOS and Electron are not captured. Electron uses the web renderer.

## Parked

- An image without alt text gets a generated id, or a long base64 string while pending, as its
  web `alt` attribute. This affects all Markdown, not only questions.
- A missing image shows its pending placeholder for about 7 s before the alt text.
- An agent that had already finished a turn while the phone was active sent no second finished
  push; a fresh agent did. Seen once during B's push check; not investigated.
- Markdown inside alt text keeps its syntax in the notification placeholder (`[image: **a**]`).
