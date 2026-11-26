# CLAUDE.md

Paseo is a mobile app for monitoring and controlling your local AI coding agents from anywhere. It connects directly to your actual development environment — your code stays on your machine.

**Supported agents:** Claude Code, Codex, GitHub Copilot, OpenCode, Pi, Oh My Pi, Antigravity, and Muse Code.

## Repository map

This is an npm workspace monorepo:

- `packages/server` — Daemon: agent lifecycle, WebSocket API, provider-native tools
- `packages/app` — Mobile + web client (Expo)
- `packages/cli` — Docker-style CLI (`paseo run/ls/logs/wait`)
- `packages/relay` — E2E encrypted relay for remote access
- `packages/desktop` — Electron desktop wrapper
- `packages/website` — Marketing site (paseo.sh)

## Docs

`docs/` is the source of truth for system-level and process-level knowledge. **"The docs", "check the docs", or "check the X docs" always mean this directory — not the web.** Look here before fetching anything online; the docs capture gotchas and conventions you cannot derive from the code or external sources.

Fork-specific operating notes live at the top level of `docs/`. Paseo's bundled documentation and evidence live in `docs/upstream/`. Upstream code comments and lint messages cite these as `docs/<name>.md`; read `docs/upstream/<name>.md`. Process docs in `docs/upstream/` (release, Docker, EAS) describe upstream's pipeline unless a fork note says otherwise.

- **At the start of non-trivial work, read the docs index, [docs/README.md](docs/README.md), and open the entries relevant to the task.**
- **Before writing or editing a doc or this file, read [docs/writing-docs.md](docs/writing-docs.md).**

## Quick start

```bash
npm run dev                          # Start the dev daemon
npm run dev:app                      # Start Expo against the dev daemon
npm run dev:desktop                  # Start Electron desktop dev
npm run cli -- ls -a -g              # List all agents
npm run cli -- daemon status         # Check daemon status
npm run typecheck                    # Always run after changes; runs build:server first in a fresh checkout
npm run lint                         # Always run after changes
npm run format                       # Auto-format with oxfmt
npm run format:check                 # Check formatting without writing
```

Repo dev commands use checkout-local state by default. In this checkout, `PASEO_HOME` resolves to `.dev/paseo-home`, and `npm run cli -- ...` targets that same dev home automatically. The packaged desktop app and production-style daemon keep using `~/.paseo` on port `6767`.

See [docs/upstream/development.md](docs/upstream/development.md) for full setup, build sync requirements, and debugging, and [docs/upstream/android.md](docs/upstream/android.md) for APK builds.

## Release branches

Open PRs against `dev` and merge them there; it is the fork's default branch. Never target
`upstream/main`: it mirrors upstream, and `rebase-dev` rebases `dev` onto it. Releases cut from `dev` through release-please;
see the `release-stable` skill.
[docs/upstream/release.md](docs/upstream/release.md) and the root `release:*` npm scripts are
upstream's npm, EAS and store process; never follow or run them in the fork.

## Critical rules

- **NEVER restart the main Paseo daemon on port 6767 without permission** — it manages all running agents. If you're an agent, restarting it kills your own process. A timeout is often transient and is not a reason to restart.
- **Before changing app routes, startup routing, remembered workspace restore, or active workspace selection, read [docs/upstream/expo-router.md](docs/upstream/expo-router.md).**
- **Before adding platform-specific code, hover UI or layout switches in `packages/app`, read [docs/platform-gating.md](docs/platform-gating.md).** Code is cross-platform by default.
- Run the [focused tests your change affects](docs/upstream/testing.md#running-tests-locally). Run a whole workspace suite locally only when explicitly asked. Leave full Playwright runs to CI and check which lanes ran on the PR. Redirect broad output to a file. Reuse another agent's green result only for the same revision and inputs.
- Use [controlled clocks and explicit readiness signals](docs/testing.md) in tests.
- Add tests to existing suites and reuse their npm scripts and CI jobs instead of creating feature-specific ones. Don't add auth checks or skips to tests; providers handle their own auth ([testing.md](docs/upstream/testing.md#agent-authentication-in-tests)).
- **Always run typecheck and lint after every change, and `npm run format` before committing, through npm scripts only.** Pass file paths for targeted checks (`npm run lint -- <files>`, `npm run format:files -- <files>`); never run `npx eslint`, `npx oxfmt`, `npx oxlint` or package-local binaries. Do not fix formatting by hand.
- **Keep remote-only checks remote.** When a task assigns verification to another host, verify the same source revision there first, then use `LEFTHOOK=0 git commit` locally. The pre-commit hook otherwise reruns typecheck and can trigger builds on the Mac. Record the remote checks and confirm the staged source matches what passed before skipping the duplicate hook.
- **Build workspace packages before diagnosing cross-package type errors.** Packages consume each other's generated `dist` declarations, and typecheck builds them only when they are missing, not when they are stale. Rebuild the owning stack as [docs/upstream/development.md](docs/upstream/development.md) describes; do not patch inferred callback parameters or add duplicate local types to silence stale declarations.
- **The protocol stays backward-compatible. Features don't have to.** Before touching `packages/protocol`, adding an RPC, or changing wire schemas, capability negotiation, or behavior across client and daemon versions, read [docs/upstream/protocol-compatibility.md](docs/upstream/protocol-compatibility.md). For a new RPC, also read [docs/upstream/rpc-namespacing.md](docs/upstream/rpc-namespacing.md).

## Debugging

The daemon log is `$PASEO_HOME/daemon.log`. It logs at `info` and rotates; [docs/upstream/development.md](docs/upstream/development.md#daemon-logs) says how to get full traces.
