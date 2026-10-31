# Question images plan

Agents can show real images in question dialogs: in the question text, in
option descriptions, and as an option's whole preview. Today an agent that
wants to show a visual draws an ASCII mockup in the monospace `preview` box,
because nothing tells it Paseo can draw images there. Notifications for such
questions read cleanly on every platform.

Progress and evidence: [Question images status](QUESTION_IMAGES_STATUS.md).

## Known facts

Read from code at `73ac3f53e`, before anything was rendered. Two facts were corrected after the
spike and are marked **Corrected**; the evidence is in the [status](QUESTION_IMAGES_STATUS.md#spike-findings-step-0).

- The question text, option labels and option descriptions go through the
  shared Markdown renderer (`packages/app/src/components/question-form-card.tsx:153,160,591`),
  which draws HTTP(S) images and workspace images read over the session RPC
  ([Markdown renderer](../markdown-renderer.md#links-and-images)).
- Workspace images need the daemon client and workspace root from the
  file-link context. The workspace screen supplies it around everything it
  draws, question cards included
  (`packages/app/src/screens/workspace/workspace-screen.tsx:3821`), so images
  in question text and descriptions may already work. **Corrected:** that
  resolves against the workspace root, while replies resolve against the
  agent's cwd. The two differ only for an agent created with `runtimeCwd`,
  because the daemon ignores a create request's `cwd` when it names a
  workspace. Question cards now use the agent-cwd resolver.
- `preview` is a plain string drawn in `ScrollableCodeSurface`: monospace,
  wrapped, 240 px tall at most on web and uncapped on native
  (`question-form-card.tsx:42-44,163-175`).
- Every provider sends questions as plain strings: Claude `AskUserQuestion`,
  Codex, OpenCode, Pi and OMP. Images in Markdown work for all of them without
  a protocol or provider change.
- Notification text strips Markdown and turns an image into its alt text, so
  an image without alt text vanishes
  (`packages/protocol/src/agent-attention-notification.ts:62`). For Claude
  questions the permission request carries the first question as its title and
  the option labels as its description
  (`packages/server/src/server/agent/providers/claude/agent.ts:1186`).
  **Corrected:** the notification title is the agent's title (`❓️ <agent>`);
  the request's question and option labels go in the body.
  Descriptions and previews never reach a notification.
- The daemon appends Paseo instructions to every agent's system prompt in
  `applyDaemonAppendSystemPrompt` (`packages/server/src/server/agent/agent-manager.ts:5660`).
- The Claude Code terminal shows the raw `![…](…)` source. Paseo cannot change
  that.

## Decisions

1. **Images go in question text and descriptions, not labels.** Labels are
   not selectable, take a single line and appear in notifications; an image
   there would crowd the option row.
2. **Previews stay monospace.** A preview whose whole content is one image
   reference, ignoring surrounding whitespace, draws as that image. Any other
   preview stays text, so ASCII mockups keep their spacing.
3. **No protocol or provider changes.** The work lives in the app, the shared
   notification helper and one system prompt sentence.
4. **Notifications show `[image: alt]`, or `[image]` without alt text.** Not
   `<image>`: the autolink rule a few lines later strips angle brackets. The
   same rule applies to finished notifications built from assistant replies.

## Increments

- [x] **0. Spike.** Ask one test question with a workspace PNG in the question
      text, in a description and as an image-only preview, plus one HTTP(S)
      image. Capture it on web, Electron and the Cuttlefish tablet. Record:
  - whether text and description images load already;
  - image size, and whether it overflows the card;
  - whether tapping an image in a description opens the lightbox or selects
    the option, on web and Android;
  - what an image outside the workspace (`/tmp/x.png`) shows.
- [x] **1. Text and description images.** Fix only what the spike finds.
      Likely fixes: cap image height in the compact card, and keep an image tap
      from also selecting the option. Descriptions already claim their own
      touches on native (`question-form-card.tsx:57`); the web click filter at
      `question-form-card.tsx:50-54` may need to include images.
- [x] **2. Image-only previews.** Add a pure `parseImageOnlyPreview(preview)`
      to `question-form-card-core.ts` with unit cases for a lone image,
      surrounding whitespace, text plus an image, two images and ASCII art.
      Draw a match through the Markdown image path inside the existing preview
      height cap; everything else stays in `ScrollableCodeSurface`.
- [x] **3. Notification placeholder.** Replace the image rule in
      `stripMarkdownToText` and add a case to
      `agent-attention-notification.test.ts` for an image with and without alt
      text. Check that the later link and autolink rules leave the placeholder
      alone.
- [x] **4. Tell agents.** Add one sentence beside the Paseo CLI instructions,
      only when Paseo agent tools are enabled: question dialogs show Markdown
      images from the workspace in question text, option descriptions and
      image-only previews, so save mockups as PNGs inside the workspace. Update
      the test that pins those instructions, if one exists.
- [x] **5. Docs.** Move the durable rules (where question images draw, the
      image-only preview rule, the notification placeholder) into
      [Markdown renderer](../markdown-renderer.md#links-and-images), then move this
      plan to `complete-campaigns/`.

## Acceptance

- A real Claude agent, prompted only by the new instruction, asks a question
  with images on its own. Captures on web and on the tablet show the images
  in the question text, a description and a preview.
- A real push notification from the backgrounded tablet shows the placeholder.
  Background the app with `am kill`, not force-stop, or FCM drops the push.
- Typecheck, lint and format pass; only the changed test files run locally.
- Captures are kept as receipts under `docs/qa-evidence/`.

As run, three checks differ from the criteria above. They are reported to the user for acceptance
rather than claimed as met; evidence is in the [status](QUESTION_IMAGES_STATUS.md):

- The push check ran on the user's phone with a debug build, not the tablet: the Cuttlefish build
  has no Firebase, so it cannot receive pushes. The user chose "Phone at end of B".
- The live Claude check ran on web only, against a branch daemon on the Mac, which the tablet's
  pod cannot reach. Android rendering of the same Markdown is captured with the mock agent.
- The live agent used image-only previews, not images in question text or descriptions. Those two
  are proven with the mock agent on web and Android.

## Risks

- **Prompt size.** The sentence is added to every agent session that has
  Paseo tools. If that cost is unwanted, put it in the Paseo CLI help instead;
  agents would find it less often.
- **Broken images.** A missing or out-of-workspace image should show the
  renderer's existing failure state. The spike confirms it.
- **Version drift.** An old app with a new daemon receives agents that send
  images. Old apps already draw images in text and descriptions; only
  image-only previews show as source there. No compatibility code is needed.
