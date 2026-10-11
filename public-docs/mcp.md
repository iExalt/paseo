---
title: Paseo tools and CLI migration
description: Native tool policy and migration from Paseo's former MCP endpoint to the CLI.
nav: Tool policy and migration
order: 34
category: Orchestration
---

# Paseo tools and CLI migration

Paseo no longer serves `/mcp/agents` or injects its own MCP server into agent sessions. Use the [CLI reference](/docs/cli) for automation. Provider-native Paseo tools, shared command services, and third-party MCP servers remain supported. This page keeps its former URL for existing links.

## Configuration

`daemon.agentTools.enabled` controls provider-native Paseo tools and generated CLI guidance. It defaults to `false` in a new configuration. Enable it in **Settings → your host → Agents → Enable Paseo tools**, or configure:

```json
{
  "version": 1,
  "daemon": {
    "agentTools": { "enabled": true }
  }
}
```

Use [configuration reload](/docs/configuration#apply-changes) after editing the file, then start or reload an agent to pick up its new catalog and launch context. Reloading daemon configuration does not restart the daemon.

Legacy persisted `daemon.mcp` values are migration input only. When `daemon.agentTools.enabled` is absent, the effective value is `(daemon.mcp.enabled ?? true) && (daemon.mcp.injectIntoAgents ?? false)`. An explicit `agentTools.enabled` wins, including `false`; a daemon launch override takes precedence over the persisted value. Old settings do not restore an MCP endpoint.

## Limit Paseo tools by provider

Configure `agents.providers.<provider-id>.paseoTools` for each exact provider ID:

```json
{
  "agents": {
    "providers": {
      "codex-worker": {
        "extends": "codex",
        "label": "Codex Worker",
        "paseoTools": {
          "disabledTools": ["create_agent", "send_agent_prompt", "kill_agent"]
        }
      }
    }
  }
}
```

With the global switch enabled, omitting `paseoTools` enables the catalog. `enabled: false` disables it; `disabledTools` omits exact native tool IDs. Custom providers do not inherit this policy from `extends`. Children use their own provider's policy. The policy also filters generated CLI guidance; it does not deny shell commands or grant daemon permissions. A shell-capable agent can still invoke the CLI, subject to ordinary daemon authorization.

Browser commands require `daemon.browserTools.enabled` and a connected browser host. The voice-only `speak` native tool is separate from this catalog policy. See [browser commands](/docs/browser-tools) and [CLI speech](/docs/cli#speech).

## Caller context and daemon selection

When CLI exposure is enabled and the executable is available, managed agents receive an absolute `PASEO_CLI`, their daemon's `PASEO_HOME`, and an empty `PASEO_HOST` to discard inherited host overrides. The daemon also sets `PASEO_AGENT_ID` and `PASEO_AGENT_CWD`; caller-supplied environment values cannot replace that identity.

Invoke `"$PASEO_CLI"` and preserve this context. Do not manufacture another agent's identity. Explicit `--home` or `--host` selects a different daemon; the caller is resolved on the selected daemon and an absent caller does not establish parentage there. See [daemon selection](/docs/cli#select-one-daemon).

## Mental model

Workspaces decide where work happens; parentage decides who owns the work. A managed agent's `paseo run` defaults to a subagent in its own workspace. `--workspace <id>` changes placement without changing parentage. `--relationship detached` explicitly creates an independent agent. `--no-wait` only returns after startup or dispatch; it does not detach the worker. See [asynchronous delegation](/docs/cli#asynchronous-delegation).

## Replacing external MCP clients

Remove the old Paseo endpoint from external client configuration and invoke CLI commands through a shell-capable integration. The CLI is not an MCP transport. Its JSON output is command-specific, so update consumers rather than parsing former MCP content envelopes.

| Former operation                                     | Current reference                                                            |
| ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| Agent create/send/query/status/activity/update/close | [Agents and runtime settings](/docs/cli#agent-runtime-settings)              |
| Profiles and provider capabilities                   | [Profiles and provider discovery](/docs/cli#profiles-and-provider-discovery) |
| Workspaces, scripts, terminals, notification policy  | [CLI reference](/docs/cli)                                                   |
| Schedule and heartbeat operations                    | [Schedules from the CLI](/docs/schedules-cli)                                |
| All 22 browser operations                            | [Browser commands](/docs/browser-tools)                                      |
| Voice output                                         | [Speech](/docs/cli#speech)                                                   |
| Permission responses                                 | [Permissions](/docs/cli#permissions)                                         |
