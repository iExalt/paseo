import { describe, expect, it } from "vitest";
import { createNativeHeadlessTerminal } from "./headless-terminal-state";
import { createTerminalFindController } from "./terminal-find-controller";

function setup() {
  const terminal = createNativeHeadlessTerminal({ rows: 4, cols: 20, scrollbackLines: 6 });
  let revision = 0;
  const controller = createTerminalFindController({
    search: (query) => terminal.search(query),
    revision: () => revision,
    coordinateEpoch: () => terminal.getBufferBounds().coordinateEpoch,
  });
  async function write(text: string) {
    await terminal.write(text);
    revision += 1;
  }
  const line = (index: number) => `match ${index}\r\n`;
  return { terminal, controller, write, line };
}

function selectedText(state: ReturnType<ReturnType<typeof setup>["controller"]["state"]>) {
  return state.matches[state.current];
}

describe("terminal find controller", () => {
  it("steps by position after scrollback trims, not by the old index", async () => {
    const { terminal, controller, write, line } = setup();
    for (let index = 0; index < 8; index += 1) await write(line(index));
    controller.search("match", 0);
    controller.step(1);
    controller.step(1);
    const picked = selectedText(controller.state())!;
    const row = picked.startRow;
    // Four more lines trim four rows off the top.
    for (let index = 8; index < 12; index += 1) await write(line(index));
    expect(terminal.getBufferBounds().oldestRow).toBeGreaterThan(0);
    const next = selectedText(controller.step(1))!;
    expect(next.startRow).toBe(row + 1);
  });

  it("reuses the scan while nothing was written", async () => {
    const { controller, write, line } = setup();
    await write(line(0));
    const first = controller.search("match", 0).matches;
    expect(controller.step(1).matches).toBe(first);
  });

  it("starts a new query at the first match at or below the viewport", async () => {
    const { controller, write, line } = setup();
    for (let index = 0; index < 3; index += 1) await write(line(index));
    expect(selectedText(controller.search("match", 1))!.startRow).toBe(1);
    expect(selectedText(controller.search("match", 99))!.startRow).toBe(0);
  });
});
