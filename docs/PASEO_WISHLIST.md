# Paseo wishlist

- [ ] New workspaces default to **Chat** instead of **Terminal**.
- [ ] Make the model picker more like Cursor's: put a **Commonly used** section at the top and group providers (Claude, Codex, etc.) into expandable sections. Let users configure the picker in **Settings** to hide unused providers and models.
- [ ] Interrupting/noninterrupting agent to agent messaging
- [ ] Fix the schedule creation tool ignoring the **archive on finish** argument.
- [ ] Support `$` to only bring up skills
- [ ] Speed up dev rebase workflow, don't run checks in the workflow
- [ ] Make sure both dev/upstream rebase workflows are safe (handle reruns, cancellation, parallelism 1, etc)
- [ ] Make the relay socket report its buffered amount, so heavy terminal output streams instead of forcing a snapshot every 256 KB, while keeping the bound on how far a slow relay client can fall behind. Add a session-controller test: a client over `MAX_CLIENT_BUFFERED_BYTES` still gets the snapshot fallback, and a draining client streams. (P2 item deferred from `MOBILE_TERMINAL_PLAN.md`.)

## Known bugs

Found during the device runs for the 2026-11-03 architecture deepening
(`ARCHITECTURE_DEEPENING_STATUS.md`). Each one also shows up on a build from
before that work, so none of them comes from it. Screenshots and logs are in
`~/dev/scratch/cf-arch` on the Mac.

- [ ] **Chat rows out of order after a drag during rotation (Android).** On a
      fake-agent chat with 62 prompts, dragging 0.6 or 0.9 s after rotating to
      portrait left prompt 24's reply followed directly by prompt 53, with 25 to
      52 missing from the inverted list (`base-0.6-portrait.png`,
      `i7b-0.6-portrait.png`). Seen on `50c61e532` and `bf87f5cd3`.
- [ ] **Portrait width kept after rotating to landscape (Android).** After some
      rotations the app keeps the portrait width until the next rotation: 5 of 7
      rotations on `bf87f5cd3`, 1 of 4 on `50c61e532`. Too few runs to call a
      difference between the builds. It sits in the app root, not the agent
      stream.
- [ ] **Fork update Install needs a second press (Android).** When the app
      lacks permission to install packages, the first Install press shows "Allow
      Paseo to install updates…" but Android's Settings opens only on the next
      press (Continue). Same behaviour before the fork updater controller
      refactor (#323).
- [ ] **Notifications don't clear live on a backgrounded Android app.** Android
      drops the app's socket about 50 s after it leaves the foreground, so a push
      read on another client clears only when the app returns to the foreground.
      Clearing in the background would need the server to send a dismissal push.
