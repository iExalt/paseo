---
title: Paseo 工具与 CLI 迁移
description: 原生工具策略，以及从 Paseo 原有 MCP 端点迁移到 CLI 的说明。
nav: 工具策略与迁移
---

# Paseo 工具与 CLI 迁移 {#paseo-tools-and-cli-migration}

Paseo 不再提供 `/mcp/agents`，也不再向 Agent 会话注入自己的 MCP 服务器。自动化请使用 [CLI 参考](/docs/cli)。Provider 原生的 Paseo 工具、共享的命令服务和第三方 MCP 服务器仍然受支持。本页保留原来的 URL，以免现有链接失效。

## 配置 {#configuration}

`daemon.agentTools.enabled` 控制 Provider 原生的 Paseo 工具和生成的 CLI 指引。新配置中它默认为 `false`。可以在 **设置 → 你的主机 → Agents → 启用 Paseo tools** 中开启，或者这样配置：

```json
{
  "version": 1,
  "daemon": {
    "agentTools": { "enabled": true }
  }
}
```

编辑文件后使用[配置重新加载](/docs/configuration#apply-changes)，然后启动或重新加载 Agent，让它获得新的工具目录和启动上下文。重新加载 daemon 配置不会重启 daemon。

旧版持久化的 `daemon.mcp` 值只作为迁移输入。当 `daemon.agentTools.enabled` 缺省时，生效值为 `(daemon.mcp.enabled ?? true) && (daemon.mcp.injectIntoAgents ?? false)`。显式的 `agentTools.enabled` 优先，包括 `false`；daemon 启动时的覆盖项优先于持久化的值。旧设置不会恢复 MCP 端点。

## 按 Provider 限制 Paseo 工具 {#limit-paseo-tools-by-provider}

为每个确切的 Provider ID 配置 `agents.providers.<provider-id>.paseoTools`：

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

全局开关开启时，省略 `paseoTools` 即启用该目录。`enabled: false` 会禁用它；`disabledTools` 会省略确切的原生工具 ID。自定义 Provider 不会通过 `extends` 继承此策略；子 Provider 使用自己的策略。该策略也会过滤生成的 CLI 指引；它不会拒绝 shell 命令，也不会授予 daemon 权限。支持 shell 的 Agent 仍然可以调用 CLI，但要遵循普通的 daemon 授权。

浏览器命令需要 `daemon.browserTools.enabled` 和已连接的浏览器宿主。仅用于语音的 `speak` 原生工具与此目录策略是分开的。参阅[浏览器命令](/docs/browser-tools)和 [CLI 语音](/docs/cli#speech)。

## 调用方上下文与 daemon 选择 {#caller-context-and-daemon-selection}

启用 CLI 暴露且可执行文件可用时，受管的 Agent 会收到绝对路径的 `PASEO_CLI`、其所属 daemon 的 `PASEO_HOME`，以及一个空的 `PASEO_HOST`，用来丢弃继承来的主机覆盖项。daemon 还会设置 `PASEO_AGENT_ID` 和 `PASEO_AGENT_CWD`；调用方提供的环境变量值无法替换这个身份。

请调用 `"$PASEO_CLI"` 并保留这些上下文。不要伪造其他 Agent 的身份。显式的 `--home` 或 `--host` 会选择另一个 daemon；调用方在所选的 daemon 上解析，缺少调用方并不会在那里建立父子关系。参阅 [daemon 选择](/docs/cli#select-one-daemon)。

## 心智模型 {#mental-model}

工作区决定工作在哪里进行；父子关系决定谁拥有这项工作。受管 Agent 的 `paseo run` 默认在自己的工作区中创建子 Agent。`--workspace <id>` 只改变放置位置，不改变父子关系。`--relationship detached` 显式创建独立的 Agent。`--no-wait` 只是在启动或分发之后返回，并不会让执行者脱离父级。参阅[异步委派](/docs/cli#asynchronous-delegation)。

## 替换外部 MCP 客户端 {#replacing-external-mcp-clients}

请从外部客户端配置中移除旧的 Paseo 端点，并通过支持 shell 的集成调用 CLI 命令。CLI 不是 MCP 传输。它的 JSON 输出因命令而异，因此请更新使用方，而不是解析以前的 MCP 内容封装。

| 原操作                                   | 当前参考                                                          |
| ---------------------------------------- | ----------------------------------------------------------------- |
| Agent 创建/发送/查询/状态/活动/更新/关闭 | [Agent 与运行时设置](/docs/cli#agent-runtime-settings)            |
| 配置与 Provider 能力                     | [配置与 Provider 发现](/docs/cli#profiles-and-provider-discovery) |
| 工作区、脚本、终端、通知策略             | [CLI 参考](/docs/cli)                                             |
| 定时任务与 heartbeat 操作                | [在 CLI 中使用定时任务](/docs/schedules-cli)                      |
| 全部 22 项浏览器操作                     | [浏览器命令](/docs/browser-tools)                                 |
| 语音输出                                 | [语音](/docs/cli#speech)                                          |
| 权限响应                                 | [权限](/docs/cli#permissions)                                     |
