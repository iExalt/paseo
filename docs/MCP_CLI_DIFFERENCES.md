# Completed MCP-to-CLI migration

Paseo's served MCP endpoint, transport, admission exception, and runtime injection were removed in `635a4e413`. All 66 operations in the pre-removal inventory have dedicated CLI replacements. Provider-native tools, shared services, and third-party MCP support remain.

This document records the completed migration from the inventory at `b48df9e24`; Git history retains the original gap analysis. Current usage belongs in the [CLI reference](../public-docs/cli.md), [tool policy and caller context](../public-docs/mcp.md), [browser reference](../public-docs/browser-tools.md), and [schedule reference](../public-docs/schedules-cli.md). Keeping this filename preserves existing handoff links; it is no longer an open implementation plan.

## Completion checklist

- [x] Replace all 66 Paseo operations, including browser and speech.
- [x] Preserve caller/workspace defaults, notifications, runtime settings, and native tools.
- [x] Remove served MCP transport and injection; retain legacy persisted settings as migration input.
- [x] Replace obsolete documentation and checked-in skill guidance.
- [x] Record verification limits without treating untested journeys as passed.

## Operation mapping

Names on the left are historical MCP/native catalog IDs, not CLI syntax. Commands omit the `paseo` prefix; use `--help` for arguments. Output is command-specific and does not preserve MCP content envelopes.

| Former operation                  | CLI replacement                    |
| --------------------------------- | ---------------------------------- |
| `speak`                           | `speech speak`                     |
| `create_workspace`                | `workspace create`                 |
| `list_workspaces`                 | `workspace ls`                     |
| `get_daemon_notification_rules`   | `daemon notifications rules get`   |
| `set_daemon_notification_rules`   | `daemon notifications rules set`   |
| `clear_daemon_notification_rules` | `daemon notifications rules clear` |
| `set_workspace_notifications`     | `workspace update`                 |
| `archive_workspace`               | `workspace archive`                |
| `create_agent`                    | `run`                              |
| `send_agent_prompt`               | `send`                             |
| `get_agent_status`                | `agent status`                     |
| `list_agents`                     | `agent query`                      |
| `cancel_agent`                    | `stop`                             |
| `archive_agent`                   | `archive`                          |
| `kill_agent`                      | `agent close`                      |
| `update_agent`                    | `agent update`                     |
| `rename_workspace`                | `workspace rename`                 |
| `list_workspace_scripts`          | `script ls`                        |
| `start_workspace_script`          | `script start`                     |
| `stop_workspace_script`           | `script stop`                      |
| `list_terminals`                  | `terminal ls`                      |
| `create_terminal`                 | `terminal create`                  |
| `kill_terminal`                   | `terminal kill`                    |
| `capture_terminal`                | `terminal capture`                 |
| `send_terminal_keys`              | `terminal send-keys`               |
| `create_schedule`                 | `schedule create`                  |
| `create_heartbeat`                | `heartbeat create`                 |
| `delete_heartbeat`                | `heartbeat delete`                 |
| `list_schedules`                  | `schedule ls`                      |
| `inspect_schedule`                | `schedule inspect`                 |
| `pause_schedule`                  | `schedule pause`                   |
| `resume_schedule`                 | `schedule resume`                  |
| `delete_schedule`                 | `schedule delete`                  |
| `update_schedule`                 | `schedule update`                  |
| `schedule_logs`                   | `schedule logs`                    |
| `run_schedule_once`               | `schedule run-once`                |
| `list_providers`                  | `provider ls`                      |
| `list_models`                     | `provider models`                  |
| `list_profiles`                   | `profile ls`                       |
| `inspect_provider`                | `provider inspect`                 |
| `get_agent_activity`              | `agent activity`                   |
| `set_agent_mode`                  | `agent mode`                       |
| `list_pending_permissions`        | `permit ls`                        |
| `respond_to_permission`           | `permit allow / permit deny`       |
| `browser_list_tabs`               | `browser list-tabs`                |
| `browser_new_tab`                 | `browser new-tab`                  |
| `browser_snapshot`                | `browser snapshot`                 |
| `browser_click`                   | `browser click`                    |
| `browser_fill`                    | `browser fill`                     |
| `browser_wait`                    | `browser wait`                     |
| `browser_type`                    | `browser type`                     |
| `browser_keypress`                | `browser keypress`                 |
| `browser_navigate`                | `browser navigate`                 |
| `browser_back`                    | `browser back`                     |
| `browser_forward`                 | `browser forward`                  |
| `browser_reload`                  | `browser reload`                   |
| `browser_screenshot`              | `browser screenshot`               |
| `browser_upload`                  | `browser upload`                   |
| `browser_select`                  | `browser select`                   |
| `browser_hover`                   | `browser hover`                    |
| `browser_drag`                    | `browser drag`                     |
| `browser_logs`                    | `browser logs`                     |
| `browser_evaluate`                | `browser evaluate`                 |
| `browser_scroll`                  | `browser scroll`                   |
| `browser_resize`                  | `browser resize`                   |
| `browser_close_tab`               | `browser close-tab`                |

