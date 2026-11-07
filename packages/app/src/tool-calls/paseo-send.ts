import type { ToolCallItem } from "@/types/stream";

/** Recognize one literal CLI send; compound commands keep their shell presentation. */
export function presentPaseoSend(item: ToolCallItem): ToolCallItem {
  if (item.payload.source !== "agent" || item.payload.data.detail.type !== "shell") return item;
  const command = item.payload.data.detail.command;
  const tokens = tokenizeLiteralCommand(command);
  if (!tokens) return item;
  const [executable, group, action, ...args] = tokens;
  if (group !== "agent" || action !== "send" || !isPaseoExecutable(executable, command))
    return item;
  const input = readSendArguments(args);
  if (!input) return item;
  return {
    ...item,
    payload: {
      source: "agent",
      data: {
        ...item.payload.data,
        name: "mcp__paseo__send_agent_prompt",
        detail: {
          type: "unknown",
          input: {
            ...input,
            command,
          },
          output: item.payload.data.detail.output ?? null,
        },
      },
    },
  };
}

function hasShellSyntax(char: string, quote: string, tokenCount: number): boolean {
  return (
    (!quote && /[\n\r()]/.test(char)) ||
    (quote !== "'" && ((char === "$" && tokenCount > 0) || char === "`"))
  );
}

function isLiteralCharacter(char: string, tokenCount: number): boolean {
  return /[a-zA-Z0-9_./:=+$-]/.test(char) || (tokenCount === 0 && /[{}]/.test(char));
}

function tokenizeLiteralCommand(command: string): string[] | null {
  const tokens: string[] = [];
  let token = "";
  let started = false;
  let quote = "";
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (hasShellSyntax(char, quote, tokens.length)) return null;
    if (char === "\\" && quote !== "'") {
      const next = command[++i];
      if (next === undefined) return null;
      if (next === "\n") continue;
      token += quote === '"' && !/[\\$`"]/.test(next) ? `\\${next}` : next;
      started = true;
    } else if (quote) {
      if (char === quote) quote = "";
      else token += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) tokens.push(token);
      token = "";
      started = false;
    } else {
      if (!isLiteralCharacter(char, tokens.length)) return null;
      token += char;
      started = true;
    }
  }
  if (quote) return null;
  if (started) tokens.push(token);
  return tokens;
}

function isPaseoExecutable(executable: string | undefined, command: string): boolean {
  if (!executable || !/^(?:\$PASEO_CLI|\$\{PASEO_CLI\}|(?:.*\/)?paseo)$/.test(executable))
    return false;
  if (executable.includes("$") && executable !== "$PASEO_CLI" && executable !== "${PASEO_CLI}")
    return false;
  if (
    executable.includes("$") &&
    !/^\s*(?:"\$(?:PASEO_CLI|\{PASEO_CLI\})"|\$(?:PASEO_CLI|\{PASEO_CLI\}))\s/.test(command)
  )
    return false;
  if (/[{}]/.test(executable) && executable !== "${PASEO_CLI}") return false;
  return true;
}

function readSendArguments(
  args: string[],
): { agentId: string; prompt?: string; promptFile?: string } | null {
  let agentId: string | undefined;
  let prompt: string | undefined;
  let promptFile: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (["--no-wait", "--notify-on-finish", "--no-notify-on-finish"].includes(arg)) continue;
    if (
      ["--prompt", "--prompt-file", "--if-running", "--behavior", "--mode", "--cwd"].includes(arg)
    ) {
      const value = args[++i];
      if (value === undefined) return null;
      if (arg === "--prompt") prompt = value;
      if (arg === "--prompt-file") promptFile = value;
    } else if (arg.startsWith("-")) return null;
    else if (!agentId) agentId = arg;
    else if (prompt === undefined) prompt = arg;
    else return null;
  }
  if (!agentId || (!prompt && !promptFile)) return null;
  return {
    agentId,
    ...(prompt !== undefined ? { prompt } : {}),
    ...(promptFile ? { promptFile } : {}),
  };
}
