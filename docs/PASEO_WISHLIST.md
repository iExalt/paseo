# Paseo wishlist

- [ ] New workspaces default to **Chat** instead of **Terminal**.
- [ ] Make the model picker more like Cursor's: put a **Commonly used** section at the top and group providers (Claude, Codex, etc.) into expandable sections. Let users configure the picker in **Settings** to hide unused providers and models.
- [ ] Interrupting/noninterrupting agent to agent messaging
- [ ] Fix the schedule creation tool ignoring the **archive on finish** argument.
- [ ] Support `$` to only bring up skills
- [ ] Speed up dev rebase workflow, don't run checks in the workflow
- [ ] Make sure both dev/upstream rebase workflows are safe (handle reruns, cancellation, parallelism 1, etc)
- [ ] Make the relay socket report its buffered amount, so heavy terminal output streams instead of forcing a snapshot every 256 KB, while keeping the bound on how far a slow relay client can fall behind. Add a session-controller test: a client over `MAX_CLIENT_BUFFERED_BYTES` still gets the snapshot fallback, and a draining client streams. (P2 item deferred from `MOBILE_TERMINAL_PLAN.md`.)
