---
title: 浏览器命令
description: 操作 Paseo 浏览器标签页的全部 22 条 CLI 命令。
nav: 命令参考
---

# 浏览器命令 {#browser-commands}

启用[浏览器自动化](/docs/browser)且已连接桌面浏览器宿主时，使用 `paseo browser`。支持原生工具的 Provider 在其原生目录中保留对应的 `browser_*` 工具；Paseo 不再提供 MCP 端点。

## 上下文与结果 {#context-and-results}

`--workspace <id>` 选择工作区；`--agent <id>` 提供 Agent 运行时上下文。没有显式上下文时，CLI 会从 `PASEO_AGENT_ID` 解析调用方。外部调用方在创建和列出标签页时应选择一个工作区。浏览器 ID 来自 `new-tab` 或 `list-tabs`，所有针对标签页的操作都需要它。标签页操作使用显式 ID，并仍然受宿主上下文检查的约束。同时选择 Agent 和工作区时，该工作区必须属于该 Agent。

添加 `--json` 可获得结构化的结果和上下文。结果会报告命令执行期间页面打开的对话框（alert 会被接受；confirm/prompt/beforeunload 会被取消）。全局的 `--home` 或 `--host` 用于选择 daemon；它不会把浏览器从已连接的桌面宿主上移走。

## 命令 {#commands}

每一行都以 `paseo browser` 开头。方括号表示可选参数。

| 命令和参数                                              | 用途                                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `list-tabs`                                             | 列出所选上下文中的标签页。                                                            |
| `new-tab [url]`                                         | 在后台打开一个标签页并返回它的浏览器 ID。                                             |
| `close-tab <browser-id>`                                | 关闭标签页及其 webview。                                                              |
| `resize <browser-id> <width> <height>`                  | 以像素为单位调整视口大小。                                                            |
| `snapshot <browser-id>`                                 | 读取无障碍树和最新的元素引用。                                                        |
| `screenshot <browser-id> --output <path> [--full-page]` | 在 CLI 所在的机器上写入一个 PNG。                                                     |
| `logs <browser-id> [--max-entries <n>]`                 | 控制台和网络条目；默认 50，最多 200。                                                 |
| `wait <browser-id> --text <text>`                       | 等待可见文本出现。                                                                    |
| `click <browser-id> <ref>`                              | 点击；支持 `--button left\|right\|middle`、`--double-click` 和可重复的 `--modifier`。 |
| `fill <browser-id> <ref> <value>`                       | 替换输入框内容。                                                                      |
| `type <browser-id> <text> [--ref <ref>]`                | 输入到引用的控件或当前聚焦的控件。                                                    |
| `keypress <browser-id> <key> [--ref <ref>]`             | 按下 Enter、Escape、Tab 或其他按键。                                                  |
| `hover <browser-id> <ref>`                              | 悬停，包括 CSS 悬停行为。                                                             |
| `select <browser-id> <ref> <value>`                     | 选择一个选项。                                                                        |
| `drag <browser-id> <source-ref> <target-ref>`           | 在元素之间拖动。                                                                      |
| `upload <browser-id> <ref> --file <path>`               | 设置文件输入框的内容；多个文件时重复 `--file`。                                       |
| `scroll <browser-id> <delta-x> <delta-y> [--ref <ref>]` | 以 CSS 像素为单位滚动。                                                               |
| `navigate <browser-id> <url>`                           | 打开一个 HTTP(S) URL。                                                                |
| `back <browser-id>`                                     | 后退；没有历史记录时报错。                                                            |
| `forward <browser-id>`                                  | 前进；没有前进条目时报错。                                                            |
| `reload <browser-id>`                                   | 重新加载页面。                                                                        |
| `evaluate <browser-id> <function> [--ref <ref>]`        | 运行 JavaScript；传入 ref 时，该元素作为第一个参数传入。返回有大小限制的 JSON。       |

`wait` 也接受 `--url <url>` 来代替 `--text`。请恰好提供一个条件。`--timeout-ms <ms>` 接受 1–30000 毫秒。

## 快照、操作、验证 {#snapshot-act-verify}

```bash
paseo browser list-tabs --workspace <workspace-id> --json
paseo browser snapshot <browser-id> --json
paseo browser click <browser-id> @e3
paseo browser wait <browser-id> --text "Saved" --timeout-ms 10000
paseo browser screenshot <browser-id> --output ./saved.png
```

类似 `@e3` 的元素引用属于该标签页的最新快照，页面变化后会失效。遇到 `browser_stale_ref` 时，请先重新获取快照再重试。

## 文件与截图 {#files-and-screenshots}

截图需要 `--output <path>`，相对于 CLI 的当前目录解析。父目录必须已经存在。CLI 会写入或覆盖 PNG，并返回绝对路径 `outputPath` 和图像元数据，而不是内联的 base64。即使使用 `--host`，产物也在 CLI 所在的机器上。

上传使用在允许的工作区内、浏览器宿主可访问的路径。它们不会从远程 CLI 机器传输任意文件。参阅[浏览器文件访问](/docs/browser)。

## 错误 {#errors}

| 错误码              | 恢复方式                               |
| ------------------- | -------------------------------------- |
| `browser_disabled`  | 在所选 daemon 上启用浏览器工具。       |
| `browser_no_host`   | 连接一个桌面浏览器宿主，然后重试。     |
| `browser_stale_ref` | 读取最新的快照。                       |
| `browser_timeout`   | 检查页面状态和等待条件。               |
| `browser_denied`    | 检查 URL、文件路径、导航历史和上下文。 |

不支持 CLI 浏览器功能的旧版 daemon 会返回需要更新的错误。中断 CLI 会取消浏览器请求。
