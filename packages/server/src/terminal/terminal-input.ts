import type { TerminalManager } from "./terminal-manager.js";

export function sendTerminalInput(
  terminalManager: TerminalManager,
  terminalId: string,
  data: string,
): void {
  const terminal = terminalManager.getTerminal(terminalId);
  if (!terminal) {
    throw new Error(`Terminal ${terminalId} not found`);
  }

  terminal.send({ type: "input", data });
}
