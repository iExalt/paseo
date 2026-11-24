---
title: Supported providers
description: Every coding agent Paseo can launch, natively supported providers and the ACP catalog.
nav: Supported providers
order: 21
category: Providers
---

# Supported providers

For the concept and how Paseo manages providers, see [Providers](/docs/providers). To add or configure your own, see [Custom providers](/docs/custom-providers).

## Native support

CLI-based providers require their CLI to be installed and authenticated on the daemon host.

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Anthropic's coding agent with MCP support, streaming, and deep reasoning.
- [Codex](/docs/codex). OpenAI's workspace agent with sandbox controls and optional network access.
- [OpenCode](https://opencode.ai/). Open-source coding assistant with multi-provider model support.
- [Pi](https://pi.dev). Minimal terminal-based coding agent with multi-provider LLM support.
- [Antigravity](#antigravity). Uses your installed `agy` CLI through a built-in provider plugin.
- [Muse Code](/docs/muse-code). Meta's terminal coding agent, bundled as a provider plugin.
- [Cursor SDK](#cursor-sdk). An opt-in local agent using Cursor's TypeScript SDK.

### Antigravity

Install the Antigravity CLI (`agy`) on your daemon host, then run `agy` once to sign in. Pick
**Antigravity** in Paseo. The provider ships with Paseo; no separate plugin install is required.

**Full access** is the only permission mode. Antigravity cannot ask for permission when another
app drives it, so Paseo starts `agy` with `--dangerously-skip-permissions`. Every tool call,
including shell commands, runs without asking. Each session starts with a warning explaining
this, including when you reopen a chat. Antigravity's own policy can still deny
an action.

After a daemon restart, Antigravity remembers the conversation, but Paseo's transcript starts
fresh because `agy` does not replay its history.

This integration uses your installed CLI and sign-in. It is not endorsed by Google.

Steering is unavailable. Use the Paseo CLI for Paseo operations in shell-capable sessions. Your own `agy` MCP servers still work. Attached
images are passed as file references for the agent to read.

If `agy` is outside your daemon's PATH, override its command in `~/.paseo/config.json`. Use `env`
for provider-specific environment variables:

```json
{
  "agents": {
    "providers": {
      "antigravity": {
        "command": ["/absolute/path/to/agy"],
        "env": { "EXAMPLE_VARIABLE": "value" }
      }
    }
  }
}
```

See [Custom providers](/docs/custom-providers) for command and environment overrides.

### Cursor SDK

Open **Settings → Hosts → your host → Providers**. Under **Add provider**, add **Cursor SDK**.
Choose **Sign in with Cursor** and finish in your browser. The selected host keeps the attempt.
If you reload Paseo or reconnect directly to that host, open **Cursor SDK** in its provider
settings to reopen the sign-in page or cancel the attempt.

The host saves the SDK login separately from your Cursor editor login. Sign in again when it
expires. **Sign out of Cursor** clears the saved login on that host. New turns and queued turns
that have yet to start require a current credential. A running turn can finish with the
credential it already has. To revoke the minted key before it expires, use Cursor's API keys
dashboard. Existing Cursor CLI chats still
open with the **Cursor** provider.

For a headless setup, set `agents.providers.cursor-sdk.enabled` to `true` in the daemon's
`config.json` and supply `CURSOR_API_KEY` in the daemon environment or under
`agents.providers.cursor-sdk.env`. Paseo uses the provider's configured key first, then the
daemon environment key when the provider has no override. These settings take precedence over
the saved login and must be changed on the host.

In provider settings, check whether Cursor SDK is enabled before refreshing models. The model
diagnostic distinguishes a missing native helper, a rejected key, a credential without catalog
access, and an unreachable model catalog.

**Unrestricted** is the only mode. Cursor runs tools as the daemon user, with access to the
files and network that user can reach. General tool approvals and exact Hub MCP preapproval
are unavailable. Inference requests go to Cursor.

Cursor SDK can ask a structured question in the chat. A pending question remains available
after you reconnect while its turn is still running. You can answer or dismiss it. Stopping
the turn cancels the question.

Paseo adds your global Codex instructions (`AGENTS.override.md` or `AGENTS.md` in
`$CODEX_HOME`, by default `~/.codex`). For a trusted registered workspace, it also adds
`AGENTS.md` from the workspace root through the agent's working directory, the root
`.cursorrules` file, and top-level `.cursor/rules/*.mdc` rules marked `alwaysApply: true`.
Like Codex, Paseo sends this text once per context window: with the first prompt, and again
after Cursor summarizes the conversation or the text changes. Cursor keeps its built-in
instructions. Ambient settings, hooks, Cursor plugins, custom subagent definitions,
and file-configured MCP stay disabled. Paseo accepts MCP servers explicitly supplied to the
agent.

Resume uses the same native conversation and workspace. The daemon keeps its Cursor SDK
state under `$PASEO_HOME/cursor-sdk`.

## ACP catalog

Pick any of these from the in-app provider catalog. Each entry is a one-click install of the underlying CLI.

- [Agoragentic](https://agoragentic.com), agent marketplace with 174+ AI capabilities.
- [Amp](https://github.com/tao12345666333/amp-acp), frontier coding agent.
- [Auggie CLI](https://www.augmentcode.com/), Augment Code's agent backed by their context engine.
- [Autohand Code](https://www.autohand.ai/cli/), Autohand AI's coding agent.
- [Cline](https://cline.bot/cli), autonomous coding agent.
- [Codebuddy Code](https://www.codebuddy.cn/cli/), Tencent Cloud's coding tool.
- [CodeWhale](https://codewhale.net/), terminal coding agent for DeepSeek V4 and open models.
- [Cortex Code](https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code-cli), Snowflake's coding agent.
- [Corust Agent](https://github.com/Corust-ai/corust-agent-release/releases), Rust-focused coding partner.
- [crow-cli](https://crow-ai.dev/), minimal ACP-native coding agent.
- [Cursor](https://cursor.com/docs/cli/overview), Cursor's coding agent.
- [DeepAgents](https://docs.langchain.com/oss/javascript/deepagents/overview), LangChain-powered coding agent.
- [DimCode](https://dimcode.dev/docs/acp.html), multi-model coding agent.
- [Dirac](https://dirac.run), open-source agent with hash-anchored parallel edits.
- [Factory Droid](https://factory.ai/product/cli), Factory AI's coding agent.
- [fast-agent](https://fast-agent.ai/acp/), multi-provider coding agent.
- [fx](#fx), Vercel Labs' native coding agent.
- [Gajae Code](https://gajae-code.com), subscription-based coding agent with plan-before-mutation workflows.
- [Gemini CLI](https://geminicli.com), Google's official Gemini CLI.
- [GitHub Copilot](https://github.com/features/copilot/cli/), GitHub's AI pair programmer via ACP.
- [GLM Agent](https://github.com/stefandevo/glm-acp-agent), Zhipu AI's GLM coding agent.
- [goose](https://block.github.io/goose/), Block's local open-source AI agent.
- [Grok](https://docs.x.ai/build/overview), xAI's Grok Build agentic coding CLI.
- [Hermes Agent](https://hermes-agent.nousresearch.com/docs/user-guide/features/acp), Nous Research's self-improving agent.
- [Hoplite](#hoplite), cloud coding agent through its local ACP bridge.
- [Junie](https://junie.jetbrains.com/docs/junie-cli-acp.html), JetBrains' coding agent.
- [Kilo Code](https://kilo.ai/docs/code-with-ai/platforms/cli), open-source coding agent.
- [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code), Moonshot AI's coding assistant.
- [Minion Code](https://github.com/femto/minion-code), Minion-framework coding agent.
- [Mistral Vibe](https://github.com/mistralai/mistral-vibe), Mistral's open-source CLI assistant.
- [Nova](https://www.compassap.ai/portfolio/nova.html), Compass AI's software engineer.
- [Poolside](https://docs.poolside.ai/cli/pool), Poolside's coding agent.
- [Qoder](https://qoder.com), agentic coding assistant.
- [Qwen Code](https://qwenlm.github.io/qwen-code-docs/en/users/overview), Alibaba's Qwen coding assistant.
- [siGit Code](https://github.com/getsigit/sigit), local-first coding agent with optional on-device LLM.
- [Stakpak](https://stakpak.dev/), Rust-based DevOps agent.
- [TRAE CLI](https://docs.trae.cn/cli_get-started-with-trae-cli), ByteDance's official TRAE coding agent.
- [VT Code](https://github.com/vinhnx/VTCode/blob/main/docs/guides/zed-acp.md), open-source multi-provider coding agent.

The in-app catalog is the canonical, version-pinned source. Anything not listed here can still be added manually, see [Custom providers](/docs/custom-providers).

### fx

[Install fx](https://fx.sh/docs/getting-started/installation) on your daemon host and
[connect a provider](https://fx.sh/docs/getting-started/authentication), for example with
`fx login`. In **Settings → Hosts → your host → Providers**, find **fx** in the catalog and
choose **Add**. Paseo launches `fx acp` and uses your fx credentials and settings. Until fx has
credentials, the provider reports the sign-in message from fx.

The model list comes from your active fx provider, so run `fx provider` to change the list a new
agent starts from. Changing an agent's permission mode also changes fx's saved permission mode.
See [fx's ACP guide](https://fx.sh/docs/using-fx/acp) for what fx supports. Use a
[command override](/docs/custom-providers) if `fx` is outside your daemon's PATH; keep `acp` in
the arguments.

### Hoplite

Install the [Hoplite CLI](https://hoplite.sh/docs/cli) on your daemon host and run
`hoplite login`. In **Settings → Hosts → your host → Providers**, find **Hoplite**
in the catalog and choose **Add**. Paseo launches `hoplite acp` through the generic ACP adapter.

Hoplite runs the agent in a cloud workspace. Open a repository linked to a Hoplite project,
or set `agents.providers.hoplite.env.HOPLITE_PROJECT_ID` to use one project everywhere.
Without a linked repository or pinned project, discovery reports `No Hoplite project`.
Your local files and Paseo's local CLI are not available in that cloud workspace.

See [Hoplite's ACP guide](https://hoplite.sh/docs/cli/acp) for authentication and project setup.
Use a [command override](/docs/custom-providers) if `hoplite` is outside your daemon's PATH;
keep `acp` in the arguments.
