import { encodeTerminalKeyInput } from "@getpaseo/protocol/terminal-key-input";
import { TerminalInputModeTracker } from "@getpaseo/protocol/terminal-input-mode";

interface TerminalKeyTokenInput {
  key: string;
  literal: boolean;
  preamble: string;
}

// Upstream's `send_terminal_keys` MCP tool encoding (d0fd2e532 paseo-tools.ts:569-604), kept
// verbatim so `paseo terminal send-keys` encodes keys for the terminal's current input mode.
export function resolveTerminalKeyToken({ key, literal, preamble }: TerminalKeyTokenInput): string {
  if (literal) {
    return key;
  }

  const match = /^((?:[CMS]-)*)(.+)$/.exec(key);
  if (!match) {
    return key;
  }
  const [, modifiers, token] = match;
  const aliases: Record<string, string> = {
    Up: "ArrowUp",
    Down: "ArrowDown",
    Left: "ArrowLeft",
    Right: "ArrowRight",
    BSpace: "Backspace",
    Space: " ",
  };
  const inputMode = new TerminalInputModeTracker();
  inputMode.feed(preamble);
  const encodedKey = Object.hasOwn(aliases, token) ? aliases[token] : token;
  return (
    encodeTerminalKeyInput(
      {
        key: encodedKey,
        ctrl: modifiers.includes("C-"),
        alt: modifiers.includes("M-"),
        shift: modifiers.includes("S-"),
      },
      { inputMode: inputMode.getState() },
    ) || key
  );
}
