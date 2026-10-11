---
title: Browser commands
description: All 22 CLI operations for Paseo browser tabs.
nav: Commands reference
order: 37
category: Browser
---

# Browser commands

Use `paseo browser` when [browser automation](/docs/browser) is enabled and a desktop browser host is connected. Provider-native catalogs retain the corresponding `browser_*` tools where supported; Paseo no longer serves an MCP endpoint.

## Context and results

`--workspace <id>` selects a workspace; `--agent <id>` supplies agent runtime context. Without explicit context the CLI resolves the caller from `PASEO_AGENT_ID`. External callers should select a workspace for tab creation/listing. Browser IDs come from `new-tab` or `list-tabs` and are required for tab operations. Tab operations use explicit IDs and remain subject to host context checks. When both an agent and a workspace are selected, the workspace must belong to that agent.

Add `--json` for structured results and context. Results report dialogs opened during the command (alerts accepted; confirm/prompt/beforeunload dismissed). Global `--home` or `--host` selects the daemon; it does not move the browser from its connected desktop host.

## Commands

Every row starts with `paseo browser`. Brackets denote optional arguments.

| Command and arguments                                   | Purpose                                                                                        |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `list-tabs`                                             | List tabs in the selected context.                                                             |
| `new-tab [url]`                                         | Open a background tab and return its browser ID.                                               |
| `close-tab <browser-id>`                                | Close a tab and its webview.                                                                   |
| `resize <browser-id> <width> <height>`                  | Resize the viewport in pixels.                                                                 |
| `snapshot <browser-id>`                                 | Read the accessibility tree and fresh element refs.                                            |
| `screenshot <browser-id> --output <path> [--full-page]` | Write a PNG on the CLI machine.                                                                |
| `logs <browser-id> [--max-entries <n>]`                 | Console and network entries; default 50, maximum 200.                                          |
| `wait <browser-id> --text <text>`                       | Wait for visible text.                                                                         |
| `click <browser-id> <ref>`                              | Click; accepts `--button left                                                                  | right | middle`, `--double-click`, repeatable `--modifier`. |
| `fill <browser-id> <ref> <value>`                       | Replace input content.                                                                         |
| `type <browser-id> <text> [--ref <ref>]`                | Type into a referenced or focused control.                                                     |
| `keypress <browser-id> <key> [--ref <ref>]`             | Press Enter, Escape, Tab, or another key.                                                      |
| `hover <browser-id> <ref>`                              | Hover, including CSS hover behavior.                                                           |
| `select <browser-id> <ref> <value>`                     | Select an option.                                                                              |
| `drag <browser-id> <source-ref> <target-ref>`           | Drag between elements.                                                                         |
| `upload <browser-id> <ref> --file <path>`               | Set file input contents; repeat `--file` for multiple files.                                   |
| `scroll <browser-id> <delta-x> <delta-y> [--ref <ref>]` | Scroll in CSS pixels.                                                                          |
| `navigate <browser-id> <url>`                           | Open an HTTP(S) URL.                                                                           |
| `back <browser-id>`                                     | Go back; errors if no history exists.                                                          |
| `forward <browser-id>`                                  | Go forward; errors if no forward entry exists.                                                 |
| `reload <browser-id>`                                   | Reload the page.                                                                               |
| `evaluate <browser-id> <function> [--ref <ref>]`        | Evaluate JavaScript; with a ref, pass the element as the first argument. Returns bounded JSON. |

`wait` also accepts `--url <url>` instead of `--text`. Supply exactly one condition. `--timeout-ms <ms>` accepts 1–30000 milliseconds.

## Snapshot, act, verify

```bash
paseo browser list-tabs --workspace <workspace-id> --json
paseo browser snapshot <browser-id> --json
paseo browser click <browser-id> @e3
paseo browser wait <browser-id> --text "Saved" --timeout-ms 10000
paseo browser screenshot <browser-id> --output ./saved.png
```

Element refs such as `@e3` belong to the latest snapshot of that tab and expire when the page changes. On `browser_stale_ref`, take a new snapshot before retrying.

## Files and screenshots

Screenshots require `--output <path>`, resolved relative to the CLI's current directory. The parent directory must already exist. The CLI writes or overwrites the PNG and returns an absolute `outputPath` with image metadata, not inline base64. Even with `--host`, the artifact is on the CLI machine.

Uploads use paths available to the browser host in the permitted workspace. They do not transfer arbitrary files from a remote CLI machine. See [browser file access](/docs/browser).

## Errors

| Code                | Recovery                                               |
| ------------------- | ------------------------------------------------------ |
| `browser_disabled`  | Enable browser tools on the selected daemon.           |
| `browser_no_host`   | Connect a desktop browser host, then retry.            |
| `browser_stale_ref` | Read a fresh snapshot.                                 |
| `browser_timeout`   | Check page state and the wait condition.               |
| `browser_denied`    | Check URL, file path, navigation history, and context. |

An older daemon without CLI browser support returns an update-required error. Interrupting the CLI cancels the browser request.
