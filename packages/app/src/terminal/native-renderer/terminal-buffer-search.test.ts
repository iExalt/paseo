import { Terminal } from "@xterm/headless";
import { describe, expect, it } from "vitest";
import { searchTerminalBuffer } from "./terminal-buffer-search";

async function terminalWith(text: string, cols = 10) {
  const terminal = new Terminal({ cols, rows: 4, scrollback: 100, allowProposedApi: true });
  await new Promise<void>((resolve) => terminal.write(text, resolve));
  return terminal;
}

function search(terminal: Terminal, query: string, limit?: number) {
  return searchTerminalBuffer(terminal.buffer.active, query, {
    oldestRow: 100,
    cell: terminal.buffer.active.getNullCell(),
    limit,
  });
}

describe("searchTerminalBuffer", () => {
  it("matches across a soft wrap and ignores case", async () => {
    const terminal = await terminalWith("12345678 HELLO world");
    expect(search(terminal, "hello wor").matches).toEqual([
      { startRow: 100, startCol: 9, endRow: 101, endCol: 8 },
    ]);
  });

  it("never matches the padding after a line's text", async () => {
    const terminal = await terminalWith("ab\r\ncd");
    expect(search(terminal, "ab  ").matches).toEqual([]);
    expect(search(terminal, "cd").matches).toEqual([
      { startRow: 101, startCol: 0, endRow: 101, endCol: 2 },
    ]);
  });

  it("ends a match on a wrapped row's last column", async () => {
    const terminal = await terminalWith("123456789Xabc");
    expect(search(terminal, "9x").matches).toEqual([
      { startRow: 100, startCol: 8, endRow: 100, endCol: 10 },
    ]);
  });

  it("maps a combining sequence to its one cell", async () => {
    const terminal = await terminalWith("e\u0301tat é");
    expect(search(terminal, "tat").matches).toEqual([
      { startRow: 100, startCol: 1, endRow: 100, endCol: 4 },
    ]);
  });

  it("counts a wide character as two columns and skips its empty second cell", async () => {
    const terminal = await terminalWith("界x界");
    expect(search(terminal, "x界").matches).toEqual([
      { startRow: 100, startCol: 2, endRow: 100, endCol: 5 },
    ]);
  });

  it("stops at the limit and says more were left", async () => {
    const terminal = await terminalWith("aaaaaa");
    expect(search(terminal, "a", 4)).toMatchObject({ limited: true });
    expect(search(terminal, "a", 4).matches).toHaveLength(4);
  });
});