## Behavioral distinctions

- [Close, stop, archive, and delete](../public-docs/cli.md#close-stop-archive-and-delete) are separate lifecycle operations. `kill_agent` maps to `agent close`, preserving history.
- [Asynchronous delegation](../public-docs/cli.md#asynchronous-delegation) separates `--no-wait`, relationship selection, and caller notifications.
- [Runtime updates](../public-docs/cli.md#agent-runtime-settings) accept features, resets, and metadata together, but apply sequentially with partial-failure reporting.
- [Schedule replacement](../public-docs/schedules-cli.md#explicit-replacement) is explicit and matches name plus target; heartbeat update remains cadence-only.
- [Screenshots](../public-docs/browser-tools.md#files-and-screenshots) require a CLI-local output path, including when controlling a remote daemon.
- [Native policy](../public-docs/mcp.md#limit-paseo-tools-by-provider) controls exposed catalogs and guidance, not shell authorization. Host permissions still apply.
- [Configuration precedence](../public-docs/mcp.md#configuration) gives `daemon.agentTools.enabled` priority over legacy persisted MCP settings. No setting restores the removed endpoint.

## Verification record

The implementation handoff reports 128 temporary differential cases across this 66-operation inventory before transport removal. All nine temporary suites were deleted after distinct regression coverage was retained, including 138 native catalog contracts. Typechecking, lint, server build, scoped formatting, and focused tests passed. A CLI-only Electron/Xvfb browser journey passed on `dev-station`.

These are implementation receipts supplied in the handoff, not reruns from this documentation audit. Real-provider tests and real audio were not exercised; the broader Settings browser suite was not verified. The documentation audit passed typecheck, lint, scoped formatting, 319 shell-example path/option checks, all 66 operation mappings, six feature-parser checks, six configuration-precedence checks, three configuration examples, two skill frontmatters, and added local documentation links. The public schema's `agentTools` fragment was generated from the current config schema; unrelated generator drift was excluded. No live daemon journey or full local test suite was run.

## Source anchors

- [CLI registration](../packages/cli/src/cli.ts) and [feature parser](../packages/cli/src/utils/feature-values.ts).
- [Native catalog](../packages/server/src/server/agent/tools/paseo-tools.ts) and [browser catalog](../packages/server/src/server/browser-tools/tools.ts).
- [Configuration resolution](../packages/server/src/server/config.ts) and [launch context](../packages/server/src/server/agent/agent-manager.ts).
- [Schedule caller inheritance](../packages/server/src/server/schedule/caller-runtime.ts) and [replacement identity](../packages/server/src/server/schedule/store.ts).

The website landing-page automation demo in `packages/website/src/components/landing-page.tsx` still advertises Paseo MCP. Updating that interactive demo is outside this documentation-only change; it is a remaining stale product surface.

Earlier receipts under `docs/complete-campaigns/` and the historical session decomposition plan describe the MCP implementation that existed when those campaigns ran. They are historical evidence, not current setup instructions.
